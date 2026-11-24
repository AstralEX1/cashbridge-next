import { binToHex } from '@bitauth/libauth'
import { Chain, EVMChain, getChainConfig, UTXOChain } from '@tcswap/core'
import { ProviderName } from '@tcswap/helpers'
import type { QuoteResponseRoute } from '@tcswap/helpers/api'
import { getProvider } from '@/lib/evm-rpc'
import { fetchFirst } from '@/lib/fallback'
import type { Asset } from '@/components/swap/asset'
import { BridgeConfig } from '@/config'
import { getInboundAddresses, getQuotes, getTxStatus, isBridgeRoute, type TxStatusResponse } from '@/lib/api'
import { addressToLockingBytecode, type BchBinding, decodeTx, getTransactionState, listWalletCoins } from '@/lib/bch'
import { formatBaseUnits, minOutputFor } from '@/lib/bridge'
import { withLock } from '@/lib/bridge-first-leg'
import { BroadcastRejected, broadcastBchTransaction, parseP2pkhUnlock, prepareTokenTrade } from '@/lib/cauldron'
import type { CauldronToken } from '@/lib/cauldron-tokens'
import { buildDeposit, type BuiltDeposit, checkDepositMemo, checkInbound, DepositError, type InboundAddress, matchPayout, pickBchFunding, TRANSFER_FAILED_TOPIC, TRANSFER_OUT_TOPIC } from '@/lib/thorchain-deposit'
import { cosmosPayout, type ChainPayout, evmTransferPayout, type PayoutExpectation, solanaPayout, thorchainPayout, tronPayout, utxoPayout, xrpPayout } from '@/lib/payout-check'
import { getNearQuote, getNearStatus, interpretNearStatus, nearLegOf, nearSlippageBps, nudgeNearDeposit } from '@/lib/near-intents'
import { getShapeShiftBridgeRoute } from '@/lib/shapeshift'
import { blockHeight, destinationChainOf, isEvmChain } from '@/lib/payout-chains'
import { BLOCKCHAIR_CHAINS } from '@/lib/blockchair'
import { postFirst, rpcUrls } from '@/lib/transfer-status'
import { XRPL_RPC_URLS } from '@/lib/endpoints'
import { generateId } from '@/lib/utils'
import { blockchairProxyUrl } from '@/lib/wallets'
import type { Signable } from '@/lib/bch-signing'
import { SIGN_REQUEST_EXPIRY_S } from '@/lib/bch-walletconnect'
import { type BridgeOperation, bridgeTxStatus, getActiveBridge, type NearLeg, type ReverseDetails, type SwapTransaction, transactionStore } from '@/store/transaction-store'

// The reverse bridge: (token -> BCH on Cauldron, step 1) then a BCH deposit to THORChain paying an
// THORChain asset's address (step 2). Both transactions are built here, checked, signed in the bound BCH wallet
// without broadcasting, checked again, saved, and only then broadcast by this app.

export class ReverseBlocked extends Error {}

export const bchAsset = (): Asset => ({
  chain: Chain.BitcoinCash,
  chainId: getChainConfig(Chain.BitcoinCash).chainId,
  decimals: 8,
  identifier: BridgeConfig.buyAsset,
  ticker: 'BCH',
  name: 'Bitcoin Cash',
  logoURI: '/networks/bch.svg',
  providers: []
})

// A Cauldron token as the history's asset record (identified by its category, never its ticker).
export const tokenAsset = (token: CauldronToken): Asset => ({
  ...bchAsset(),
  decimals: token.decimals,
  identifier: `BCH.${token.ticker}-${token.category}`,
  ticker: token.ticker,
  name: token.name,
  logoURI: token.icon
})

export { blockHeight, destinationChainOf }

export { signInWallet, type Signable } from '@/lib/bch-signing'

type Update = ReturnType<typeof transactionStore.getState>['updateBridge']

const allUnspent = async (lockingBytecode: string, outpoints: { txid: string; vout: number }[]) => {
  const { utxos } = await listWalletCoins(lockingBytecode)
  return outpoints.every(p => utxos.some(coin => coin.txid === p.txid && coin.vout === p.vout))
}

// What the first transaction spends from the bound wallet, saved before it goes to the wallet.
export const signingInputs = ({ unsignedHex, ownIndexes }: Signable): NonNullable<ReverseDetails['signing']> => ({
  inputs: decodeTx(unsignedHex)
    .inputs.filter((_, index) => ownIndexes.includes(index))
    .map(input => ({ txid: binToHex(input.outpointTransactionHash), vout: input.outpointIndex })),
  sentAt: Date.now()
})

// How long a wallet may still answer a request this app stopped waiting for: WalletConnect's request expiry, plus a
// minute for the steps between saving the inputs and sending the request.
export const OPEN_REQUEST_MS = SIGN_REQUEST_EXPIRY_S * 1000 + 60_000

// A first transaction whose signature never came back (the page went away, or the request was withdrawn while the
// wallet still had it). This app broadcasts only what it saved, but a wallet that broadcasts on its own may have sent
// it: nothing counts as sent or not until the inputs are spent or the request has expired.
export const unsignedOutcome = async (op: BridgeOperation, now = Date.now()): Promise<Partial<BridgeOperation> | undefined> => {
  const signing = op.reverse?.signing
  if (!signing?.inputs.length) return { stage: 'failed', error: 'The wallet returned no signed transaction. Check your BCH wallet before trying again' }
  if (!(await allUnspent(op.binding.lockingBytecode, signing.inputs)))
    return { stage: 'failed', error: 'Your BCH wallet spent the coins of this transfer after the request, so it may have sent it. Check its history before trying again' }
  if (now - signing.sentAt > OPEN_REQUEST_MS) return { stage: 'failed', error: 'Nothing was signed, so nothing was sent' }
}

const rejectedFundingIntact = async (uid: string, signedHex: string, txid: string) => {
  if ((await getTransactionState(txid)).seen) return false
  const tx = transactionStore.getState().transactions.find(item => item.uid === uid)
  const binding = tx?.kind !== 'send' ? tx?.bridge?.binding : undefined
  if (!binding?.pubkey) return false
  const inputs = decodeTx(signedHex).inputs.filter(input => {
    const unlock = parseP2pkhUnlock(input.unlockingBytecode)
    return unlock && binToHex(unlock.pubkey) === binding.pubkey
  })
  if (!inputs.length) return false
  return allUnspent(binding.lockingBytecode, inputs.map(input => ({ txid: binToHex(input.outpointTransactionHash), vout: input.outpointIndex })))
}

export const broadcastSale = async (uid: string, signedHex: string, txid: string, update: Update) => {
  try {
    await broadcastBchTransaction(signedHex, txid)
    update(uid, op => op.reverse?.sale?.txid === txid ? { stage: 'bch_ready', error: undefined } : {})
  } catch (error) {
    if (error instanceof BroadcastRejected && await rejectedFundingIntact(uid, signedHex, txid).catch(() => false))
      // The sale is dropped with it: a ticked step and a "sent" toast would contradict "Nothing was sent".
      return update(uid, op => op.reverse?.sale?.txid === txid ? { stage: 'failed', error: `The swap was rejected: ${error.message}. Nothing was sent.`, reverse: { ...op.reverse, sale: undefined } } : {})
    update(uid, op => op.reverse?.sale?.txid === txid ? { stage: 'first_leg_unknown', error: error instanceof Error ? error.message : 'Broadcast outcome unknown' } : {})
  }
}

// The tokens sent to a Cashbridge Router order's sale contract. Only a definite refusal with the coins still in the
// wallet ends the operation; an unknown outcome is sent again by the tracker.
export const broadcastRouterSend = async (uid: string, signedHex: string, txid: string, update: Update) => {
  try {
    await broadcastBchTransaction(signedHex, txid)
  } catch (error) {
    if (error instanceof BroadcastRejected && (await rejectedFundingIntact(uid, signedHex, txid).catch(() => false)))
      update(uid, op => (op.reverse?.router?.sendTxid === txid ? { stage: 'failed', error: `The transfer was rejected: ${error.message}. Nothing was sent.` } : {}))
  }
}

export const broadcastDeposit = async (uid: string, signedHex: string, txid: string, update: Update) => {
  const dropped = (reason: string) =>
    update(uid, op => op.reverse?.deposit?.txid !== txid ? {} : op.reverse.sale ? {
      stage: 'bch_ready',
      error: `${reason}. Prepare it again.`,
      reverse: { ...op.reverse, deposit: undefined, priorDepositTxids: [...(op.reverse.priorDepositTxids ?? []), txid] }
    } : { stage: 'failed', error: `${reason}. Nothing was sent.` })
  const tx = transactionStore.getState().transactions.find(item => item.uid === uid)
  const deposit = tx?.kind !== 'send' ? tx?.bridge?.reverse?.deposit : undefined
  // A deposit the chain has not seen is not sent after its quote lapsed (a retired vault, an old price limit or a refund).
  if (deposit?.txid === txid && deposit.expiresAt !== undefined && deposit.expiresAt <= Date.now() && (await rejectedFundingIntact(uid, signedHex, txid).catch(() => false)))
    return dropped('The quote expired before the deposit went out')
  try {
    await broadcastBchTransaction(signedHex, txid)
    update(uid, op => op.reverse?.deposit?.txid === txid ? { stage: 'second_leg_pending', error: undefined } : {})
  } catch (error) {
    if (error instanceof BroadcastRejected && await rejectedFundingIntact(uid, signedHex, txid).catch(() => false))
      return dropped(`The deposit was rejected: ${error.message}`)
    update(uid, op => op.reverse?.deposit?.txid !== txid ? {} : {
      stage: 'second_leg_unknown',
      reverse: { ...op.reverse!, deposit: { ...op.reverse!.deposit!, error: error instanceof Error ? error.message : 'Broadcast outcome unknown' } }
    })
  }
}

// --- Step 1: the Cauldron sale -------------------------------------------------------------------

// Largest first, until `need` is covered.
const pick = <T,>(coins: T[], amountOf: (c: T) => bigint, need: bigint) => {
  const chosen: T[] = []
  let total = 0n
  for (const coin of [...coins].sort((a, b) => (amountOf(b) > amountOf(a) ? 1 : amountOf(b) < amountOf(a) ? -1 : 0))) {
    if (total >= need) break
    chosen.push(coin)
    total += amountOf(coin)
  }
  return total >= need ? chosen : undefined
}

// A fresh, reviewed sale of `sellUnits` of `token` from the bound address, ready to sign.
export const prepareSale = async (token: CauldronToken, sellUnits: bigint, binding: BchBinding, slippageBps = BridgeConfig.pusdSlippageBps) => {
  const { utxos } = await listWalletCoins(binding.lockingBytecode)
  const tokenCoins = utxos.filter(u => u.token?.category === token.category && !u.token.nft)
  const coins = pick(tokenCoins, u => u.token!.amount, sellUnits)
  if (!coins) throw new DepositError(`The BCH wallet holds less ${token.ticker} than this amount at the connected address`)
  return prepareTokenTrade(
    {
      category: token.category,
      side: 'sell',
      funding: coins.map(u => ({ txid: u.txid, vout: u.vout, value: u.value.toString(), token: { category: token.category, amount: u.token!.amount.toString() } })),
      lockingBytecode: binding.lockingBytecode,
      tokenAddress: binding.tokenAddress,
      cashAddress: binding.cashAddress
    },
    sellUnits,
    output => minOutputFor(output, slippageBps)
  )
}

// --- Step 2: the THORChain deposit ---------------------------------------------------------------

export interface PreparedDeposit {
  built: BuiltDeposit
  route: QuoteResponseRoute
  router?: string
  // Set for a deposit to NEAR Intents: the executable quote whose one-use address the deposit pays.
  near?: NearLeg
}

const pickRoute = (routes: QuoteResponseRoute[]) =>
  routes.find(r => r.providers[0] === ProviderName.THORCHAIN_STREAMING) ?? routes.find(r => r.providers[0] === ProviderName.THORCHAIN)

// A fresh THORChain quote for the BCH being deposited, its memo and vault checked against the asked
// asset and address and THORNode's own inbound addresses, and the deposit transaction built on it.
// `payAll` deposits every satoshi of `funding` but the fee (a sale's proceeds); otherwise exactly
// `amountSats` with change back to the wallet.
export const prepareDeposit = async ({
  funding,
  payAll,
  amountSats,
  binding,
  buyAsset,
  shortCode,
  destination,
  slippage
}: {
  funding: { txid: string; vout: number; value: string }[]
  payAll: boolean
  amountSats?: bigint
  binding: BchBinding
  buyAsset: string
  // The asset's THORChain short code, which a memo may use in its place.
  shortCode?: string
  destination: string
  slippage: number
}): Promise<PreparedDeposit> => {
  const inbounds = (await getInboundAddresses()) as unknown as InboundAddress[]
  const chain = destinationChainOf(buyAsset)
  const bchVault = inbounds.find(i => i.chain === 'BCH')?.address
  if (!bchVault) throw new DepositError('THORChain has no BCH vault right now')
  const { feeRate, vaultScript: sizingVault } = checkInbound(inbounds, bchVault, chain)
  if (!payAll) funding = pickBchFunding(funding, amountSats ?? 0n, binding.lockingBytecode, sizingVault, feeRate)
  // Sized with the longest memo THORChain reads: the real memo can only make the fee smaller.
  const sizing = buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript: sizingVault, memo: 'x'.repeat(80), payAll, amountSats, feeRate })
  const amount = sizing.amountSats

  const routes = await getQuotes({
    sellAsset: BridgeConfig.buyAsset,
    buyAsset,
    sellAmount: formatBaseUnits(amount, 8),
    slippage,
    providers: [ProviderName.THORCHAIN],
    sourceAddress: binding.cashAddress,
    destinationAddress: destination,
    refundAddress: binding.cashAddress
  })
  const route = pickRoute(routes)
  if (!route || !route.memo || !route.inboundAddress) throw new DepositError('THORChain has no route for this amount right now')
  if (!isBridgeRoute(route, { sellAsset: BridgeConfig.buyAsset, buyAsset, destinationAddress: destination })) throw new DepositError('The quote is not for this bridge')
  checkDepositMemo(route.memo, { buyAsset, destination, shortCode, minOut: route.expectedBuyAmountMaxSlippage })
  const { vaultScript, router } = checkInbound(inbounds, route.inboundAddress, chain)
  const built = buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript, memo: route.memo, amountSats: amount, feeRate })
  return { built, route, router }
}

// A plain BCH deposit of `amountSats` from the bound address, quoted and built, ready to sign.
export const prepareBchDeposit = async (args: { amountSats: bigint; binding: BchBinding; buyAsset: string; shortCode?: string; destination: string; slippage: number }) => {
  const { utxos } = await listWalletCoins(args.binding.lockingBytecode)
  const funding = utxos.filter(u => !u.hasToken).map(u => ({ txid: u.txid, vout: u.vout, value: u.value.toString() }))
  return prepareDeposit({ ...args, funding, payAll: false })
}

// --- Step 2 through NEAR Intents ---------------------------------------------------------------------

// Bitcoin Cash's standard relay fee; a NEAR deposit has no THORNode gas rate to follow.
const NEAR_DEPOSIT_FEE_RATE = 1n

// A deposit to a NEAR Intents one-use address instead of THORChain's vault: an executable 1Click quote for the BCH
// being sent (paying `destination`, refunds to the bound address), and a plain transfer of exactly that amount to the
// quoted address: no memo, change back to the wallet. `payAll` and `amountSats` work as in prepareDeposit.
export const prepareNearDeposit = async ({
  funding,
  payAll,
  amountSats,
  binding,
  buyAsset,
  destination,
  slippage
}: {
  funding: { txid: string; vout: number; value: string }[]
  payAll: boolean
  amountSats?: bigint
  binding: BchBinding
  buyAsset: string
  destination: string
  slippage: number
}): Promise<PreparedDeposit> => {
  const feeRate = NEAR_DEPOSIT_FEE_RATE
  // Sized against a P2PKH output like the bound address's own; 1Click's BCH deposit addresses are P2PKH.
  const sizingScript = binding.lockingBytecode
  if (!payAll) funding = pickBchFunding(funding, amountSats ?? 0n, binding.lockingBytecode, sizingScript, feeRate)
  const amount = buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript: sizingScript, payAll, amountSats, feeRate }).amountSats
  // FLEX_INPUT (Hashi-style): the deposit may land at or above the quoted minimum; Cauldron sale
  // proceeds are rarely exact to the dry quote, so EXACT_INPUT would reject a shortfall.
  const route = await getNearQuote({
    sellAsset: BridgeConfig.buyAsset,
    buyAsset,
    sellAmount: formatBaseUnits(amount, 8),
    recipient: destination,
    refundTo: binding.cashAddress,
    dry: false,
    flexible: true,
    slippageBps: nearSlippageBps(slippage)
  })
  if (!route) throw new DepositError('NEAR Intents does not carry this asset')
  const near = nearLegOf(route)
  const minIn = BigInt(route.near.quote.minAmountIn ?? near.amountIn)
  if (amount < minIn) throw new DepositError('The deposit is below the NEAR Intents minimum')
  const vaultScript = addressToLockingBytecode(near.depositAddress)
  if (!vaultScript || vaultScript === binding.lockingBytecode) throw new DepositError('The NEAR Intents deposit address is not a BCH address')
  const built = buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript, amountSats: amount, feeRate })
  return { built, route, near }
}

// A deposit through ShapeShift. Its BCH quotes are NEAR Intents addresses that take exactly the quoted amount, so the
// quote is made for exactly the BCH being sent, its 1Click swap checked (paying `destination`, refunds to the bound
// address), and the transfer pays that amount. `payAll` and `amountSats` work as in prepareDeposit.
export const prepareShapeShiftDeposit = async ({
  funding,
  payAll,
  amountSats,
  binding,
  buyAsset,
  buyDecimals,
  destination,
  slippage
}: {
  funding: { txid: string; vout: number; value: string }[]
  payAll: boolean
  amountSats?: bigint
  binding: BchBinding
  buyAsset: string
  buyDecimals: number
  destination: string
  slippage: number
}): Promise<PreparedDeposit> => {
  const feeRate = NEAR_DEPOSIT_FEE_RATE
  const sizingScript = binding.lockingBytecode
  if (!payAll) funding = pickBchFunding(funding, amountSats ?? 0n, binding.lockingBytecode, sizingScript, feeRate)
  const amount = buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript: sizingScript, payAll, amountSats, feeRate }).amountSats
  const route = await getShapeShiftBridgeRoute({
    sellAsset: BridgeConfig.buyAsset,
    buyAsset,
    sellAmount: formatBaseUnits(amount, 8),
    sellDecimals: 8,
    buyDecimals,
    slippage,
    sourceAddress: binding.cashAddress,
    destinationAddress: destination
  })
  const near = route?.shapeshift.near
  if (!route || !near) throw new DepositError('ShapeShift does not carry this asset')
  if (BigInt(near.amountIn) !== amount) throw new DepositError('ShapeShift quoted another amount')
  const vaultScript = addressToLockingBytecode(near.depositAddress)
  if (!vaultScript || vaultScript === binding.lockingBytecode) throw new DepositError('The ShapeShift deposit address is not a BCH address')
  const built = buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript, amountSats: amount, feeRate })
  return { built, route, near }
}

// A plain BCH deposit through ShapeShift of `amountSats` from the bound address, quoted and built, ready to sign.
export const prepareShapeShiftBchDeposit = async (args: { amountSats: bigint; binding: BchBinding; buyAsset: string; buyDecimals: number; destination: string; slippage: number }) => {
  const { utxos } = await listWalletCoins(args.binding.lockingBytecode)
  const funding = utxos.filter(u => !u.hasToken).map(u => ({ txid: u.txid, vout: u.vout, value: u.value.toString() }))
  return prepareShapeShiftDeposit({ ...args, funding, payAll: false })
}

// A plain BCH deposit through NEAR Intents of `amountSats` from the bound address, quoted and built, ready to sign.
export const prepareNearBchDeposit = async (args: { amountSats: bigint; binding: BchBinding; buyAsset: string; destination: string; slippage: number }) => {
  const { utxos } = await listWalletCoins(args.binding.lockingBytecode)
  const funding = utxos.filter(u => !u.hasToken).map(u => ({ txid: u.txid, vout: u.vout, value: u.value.toString() }))
  return prepareNearDeposit({ ...args, funding, payAll: false })
}

// A transaction on the destination chain named by its hash, counted only if that chain's own node shows it paying the
// destination (no memo asked): an EVM receipt and transaction, or the chain's own lookup.
export const payoutByHash = async (chain: string, hash: string, expect: PayoutExpectation): Promise<ChainPayout | undefined> => {
  if (!isEvmChain(chain)) return payoutOnChain(chain, hash, expect)
  const provider = await getProvider(chain as EVMChain)
  const id = hash.startsWith('0x') ? hash : `0x${hash}`
  const [receipt, tx] = await Promise.all([provider.getTransactionReceipt(id), provider.getTransaction(id)])
  return evmTransferPayout(receipt, tx, receipt?.hash ?? id, expect)
}

export type NearReverseOutcome = { payout: ChainPayout } | { refundSats?: string; reason?: string } | { error: string } | undefined

// Where a NEAR Intents deposit stands. 1Click's status only points at the payout transactions; they count once the
// destination chain shows them paying the destination, together at least the quoted minimum. A refund (to the bound
// address) is 1Click's report, which names no BCH transaction.
export const nearReverseOutcome = async (op: BridgeOperation): Promise<NearReverseOutcome> => {
  const near = op.near
  const reverse = op.reverse
  if (!near || !reverse) return undefined
  const status = await getNearStatus(near.depositAddress)
  nudgeNearDeposit(status, near.depositAddress, reverse.deposit?.txid)
  const view = interpretNearStatus(status)
  if (view.kind === 'refunded') return { refundSats: view.amount, reason: view.reason }
  if (view.kind === 'failed') return { error: view.reason }
  if (view.kind === 'pending') return view.detail ? { error: view.detail } : undefined
  const chain = destinationChainOf(reverse.buyAsset)
  const expect = { destination: reverse.destination, buyAsset: reverse.buyAsset, ...(view.txids.length === 1 && view.amountOut && { reportedAmount: view.amountOut }) }
  const found = (await Promise.all(view.txids.map(hash => payoutByHash(chain, hash, expect).catch(() => undefined)))).filter(p => p !== undefined)
  const total = found.reduce((sum, p) => sum + BigInt(p.amount), 0n)
  return found.length && total >= BigInt(near.minAmountOut) ? { payout: { hash: found[0].hash, amount: total.toString() } } : undefined
}
// --- Recording -----------------------------------------------------------------------------------

type ReverseRecord = Omit<SwapTransaction, 'uid' | 'status' | 'bridge' | 'hash'>
type ReverseBridge = Omit<BridgeOperation, 'id' | 'updatedAt' | 'direction' | 'firstLeg'>

const ensureNoActiveBridge = async () => {
  await transactionStore.persist.rehydrate()
  if (getActiveBridge()) throw new ReverseBlocked('Finish or close the current bridge operation first')
}

// Saves an operation whose wallet already signed: it is never refused, as the signed transaction must be tracked.
export const recordReverseOperation = (record: ReverseRecord, bridge: ReverseBridge, hash?: string) => {
  const id = generateId()
  const op: BridgeOperation = { ...bridge, id, direction: 'reverse', firstLeg: { result: 'pending' }, updatedAt: Date.now() }
  transactionStore.getState().setTransaction({ ...record, uid: id, ...(hash && { hash }), status: bridgeTxStatus(op), bridge: op })
  return id
}

// Checks that no other operation needs this wallet before the Cashbridge Router's send is signed: that one is saved only
// once signed (recordReverseOperation), so a cancelled request leaves nothing behind.
export const assertReverseFree = async () => {
  const done = await withLock('bch-bridge-first-leg', async () => (await ensureNoActiveBridge(), true))
  if (!done) throw new ReverseBlocked('Another tab is starting a bridge operation')
}

// Records a manual reverse operation before anything is signed. One operation at a time per browser.
export const startReverseOperation = async (record: ReverseRecord, bridge: ReverseBridge) => {
  const uid = await withLock('bch-bridge-first-leg', async () => {
    await ensureNoActiveBridge()
    return recordReverseOperation(record, bridge)
  })
  if (uid === undefined) throw new ReverseBlocked('Another tab is starting a bridge operation')
  return uid
}

// --- Payout --------------------------------------------------------------------------------------

const PAYOUT_SCAN_CHUNK = 1_000
const PAYOUT_SCAN_CHUNKS_PER_POLL = 10

// Looks for the router's TransferOut paying the destination for the deposit, from the deposit's
// start block onwards; reports how far it has looked so the next poll resumes there.
export const findPayout = async (op: BridgeOperation) => {
  const reverse = op.reverse
  const deposit = reverse?.deposit
  if (!reverse || !deposit?.txid || !deposit.router) return undefined
  const provider = await getProvider(destinationChainOf(reverse.buyAsset) as EVMChain)
  const head = await provider.getBlockNumber()
  let from = deposit.scannedBlock ?? deposit.startBlock ?? Math.max(0, head - PAYOUT_SCAN_CHUNK)
  const recipient = `0x${'0'.repeat(24)}${reverse.destination.toLowerCase().replace(/^0x/, '')}`
  for (let i = 0; i < PAYOUT_SCAN_CHUNKS_PER_POLL && from <= head; i++) {
    const to = Math.min(head, from + PAYOUT_SCAN_CHUNK - 1)
    const logs = await provider.getLogs({ address: deposit.router, topics: [[TRANSFER_OUT_TOPIC, TRANSFER_FAILED_TOPIC], null, recipient], fromBlock: from, toBlock: to })
    const match = matchPayout(
      logs.map(l => ({ address: l.address, topics: [...l.topics], data: l.data, transactionHash: l.transactionHash, blockNumber: l.blockNumber })),
      { destination: reverse.destination, depositTxid: deposit.txid, router: deposit.router, buyAsset: reverse.buyAsset }
    )
    if (match) return { payout: { hash: match.hash, amount: match.amount }, scannedBlock: to }
    from = to + 1
  }
  return { scannedBlock: from }
}

// THORChain swaps and pays out about this long after the deposit is final on BCH.
const SWAP_AND_PAYOUT_SECONDS = 60

// When the payout is expected, from THORNode's own countdown: the BCH confirmations it still waits
// for (it may need several blocks, more than the quote's estimate), any outbound delay, then the
// swap and the payout. Timing only: the payout itself is always seen on the destination chain.
export const depositReadyAt = (status: TxStatusResponse, nowMs = Date.now()) => {
  const stages = status.stages
  if (!stages?.inbound_observed?.completed) return undefined
  const confirming = stages.inbound_confirmation_counted?.completed === false ? (stages.inbound_confirmation_counted.remaining_confirmation_seconds ?? 0) : 0
  const delayed = stages.outbound_delay?.completed === false ? (stages.outbound_delay.remaining_delay_seconds ?? 0) : 0
  const seconds = confirming + delayed + SWAP_AND_PAYOUT_SECONDS
  return Number.isFinite(seconds) ? nowMs + seconds * 1000 : undefined
}

// The outbound THORNode names, looked up on its own chain (see payout-check.ts). A lookup that fails
// is no payout yet; the next poll asks again.
const nonEvmPayout = async (chain: string, out: OutTx, expect: { destination: string; depositTxid: string; buyAsset: string }): Promise<ChainPayout | undefined> => {
  if (chain === Chain.THORChain) return thorchainPayout(out, expect)
  if (chain === Chain.Cosmos) {
    const res = await fetchFirst(rpcUrls(Chain.Cosmos), `/tx?hash=0x${out.id.replace(/^0x/i, '')}`)
    const { result } = await res.json()
    return result ? cosmosPayout(result, out.id, expect) : undefined
  }
  return payoutOnChain(chain, out.id, expect)
}

// A transaction on a chain without THORChain's router, looked up on that chain's own node by its hash.
const payoutOnChain = async (chain: string, hash: string, expect: PayoutExpectation): Promise<ChainPayout | undefined> => {
  const slug = BLOCKCHAIR_CHAINS[chain as UTXOChain]
  if (slug) {
    const res = await fetch(`${blockchairProxyUrl()}/${slug}/dashboards/transaction/${encodeURIComponent(hash.toLowerCase())}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`UTXO lookup answered ${res.status}`)
    return utxoPayout(await res.json(), hash.toLowerCase(), expect)
  }
  if (chain === Chain.Ripple) {
    const { result } = await postFirst(XRPL_RPC_URLS, '', { method: 'tx', params: [{ transaction: hash }] })
    return xrpPayout(result, hash, expect)
  }
  if (chain === Chain.Solana) {
    const { result } = await postFirst(rpcUrls(Chain.Solana), '', {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [hash, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]
    })
    return solanaPayout(result, hash, expect)
  }
  if (chain === Chain.Tron) {
    const urls = rpcUrls(Chain.Tron)
    const id = hash.replace(/^0x/i, '').toLowerCase()
    const [tx, info] = await Promise.all([postFirst(urls, '/wallet/gettransactionbyid', { value: id }), postFirst(urls, '/wallet/gettransactioninfobyid', { value: id })])
    return tronPayout(tx, info, id, expect)
  }
  return undefined
}

type OutTx = NonNullable<TxStatusResponse['out_txs']>[number]

// THORNode names the payout's hash, and it counts only once the destination chain's own node shows
// it paying the destination for this deposit: on an EVM chain a successful receipt whose TransferOut
// matches (a gap filler when the log search finds nothing: an RPC that limits
// log queries); elsewhere the chain's own transaction, the only evidence those chains have.
export const confirmReportedPayout = async (op: BridgeOperation) => {
  const reverse = op.reverse
  const depositTxid = reverse?.deposit?.txid
  if (!reverse || !depositTxid) return undefined
  return confirmPayout({ destination: reverse.destination, depositTxid, buyAsset: reverse.buyAsset, router: reverse.deposit?.router })
}

// Shared by reverse bridges and free-pair swaps: THORNode names an outbound; its own chain proves it.
export const confirmPayout = async ({ destination, depositTxid, buyAsset, router: knownRouter }: {
  destination: string; depositTxid: string; buyAsset: string; router?: string
}) => {
  const chain = destinationChainOf(buyAsset)
  const status = await getTxStatus(depositTxid)
  const outs = (status.out_txs ?? []).filter(o => o.chain?.toUpperCase() === chain && o.memo?.toUpperCase().startsWith('OUT:'))
  if (outs.length === 0) return undefined
  if (!isEvmChain(chain)) {
    for (const out of outs) {
      const found = await nonEvmPayout(chain, out, { destination, depositTxid, buyAsset }).catch(() => undefined)
      if (found) return found
    }
    return undefined
  }
  const router = knownRouter ?? (await getInboundAddresses()).find(inbound => inbound.chain === chain)?.router
  if (!router) return undefined
  const provider = await getProvider(chain as EVMChain)
  for (const out of outs) {
    const receipt = await provider.getTransactionReceipt(out.id.startsWith('0x') ? out.id : `0x${out.id}`)
    if (!receipt || receipt.status !== 1) continue
    const match = matchPayout(
      receipt.logs.map(l => ({ address: l.address, topics: [...l.topics], data: l.data, transactionHash: receipt.hash, blockNumber: receipt.blockNumber })),
      { destination, depositTxid, router, buyAsset }
    )
    if (match) return { hash: match.hash, amount: match.amount }
  }
  return undefined
}

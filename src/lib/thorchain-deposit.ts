import { binToHex, encodeTransaction, hexToBin, utf8ToBin } from '@bitauth/libauth'
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize'
import { AbiCoder } from 'ethers'
import { addressToLockingBytecode, normalizeTxid } from '@/lib/bch'
import { sameAddress } from '@/lib/payout-chains'

// The reverse bridge's THORChain leg: a BCH deposit to THORChain's vault carrying the swap memo,
// built here and signed in the bound BCH wallet. THORChain refunds to the address of the first
// input, so every input is the bound wallet's own. Pure functions, tested on fixtures.

// BCH kept back from a token sale's proceeds for the deposit's own miner fee.
export const DEPOSIT_FEE_RESERVE = 1_000n
// THORChain ignores a BCH deposit "equal to or below the dust threshold" (docs, vault behaviours); Bifrost skips only
// below it, so a deposit must be above it to satisfy both.
export const BCH_DUST_THRESHOLD = 10_000n

// A signing or outbound halt leaves quotes and swaps running while THORChain holds every payout and refund on the chain;
// its docs say interfaces must not let users send then. `assets` are the route's two ends (`BASE.USDC-0X..` -> BASE).
export const thorchainPayoutsHalted = (mimir: Record<string, number>, assets: (string | undefined)[]) =>
  mimir['HALTSIGNING'] > 0 ||
  mimir['HALTOUTBOUND'] > 0 ||
  assets.some(asset => {
    const chain = asset?.split(/[.~/-]/)[0].toUpperCase()
    return !!chain && (mimir[`HALTSIGNING${chain}`] > 0 || mimir[`HALTOUTBOUND${chain}`] > 0)
  })
// BCH relays OP_RETURN data up to 223 bytes, but THORChain reads at most 80 bytes of memo.
export const MAX_MEMO_BYTES = 80
// Change below this is not worth an output; it goes to the miner.
const CHANGE_DUST = 546n
// The largest P2PKH unlocking script a wallet can sign: a 72-byte low-S DER ECDSA signature plus sighash
// byte, and a 33-byte key, each with its push. A Schnorr signature is 8 bytes shorter and simply overpays.
const P2PKH_UNLOCK_BYTES = 108

export class DepositError extends Error {}

// --- THORNode inbound address --------------------------------------------------------------------

export interface InboundAddress {
  chain: string
  address: string
  router?: string
  halted?: boolean
  chain_trading_paused?: boolean
  global_trading_paused?: boolean
  gas_rate?: string
  dust_threshold?: string
}

// The BCH vault a deposit may pay: THORNode's current BCH inbound address, and only while BCH
// trading is open; plus the destination chain's router, whose TransferOut event is the payout.
export const checkInbound = (inbounds: InboundAddress[], quotedVault: string, destinationChain: string) => {
  const bch = inbounds.find(i => i.chain === 'BCH')
  if (!bch) throw new DepositError('THORChain has no BCH vault right now')
  if (bch.halted || bch.chain_trading_paused || bch.global_trading_paused) throw new DepositError('THORChain has paused BCH trading')
  const vaultScript = addressToLockingBytecode(bch.address)
  if (!vaultScript || vaultScript !== addressToLockingBytecode(quotedVault)) throw new DepositError('The quoted vault is not THORChain’s current BCH vault')
  // RUNE and THORChain-native tokens are paid inside THORChain, which has no inbound address of its own.
  const destination = inbounds.find(i => i.chain === destinationChain)
  if (destinationChain !== 'THOR' && (!destination || destination.halted || destination.chain_trading_paused))
    throw new DepositError(`THORChain has paused ${destinationChain} payouts`)
  const gasRate = BigInt(Math.min(10, Math.max(1, Number(bch.gas_rate) || 1)))
  return { vaultScript, router: destination?.router, feeRate: gasRate }
}

// --- Memo ----------------------------------------------------------------------------------------

// THORNode's own asset short codes (common/asset.go, Asset.ShortCode). The aggregator writes them in
// memos even where its token list leaves `shortCode` empty: SOL.SOL is quoted as `=:o:...`.
// THORNode looks them up exactly as written, so only the lowercase form expands; `B` alone would be a THOR-chain asset.
const THORNODE_SHORT_CODES: Record<string, string> = {
  'THOR.RUNE': 'r', 'BTC.BTC': 'b', 'ETH.ETH': 'e', 'GAIA.ATOM': 'g', 'DOGE.DOGE': 'd', 'LTC.LTC': 'l', 'BCH.BCH': 'c',
  'AVAX.AVAX': 'a', 'BSC.BNB': 's', 'BASE.ETH': 'f', 'TRON.TRX': 'tr', 'XRP.XRP': 'x', 'SOL.SOL': 'o', 'TAO.TAO': 'ta',
  'ZEC.ZEC': 'z', 'XMR.XMR': 'm', 'POL.POL': 'p', 'SUI.SUI': 'u', 'DOT.DOT': 'do', 'ADA.ADA': 'ad'
}

// The quoted memo must swap to the asked asset and pay the asked address: `=:ASSET:DEST[:LIMIT...]`
// (also `s`/`swap`). THORChain accepts the asset in its short form (BASE.USDC for
// BASE.USDC-0X8335...), or the protocol's short code (`b` for BTC.BTC), which the aggregator uses to
// fit the 80 bytes. With `minOut` (the "at least" amount shown, in the asset's units) a limit the memo sets must not be
// looser than it.
export const checkDepositMemo = (memo: string, { buyAsset, destination, shortCode, minOut }: { buyAsset: string; destination: string; shortCode?: string; minOut?: string }) => {
  if (utf8ToBin(memo).length > MAX_MEMO_BYTES) throw new DepositError('The swap memo is longer than THORChain reads')
  const [action, asset = '', dest = '', limitField = ''] = memo.split(':')
  if (!['=', 's', 'swap'].includes(action.toLowerCase())) throw new DepositError('The memo is not a swap')
  const want = buyAsset.toUpperCase()
  const got = asset.toUpperCase()
  const [chainSymbol] = want.split('-')
  const codes = [THORNODE_SHORT_CODES[want], shortCode?.toLowerCase()]
  if (got !== want && got !== chainSymbol && !codes.includes(asset)) throw new DepositError('The memo swaps to a different asset')
  if (!sameAddress(dest, destination)) throw new DepositError('The memo pays a different address')
  // THORChain's limit is in 1e8 units (`LIM` or `LIM/INTERVAL/QUANTITY`, `12e5` allowed); 0 or none sets no limit.
  // shortcut: a limit 0 is accepted as THORChain quotes it; 0.5% covers the shown figure's rounding.
  const limit = /^(\d+)(?:e(\d{1,2}))?$/i.exec(limitField.split('/')[0])
  if (minOut && limit) {
    const [whole, fraction = ''] = minOut.split('.')
    const shown = BigInt(whole + fraction.slice(0, 8).padEnd(8, '0'))
    const set = BigInt(limit[1]) * 10n ** BigInt(limit[2] ?? 0)
    if (set > 0n && set * 1000n < shown * 995n) throw new DepositError('The memo’s limit lets THORChain pay less than the minimum shown')
  }
}

// --- Deposit transaction ---------------------------------------------------------------------------

export interface DepositIntent {
  // Token-free outputs of the bound address, all spent.
  funding: { txid: string; vout: number; value: string }[]
  lockingBytecode: string
  vaultScript: string
  // THORChain's swap memo. Absent for a NEAR Intents deposit address, which needs none: no OP_RETURN output then.
  memo?: string
  // Satoshis to the vault; with `payAll` the vault gets everything but the fee and no change is made.
  amountSats?: bigint
  payAll?: boolean
  feeRate: bigint
}

export interface BuiltDeposit {
  unsignedHex: string
  sourceOutputs: ReturnType<typeof sourceOutputToRelay>[]
  ownIndexes: number[]
  amountSats: bigint
  minerFeeSats: bigint
  changeSats: bigint
}

const opReturn = (memo: string) => {
  const data = utf8ToBin(memo)
  return Uint8Array.from([0x6a, ...(data.length > 75 ? [0x4c, data.length] : [data.length]), ...data])
}

// Vault output first (THORChain reads the first output not paying the sender), then the memo, then
// change back to the bound address.
export const buildDeposit = (intent: DepositIntent): BuiltDeposit => {
  if (intent.funding.length === 0) throw new DepositError('No BCH to deposit')
  const own = hexToBin(intent.lockingBytecode)
  const vault = hexToBin(intent.vaultScript)
  const total = intent.funding.reduce((sum, f) => sum + BigInt(f.value), 0n)
  const inputs = intent.funding.map(f => ({
    outpointTransactionHash: hexToBin(normalizeTxid(f.txid)),
    outpointIndex: f.vout,
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array()
  }))
  const assemble = (amount: bigint, change: bigint) => ({
    version: 2,
    locktime: 0,
    inputs,
    outputs: [
      { lockingBytecode: vault, valueSatoshis: amount },
      ...(intent.memo ? [{ lockingBytecode: opReturn(intent.memo), valueSatoshis: 0n }] : []),
      ...(change > 0n ? [{ lockingBytecode: own, valueSatoshis: change }] : [])
    ]
  })
  const feeFor = (tx: ReturnType<typeof assemble>) => BigInt(encodeTransaction(tx).length + P2PKH_UNLOCK_BYTES * inputs.length) * intent.feeRate

  let amount: bigint
  let change = 0n
  let fee: bigint
  if (intent.payAll) {
    fee = feeFor(assemble(total, 0n))
    amount = total - fee
  } else {
    amount = intent.amountSats ?? 0n
    fee = feeFor(assemble(amount, 1n))
    change = total - amount - fee
    if (change < CHANGE_DUST) {
      // No change output: what is left over (dust) goes to the miner, if it pays the fee at all.
      if (total - amount < feeFor(assemble(amount, 0n))) throw new DepositError('The BCH does not cover the deposit and its fee')
      fee = total - amount
      change = 0n
    }
  }
  if (amount <= BCH_DUST_THRESHOLD) throw new DepositError('The deposit is below THORChain’s BCH minimum')
  if (fee < 0n || amount + fee + change !== total) throw new DepositError('The BCH does not cover the deposit and its fee')

  const tx = assemble(amount, change)
  return {
    unsignedHex: binToHex(encodeTransaction(tx)),
    sourceOutputs: tx.inputs.map((input, i) =>
      sourceOutputToRelay({ ...input, lockingBytecode: own, valueSatoshis: BigInt(intent.funding[i].value) })
    ),
    ownIndexes: tx.inputs.map((_, i) => i),
    amountSats: amount,
    minerFeeSats: total - amount - change,
    changeSats: change
  }
}

// Use the same transaction sizing for MAX, coin selection and the executable deposit.
export const maxBchDeposit = (funding: DepositIntent['funding'], lockingBytecode: string, vaultScript: string, feeRate: bigint) => {
  if (!funding.length) return 0n
  try {
    return buildDeposit({ funding, lockingBytecode, vaultScript, memo: 'x'.repeat(MAX_MEMO_BYTES), payAll: true, feeRate }).amountSats
  } catch (error) {
    if (error instanceof DepositError) return 0n
    throw error
  }
}

export const pickBchFunding = (funding: DepositIntent['funding'], amountSats: bigint, lockingBytecode: string, vaultScript: string, feeRate: bigint) => {
  if (amountSats <= BCH_DUST_THRESHOLD) throw new DepositError('The deposit is below THORChain’s BCH minimum')
  const chosen: DepositIntent['funding'] = []
  let total = 0n
  for (const coin of [...funding].sort((a, b) => BigInt(a.value) > BigInt(b.value) ? -1 : BigInt(a.value) < BigInt(b.value) ? 1 : 0)) {
    chosen.push(coin)
    total += BigInt(coin.value)
    if (total >= amountSats && maxBchDeposit(chosen, lockingBytecode, vaultScript, feeRate) >= amountSats) return chosen
  }
  throw new DepositError('The BCH wallet holds less BCH than this amount and its fee at the connected address')
}

// --- Payout on the EVM chain -----------------------------------------------------------------------

// keccak256("TransferOut(address,address,address,uint256,string)") of THORChain's router.
export const TRANSFER_OUT_TOPIC = '0xa9cd03aa3c1b4515114539cd53d22085129d495cb9e9f9af77864526240f1bf7'
// keccak256("TransferFailed(address,address,address,uint256,string)"). The router's _sendEth emits it when the recipient
// refuses native ETH (the ETH goes back to the vault), and transferOut still emits TransferOut after it.
export const TRANSFER_FAILED_TOPIC = '0xa6a370fa655359af5f69091e908830c250b8daffb80f6b578741423ae4c47ab1'

export interface RouterLog {
  address: string
  topics: string[]
  data: string
  transactionHash: string
  blockNumber: number
}

// The router's TransferOut paying `destination` for the deposit `depositTxid` (memo OUT:<txid>).
// Match the emitting router and asset too: another contract can emit an identical event.
export const matchPayout = (logs: RouterLog[], { destination, depositTxid, router, buyAsset }: { destination: string; depositTxid: string; router: string; buyAsset: string }) => {
  const recipient = `0x${'0'.repeat(24)}${destination.toLowerCase().replace(/^0x/, '')}`
  const memo = `OUT:${normalizeTxid(depositTxid)}`.toUpperCase()
  const expectedAsset = buyAsset.split('-')[1]?.toLowerCase() ?? `0x${'00'.repeat(20)}`
  const from = (log: RouterLog, topic: string) => log.address.toLowerCase() === router.toLowerCase() && log.topics[0]?.toLowerCase() === topic && log.topics[2]?.toLowerCase() === recipient
  const failed = new Set(logs.filter(log => from(log, TRANSFER_FAILED_TOPIC)).map(log => log.transactionHash.toLowerCase()))
  for (const log of logs) {
    if (!from(log, TRANSFER_OUT_TOPIC) || failed.has(log.transactionHash.toLowerCase())) continue
    try {
      const [asset, amount, text] = AbiCoder.defaultAbiCoder().decode(['address', 'uint256', 'string'], log.data)
      if (asset.toLowerCase() === expectedAsset && amount > 0n && text.toUpperCase() === memo)
        return { hash: log.transactionHash, amount: amount.toString(), asset: asset.toLowerCase() }
    } catch {
      // A malformed log is not ours.
    }
  }
  return undefined
}

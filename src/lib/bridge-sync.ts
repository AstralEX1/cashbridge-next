// Following a bridge operation from the chains: each step reads the source chain, the BCH address (Fulcrum) and the
// bridges' own status, and moves the saved operation on. No React here, so each step can be tested on its own.
import { binToHex } from '@bitauth/libauth'
import { Chain, EVMChain, EVMChains, getChainConfig } from '@tcswap/core'
import { BridgeConfig } from '@/config'
import { getMidgardActions, getTrack, getTxStatus, thorchainBchVaultScripts } from '@/lib/api'
import { orderRequest } from '@/lib/auto-bridge-client'
import type { PublicOrder } from '@/lib/auto-bridge-contract'
import {
  checkUnspent,
  findThorchainOutbound,
  getRawTransaction,
  getTransactionState,
  historyIncludes,
  verifyPayments,
  verifyThorchainOutbound
} from '@/lib/bch'
import { interpretMidgard, interpretTxStatus } from '@/lib/bridge'
import { recoverSecondSigning, sameSecondAttempt } from '@/lib/bridge-signing-recovery'
import { firstLegFromChain, type SourceReceipt } from '@/lib/bridge-tracking'
import { getProvider } from '@/lib/evm-rpc'
import { getNearStatus, interpretNearStatus, nudgeNearDeposit } from '@/lib/near-intents'
import { returnFromPage } from '@/lib/page-settle'
import { isEvmChain } from '@/lib/payout-chains'
import {
  broadcastRouterSend,
  confirmReportedPayout,
  depositReadyAt,
  destinationChainOf,
  findPayout,
  nearReverseOutcome,
  OPEN_REQUEST_MS,
  unsignedOutcome
} from '@/lib/reverse-bridge'
import { getTransferStatus } from '@/lib/transfer-status'
import { generateId } from '@/lib/utils'
import {
  type BridgeOperation,
  type BridgeRecord,
  isReverseOperation,
  type NearLeg,
  type useSetTransactionDetails,
  type useUpdateBridge
} from '@/store/transaction-store'

type Update = ReturnType<typeof useUpdateBridge>
type SetDetails = ReturnType<typeof useSetTransactionDetails>

// How long the payout is looked for in the router's logs alone before THORNode's report is also read.
const REPORTED_PAYOUT_AFTER_MS = 3 * 60_000

// --- Forward: another chain to BCH (and a token) -----------------------------------------------

// The source transaction's receipt on its own chain. EVM sources report their depth; the others
// only whether the transaction is in a block and succeeded, from their own nodes (transfer-status.ts).
const sourceReceipt = async (tx: BridgeRecord): Promise<SourceReceipt | undefined> => {
  if (!tx.hash) return undefined
  if (!EVMChains.includes(tx.assetFrom.chain as EVMChain)) {
    const status = await getTransferStatus(tx.assetFrom.chain as Chain, tx.hash)
    if (status === 'unsupported') return undefined
    return { confirmations: status === 'pending' ? 0 : 1, failed: status === 'failed' }
  }
  const provider = await getProvider(tx.assetFrom.chain as EVMChain)
  const receipt = await provider.getTransactionReceipt(tx.hash)
  if (!receipt) return { confirmations: 0, failed: false }
  const head = await provider.getBlockNumber()
  return { confirmations: Math.max(1, head - receipt.blockNumber + 1), failed: receipt.status === 0 }
}

// A NEAR Intents leg: 1Click's status names the BCH payout (there is no memo to find it by), and the chain decides
// whether that payout reached the bound address with at least the quoted minimum.
const syncNearFirstLeg = async (tx: BridgeRecord, near: NearLeg, update: Update) => {
  const op = tx.bridge
  const [source, status] = await Promise.all([sourceReceipt(tx).catch(() => undefined), getNearStatus(near.depositAddress).catch(() => undefined)])
  nudgeNearDeposit(status, near.depositAddress, tx.hash)
  const view = status && interpretNearStatus(status)
  const outbound =
    view?.kind === 'paid' ? await verifyPayments(view.txids, op.binding.lockingBytecode, BigInt(near.minAmountOut)).catch(() => undefined) : undefined
  const fromChain = firstLegFromChain(op, { source, outbound })
  const nearStatus = status?.status ?? near.status
  if (fromChain) return update(tx.uid, () => ({ ...fromChain, near: { ...near, status: nearStatus } }))
  if (!view) return
  if (outbound?.kind === 'invalid') return update(tx.uid, () => ({ error: outbound.reason, near: { ...near, status: nearStatus } }))
  if (view.kind === 'refunded')
    return update(tx.uid, current => ({
      stage: 'refunded',
      near: { ...near, status: nearStatus },
      refunds: [{ asset: tx.assetFrom.identifier, amount: view.amount ?? '0', pending: false }],
      firstLeg: { ...current.firstLeg, result: 'refunded' }
    }))
  const error = view.kind === 'failed' ? view.reason : view.kind === 'pending' ? view.detail : undefined
  if (nearStatus !== near.status || error !== op.error) update(tx.uid, () => ({ error, near: { ...near, status: nearStatus } }))
}

// The source transactions NEAR Intents has seen at a leg's deposit address: the deposit address is one-use, so
// these are this operation's own, and a lost wallet answer recovers from them.
export const nearDeposits = async (near: NearLeg) =>
  ((await getNearStatus(near.depositAddress)).swapDetails?.originChainTxHashes ?? []).map(t => t.hash).filter(Boolean)

const syncUnknownFirstLeg = async (tx: BridgeRecord, near: NearLeg, update: Update) => {
  const [hash] = await nearDeposits(near)
  if (hash) update(tx.uid, () => ({ stage: 'first_leg_pending', hash, error: undefined }))
}

const syncFirstLeg = async (tx: BridgeRecord, update: Update, setDetails: SetDetails) => {
  const op = tx.bridge
  if (!tx.hash) return
  if (op.near) return syncNearFirstLeg(tx, op.near, update)
  let timing: Partial<BridgeOperation['firstLeg']> = {}

  // The chains decide: the source receipt on its own chain, and the BCH at the bound address
  // (THORChain's OUT:<inbound hash> outbound, mempool included). THORChain's status below only
  // fills gaps (refunds, timing) and never holds a stage back.
  const [source, outbound] = await Promise.all([
    sourceReceipt(tx).catch(() => undefined),
    thorchainBchVaultScripts()
      .then(vaults => findThorchainOutbound(tx.hash!, op.binding.lockingBytecode, 'OUT', vaults))
      .catch(() => undefined)
  ])
  const fromChain = firstLegFromChain(op, { source, outbound })
  if (fromChain) update(tx.uid, () => fromChain)
  if (fromChain?.stage) return

  // The aggregator's tracker is the normal progress feed; its answer is shown, never trusted for receipt.
  getTrack({
    provider: tx.provider,
    hash: tx.hash,
    chainId: getChainConfig(tx.assetFrom.chain).chainId,
    fromAsset: tx.assetFrom.identifier,
    fromAddress: tx.addressFrom,
    fromAmount: tx.amountFrom,
    toAsset: tx.assetTo.identifier,
    toAddress: tx.addressTo,
    toAmount: tx.amountTo
  })
    .then(data => setDetails(tx.uid, data))
    .catch(() => null)

  const view = await getTxStatus(tx.hash)
    .then(status => {
      const stages = status.stages
      // Estimate the remaining outbound queue after swapping, without adding a BCH block wait.
      const seconds = stages?.swap_finalised?.completed && !stages.swap_status?.pending ? stages.outbound_delay?.remaining_delay_seconds : undefined
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
        timing = { readyAt: Date.now() + seconds * 1000, timingUpdatedAt: Date.now() }
      }
      return interpretTxStatus(status, op.binding.lockingBytecode)
    })
    .catch(async () => interpretMidgard(await getMidgardActions(tx.hash!).catch(() => [])))
  if (!view) return

  if (view.kind === 'invalid') return update(tx.uid, () => ({ error: view.reason }))
  if (view.kind === 'refunded')
    return update(tx.uid, current => ({ stage: 'refunded', refunds: view.refunds, firstLeg: { ...current.firstLeg, ...timing, result: 'refunded' } }))
  if (view.kind === 'pending')
    return update(tx.uid, current => ({ refunds: view.refunds, firstLeg: { ...current.firstLeg, ...timing, result: view.result }, error: undefined }))

  const received = []
  for (const out of view.outbound) {
    const check = await verifyThorchainOutbound({
      outTxid: out.txid,
      inboundHash: tx.hash,
      lockingBytecode: op.binding.lockingBytecode,
      expectedSats: BigInt(out.amountSats)
    })
    if (check.kind === 'not_found')
      return update(tx.uid, current => ({
        outbound: view.outbound,
        refunds: view.refunds,
        firstLeg: { ...current.firstLeg, ...timing, result: view.result }
      }))
    if (check.kind === 'invalid') return update(tx.uid, () => ({ outbound: view.outbound, error: check.reason }))
    received.push(...check.outputs)
  }

  // Deduplicate by outpoint: the same outbound is never counted twice.
  const unique = [...new Map(received.map(o => [`${o.txid}:${o.vout}`, o])).values()]
  const ready = unique.every(o => (op.destinationAsset === 'BCH' || o.unspent) && o.confirmations >= BridgeConfig.minConfirmations)
  const nativeStage = view.result === 'refund_pending' ? 'first_leg_pending' : 'kept_bch'
  update(tx.uid, current => ({
    stage: ready ? (op.destinationAsset === 'BCH' ? nativeStage : 'bch_ready') : 'bch_unconfirmed',
    outbound: view.outbound,
    refunds: view.refunds,
    received: unique,
    firstLeg: { ...current.firstLeg, ...timing, result: view.result },
    error: undefined
  }))
}

const syncReceived = async (tx: BridgeRecord, update: Update) => {
  const op = tx.bridge
  const recovery = await recoverSecondSigning(op)
  if (recovery) return update(tx.uid, current => (sameSecondAttempt(current, op) ? recovery : {}))
  if (!op.received?.length) return
  const checked = await checkUnspent(op.binding.lockingBytecode, op.received)
  if (op.destinationAsset === 'BCH') {
    const ready = checked.every(o => o.confirmations >= BridgeConfig.minConfirmations)
    const nativeStage = op.firstLeg.result === 'refund_pending' ? 'first_leg_pending' : 'kept_bch'
    return update(tx.uid, current => (sameSecondAttempt(current, op) ? { stage: ready ? nativeStage : 'bch_unconfirmed', received: checked } : {}))
  }
  const allUnspent = checked.every(o => o.unspent)
  // Outputs spent by something other than this app's second leg: the user moved their BCH. Before the swap is offered a
  // missing output may only lag at the server: it counts as spent once it was seen unspent, or its transaction is mined.
  const gone = checked.find(o => !o.unspent)
  const spent =
    !!gone &&
    (op.stage === 'bch_ready' ||
      checked.some((o, i) => !o.unspent && op.received![i]?.unspent) ||
      (await getTransactionState(gone.txid).then(state => state.seen && state.confirmations > 0)))
  if (spent) {
    return update(tx.uid, current =>
      sameSecondAttempt(current, op)
        ? { stage: 'kept_bch', received: checked, error: 'The received BCH was spent from your wallet outside this app' }
        : {}
    )
  }
  const ready = allUnspent && checked.every(o => o.confirmations >= BridgeConfig.minConfirmations)
  update(tx.uid, current => (sameSecondAttempt(current, op) ? { stage: ready ? 'bch_ready' : 'bch_unconfirmed', received: checked } : {}))
}

const syncSecondLeg = async (tx: BridgeRecord, update: Update) => {
  const op = tx.bridge
  if (!op.secondLeg?.txid || op.priorSecondLegs?.length) {
    const recovery = await recoverSecondSigning(op)
    if (recovery) return update(tx.uid, current => (sameSecondAttempt(current, op) ? recovery : {}))
  }
  const leg = op.secondLeg
  if (!leg?.txid) return
  const state = await getTransactionState(leg.txid)
  // 0-conf: once the network holds the swap (mempool or block) the operation is complete.
  if (state.seen) {
    return update(tx.uid, () => ({
      stage: 'completed',
      secondLeg: { ...leg, confirmations: state.confirmations, error: undefined }
    }))
  }
  // Not seen by that server, yet the funding is spent: if the address's history holds any swap this
  // operation signed, that is the spender (a server can lag on the txid), so the swap is done. Only a
  // genuinely foreign spender means the token swap did not happen.
  const checked = await checkUnspent(op.binding.lockingBytecode, op.received ?? [])
  if (checked.some(o => !o.unspent)) {
    const ours = await historyIncludes(op.binding.lockingBytecode, [leg.txid, ...(op.priorSwapTxids ?? [])])
    if (ours.length > 0)
      return update(tx.uid, () => ({ stage: 'completed', secondLeg: { ...leg, txid: ours[0], confirmations: 0, error: undefined } }))
    update(tx.uid, () => ({ stage: 'failed', error: 'The BCH was spent by a different transaction; the token swap did not happen' }))
  }
}

// --- Back from BCH ------------------------------------------------------------------------------

// BCH a transaction pays to the bound address, read from the chain.
const bchPaidTo = async (txid: string, lockingBytecode: string) => {
  const raw = await getRawTransaction(txid)
  if (!raw) throw new Error('The BCH server does not have this transaction yet')
  return raw.tx.outputs
    .filter(o => !o.token && binToHex(o.lockingBytecode) === lockingBytecode)
    .reduce((sum, o) => sum + o.valueSatoshis, 0n)
    .toString()
}

// Coins still at the sale contract after its refund time go back to the user's wallet through `expire`, which needs no
// key. True when the page sent them.
const returnSale = async (tx: BridgeRecord, order: PublicOrder, update: Update) => {
  if (!(await returnFromPage(order, undefined))) return false
  update(tx.uid, () => ({
    stage: 'failed',
    error: 'The Cashbridge Router did not finish in time, so this page sent the coins at its contract back to your wallet'
  }))
  return true
}

// A transfer the Cashbridge Router runs: the user's send to the order's sale contract (sent again while the chain has
// not seen it), then the Router's sale and THORChain deposit read from the order. The payout is then found on the
// destination chain like any deposit's. True when the operation needs nothing more from syncReverse this time.
const syncRouterOrder = async (tx: BridgeRecord, update: Update) => {
  const op = tx.bridge
  const reverse = op.reverse!
  const router = reverse.router!
  const before = ['first_leg_pending', 'first_leg_unknown'].includes(op.stage)
  const requestEnded = Date.now() - (reverse.signing?.sentAt ?? 0) > OPEN_REQUEST_MS
  if (router.sendTxid && router.signedHex && before && !(await getTransactionState(router.sendTxid)).seen)
    await broadcastRouterSend(tx.uid, router.signedHex, router.sendTxid, update)
  let order: PublicOrder
  try {
    order = await orderRequest({ id: router.id, capability: router.capability }, 'GET')
  } catch (error) {
    // A stopped Router cannot strand the coins: past the refund time the page sends them back from the saved terms.
    if (router.order && (await returnSale(tx, router.order, update))) return true
    throw error
  }
  if (order.depositAddress !== router.depositAddress) throw new Error('The Cashbridge Router order changed its address')
  if (await returnSale(tx, order, update)) return true
  const accepted = (kind: 'swap' | 'deposit' | 'refund') => order.attempts.find(a => a.kind === kind && a.status === 'accepted')
  const [sold, deposited, returned] = [accepted('swap'), accepted('deposit'), accepted('refund')]
  if (before) {
    if (deposited && order.sale) {
      update(tx.uid, current => ({
        stage: 'second_leg_pending',
        error: undefined,
        reverse: {
          ...current.reverse!,
          sale: { ...current.reverse!.sale!, txid: sold?.txid },
          deposit: {
            attempt: generateId(),
            amountSats: deposited.pusdOut,
            minerFeeSats: '0',
            memo: order.sale!.memo,
            inboundAddress: order.sale!.vaultAddress,
            router: router.payoutRouter,
            startBlock: router.startBlock,
            expectedOut: tx.amountTo,
            txid: deposited.txid,
            signedAt: Date.now()
          }
        }
      }))
    } else if (order.state === 'refunded' || (!router.sendTxid && order.receivedSats === '0' && !order.attempts.length && requestEnded)) {
      // Given back before any deposit (or never sent: the page went away mid-signing and the contract got nothing while
      // the wallet could still answer).
      update(tx.uid, () => ({
        stage: 'failed',
        error: router.sendTxid ? 'The Cashbridge Router sent the coins back to your wallet' : 'Nothing was signed, so nothing was sent'
      }))
    } else if (order.state === 'manual_review') {
      update(tx.uid, () => ({ error: 'The Cashbridge Router stopped this order for a manual check' }))
    }
    return true
  }
  // THORChain refunded to the contract and the Router gave the BCH back (a refund to the memo's address is found as usual).
  if (op.stage === 'second_leg_pending' && order.state === 'refunded' && returned) {
    const amountSats = await bchPaidTo(returned.txid, op.binding.lockingBytecode)
    update(tx.uid, current => ({ stage: 'refunded', reverse: { ...current.reverse!, refund: { txid: returned.txid, amountSats } } }))
    return true
  }
  return false
}

// Progress from the chains: the BCH transactions on Fulcrum, the payout as the router's TransferOut
// event on an EVM chain's RPC or the outbound on another chain's own node, a refund as THORChain's REFUND:<deposit> payment at the bound address.
export const syncReverse = async (tx: BridgeRecord, update: Update) => {
  const op = tx.bridge
  const reverse = op.reverse
  if (!reverse) return
  if (reverse.router && (await syncRouterOrder(tx, update))) return
  if (
    op.stage !== 'second_leg_signing' &&
    ['bch_ready', 'first_leg_unknown', 'second_leg_signed', 'second_leg_unknown', 'second_leg_pending'].includes(op.stage) &&
    (reverse.deposit?.signing || reverse.priorDeposits?.length || (op.stage === 'second_leg_unknown' && !reverse.deposit?.txid))
  ) {
    const recovery = await recoverSecondSigning(op)
    if (recovery) {
      update(tx.uid, current => (sameSecondAttempt(current, op) ? recovery : {}))
      if (recovery.stage !== 'second_leg_pending') return
      // Continue payout tracking on the next poll with the recovered deposit's metadata.
      if (!reverse.deposit?.txid || reverse.deposit.txid !== recovery.reverse?.deposit?.txid) return
    }
  }
  const sale = reverse.sale
  const deposit = reverse.deposit
  switch (op.stage) {
    case 'first_leg_unknown': {
      if (!sale?.txid) {
        const outcome = await unsignedOutcome(op)
        return outcome && update(tx.uid, () => outcome)
      }
      const state = await getTransactionState(sale.txid)
      if (state.seen) update(tx.uid, () => ({ stage: 'bch_ready', error: undefined }))
      return
    }
    case 'first_leg_pending': {
      if (sale?.txid && (await getTransactionState(sale.txid)).seen) update(tx.uid, () => ({ stage: 'bch_ready', error: undefined }))
      return
    }
    case 'bch_ready': {
      const outputs = sale?.outputs ?? []
      if (!outputs.length) return
      const checked = await checkUnspent(op.binding.lockingBytecode, outputs)
      if (checked.every(o => o.unspent)) return
      // Spent by one of this operation's deposits (a lost broadcast answer) is still ours.
      const ours = await historyIncludes(op.binding.lockingBytecode, reverse.priorDepositTxids ?? [])
      if (ours.length === 0)
        update(tx.uid, current =>
          sameSecondAttempt(current, op) ? { stage: 'kept_bch', error: 'The BCH from the swap was spent outside this app' } : {}
        )
      return
    }
    case 'second_leg_signed':
    case 'second_leg_unknown': {
      if (deposit?.txid && (await getTransactionState(deposit.txid)).seen) update(tx.uid, () => ({ stage: 'second_leg_pending', error: undefined }))
      return
    }
    case 'second_leg_pending': {
      if (!deposit?.txid) return
      if (op.near) {
        const outcome = await nearReverseOutcome(op)
        if (!outcome) return op.error && update(tx.uid, () => ({ error: undefined }))
        if ('payout' in outcome)
          return update(tx.uid, current => ({ stage: 'completed', error: undefined, reverse: { ...current.reverse!, payout: outcome.payout } }))
        if ('error' in outcome) return outcome.error !== op.error && update(tx.uid, () => ({ error: outcome.error }))
        return update(tx.uid, current => ({
          stage: 'refunded',
          error: undefined,
          reverse: { ...current.reverse!, refund: { amountSats: outcome.refundSats ?? current.reverse!.deposit!.amountSats } }
        }))
      }
      const [found, refund, readyAt] = await Promise.all([
        findPayout(op).catch(() => undefined),
        thorchainBchVaultScripts()
          .then(vaults => findThorchainOutbound(deposit.txid!, op.binding.lockingBytecode, 'REFUND', vaults))
          .catch(() => undefined),
        getTxStatus(deposit.txid)
          .then(status => depositReadyAt(status))
          .catch(() => undefined)
      ])
      // On an EVM chain THORChain's own report fills the gap after a while; elsewhere it names the
      // outbound from the start. Either way the payout is checked on the destination chain.
      const reportedNow = !isEvmChain(destinationChainOf(reverse.buyAsset)) || Date.now() - (deposit.signedAt ?? 0) > REPORTED_PAYOUT_AFTER_MS
      const reported = !found?.payout && reportedNow ? await confirmReportedPayout(op).catch(() => undefined) : undefined
      if (reported) return update(tx.uid, current => ({ stage: 'completed', reverse: { ...current.reverse!, payout: reported } }))
      if (found?.payout) {
        return update(tx.uid, current => ({
          stage: 'completed',
          reverse: { ...current.reverse!, payout: found.payout, deposit: { ...current.reverse!.deposit!, scannedBlock: found.scannedBlock } }
        }))
      }
      if (refund?.kind === 'ok') {
        return update(tx.uid, current => ({
          stage: 'refunded',
          reverse: { ...current.reverse!, refund: { txid: refund.outputs[0].txid, amountSats: refund.total } }
        }))
      }
      const scannedBlock = found?.scannedBlock ?? deposit.scannedBlock
      if (scannedBlock !== deposit.scannedBlock || (readyAt !== undefined && readyAt !== deposit.readyAt)) {
        update(tx.uid, current => ({
          reverse: {
            ...current.reverse!,
            deposit: { ...current.reverse!.deposit!, scannedBlock, readyAt: readyAt ?? current.reverse!.deposit!.readyAt }
          }
        }))
      }
      return
    }
  }
}

// One pass over an operation at its current step.
export const syncBridge = async (tx: BridgeRecord, update: Update, setDetails: SetDetails) => {
  if (isReverseOperation(tx.bridge)) return syncReverse(tx, update)
  switch (tx.bridge.stage) {
    case 'first_leg_unknown':
      if (tx.bridge.near) await syncUnknownFirstLeg(tx, tx.bridge.near, update)
      break
    case 'first_leg_pending':
      await syncFirstLeg(tx, update, setDetails)
      break
    case 'bch_unconfirmed':
    case 'bch_ready':
      await syncReceived(tx, update)
      break
    case 'second_leg_signed':
    case 'second_leg_unknown':
    case 'second_leg_pending':
      await syncSecondLeg(tx, update)
      break
  }
}

import { ProviderName } from '@tcswap/helpers'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import { Asset } from '@/components/swap/asset'
import { type BchBinding, isValidBinding, type VerifiedOutput } from '@/lib/bch'
import { type CauldronToken, isCauldronToken, PUSD_TOKEN } from '@/lib/cauldron-tokens'
import type { Signable } from '@/lib/bch-signing'
import type { PublicOrder } from '@/lib/auto-bridge-contract'

// 'broadcast': a send history cannot confirm on its chain - known to be submitted, nothing more.
export type TxStatus = 'not_started' | 'pending' | 'swapping' | 'completed' | 'failed' | 'expired' | 'refunded' | 'unknown' | 'broadcast'

interface BaseTransaction {
  uid: string
  chainId: string
  hash?: string
  timestamp: Date
  estimatedTime?: number
  assetFrom: Asset
  assetTo: Asset
  amountFrom: string
  amountTo: string
  addressFrom?: string
  addressTo: string
  addressDeposit?: string
  status: TxStatus
  details?: any
  qrCodeData?: string
  // A memo/tag the deposit must carry (a provider's deposit tag), shown with the QR code.
  depositMemo?: string
  expiration?: number
  // The provider's own id for the swap, when it tracks by one instead of by hash (Houdini order id).
  providerSwapId?: string
}

export interface SwapTransaction extends BaseTransaction {
  kind?: undefined
  provider: ProviderName
  // Set on a bridge operation (either direction); the record's `status` is then the
  // operation's overall status (bridgeTxStatus), never the first leg's alone.
  bridge?: BridgeOperation
  // Free pairs settle only after source success and a chain-verified payout meeting this floor.
  // `shapeshift`: a deposit-address swap tracked by ShapeShift's quote id instead of a THORChain memo.
  // `near`: a NEAR Intents one-use deposit address, tracked by 1Click's status of it.
  networkSwap?: {
    minOutput: string
    memo?: string
    shapeshift?: { quoteId: string; depositAddress: string }
    near?: { depositAddress: string }
    payout?: { hash: string; amount: string }
  }
}

// --- Bridge operation (two legs) -----------------------------------------------------------------

// Where an operation is. Only public data is kept: addresses, amounts, hashes, outpoints.
export type BridgeStage =
  // Intent saved and the source wallet opened; no transaction hash yet.
  | 'first_leg_signing'
  // The page closed or the wallet errored before a hash came back: the source swap may or may
  // not have been sent. Never resubmitted automatically.
  | 'first_leg_unknown'
  // Source transaction sent; THORChain swapping / scheduling the BCH outbound.
  | 'first_leg_pending'
  // BCH outbound seen paying the bound address, waiting for confirmations.
  | 'bch_unconfirmed'
  // Verified, confirmed, unspent BCH outputs: the second leg may be quoted and authorized.
  | 'bch_ready'
  // The exact second-step authorization is saved before the wallet is opened.
  | 'second_leg_signing'
  // A second-leg transaction was signed (its txid is saved before broadcast).
  | 'second_leg_signed'
  // Broadcast outcome unknown; reconciled by txid before anything else happens.
  | 'second_leg_unknown'
  | 'second_leg_pending'
  // Terminal states.
  | 'completed'
  | 'kept_bch'
  | 'refunded'
  | 'failed'

export type FirstLegResult = 'pending' | 'swapped' | 'partial' | 'refund_pending' | 'refunded'

export interface BridgeRefund {
  asset: string
  amount: string
  txid?: string
  pending: boolean
}

export interface BridgeSigningRequest extends Signable {
  sentAt: number
}

export interface SecondLeg {
  // Fresh id per authorization, so a stale tab cannot act on a newer attempt.
  attempt: string
  category: string
  sellSats: string
  // Token base units: the approved floor and what the signed trade pays.
  minOutput: string
  tokenOut?: string
  // Operations saved before any token could be bought kept the PUSD amount here.
  pusdOut?: string
  routerFeeSats: string
  minerFeeSats: string
  txid?: string
  // The signed transaction is public once broadcast, and re-sending the same bytes is the only
  // safe retry: it cannot spend the outputs twice.
  signedHex?: string
  confirmations?: number
  error?: string
  signing?: BridgeSigningRequest
}

// A reverse operation: (token -> BCH on Cauldron, step 1) then a BCH deposit to THORChain paying an
// EVM address (step 2). Its stages reuse the forward names: first_leg_* is the Cauldron sale,
// bch_ready the deposit ready to sign, second_leg_* the deposit, completed the payout seen on the
// EVM chain, refunded THORChain's BCH refund seen at the bound address, kept_bch the user stopping
// after step 1.
export interface ReverseSale {
  attempt: string
  sellTokens: string
  // Satoshis: the approved floor and what the signed trade pays out of the pools.
  minOutput: string
  bchOut: string
  minerFeeSats: string
  txid?: string
  signedHex?: string
  // The sale's token-free outputs to the bound address: the BCH the deposit spends.
  outputs?: { txid: string; vout: number; value: string }[]
}

export interface ReverseDeposit {
  attempt: string
  // Satoshis paid to THORChain's vault, and the deposit's own miner fee.
  amountSats: string
  minerFeeSats: string
  memo: string
  inboundAddress: string
  // The THORChain router on the destination chain, whose TransferOut event is the payout.
  router?: string
  // The destination chain's block height when the deposit was signed: the payout is searched from it.
  startBlock?: number
  // How far the payout search has looked, so a poll resumes there.
  scannedBlock?: number
  signedAt?: number
  // When the quote behind it lapses (ms): THORChain says not to send after it, and NEAR refunds a late deposit.
  expiresAt?: number
  // When THORNode's countdown expects the payout (display only).
  readyAt?: number
  expectedOut?: string
  txid?: string
  signedHex?: string
  error?: string
  signing?: BridgeSigningRequest
  near?: NearLeg
}

export interface ReverseDetails {
  // The THORChain buy asset and the EVM address it pays.
  buyAsset: string
  destination: string
  sale?: ReverseSale
  deposit?: ReverseDeposit
  // The payout transaction on the destination chain, and its amount in the buy asset's base units.
  payout?: { hash: string; amount?: string }
  // A NEAR Intents refund carries no txid: 1Click's status reports the amount only.
  refund?: { txid?: string; amountSats: string }
  // Deposit txids signed earlier for this operation (a rejected broadcast is re-quoted and re-signed).
  priorDepositTxids?: string[]
  // Expired or rejected authorizations remain recoverable if their wallet later broadcasts them.
  priorDeposits?: ReverseDeposit[]
  // Set when the Cashbridge Router runs the sale and the deposit: its order (id and capability), the signed send of
  // the tokens to the order's contract, and what the payout search needs. `order` keeps the contract's terms, so the
  // page can send the coins back itself after the refund time if the Router stops.
  router?: { id: string; capability: string; depositAddress: string; sendTxid?: string; signedHex?: string; payoutRouter?: string; startBlock?: number; order?: PublicOrder }
  // The bound wallet's own inputs of the first transaction, and when it went to the wallet: an answer that never came
  // back is settled by whether they get spent.
  signing?: { inputs: { txid: string; vout: number }[]; sentAt: number }
  // Set when NEAR Intents carries the BCH out instead of THORChain (chosen on the form), directly or through a
  // ShapeShift quote; the deposit's quote is then the operation's `near`.
  route?: 'near' | 'shapeshift'
}

// A leg carried by NEAR Intents instead of THORChain: the one-use deposit address its status is read by, and the
// signed quote 1Click asks integrators to keep. Amounts are base units of the asset each side names.
export interface NearLeg {
  depositAddress: string
  correlationId: string
  signature: string
  quotedAt: string
  deadline?: string
  amountIn: string
  amountOut: string
  minAmountOut: string
  status?: string
  // ShapeShift quoted this NEAR Intents deposit address; its quote id finds the swap on ShapeShift.
  shapeshiftQuoteId?: string
}

export interface BridgeOperation {
  id: string
  // Set when NEAR Intents carries the bridge leg; THORChain otherwise.
  near?: NearLeg
  stage: BridgeStage
  // Absent on older (forward) operations.
  direction?: 'forward' | 'reverse'
  // The BCH side: 'BCH' is native BCH; anything else is a Cauldron token (`token`, or PUSD on
  // operations saved before other tokens were possible, which wrote 'PUSD').
  destinationAsset?: 'BCH' | 'PUSD' | 'TOKEN'
  token?: CauldronToken
  reverse?: ReverseDetails
  binding: BchBinding
  walletName?: string
  // Indicative BCH (sats) from the first-leg quote; never used as receipt evidence.
  quotedBchSats?: string
  // sourceConfirmations: the source transaction's depth on its own chain; receivedAt: when the BCH
  // was first seen at the bound address (mempool included).
  firstLeg: {
    result: FirstLegResult
    trackerStatus?: string
    readyAt?: number
    timingUpdatedAt?: number
    sourceConfirmations?: number
    receivedAt?: number
  }
  outbound?: { txid: string; amountSats: string }[]
  refunds?: BridgeRefund[]
  received?: VerifiedOutput[]
  secondLeg?: SecondLeg
  // Txids of earlier second-leg signatures (a rejected broadcast is re-quoted and re-signed): a spend
  // of the received BCH by any of them is still this operation's swap.
  priorSwapTxids?: string[]
  priorSecondLegs?: SecondLeg[]
  error?: string
  updatedAt: number
}

// The Cauldron token of an operation's BCH side, or undefined for native BCH.
export const operationToken = (op: Pick<BridgeOperation, 'destinationAsset' | 'token'>): CauldronToken | undefined =>
  op.destinationAsset === 'BCH' ? undefined : op.token && isCauldronToken(op.token) ? op.token : PUSD_TOKEN
export const isReverseOperation = (op: Pick<BridgeOperation, 'direction'>) => op.direction === 'reverse'

const TERMINAL_STAGES: BridgeStage[] = ['completed', 'kept_bch', 'refunded', 'failed']
export const isBridgeTerminal = (op: BridgeOperation) => TERMINAL_STAGES.includes(op.stage)
// Only the network is left: the reverse deposit is out, the Cashbridge Router has the coins, or THORChain is paying
// plain BCH. Nothing more to sign and no wallet needed, so a new operation may start while this one runs on.
export const isBridgeWaiting = (op: BridgeOperation) =>
  isReverseOperation(op)
    ? op.stage === 'second_leg_pending' || (op.stage === 'first_leg_pending' && !!op.reverse?.router?.sendTxid)
    : op.destinationAsset === 'BCH' && (op.stage === 'first_leg_pending' || op.stage === 'bch_unconfirmed')

export const bridgeTxStatus = (op: BridgeOperation): TxStatus => {
  switch (op.stage) {
    case 'completed':
    case 'kept_bch':
      return 'completed'
    case 'refunded':
      return 'refunded'
    case 'failed':
      return 'failed'
    case 'first_leg_unknown':
    case 'second_leg_unknown':
      return 'unknown'
    case 'first_leg_signing':
    case 'second_leg_signing':
      return 'not_started'
    case 'first_leg_pending':
      return 'swapping'
    default:
      return 'pending'
  }
}

// A plain transfer from the Send dialog, confirmed against its own chain (src/lib/transfer-status.ts).
export interface SendTransaction extends BaseTransaction {
  kind: 'send'
  provider?: undefined
}

export type Transaction = SwapTransaction | SendTransaction

interface TransactionStore {
  transactions: Transaction[]
  setTransaction: (tx: Transaction) => void
  setTransactionDetails: (uid: string, data: any) => void
  setTransactionStatus: (uid: string, status: TxStatus) => void
  // Drops a record that never became a transaction (the wallet declined to sign it).
  removeTransaction: (uid: string) => void
  updateBridge: (uid: string, update: (op: BridgeOperation, tx: SwapTransaction) => Partial<BridgeOperation> & Partial<Pick<SwapTransaction, 'hash' | 'addressFrom'>>) => void
}

const sanitizeBridge = (op: BridgeOperation, pageLoad: boolean): BridgeOperation => {
  if (!op || typeof op !== 'object') return { stage: 'failed', error: 'Unreadable saved operation' } as BridgeOperation
  if (!isValidBinding(op.binding)) return { ...op, stage: isBridgeTerminal(op) ? op.stage : 'failed', error: 'Saved BCH address failed validation' }
  // Mid-signing when the page went away: the source wallet may have sent it. Only the page's first read can tell: a
  // later one (a check before a send, another tab's write) finds a wallet request that is still open.
  if (pageLoad && op.stage === 'first_leg_signing') return { ...op, stage: 'first_leg_unknown' }
  if (pageLoad && op.stage === 'second_leg_signing') return { ...op, stage: 'second_leg_unknown' }
  // A completed operation carries no error (an older version could leave a stale one behind).
  if (op.stage === 'completed' && op.error) return { ...op, error: undefined }
  return op
}

// Set by the first read of saved operations, when the page opens.
let restored = false

export const transactionStore = create<TransactionStore>()(
  persist(
    set => ({
      transactions: [],

      setTransaction: transaction => {
        set(state => {
          const exists = state.transactions.find(d => d.uid === transaction.uid)
          if (exists) return state

          return {
            transactions: [...state.transactions, transaction],
            showPendingAlert: true
          }
        })
      },

      setTransactionDetails: (uid, data: any) => {
        set(state => {
          return {
            transactions: state.transactions.map(item => {
              if (item.uid !== uid) {
                return item
              }

              // A bridge operation keeps the tracker's answer as first-leg detail only: the
              // tracker's `completed` and planned amounts say nothing about the BCH actually received.
              if (item.kind !== 'send' && item.bridge) {
                const total = data.transient?.estimatedTimeToComplete
                const observation = data.transient?.estimates?.outboundObservation
                // The second leg can use BCH before its outbound block confirmation. This is
                // display-only timing; receipt and spendability are verified independently.
                const timing =
                  typeof total === 'number' && Number.isFinite(total) &&
                  typeof observation === 'number' && Number.isFinite(observation) &&
                  observation >= 0 && total >= observation
                    ? { readyAt: Date.now() + (total - observation) * 1000, timingUpdatedAt: Date.now() }
                    : {}
                return {
                  ...item,
                  details: data,
                  bridge: { ...item.bridge, firstLeg: { ...item.bridge.firstLeg, ...timing, trackerStatus: data.status } }
                }
              }

              const tx = {
                ...item,
                status: data.status,
                hash: data.hash,
                addressFrom: data.fromAddress,
                details: data
              }

              if (data.status === 'completed') {
                tx.amountFrom = data.fromAmount
                tx.amountTo = data.toAmount
              }

              return tx
            })
          }
        })
      },

      updateBridge: (uid, update) => {
        set(state => ({
          transactions: state.transactions.map(item => {
            if (item.uid !== uid || item.kind === 'send' || !item.bridge) return item
            const { hash, addressFrom, ...patch } = update(item.bridge, item)
            const bridge = { ...item.bridge, ...patch, updatedAt: Date.now() }
            // Completion clears any earlier error: it is the final word on the operation.
            if (bridge.stage === 'completed') bridge.error = undefined
            return { ...item, ...(hash && { hash }), ...(addressFrom && { addressFrom }), bridge, status: bridgeTxStatus(bridge) }
          })
        }))
      },

      removeTransaction: uid => {
        set(state => ({ transactions: state.transactions.filter(item => item.uid !== uid) }))
      },

      setTransactionStatus: (uid, status) => {
        set(state => {
          return {
            transactions: state.transactions.map(item => {
              if (item.uid !== uid) {
                return item
              }
              // A bridge operation's status follows its stage (updateBridge).
              if (item.kind !== 'send' && item.bridge) return item

              return {
                ...item,
                status: status
              }
            })
          }
        })
      }
    }),
    {
      name: 'tc-transactions',
      version: 1,
      // Restored bridge operations are rechecked before use: a corrupted or edited record cannot
      // name another address, and a page closed mid-signing is never treated as "not sent".
      merge: (persisted, current) => {
        const pageLoad = !restored
        restored = true
        // This tab's own open wallet requests: another tab's first read may have marked them unknown.
        const signing = new Map(current.transactions.filter(tx => tx.kind !== 'send' && tx.bridge?.stage.endsWith('_signing')).map(tx => [tx.uid, tx]))
        const transactions = ((persisted as Partial<TransactionStore>)?.transactions ?? []).map(tx => {
          if (tx.kind === 'send' || !tx.bridge) return tx
          const own = signing.get(tx.uid)
          if (own && tx.bridge.stage?.endsWith('_unknown')) return own
          const bridge = sanitizeBridge(tx.bridge, pageLoad)
          return { ...tx, bridge, status: bridgeTxStatus(bridge) }
        })
        return { ...current, transactions }
      }
    }
  )
)

export const useSetTransaction = () => transactionStore(state => state.setTransaction)
export const useSetTransactionDetails = () => transactionStore(state => state.setTransactionDetails)
export const useSetTransactionStatus = () => transactionStore(state => state.setTransactionStatus)
export const useUpdateBridge = () => transactionStore(state => state.updateBridge)

export type BridgeRecord = SwapTransaction & { bridge: BridgeOperation }
// The persisted operation as every tab sees it right now (another tab may have moved it on).
export const freshOperation = async (uid: string) => {
  await transactionStore.persist.rehydrate()
  const tx = transactionStore.getState().transactions.find(t => t.uid === uid)
  return tx && tx.kind !== 'send' && tx.bridge ? (tx as BridgeRecord) : undefined
}
const isUnfinishedBridge = (tx: Transaction): tx is BridgeRecord => tx.kind !== 'send' && !!tx.bridge && !isBridgeTerminal(tx.bridge)
// One operation at a time per browser needs the user: the newest unfinished one that is not just
// waiting on the network. Waiting ones run on in the background (isBridgeWaiting).
export const activeBridge = (state: TransactionStore) => state.transactions.find((tx): tx is BridgeRecord => isUnfinishedBridge(tx) && !isBridgeWaiting(tx.bridge))
// Every unfinished operation, the active one and those waiting in the background.
export const unfinishedBridges = (state: TransactionStore) => state.transactions.filter(isUnfinishedBridge)
export const getActiveBridge = () => activeBridge(transactionStore.getState())
export const useTransaction = (uid?: string) => transactionStore(state => (uid ? state.transactions.find(tx => tx.uid === uid) : undefined))

export const isTxPending = (status: string) => status === 'not_started' || status === 'swapping' || status === 'pending'
export const isTxTerminal = (status: string) => status === 'completed' || status === 'failed' || status === 'expired' || status === 'refunded'
// The tracker has seen the deposit into a channel: it has a hash, or the swap moved past waiting.
const DEPOSIT_SEEN_STATUSES: TxStatus[] = ['pending', 'swapping', 'completed', 'failed', 'refunded']
export const hasDepositArrived = (tx: Transaction) => !!tx.hash || DEPOSIT_SEEN_STATUSES.includes(tx.status)

// Sends never get tracker details, so they are only polled while pending.
const isTxSyncable = (tx: Transaction) => isTxPending(tx.status) || (tx.kind !== 'send' && !tx.details && !isTxTerminal(tx.status))
const isBridgeTx = (tx: Transaction) => tx.kind !== 'send' && !!tx.bridge

// Bridge operations are tracked by useBridgeTracker, not the generic tracker poll.
export const useSyncablePlainTransactions = () => transactionStore(useShallow(state => state.transactions.filter(tx => isTxSyncable(tx) && !isBridgeTx(tx))))

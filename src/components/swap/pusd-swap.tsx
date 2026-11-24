'use client'

import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { Chain } from '@tcswap/core'
import { explorerTxUrl } from '@/lib/explorer'
import { ArrowRight, Check, ChevronDown, Clock, Coins, ExternalLink, LoaderCircle, ScanSearch, X } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { AssetIcon } from '@/components/asset-icon'
import { BchMark, TokenMark } from '@/components/swap/bridge-marks'
import { BridgeCompletion, type BridgeCompletionProps } from '@/components/swap/bridge-completion'
import { type FlowToast, FlowToasts } from '@/components/swap/flow-toasts'
import { WalletAddressBadge } from '@/components/swap/bridge-wallet-badge'
import { useBchWallet } from '@/components/bch-wallet'
import { useSyncTransactions } from '@/hooks/use-sync-transactions'
import { GenericButton } from '@/components/generic-button'
import { BridgeHero } from '@/components/bridge-hero/bridge-hero'
import { bridgeHeroEligible } from '@/components/bridge-hero/game'
import { SwapError } from '@/components/swap/swap-error'
import { useQuote } from '@/hooks/use-quote'
import { useRates } from '@/hooks/use-rates'
import { getTxStatus } from '@/lib/api'
import { checkUnspent, getTransactionState } from '@/lib/bch'
import { nearExplorerUrl } from '@/lib/near-intents'
import { sourceTransactionId } from '@/lib/source-transaction'
import { formatStepTime, stepTime } from '@/lib/bridge-tracking'
import { bridgeCompletionTransactions } from '@/lib/bridge-completion'
import { hasSecondAuthorization, OPEN_SECOND_REQUEST_NOTE, recoverSecondSigning, rememberAttempt, sameSecondAttempt, signingDefinitelyStopped, signingRequest } from '@/lib/bridge-signing-recovery'
import {
  formatBaseUnits,
  inboundMatchesBinding,
  minOutputFor,
  secondLegSellAmount,
  toBaseUnits
} from '@/lib/bridge'
import {
  BroadcastRejected,
  BroadcastUnknown,
  broadcastBchTransaction,
  CauldronError,
  prepareTokenTrade,
  quoteToken,
  type ReviewedSwap
} from '@/lib/cauldron'
import { type CauldronToken, PUSD_TOKEN } from '@/lib/cauldron-tokens'
import { generateId } from '@/lib/utils'
import { bridgeName, formatAmount, formatMinutes, formatUsd, PUSD_LEG_SECONDS, timeOf, usdText } from '@/lib/bridge-summary'
import { isDollarStable } from '@/lib/dollar-stable'
import { useSwapStore } from '@/store/swap-store'
import {
  type BridgeOperation,
  type BridgeStage,
  freshOperation,
  type SecondLeg,
  type SwapTransaction,
  transactionStore,
  useSetTransactionDetails,
  useTransaction,
  isBridgeTerminal,
  isBridgeWaiting,
  isReverseOperation,
  operationToken,
  useUpdateBridge
} from '@/store/transaction-store'
import { useUnfinishedBridges } from '@/hooks/use-bridges'

type BridgeTx = SwapTransaction & { bridge: BridgeOperation }

const BCH_DECIMALS = 8
const formatBch = (sats: bigint | string) => formatBaseUnits(sats, BCH_DECIMALS)
const formatToken = (units: bigint | string, token: Pick<CauldronToken, 'decimals'>) => formatBaseUnits(units, token.decimals)
const tokenAmount = (units: bigint | string, token: Pick<CauldronToken, 'decimals'>) => Number(units) / 10 ** token.decimals

// A reviewed second-leg transaction is signed only while this fresh; after that it is rebuilt.
const REVIEW_TTL_MS = 60_000
// The chains are polled often: a BCH outbound shows up in the mempool within seconds.
const POLL_MS = 8_000

import { withLock } from '@/lib/bridge-first-leg'
import { ReverseOperationPanel, SignHint, type SignPhase } from '@/components/swap/reverse-bridge'
import { nearDeposits, syncBridge } from '@/lib/bridge-sync'
import { signingNoteKey, signInWallet } from '@/lib/bch-signing'

// --- Combined estimate -------------------------------------------------------------------------

// The Cauldron quote for the BCH a first leg is expected to deliver (`expectedBuyAmount`, in BCH):
// the indicative amount of the token it would buy now. Nothing is reserved: the second leg is quoted
// again on the BCH actually received, and the user may keep the BCH instead. `token` overrides the
// form's choice (a running operation has its own); null is native BCH, which needs no quote.
export const useTokenQuoteFor = (expectedBuyAmount?: string, token?: CauldronToken | null) => {
  const formToken = useSwapStore(state => state.bchToken)
  const target = token === undefined ? formToken : token
  const bchSats = useMemo(() => {
    if (!expectedBuyAmount) return undefined
    try {
      return toBaseUnits(expectedBuyAmount, BCH_DECIMALS)
    } catch {
      return undefined
    }
  }, [expectedBuyAmount])
  const sellSats = bchSats === undefined ? undefined : secondLegSellAmount(bchSats)

  const query = useQuery({
    queryKey: ['token-estimate', target?.category, sellSats?.toString()],
    queryFn: () => quoteToken({ category: target!.category, side: 'buy', amount: sellSats! }),
    enabled: !!target && !!sellSats && sellSats > 0n,
    retry: false,
    staleTime: 20_000
  })

  return { token: target, bchSats, sellSats, output: query.data?.output, quote: query.data, isLoading: query.isLoading, error: query.error as Error | null }
}

export const useTokenEstimate = () => {
  const { quote } = useQuote()
  return useTokenQuoteFor(quote?.expectedBuyAmount)
}

// --- BCH wallet --------------------------------------------------------------------------------

// A silent wallet app matters only when the wallet is needed: a stored session resumes without it
// and the saved address stands in, so the form does not warn about it. The stored session stays
// until the user picks a new QR.
const BchStalledNotice = ({ className }: { className?: string }) => {
  const t = useTranslations('bridge')
  const { walletName, pairAgain } = useBchWallet()
  return (
    <p className={className}>
      {t('wallet.reconnectStalled', { name: walletName ?? t('wallet.yourWallet') })}{' '}
      <button type="button" className="cursor-pointer underline" onClick={pairAgain}>
        {t('wallet.pairAgain')}
      </button>
    </p>
  )
}

export const BchWalletStatus = () => {
  const t = useTranslations('bridge')
  const { mismatch, error, binding, reconnectStalled } = useBchWallet()
  const stalled = reconnectStalled && !binding
  if (!mismatch && !error && !stalled) return null
  return (
    <div className="bridge-wallet">
      {mismatch && <SwapError error={new Error(t('wallet.mismatch'))} />}
      {error && <SwapError error={new Error(error)} />}
      {stalled && <BchStalledNotice />}
    </div>
  )
}

// --- First leg ---------------------------------------------------------------------------------

export { BridgeBlocked, FirstLegRejected, startBridgeFirstLeg } from '@/lib/bridge-first-leg'

// Mounted once in the layout: follows every unfinished operation (one waiting on the network runs on
// while another starts) and keeps tabs in step.
export const BridgeTracker = () => {
  const operations = useUnfinishedBridges()
  // Plain swaps and sends too, on every page: no list has to be open for them to be followed.
  useSyncTransactions()

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'tc-transactions') transactionStore.persist.rehydrate()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return operations.map(tx => <BridgeSync key={tx.uid} tx={tx} />)
}

const BridgeSync = ({ tx }: { tx: BridgeTx }) => {
  const update = useUpdateBridge()
  const setDetails = useSetTransactionDetails()

  useQuery({
    queryKey: ['bridge-sync', tx.uid, tx.bridge.stage],
    queryFn: async () => {
      await syncBridge(tx, update, setDetails)
      return Date.now()
    },
    refetchInterval: POLL_MS,
    // Keeps following while the user is in the wallet app or another tab.
    refetchIntervalInBackground: true,
    retry: false
  })

  return null
}

// --- Operation panel ---------------------------------------------------------------------------

// The stages after the first leg's BCH reached the wallet, up to the token swap's end.
const BCH_DELIVERED: BridgeStage[] = ['bch_ready', 'second_leg_signing', 'second_leg_signed', 'second_leg_unknown', 'second_leg_pending', 'completed']
const firstLegDone = (op: BridgeOperation) => BCH_DELIVERED.includes(op.stage) || op.stage === 'kept_bch' || (isBridgeTerminal(op) && !!op.received?.length)


export interface FlowToken {
  amount: string
  ticker: string
  usd?: string
  icon: ReactNode
}

export interface FlowBar {
  // The step's transaction, opened by clicking the bar.
  href?: string
  // 0..1 of the bar filled; `live` adds the moving shimmer, `done` the check.
  fill: number
  // Time left, or time elapsed once past the estimate.
  eta?: string
  live?: boolean
  done?: boolean
}

export type { FlowToast }

export type FlowStage = 'bridging' | 'ready' | 'swapping' | 'plain' | 'done' | 'ended'

export interface BridgeFlowProps {
  stage: FlowStage
  // Read by screen readers as the dialog title.
  title: string
  // The other chain's wallet; the BCH wallet sits right of it, or left in the reverse direction.
  sourceChain: Chain
  sourceAddress?: string
  bchAddress: string
  reverse?: boolean
  // What is sent, the middle asset (BCH forward; BCH, or the payout for plain BCH, in reverse) and
  // the final asset of a two-step operation.
  sent: FlowToken
  bch: FlowToken
  final?: FlowToken
  // Bars of step 1 and step 2 (step 1 alone for a one-transaction operation).
  firstBar: FlowBar
  secondBar?: FlowBar
  details?: ReactNode
  actions?: ReactNode
  waitGame?: ReactNode
  completion?: Omit<BridgeCompletionProps, 'onClose'>
  toasts: FlowToast[]
  onDismissToast: (id: string) => void
  // Keep sonner toasts when this flow unmounts (BackgroundBridgeToasts / BackgroundAutomaticToasts keep them).
  persistToasts?: boolean
  onClose: () => void
  // Set once nothing more is asked of the user: leaves this operation running and opens a fresh form.
  onBridgeAnother?: () => void
  // Plays the bridge-collapse animation; off once it has been shown for this operation.
  animateCollapse?: boolean
}

// A bar with `href` opens its step's transaction (in an explorer) in a new tab.
const ProgressBar = ({ label, bar }: { label: string; bar: FlowBar }) => {
  const t = useTranslations('bridge.progress')
  const meter = (
    <div
      className="bridge-flow-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(bar.fill * 100)}
    >
      <i className={`bridge-flow-fill${bar.live ? ' is-live' : ''}`} style={{ transform: `translateX(${Math.round(bar.fill * 100) - 100}%)` }} />
      <span>
        {label}
        {bar.done ? (
          <Check size={16} strokeWidth={3} aria-label={t('stepDone')} />
        ) : bar.eta !== undefined ? (
          <span className="bridge-flow-eta">
            <Clock size={14} aria-hidden="true" />
            {bar.eta}
          </span>
        ) : null}
        {bar.href && <ExternalLink size={14} className="bridge-flow-bar-link" aria-hidden="true" />}
      </span>
    </div>
  )
  return bar.href ? (
    <a className="bridge-flow-bar-anchor" href={bar.href} target="_blank" rel="noopener noreferrer" title={t('openStepTx')}>
      {meter}
    </a>
  ) : (
    meter
  )
}

// `children` as a link to a transaction (new tab) when `href` is known, else as a plain block.
export const TxLink = ({ href, className, label, title, children }: { href?: string; className: string; label: string; title?: string; children: ReactNode }) =>
  href ? (
    <a className={`${className} is-link`} href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={title}>
      {children}
    </a>
  ) : (
    <div className={className} role="img" aria-label={label}>
      {children}
    </div>
  )

// Where a step's transaction is shown: a THORChain swap (inbound hash) on THORChain's explorer, which
// follows it through to the payout; anything else on its own chain's explorer.
export const thorchainTxUrl = (hash: string) => `https://thorchain.net/tx/${encodeURIComponent(sourceTransactionId(hash) ?? hash.trim())}`
export const chainTxUrl = (chain: Chain, hash: string) => explorerTxUrl({ chain, txHash: hash })

const FlowAmount = ({ token }: { token: FlowToken }) => (
  <div className="bridge-flow-token">
    <div>
      {token.icon}
      <strong title={token.amount}>{token.amount}</strong>
    </div>
    <span>
      {token.ticker}
      {token.usd ? ` · ${token.usd}` : ''}
    </span>
  </div>
)

const FlowArrow = ({ live }: { live: boolean }) => (
  <ArrowRight className={`bridge-flow-arrow${live ? ' is-live' : ''}`} size={26} strokeWidth={2.4} aria-hidden="true" />
)

const Spinner = () => (
  <svg className="bridge-flow-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="#3a4f59" />
    <path d="M12 3a9 9 0 019 9" stroke="#0ac18e" />
  </svg>
)

export const WaitingButton = ({ children }: { children: ReactNode }) => (
  <button type="button" className="bridge-flow-primary" disabled>
    <Spinner />
    {children}
  </button>
)

const COLLAPSE_SEEN_KEY = 'bridge-flow-collapse-seen'

// Whether this operation's bridge-collapse animation still has to play. Remounts (a reload, a hot
// update, reopening the screen) show the collapsed state at once instead of replaying it.
export const useCollapseOnce = (uid: string | undefined, collapsed: boolean) => {
  const [seen] = useState(() => {
    try {
      return uid ? (JSON.parse(sessionStorage.getItem(COLLAPSE_SEEN_KEY) ?? '[]') as string[]).includes(uid) : false
    } catch {
      return false
    }
  })
  useEffect(() => {
    if (!uid || !collapsed || seen) return
    try {
      const list = JSON.parse(sessionStorage.getItem(COLLAPSE_SEEN_KEY) ?? '[]') as string[]
      sessionStorage.setItem(COLLAPSE_SEEN_KEY, JSON.stringify([...list.filter(id => id !== uid), uid].slice(-20)))
    } catch {
      // Storage unavailable: the animation may replay, nothing else changes.
    }
  }, [uid, collapsed, seen])
  return !seen
}

// Pending transactions stay in corner toasts; the finished operation has its own receipt.
export const BridgeFlow = (props: BridgeFlowProps) => {
  const t = useTranslations('bridge.progress')
  const { stage, final, reverse } = props
  if (stage === 'done' && props.completion) return <BridgeCompletion {...props.completion} onClose={props.onClose} />
  const collapsed = !!final && (stage === 'ready' || stage === 'swapping' || stage === 'done')
  // Forward: Bridge (1/2) then Swap (2/2). Reverse: the Cauldron swap first, then the bridge.
  const firstLabel = t(reverse ? 'swapFirstStep' : 'bridgeStep')
  const secondLabel = t(reverse ? 'bridgeSecondStep' : 'swapStep')
  const otherWallet = props.sourceAddress ? (
    <WalletAddressBadge address={props.sourceAddress} chain={props.sourceChain} label={t(reverse ? 'destinationWallet' : 'sourceWallet')} showChainIcon />
  ) : (
    <span />
  )
  const bchWallet = <WalletAddressBadge address={props.bchAddress} chain={Chain.BitcoinCash} label={t('bchWallet')} showChainIcon />
  return (
    <div className="bridge-flow">
      <div className="bridge-flow-corner">
        {/* This wallet's transfers, in the scanner. */}
        <a className="bridge-flow-corner-btn" href={`/scanner?address=${encodeURIComponent(props.bchAddress)}`} target="_blank" rel="noopener noreferrer">
          <ScanSearch size={16} aria-hidden="true" />
          {t('scanner')}
        </a>
        <button type="button" className="bridge-flow-corner-btn is-icon" aria-label={t('close')} onClick={props.onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="bridge-flow-main">
        <div className="bridge-flow-card">
          <div className="bridge-flow-wallets">
            {reverse ? bchWallet : otherWallet}
            {reverse ? otherWallet : bchWallet}
          </div>

          {collapsed ? (
            <div className="bridge-flow-ready" data-stage={stage} data-animate={props.animateCollapse === false ? 'false' : undefined}>
              {/* The finished first step, opening its transaction like its bar did. */}
              <TxLink
                href={props.firstBar.href}
                className="bridge-flow-tile"
                label={t(reverse ? 'swapDone' : 'bridgeDone', { from: props.sent.ticker })}
                title={t('openStepTx')}
              >
                <div className="bridge-flow-tile-inner">
                  <span className="bridge-flow-tile-icons">
                    {props.sent.icon}
                    <ArrowRight size={14} strokeWidth={2.6} aria-hidden="true" />
                    {props.bch.icon}
                  </span>
                  <span>{t(reverse ? 'swap' : 'bridge')}</span>
                  <span className="bridge-flow-check">
                    <Check size={14} strokeWidth={3} aria-hidden="true" />
                  </span>
                  {props.firstBar.href && <ExternalLink size={12} className="bridge-flow-bar-link" aria-hidden="true" />}
                </div>
              </TxLink>
              <div className="bridge-flow-ready-body">
                <div className="bridge-flow-tokens is-compact bridge-flow-slide">
                  <FlowAmount token={props.bch} />
                  <FlowArrow live={stage !== 'done'} />
                  <FlowAmount token={final} />
                </div>
                {props.secondBar && (
                  <div className="bridge-flow-slide">
                    <ProgressBar label={secondLabel} bar={props.secondBar} />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className={`bridge-flow-tokens${final ? ' is-compact' : ''}`}>
                <FlowAmount token={props.sent} />
                <FlowArrow live={stage === 'bridging' || stage === 'plain'} />
                <FlowAmount token={props.bch} />
                {final && (
                  <>
                    <FlowArrow live={false} />
                    <FlowAmount token={final} />
                  </>
                )}
              </div>
              {final ? (
                <div className="bridge-flow-bars">
                  <ProgressBar label={firstLabel} bar={props.firstBar} />
                  {props.secondBar && <ProgressBar label={secondLabel} bar={props.secondBar} />}
                </div>
              ) : (
                <ProgressBar label={t('bridge')} bar={props.firstBar} />
              )}
            </>
          )}

          {props.details}
        </div>
        {(props.actions || props.onBridgeAnother) && (
          <div className="bridge-flow-actions">
            {props.actions}
            {props.onBridgeAnother && (
              <GenericButton className="bridge-flow-primary is-active w-full" onClick={props.onBridgeAnother}>
                {t('bridgeAnother')}
              </GenericButton>
            )}
          </div>
        )}
        {props.waitGame}
      </div>

      <FlowToasts toasts={props.toasts} onDismiss={props.onDismissToast} persist={props.persistToasts} />
    </div>
  )
}

// The Cauldron quote for the swap-ready stage: the trade on the live pools for the BCH received.
export interface CauldronQuoteView {
  ticker: string
  // BCH per one token unit, and that token unit in USD.
  bchPerToken: number
  tokenUsd?: number
  lpFeePercent: number
  lpFeeUsd?: number
  networkFeeBch: number
  networkFeeUsd?: number
  priceImpactPercent: number
  minimum: string
}

export const CauldronQuoteBlock = ({ quote }: { quote: CauldronQuoteView }) => {
  const t = useTranslations('bridge.progress')
  const [open, setOpen] = useState(true)
  const totalFee = quote.lpFeeUsd !== undefined && quote.networkFeeUsd !== undefined ? quote.lpFeeUsd + quote.networkFeeUsd : undefined
  return (
    <section className="bridge-confirm-details bridge-flow-quote">
      <button type="button" className="bridge-confirm-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="bridge-confirm-rate">
          {t('quoteRate', { ticker: quote.ticker, bch: formatAmount(quote.bchPerToken) })}
          {quote.tokenUsd !== undefined && <span className="bridge-flow-muted"> ({formatUsd(quote.tokenUsd)})</span>}
        </span>
        {totalFee !== undefined && (
          <span className="bridge-confirm-chip bridge-flow-fee">
            <Coins size={16} aria-hidden="true" />
            <span className="sr-only">{t('totalFee')}</span>
            {formatUsd(totalFee)}
          </span>
        )}
        <ChevronDown size={18} className="bridge-confirm-chevron" aria-hidden="true" />
      </button>
      {open && (
        <dl className="bridge-confirm-rows">
          <div>
            <dt>{t('lpFee', { percent: `${quote.lpFeePercent.toFixed(1)}%` })}</dt>
            <dd>{usdText(quote.lpFeeUsd) ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('platformFee', { percent: '0.0%' })}</dt>
            <dd>$0</dd>
          </div>
          <div>
            <dt>{t('networkFee')}</dt>
            <dd>
              {formatAmount(quote.networkFeeBch)} BCH{quote.networkFeeUsd !== undefined ? ` (${formatUsd(quote.networkFeeUsd)})` : ''}
            </dd>
          </div>
          <div>
            <dt>{t('priceImpact')}</dt>
            <dd>{quote.priceImpactPercent.toFixed(2)}%</dd>
          </div>
          <div>
            <dt>{t('minimum')}</dt>
            <dd>{quote.minimum}</dd>
          </div>
        </dl>
      )}
    </section>
  )
}

// Figures of a Cauldron buy (BCH for the token, minOutput in token units) for display. The pools' fee is in BCH.
const cauldronQuoteView = (
  leg: { sell: bigint; output: bigint; spotOutput: number; tradeFeeSats: bigint; minerFeeSats?: bigint; minOutput: bigint },
  token: Pick<CauldronToken, 'ticker' | 'decimals'>,
  bchUsd?: number
): CauldronQuoteView | undefined => {
  if (leg.output <= 0n || leg.sell <= 0n) return undefined
  const bch = Number(leg.sell) / 1e8
  const tokens = tokenAmount(leg.output, token)
  const fee = Number(leg.tradeFeeSats) / 1e8
  const miner = leg.minerFeeSats === undefined ? 0 : Number(leg.minerFeeSats) / 1e8
  const bchPerToken = bch / tokens
  // The trade's own output against what the same sale buys at spot after the fee.
  const afterFee = (leg.spotOutput / 10 ** token.decimals) * (1 - fee / bch)
  return {
    ticker: token.ticker,
    bchPerToken,
    tokenUsd: isDollarStable(token.ticker) ? 1 : bchUsd ? bchPerToken * bchUsd : undefined,
    lpFeePercent: (fee / bch) * 100,
    lpFeeUsd: bchUsd ? fee * bchUsd : undefined,
    networkFeeBch: miner,
    networkFeeUsd: bchUsd ? miner * bchUsd : undefined,
    priceImpactPercent: afterFee > 0 ? Math.max(0, (1 - tokens / afterFee) * 100) : 0,
    minimum: `${formatToken(leg.minOutput, token)} ${token.ticker}`
  }
}

// The progress screen of the operation `uid`, in its own direction.
// Operations left running with Bridge another, one row each under the form; a row reopens its progress.
export const BackgroundBridges = ({ onOpen, openUid }: { onOpen: (uid: string) => void; openUid?: string }) => {
  const t = useTranslations('bridge')
  const tAuto = useTranslations('automatic')
  const unfinished = useUnfinishedBridges()
  const waiting = unfinished.filter(tx => isBridgeWaiting(tx.bridge))
  return (
    <>
      {/* Status/tx toasts stay on /bridge after the tracking dialog closes. */}
      <BackgroundBridgeToasts openUid={openUid} />
      {waiting.length > 0 && (
        <section className="bridge-auto-orders" aria-label={t('progress.inFlight')}>
          {waiting.map(tx => {
            const state = t(isReverseOperation(tx.bridge) ? `reverse.history.${tx.bridge.stage}` : `stage.${tx.bridge.stage}`)
            const token = !isReverseOperation(tx.bridge) ? operationToken(tx.bridge) : undefined
            return (
              <button key={tx.uid} type="button" className="bridge-auto-card" onClick={() => onOpen(tx.uid)} aria-label={`${tAuto('viewTransfer')}: ${state}`}>
                <span className="bridge-auto-side">
                  <span className="bridge-flow-icon">
                    <AssetIcon asset={tx.assetFrom} showNetworkIcons={false} />
                  </span>
                  <span>
                    <strong>
                      {formatAmount(Number(tx.amountFrom))} {tx.assetFrom.ticker}
                    </strong>
                  </span>
                </span>
                <span className="bridge-auto-state">
                  <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
                  <small>{state}</small>
                </span>
                <span className="bridge-auto-side is-end">
                  <span>
                    <strong>
                      {formatAmount(Number(tx.amountTo))} {token?.ticker ?? tx.assetTo.ticker}
                    </strong>
                  </span>
                  {token ? (
                    <TokenMark token={token} size={34} />
                  ) : (
                    <span className="bridge-flow-icon">
                      <AssetIcon asset={tx.assetTo} showNetworkIcons={false} />
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </section>
      )}
    </>
  )
}

// Corner toasts for in-flight manual bridges — owned here so closing the tracking dialog does not wipe them.
function BackgroundBridgeToasts({ openUid }: { openUid?: string }) {
  const t = useTranslations('bridge')
  const unfinished = useUnfinishedBridges().filter(tx => !isBridgeTerminal(tx.bridge) && tx.uid !== openUid)
  const [dismissed, setDismissed] = useState<string[]>([])
  const toasts: FlowToast[] = unfinished.flatMap(tx => {
    const op = tx.bridge
    const token = operationToken(op)
    const items: FlowToast[] = []
    if (isReverseOperation(op) && op.reverse) {
      const reverse = op.reverse
      if (reverse.sale?.txid) {
        items.push({
          id: `sale:${reverse.sale.txid}`,
          title: t('reverse.toastSwap', { ticker: token?.ticker ?? '' }),
          hash: reverse.sale.txid,
          chain: Chain.BitcoinCash,
          icon: token ? <TokenMark token={token} size={30} /> : <BchMark size={30} />,
          pending: ['first_leg_signing', 'first_leg_pending', 'first_leg_unknown'].includes(op.stage)
        })
      }
      if (reverse.deposit?.txid) {
        items.push({
          id: `deposit:${reverse.deposit.txid}`,
          title: t('reverse.toastDeposit', { bridge: bridgeName({ near: !!op.near, shapeshift: !!op.near?.shapeshiftQuoteId }) }),
          hash: reverse.deposit.txid,
          chain: Chain.BitcoinCash,
          icon: <BchMark size={30} />,
          pending: !reverse.payout && !reverse.refund
        })
      }
      if (reverse.payout) {
        items.push({
          id: `payout:${reverse.payout.hash}`,
          title: t('reverse.toastPayout', { ticker: tx.assetTo.ticker }),
          hash: reverse.payout.hash,
          chain: tx.assetTo.chain,
          icon: (
            <span className="bridge-flow-icon">
              <AssetIcon asset={tx.assetTo} showNetworkIcons={false} />
            </span>
          )
        })
      }
      if (reverse.refund?.txid) {
        items.push({
          id: `refund:${reverse.refund.txid}`,
          title: t('reverse.toastRefund'),
          hash: reverse.refund.txid,
          chain: Chain.BitcoinCash,
          icon: <BchMark size={30} />
        })
      }
    } else {
      const firstDone =
firstLegDone(op)
      const sendConfirmed = (op.firstLeg.sourceConfirmations ?? 0) > 0 || firstDone
      if (tx.hash) {
        items.push({
          id: `send:${tx.hash}`,
          title: sendConfirmed ? t('progress.toastSendConfirmed') : t('progress.toastSent'),
          hash: tx.hash,
          chain: tx.assetFrom.chain,
          icon: (
            <span className="bridge-flow-icon">
              <AssetIcon asset={tx.assetFrom} showNetworkIcons={false} />
            </span>
          ),
          pending: !sendConfirmed
        })
      }
      for (const hash of [...new Set((op.received ?? []).map(output => output.txid))]) {
        items.push({ id: `receive:${hash}`, title: t('progress.toastReceived'), hash, chain: Chain.BitcoinCash, icon: <BchMark size={30} /> })
      }
      if (op.secondLeg?.txid) {
        items.push({
          id: `swap:${op.secondLeg.txid}`,
          title: t(op.stage === 'completed' ? 'progress.toastPusdReceived' : 'progress.toastSwapSent', {
            ticker: token?.ticker ?? '',
            confirmations: op.secondLeg.confirmations ?? 0
          }),
          hash: op.secondLeg.txid,
          chain: Chain.BitcoinCash,
          icon: token ? <TokenMark token={token} size={30} /> : <BchMark size={30} />,
          pending: op.stage !== 'completed'
        })
      }
    }
    if (!items.length) {
      items.push({
        id: `manual:${tx.uid}:status`,
        title: `${tx.assetFrom.ticker} → ${tx.assetTo.ticker}`,
        description: t(isReverseOperation(op) ? `reverse.history.${op.stage}` : `stage.${op.stage}`),
        icon: (
          <span className="bridge-flow-icon">
            <AssetIcon asset={tx.assetFrom} showNetworkIcons={false} />
          </span>
        ),
        pending: true
      })
    }
    return items
  }).filter(item => !dismissed.includes(item.id))

  return <FlowToasts toasts={toasts} onDismiss={id => setDismissed(list => [...list, id])} />
}

export const BridgeOperationPanel = ({ uid, onClose }: { uid?: string; onClose: () => void }) => {
  const tx = useTransaction(uid)
  const reverse = !!tx && tx.kind !== 'send' && !!tx.bridge && isReverseOperation(tx.bridge)
  return reverse ? <ReverseOperationPanel uid={uid} onClose={onClose} /> : <ForwardOperationPanel uid={uid} onClose={onClose} />
}

const ForwardOperationPanel = ({ uid, onClose }: { uid?: string; onClose: () => void }) => {
  const t = useTranslations('bridge')
  const tx = useTransaction(uid)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!uid) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [uid])

  const bridgeTx = tx && tx.kind !== 'send' && tx.bridge ? (tx as BridgeTx) : undefined
  const op = bridgeTx?.bridge
  const token = op ? operationToken(op) : undefined
  const hasToken = !!token
  const receivedSats = (op?.received ?? []).reduce((sum, o) => sum + BigInt(o.value), 0n)
  const bchSats = receivedSats > 0n ? receivedSats : op?.quotedBchSats ? BigInt(op.quotedBchSats) : undefined
  const pusdEstimate = useTokenQuoteFor(token && bchSats !== undefined && !op?.secondLeg ? formatBch(bchSats) : undefined, token ?? null)
  const { rates } = useRates(bridgeTx ? [bridgeTx.assetFrom.identifier, 'BCH.BCH'].sort() : [])
  const collapsedNow =
    !!op && hasToken && BCH_DELIVERED.includes(op.stage)
  const animateCollapse = useCollapseOnce(bridgeTx?.uid, collapsedNow)

  if (!bridgeTx || !op) return null
  const active = bridgeTx
  const terminal = isBridgeTerminal(op)
  const completed = op.stage === 'completed' || (op.stage === 'kept_bch' && !!op.received?.length && !op.error)
  const firstDone = firstLegDone(op)
  const secondStarted = ['second_leg_signed', 'second_leg_unknown', 'second_leg_pending'].includes(op.stage)
  const ready = (op.stage === 'bch_ready' || op.stage === 'second_leg_signing') && hasToken
  const stage: FlowStage = completed
    ? 'done'
    : terminal
      ? 'ended'
      : ready
        ? 'ready'
        : secondStarted
          ? 'swapping'
          : hasToken
            ? 'bridging'
            : 'plain'

  // Bridge bar: time since the send against the quote's estimate, counting down, then elapsed.
  const start = new Date(active.timestamp).getTime()
  const estimate = active.estimatedTime ?? undefined
  const eta = (time: ReturnType<typeof stepTime>) => {
    const label = formatStepTime(time)
    return label.key === 'minutes'
      ? t('progress.minutes', { minutes: label.value })
      : label.key === 'seconds'
        ? t('progress.seconds', { seconds: label.value })
        : t('progress.elapsedTime', { time: label.value })
  }
  // Each bar opens its step's transaction: the THORChain swap (followed through to the BCH
  // outbound on THORChain's explorer), then the token swap on the BCH explorer.
  const bridgeHref = op.near ? nearExplorerUrl(op.near.depositAddress) : active.hash ? thorchainTxUrl(active.hash) : undefined
  const swapHref = op.secondLeg?.txid ? chainTxUrl(Chain.BitcoinCash, op.secondLeg.txid) : undefined
  const firstBar: FlowBar = firstDone
    ? { fill: 1, done: true, href: bridgeHref }
    : {
        fill: estimate ? Math.min(0.95, Math.max(0.05, (now - start) / (estimate * 1000))) : 0.5,
        eta: eta(stepTime(now, start, estimate)),
        live: !terminal && op.stage !== 'first_leg_unknown',
        href: bridgeHref
      }
  const secondBar: FlowBar | undefined = !hasToken
    ? undefined
    : op.stage === 'completed'
      ? { fill: 1, done: true, href: swapHref }
      : secondStarted
        ? { fill: 0.6, live: true, eta: eta(stepTime(now, op.updatedAt, PUSD_LEG_SECONDS)), href: swapHref }
        : { fill: 0, eta: t('progress.minutes', { minutes: formatMinutes(PUSD_LEG_SECONDS) }) }

  const rateOf = (id: string) => (rates[id] ? Number(rates[id].toSignificant(12)) : undefined)
  const sentUsd = rateOf(active.assetFrom.identifier)
  const bchUsd = rateOf('BCH.BCH')
  const bchAmount = bchSats === undefined ? undefined : Number(bchSats) / 1e8
  const leg = pusdEstimate.quote
  const pusdUnitUsd = token
    ? isDollarStable(token.ticker)
      ? 1
      : leg && bchUsd && leg.spotOutput > 0
        ? ((Number(leg.sell) / 1e8) * bchUsd) / tokenAmount(BigInt(Math.round(leg.spotOutput)), token)
        : undefined
    : undefined
  const signedOut = op.secondLeg?.tokenOut ?? op.secondLeg?.pusdOut
  const pusdUnits = signedOut !== undefined ? BigInt(signedOut) : leg?.output
  const pusdAmount = pusdUnits === undefined || !token ? undefined : tokenAmount(pusdUnits, token)

  const sent: FlowToken = {
    amount: active.amountFrom,
    ticker: active.assetFrom.ticker,
    usd: usdText(sentUsd === undefined ? undefined : Number(active.amountFrom) * sentUsd),
    icon: (
      <span className="bridge-flow-icon">
        <AssetIcon asset={active.assetFrom} showNetworkIcons={false} />
      </span>
    )
  }
  const bch: FlowToken = {
    amount: bchAmount === undefined ? '—' : `${receivedSats > 0n ? '' : '≈ '}${formatAmount(bchAmount, receivedSats > 0n ? 8 : 4)}`,
    ticker: 'BCH',
    usd: usdText(bchAmount !== undefined && bchUsd ? bchAmount * bchUsd : undefined),
    icon: <BchMark size={30} />
  }
  const pusdToken: FlowToken | undefined = token
    ? {
        amount: pusdAmount === undefined ? '—' : `${op.stage === 'completed' ? '' : '≈ '}${formatAmount(pusdAmount, 4)}`,
        ticker: token.ticker,
        usd: usdText(pusdAmount !== undefined && pusdUnitUsd ? pusdAmount * pusdUnitUsd : undefined),
        icon: <TokenMark token={token} size={30} />
      }
    : undefined

  const receivedTxids = [...new Set((op.received ?? []).map(output => output.txid))]
  const sendConfirmed = (op.firstLeg.sourceConfirmations ?? 0) > 0 || firstDone
  const toasts: FlowToast[] = [
    ...(active.hash
      ? [
          {
            id: `send:${active.hash}`,
            title: sendConfirmed ? t('progress.toastSendConfirmed') : t('progress.toastSent'),
            hash: active.hash,
            chain: active.assetFrom.chain,
            time: timeOf(start),
            icon: sent.icon,
            pending: !sendConfirmed
          }
        ]
      : []),
    ...receivedTxids.map(hash => ({ id: `receive:${hash}`, title: t('progress.toastReceived'), hash, chain: Chain.BitcoinCash, icon: bch.icon })),
    ...(op.secondLeg?.txid
      ? [
          {
            id: `swap:${op.secondLeg.txid}`,
            // Complete at 0-conf; the depth is only a detail.
            title: t(op.stage === 'completed' ? 'progress.toastPusdReceived' : 'progress.toastSwapSent', {
              ticker: token?.ticker ?? '',
              confirmations: op.secondLeg.confirmations ?? 0
            }),
            hash: op.secondLeg.txid,
            chain: Chain.BitcoinCash,
            icon: pusdToken?.icon,
            pending: op.stage !== 'completed'
          }
        ]
      : [])
  ]
    .filter(item => !dismissed.includes(item.id))
    .reverse()

  const common = {
    waitGame: <BridgeHero key={active.uid} eligible={bridgeHeroEligible(op)} chain={active.assetFrom.chain} />,
    sourceChain: active.assetFrom.chain,
    sourceAddress: active.addressFrom,
    bchAddress: op.binding.cashAddress,
    sent,
    bch,
    final: pusdToken,
    firstBar,
    secondBar,
    completion: {
      received: op.stage === 'completed' && token
        ? { amount: signedOut === undefined ? '—' : formatToken(signedOut, token), ticker: token.ticker, icon: <TokenMark token={token} size={48} /> }
        : { amount: formatBch(receivedSats), ticker: 'BCH', icon: <BchMark size={48} /> },
      transactions: bridgeCompletionTransactions(active),
      liquidityCategory: op.stage === 'completed' && token ? token.category : PUSD_TOKEN.category
    },
    toasts,
    onDismissToast: (id: string) => setDismissed(list => [...list, id]),
    // Leaving the dialog must not wipe live status/tx toasts; BackgroundBridgeToasts keeps them.
    persistToasts: !terminal,
    onClose,
    onBridgeAnother: isBridgeWaiting(op) ? onClose : undefined,
    animateCollapse
  }

  const ended = terminal && !completed
  const error = op.error && !completed && op.stage !== 'first_leg_unknown' ? <SwapError error={new Error(op.error)} /> : null
  const details = (
    <>
      {ended && <p className="bridge-flow-message">{t(`stage.${op.stage}`)}</p>}
      {error}
      {op.stage === 'first_leg_unknown' && <UnknownFirstLeg tx={active} />}
    </>
  )

  const actions =
    stage === 'swapping' ? (
      <SecondLegStatus tx={active} />
    ) : terminal ? (
      <GenericButton className="bridge-flow-primary is-active w-full" onClick={onClose}>
        {t(completed ? 'progress.newTransfer' : 'progress.done')}
      </GenericButton>
    ) : op.stage === 'first_leg_unknown' ? null : stage === 'bridging' ? (
      <WaitingButton>{t('progress.swapAction', { ticker: token?.ticker ?? '' })}</WaitingButton>
    ) : stage === 'plain' ? (
      <WaitingButton>{t('progress.bridgingAction')}</WaitingButton>
    ) : null

  const title = completed
    ? t('progress.completeTitle')
    : ended
      ? t('progress.finished')
      : ready
        ? t('progress.readyTitle')
        : secondStarted
          ? t('progress.swapping')
          : t('progress.processing')

  return (
    <Dialog
      open={!!uid}
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="bridge-flow-layer" showCloseButton={false}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          {token ? t('progress.firstDescription', { ticker: token.ticker }) : t('progress.nativeDescription')}
        </DialogDescription>
        {ready ? (
          <ReadyStage key={active.uid} tx={active} bchUsd={bchUsd} common={common} />
        ) : (
          <BridgeFlow stage={stage} title={title} {...common} details={details} actions={actions} />
        )}
      </DialogContent>
    </Dialog>
  )
}

type CommonFlowProps = Omit<BridgeFlowProps, 'stage' | 'title' | 'details' | 'actions'>

// BCH received, the token swap (2/2) ready to sign: the live Cauldron quote and the swap action.
const ReadyStage = ({ tx, bchUsd, common }: { tx: BridgeTx; bchUsd?: number; common: CommonFlowProps }) => {
  const t = useTranslations('bridge')
  const leg = useSecondLeg(tx)
  const token = leg.token
  const { reconnectStalled } = useBchWallet()
  // Shown from the live trade at once; the reviewed build's exact figures replace its amounts when ready, while the
  // live trade keeps the price impact and fees it carries (same query as the panel's, so no extra request).
  const live = useTokenQuoteFor(formatBch(leg.total), token)
  const figures = leg.reviewed
    ? live.quote && {
        ...live.quote,
        output: leg.reviewed.output,
        sell: leg.reviewed.sell,
        minerFeeSats: leg.reviewed.minerFeeSats,
        minOutput: leg.reviewed.minOutput
      }
    : live.quote && { ...live.quote, minOutput: minOutputFor(live.quote.output) }
  const quote = figures ? cauldronQuoteView(figures, token, bchUsd) : undefined
  const finalToken = common.final && {
    ...common.final,
    amount: figures ? `≈ ${formatAmount(tokenAmount(figures.output, token), 4)}` : common.final.amount
  }

  return (
    <BridgeFlow
      stage="ready"
      title={t('progress.readyTitle')}
      {...common}
      final={finalToken}
      details={
        <>
          {quote && <CauldronQuoteBlock quote={quote} />}
          {!leg.walletMatches &&
            (reconnectStalled ? (
              <BchStalledNotice className="bridge-flow-message" />
            ) : (
              !leg.walletAway && <p className="bridge-flow-message">{t('progress.reconnectBch')}</p>
            ))}
          {leg.error && <SwapError error={new Error(leg.error)} />}
        </>
      }
      actions={
        <>
          <GenericButton
            className="bridge-flow-primary is-active w-full"
            colorType="3"
            onClick={leg.sign}
            disabled={!leg.reviewed || !!leg.busy || !leg.walletMatches}
            aria-busy={!!leg.busy || leg.walletAway}
          >
            {(leg.busy || leg.walletAway) && <LoaderCircle size={18} className="animate-spin" />}
            {leg.phase === 'signing'
              ? t('reverse.waitingWallet', { wallet: leg.walletName })
              : leg.phase === 'sending'
                ? t('reverse.sending')
                : leg.walletAway
                  ? t('reverse.walletAway')
                  : t('progress.swapAction', { ticker: token.ticker })}
          </GenericButton>
          <SignHint dark phase={leg.phase} walletName={leg.walletName} note={leg.note} onCancel={leg.cancel} />
          {!leg.reviewed && !leg.busy && leg.error && (
            <button type="button" className="bridge-flow-link" onClick={leg.prepare}>
              {t('progress.retry')}
            </button>
          )}
          <button type="button" className="bridge-flow-link" onClick={leg.keep} disabled={!!leg.busy || !leg.canKeep}>
            {t('progress.keepBch')}
          </button>
        </>
      }
    />
  )
}

// The source wallet's answer was lost. The user either supplies the transaction hash (checked
// against THORNode and the bound address) or states nothing was sent; nothing is re-sent.
const UnknownFirstLeg = ({ tx }: { tx: BridgeTx }) => {
  const t = useTranslations('bridge')
  const update = useUpdateBridge()
  const [hash, setHash] = useState('')
  const [error, setError] = useState<string>()
  const [checking, setChecking] = useState(false)

  const resume = async () => {
    setError(undefined)
    const bare = sourceTransactionId(hash)
    if (!bare) return setError(t('unknown.badHash'))
    setChecking(true)
    try {
      if (tx.bridge.near) {
        const seen = await nearDeposits(tx.bridge.near)
        if (!seen.some(id => id.toLowerCase() === hash.trim().toLowerCase())) return setError(t('unknown.notOursNear', { bridge: bridgeName({ near: true, shapeshift: !!tx.bridge.near.shapeshiftQuoteId }) }))
      } else {
        const status = await getTxStatus(bare)
        if (!inboundMatchesBinding(status, tx.bridge.binding.lockingBytecode)) return setError(t('unknown.notOurs'))
      }
      update(tx.uid, () => ({ stage: 'first_leg_pending', hash: hash.trim(), error: undefined }))
    } catch {
      setError(t('unknown.lookupFailed'))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-txt-label-small">{t('unknown.explain')}</div>
      <input
        className="bg-input-modal-bg-active w-full rounded-xl border p-3"
        placeholder={t('unknown.placeholder')}
        value={hash}
        onChange={e => setHash(e.target.value)}
      />
      {error && <SwapError error={new Error(error)} />}
      <div className="flex gap-2">
        <GenericButton size="medium" colorType="3" onClick={resume} disabled={checking || !hash.trim()}>
          {checking ? <LoaderCircle size={16} className="animate-spin" /> : t('unknown.resume')}
        </GenericButton>
        <GenericButton size="medium" onClick={() => update(tx.uid, () => ({ stage: 'failed', error: t('unknown.dismissed') }))}>
          {t('unknown.notSent')}
        </GenericButton>
      </div>
    </div>
  )
}

interface Review {
  reviewed: ReviewedSwap
  at: number
}

// The second leg's state and actions: a fresh quote and build on the BCH actually received, then
// signing in the bound wallet. Rendered by the swap-ready stage.
const useSecondLeg = (tx: BridgeTx) => {
  const t = useTranslations('bridge')
  const update = useUpdateBridge()
  const { binding, signer, state: walletState } = useBchWallet()
  const [review, setReview] = useState<Review>()
  const [busy, setBusy] = useState<'quote' | 'sign'>()
  const [phase, setPhase] = useState<SignPhase>('idle')
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const abort = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => abort.current?.abort(), [])
  const op = tx.bridge
  const token = operationToken(op) ?? PUSD_TOKEN
  const walletName = useBchWallet().walletName ?? op.walletName ?? t('wallet.yourWallet')
  const total = (op.received ?? []).reduce((sum, o) => sum + BigInt(o.value), 0n)
  // The binding outlives a wallet that is briefly away (see bch-wallet.tsx); signing needs it live.
  const walletMatches = walletState === 'connected' && !!binding && binding.pubkey === op.binding.pubkey
  // The right wallet, only away (its app in the background): the button waits for it to answer.
  const walletAway = !walletMatches && !!binding && binding.pubkey === op.binding.pubkey
  const signing = useRef(false)
  const preparation = useRef(0)
  const fundingKey = (op.received ?? []).map(o => `${o.txid}:${o.vout}:${o.value}`).join('|')

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  const expired = !!review && now - review.at > REVIEW_TTL_MS

  // Fresh quote on the BCH actually received, then a build checked against it.
  const prepare = async () => {
    if (signing.current) return
    const request = ++preparation.current
    setBusy('quote')
    setError(undefined)
    setReview(undefined)
    try {
      const current = await freshOperation(tx.uid)
      if (current?.bridge.stage !== 'bch_ready') return
      const recovery = await recoverSecondSigning(current.bridge)
      if (recovery) {
        update(tx.uid, live => sameSecondAttempt(live, current.bridge) ? recovery : {})
        if (recovery.stage !== 'bch_ready') throw new Error(recovery.error)
      }
      const funding = (op.received ?? []).map(o => ({ txid: o.txid, vout: o.vout, value: o.value }))
      const checked = await checkUnspent(op.binding.lockingBytecode, funding)
      if (checked.some(o => !o.unspent)) throw new Error(t('second.spent'))

      try {
        // Quote, build and review in one pass over the pools (the trade priced is the one built). It sells
        // as much of the received BCH as covers its own miner fee and dust, with no reserve held back.
        const reviewed = await prepareTokenTrade(
          { category: token.category, side: 'buy', funding, lockingBytecode: op.binding.lockingBytecode, tokenAddress: op.binding.tokenAddress, cashAddress: op.binding.cashAddress },
          total,
          output => minOutputFor(output)
        )
        if (request === preparation.current) setReview({ reviewed, at: Date.now() })
      } catch (e) {
        if (e instanceof CauldronError && e.code === 'insufficient_funds') throw new Error(t('second.tooSmall', { ticker: token.ticker }))
        throw e
      }
    } catch (e) {
      if (request === preparation.current) setError(e instanceof Error ? e.message : t('second.failed'))
    } finally {
      if (request === preparation.current) setBusy(undefined)
    }
  }

  useEffect(() => {
    void prepare()
    return () => {
      preparation.current++
    }
    // Refresh only when the funding changes, not on each tracking poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundingKey])

  useEffect(() => {
    if (expired && !signing.current) void prepare()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired])

  const sign = async () => {
    if (!review || expired || !signer || !binding || !walletMatches || signing.current) return
    signing.current = true
    const controller = new AbortController()
    abort.current = controller
    setBusy('sign')
    setPhase('signing')
    setError(undefined)
    setNote(undefined)
    let signed = false
    let retry = false
    let attempt: string | undefined
    try {
      const done = await withLock(`bch-bridge-sign-${tx.uid}`, async () => {
        const current = await freshOperation(tx.uid)
        if (current?.bridge.stage !== 'bch_ready') throw new Error(t('second.movedOn'))
        const recovery = await recoverSecondSigning(current.bridge)
        if (recovery && recovery.stage !== 'bch_ready') {
          update(tx.uid, live => sameSecondAttempt(live, current.bridge) ? recovery : {})
          throw new Error(recovery.error)
        }

        const { reviewed } = review
        const request = signingRequest(reviewed)
        attempt = generateId()
        let saved = false
        update(tx.uid, live => {
          if (!sameSecondAttempt(live, current.bridge)) return {}
          saved = true
          return {
          stage: 'second_leg_signing',
          error: undefined,
          priorSecondLegs: rememberAttempt(live.priorSecondLegs, live.secondLeg),
          secondLeg: {
            attempt: attempt!,
            signing: request,
            category: token.category,
            sellSats: reviewed.sell.toString(),
            minOutput: reviewed.minOutput.toString(),
            tokenOut: reviewed.output.toString(),
            routerFeeSats: reviewed.routerFeeSats.toString(),
            minerFeeSats: reviewed.minerFeeSats.toString()
          }
        } })
        if (!saved) throw new Error(t('second.movedOn'))

        const { txid, signedHex } = await signInWallet(
          signer,
          op.binding,
          reviewed,
          `Swap ${formatBch(reviewed.sell)} BCH for at least ${formatToken(reviewed.minOutput, token)} ${token.ticker}`,
          { signal: controller.signal }
        )
        signed = true
        setPhase('sending')

        // Saved before broadcasting, so a lost broadcast answer is reconciled by this id.
        let accepted = false
        update(tx.uid, live => {
          const prior = live.secondLeg
          if (!prior || prior.attempt !== attempt || !['second_leg_signing', 'second_leg_unknown'].includes(live.stage)) return {}
          accepted = true
          const leg: SecondLeg = { ...prior, txid, signedHex }
          return { stage: 'second_leg_signed', secondLeg: leg, priorSecondLegs: rememberAttempt(live.priorSecondLegs, leg) }
        })
        if (!accepted) throw new Error(t('second.movedOn'))

        await broadcast(tx.uid, signedHex, txid, update)
        return true
      })
      if (done === undefined) throw new Error(t('second.otherTab'))
    } catch (e) {
      if (!signed && attempt) update(tx.uid, current => {
        const leg = current.secondLeg
        if (!leg || leg.attempt !== attempt || leg.txid || !['second_leg_signing', 'second_leg_unknown'].includes(current.stage)) return {}
        retry = signingDefinitelyStopped(e)
        return retry ? { stage: 'bch_ready', secondLeg: undefined } : { stage: 'second_leg_unknown', error: OPEN_SECOND_REQUEST_NOTE }
      })
      const noteKey = signingNoteKey(e)
      if (noteKey) setNote(t(`reverse.${noteKey}`, { wallet: walletName }))
      else setError(e instanceof Error ? e.message : t('second.failed'))
      setReview(undefined)
    } finally {
      signing.current = false
      abort.current = undefined
      setBusy(undefined)
      setPhase('idle')
      // After the lock is released: prepare() does nothing while a signature is in flight, which
      // used to leave the button without a review (disabled) after a decline, timeout or cancel.
      if (retry) await prepare()
    }
  }

  const keep = () => update(tx.uid, current => (current.stage === 'bch_ready' && !hasSecondAuthorization(current) ? { stage: 'kept_bch' } : {}))
  return {
    token,
    reviewed: expired ? undefined : review?.reviewed,
    busy,
    phase,
    note,
    walletName,
    cancel: () => abort.current?.abort(),
    error,
    walletMatches,
    walletAway,
    prepare,
    sign,
    keep,
    canKeep: !hasSecondAuthorization(op),
    total
  }
}

const rejectedAndFundingIntact = async (uid: string, txid: string) => {
  const tx = await freshOperation(uid)
  const received = tx?.bridge.received
  if (!tx || !received?.length) return false
  if ((await getTransactionState(txid)).seen) return false
  const checked = await checkUnspent(tx.bridge.binding.lockingBytecode, received)
  return checked.every(o => o.unspent)
}

const broadcast = async (uid: string, signedHex: string, txid: string, update: ReturnType<typeof useUpdateBridge>) => {
  try {
    await broadcastBchTransaction(signedHex, txid)
    // Accepted by the network: complete at 0-conf (the tracker no longer needs to follow it).
    update(uid, op => ({ stage: 'completed', secondLeg: { ...op.secondLeg!, confirmations: op.secondLeg?.confirmations ?? 0, error: undefined } }))
  } catch (error) {
    if (error instanceof BroadcastRejected) {
      // A rejection can also mean "already known" or a conflicting spend, so only go back to a
      // fresh quote once the transaction is absent and every funding output is still unspent.
      const unspent = await rejectedAndFundingIntact(uid, txid).catch(() => false)
      if (unspent) {
        update(uid, op => ({
          stage: 'bch_ready',
          // The next signature starts a fresh second leg; this txid is remembered as one of ours.
          secondLeg: undefined,
          priorSwapTxids: [...(op.priorSwapTxids ?? []), txid],
          error: `Token swap rejected: ${error.message}. Get a new quote.`,
          received: op.received
        }))
        return
      }
    }
    // A timeout is not a failure: the transaction may be in the network. Reconcile by txid.
    update(uid, op => ({ stage: 'second_leg_unknown', secondLeg: { ...op.secondLeg!, error: error instanceof BroadcastUnknown ? error.message : 'Broadcast outcome unknown' } }))
  }
}

const SecondLegStatus = ({ tx }: { tx: BridgeTx }) => {
  const t = useTranslations('bridge')
  const update = useUpdateBridge()
  const [busy, setBusy] = useState(false)
  const leg = tx.bridge.secondLeg
  if (!leg?.txid) return <p className="bridge-progress-note" role="status">{tx.bridge.error ?? OPEN_SECOND_REQUEST_NOTE}</p>

  // Re-sending the same signed bytes is safe: it is the same transaction, it cannot pay twice.
  const resend = async () => {
    if (!leg.signedHex || !leg.txid) return
    setBusy(true)
    await withLock(`bch-bridge-sign-${tx.uid}`, () => broadcast(tx.uid, leg.signedHex!, leg.txid!, update))
    setBusy(false)
  }

  return (
    <div className="bridge-progress-offer">
      {leg.error && <SwapError error={new Error(leg.error)} />}
      {tx.bridge.stage !== 'second_leg_pending' && <p className="bridge-progress-note">{t('second.unknownExplain')}</p>}
      <GenericButton className="bridge-progress-primary w-full" onClick={resend} disabled={busy || tx.bridge.stage === 'second_leg_pending'}>
        {busy || tx.bridge.stage === 'second_leg_pending' ? <LoaderCircle size={16} className="animate-spin" /> : null}
        {t(tx.bridge.stage === 'second_leg_pending' ? 'progress.swapping' : 'second.resend')}
      </GenericButton>
    </div>
  )
}

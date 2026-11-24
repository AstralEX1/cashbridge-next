'use client'

import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { Chain } from '@tcswap/core'
import { ArrowUpRight } from 'lucide-react'
import { AnimatedButton } from '@/components/animated-button'
import { useBchWallet } from '@/components/bch-wallet'
import { BridgeAssetButton, BridgeAssetPicker, type BridgeInputProps } from '@/components/swap/bridge-asset-picker'
import { BridgeInputSwitcher } from '@/components/swap/bridge-input-switcher'
import { BridgeWalletBadge } from '@/components/swap/bridge-wallet-badge'
import { BridgePriceImpact } from '@/components/swap/price-impact'
import { MetaSkeleton, QuotePlaceholder, useLastValue } from '@/components/swap/quote-placeholder'
import { useBchSideBalance } from '@/components/swap/reverse-inputs'
import { SignHint, type SignPhase } from '@/components/swap/reverse-bridge'
import { BridgeConfig } from '@/config'
import { useRates } from '@/hooks/use-rates'
import { SignCancelled, SignDeclined, SignSessionLost, SignTimedOut, SignUndelivered, signInWallet } from '@/lib/bch-signing'
import { prepareBchSwap, quoteBchSwap } from '@/lib/bch-swap'
import { formatBaseUnits, toBaseUnits } from '@/lib/bridge'
import { formatUsd } from '@/lib/bridge-summary'
import { broadcastBchTransaction } from '@/lib/cauldron'
import { isDollarStable } from '@/lib/dollar-stable'
import { readableError } from '@/lib/errors'
import { explorerTxUrl } from '@/lib/explorer'
import { useSwapStore } from '@/store/swap-store'

// A swap that never leaves Bitcoin Cash: back from BCH, with a Bitcoin Cash asset picked on the other side. One Cauldron
// trade from the bound wallet, BCH for a token or a token for BCH, signed once; no bridge and no Router.

export const useBchSwap = () => {
  const from = useSwapStore(state => state.bchToken)
  const to = useSwapStore(state => state.localTo)
  const amount = useSwapStore(state => state.amountFrom)
  const units = useMemo(() => {
    try {
      return amount ? toBaseUnits(amount, from ? from.decimals : 8) : 0n
    } catch {
      return undefined
    }
  }, [amount, from])
  const pair = to !== undefined && (from === null) !== (to === null)
  const query = useQuery({
    queryKey: ['bch-swap', from?.category ?? 'BCH', to?.category ?? 'BCH', units?.toString()],
    queryFn: () => quoteBchSwap(from, to ?? null, units!),
    enabled: pair && !!units && units > 0n,
    retry: false,
    staleTime: 15_000,
    refetchInterval: 20_000
  })
  const quote = query.data
  // A sale's BCH arrives less its own miner fee; a purchase's tokens arrive whole.
  const received = quote && (to ? quote.output : quote.output - (quote.minerFeeSats ?? 0n))
  return {
    from,
    to: to ?? null,
    units,
    pair,
    quote,
    output: received !== undefined && received > 0n ? formatBaseUnits(received, to ? to.decimals : 8) : undefined,
    // Against the pools' own price before their fee and the trade's impact.
    impactPercent: quote && received !== undefined && quote.spotOutput > 0 ? (Number(received) / quote.spotOutput - 1) * 100 : undefined,
    isLoading: query.isLoading && query.fetchStatus !== 'idle',
    error: query.error as Error | null
  }
}

export const BchSwapInputTo = ({ selecting, onSelectOpenChange }: BridgeInputProps) => {
  const t = useTranslations('bridge.form')
  const { to, output, impactPercent, isLoading, error } = useBchSwap()
  const { rates } = useRates([BridgeConfig.buyAsset])
  const bchUsd = rates[BridgeConfig.buyAsset]
  const trigger = useRef<HTMLButtonElement>(null)
  const previous = useLastValue(isLoading ? undefined : output)
  const close = () => {
    onSelectOpenChange(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }
  const usd = !output
    ? undefined
    : to
      ? isDollarStable(to.ticker) ? formatUsd(Number(output)) : undefined
      : bchUsd ? formatUsd(Number(output) * Number(bchUsd.toSignificant(12))) : undefined

  return (
    <BridgeInputSwitcher selecting={selecting}>
      <div className="bridge-input-switcher__slot" aria-hidden={selecting} inert={selecting}>
        <section className="bridge-input" aria-label={t('to')}>
          <div className="bridge-input-heading">
            <BridgeAssetButton ref={trigger} bch token={to} aria-label={t('to')} aria-expanded={selecting} onClick={() => onSelectOpenChange(true)} />
            <BridgeWalletBadge kind="bch" />
          </div>
          <output className="bridge-amount" aria-label={t('receiveAmount')} aria-live="polite" aria-busy={isLoading}>
            {isLoading ? <QuotePlaceholder previous={previous} /> : (output ?? '')}
          </output>
          <div className="bridge-input-meta">
            <span>{isLoading ? <MetaSkeleton /> : (usd ?? (error ? t('noRoute') : t('receiveAmount')))}</span>
            <BridgePriceImpact percent={isLoading ? undefined : impactPercent} />
          </div>
        </section>
      </div>
      <div className="bridge-input-switcher__slot bridge-input-switcher__picker-slot" aria-hidden={!selecting} inert={!selecting}>
        <BridgeAssetPicker side="to" bch={false} open={selecting} onClose={close} />
      </div>
    </BridgeInputSwitcher>
  )
}

interface Done {
  txid: string
  amount: string
  ticker: string
}

export const BchSwapButton = () => {
  const t = useTranslations('swap')
  const tSwap = useTranslations('bridge.onBch')
  const tReverse = useTranslations('bridge.reverse')
  const tWallet = useTranslations('bridge.wallet')
  const wallet = useBchWallet()
  const { from, to, units, pair, quote, output, isLoading, error } = useBchSwap()
  const balance = useBchSideBalance(from)
  const setAmountFrom = useSwapStore(state => state.setAmountFrom)
  const [phase, setPhase] = useState<SignPhase>('idle')
  const [note, setNote] = useState<string>()
  const [done, setDone] = useState<Done>()
  const abort = useRef<AbortController | undefined>(undefined)
  const walletName = wallet.walletName ?? tWallet('yourWallet')
  const ticker = to ? to.ticker : 'BCH'

  const swap = async () => {
    if (!wallet.binding || !wallet.signer || !units || phase !== 'idle') return
    const { binding, signer } = wallet
    const controller = new AbortController()
    abort.current = controller
    setNote(undefined)
    setPhase('preparing')
    try {
      const reviewed = await prepareBchSwap(from, to, units, binding)
      const got = formatBaseUnits(reviewed.minOutput, to ? to.decimals : 8)
      const sold = formatBaseUnits(from ? reviewed.tokensSold : reviewed.sell, from ? from.decimals : 8)
      setPhase('signing')
      const { txid, signedHex } = await signInWallet(signer, binding, reviewed, `Swap ${sold} ${from ? from.ticker : 'BCH'} for at least ${got} ${ticker} on Cauldron`, {
        signal: controller.signal
      })
      setPhase('sending')
      await broadcastBchTransaction(signedHex, txid)
      setDone({ txid, amount: formatBaseUnits(to ? reviewed.output : reviewed.output - reviewed.minerFeeSats, to ? to.decimals : 8), ticker })
      setAmountFrom('')
      balance.refetch()
    } catch (e) {
      if (e instanceof SignCancelled) setNote(tReverse('signCancelled'))
      else if (e instanceof SignDeclined) setNote(tReverse('signDeclined', { wallet: walletName }))
      else if (e instanceof SignTimedOut) setNote(tReverse('signTimedOut', { wallet: walletName }))
      else if (e instanceof SignSessionLost) setNote(tReverse('signSessionLost', { wallet: walletName }))
      else if (e instanceof SignUndelivered) setNote(tReverse('signUndelivered', { wallet: walletName }))
      else setNote(tSwap('failed', { reason: readableError(e, t('button.noValidQuotes')) }))
    } finally {
      setPhase('idle')
      abort.current = undefined
    }
  }

  const state = ((): { text: string; spinner: boolean; accent: boolean; onClick?: () => void } => {
    if (phase !== 'idle') return { text: t('button.swap'), spinner: true, accent: true }
    if (done) return { text: tSwap('again'), spinner: false, accent: true, onClick: () => setDone(undefined) }
    if (!wallet.binding) {
      const connecting = wallet.state === 'connecting' || wallet.state === 'reconnecting'
      return {
        text: t('button.connectBch'),
        spinner: connecting && !wallet.reconnectStalled,
        accent: true,
        onClick: wallet.reconnectStalled || wallet.mismatch || wallet.state === 'connected' ? wallet.pairAgain : connecting ? undefined : wallet.connect
      }
    }
    if (units === undefined || !pair) return { text: t('button.noValidQuotes'), spinner: false, accent: false }
    if (units === 0n) return { text: t('button.enterAmount'), spinner: false, accent: false }
    if (isLoading) return { text: t('button.quoting'), spinner: true, accent: false }
    if (!quote || !output) return { text: error ? tReverse('noTokenRoute', { ticker: from?.ticker ?? ticker }) : t('button.noValidQuotes'), spinner: false, accent: false }
    if (balance.isLoading) return { text: t('button.checkingBalance'), spinner: true, accent: false }
    if (balance.units === undefined) return { text: t('button.balanceUnavailable'), spinner: false, accent: false, onClick: () => balance.refetch() }
    if (balance.units < units) return { text: t('button.insufficientBalance'), spinner: false, accent: false }
    return { text: t('button.swap'), spinner: false, accent: true, onClick: () => void swap() }
  })()

  return (
    <>
      <AnimatedButton
        aria-label={state.text || t('button.enterAmount')}
        colorType={state.accent ? 'accent' : 'default'}
        className="bridge-primary w-full"
        onClick={state.onClick}
        disabled={!state.onClick}
        loading={state.spinner}
      >
        {state.text}
      </AnimatedButton>
      {done ? (
        <p className="bridge-sign-hint" role="status">
          {tSwap('swapped', { amount: done.amount, ticker: done.ticker })}{' '}
          <a href={explorerTxUrl({ chain: Chain.BitcoinCash, txHash: done.txid })} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 underline">
            {tSwap('view')}
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </p>
      ) : phase === 'idle' && !note ? (
        <p className="bridge-sign-hint">{tSwap('route')}</p>
      ) : (
        <SignHint phase={phase} walletName={walletName} note={note} onCancel={() => abort.current?.abort()} />
      )}
    </>
  )
}

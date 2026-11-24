import { useRef } from 'react'
import { useTranslations } from 'next-intl'
import { USwapNumber } from '@tcswap/core'
import { BridgeAssetButton, BridgeAssetPicker, type BridgeInputProps } from '@/components/swap/bridge-asset-picker'
import { BridgeInputSwitcher } from '@/components/swap/bridge-input-switcher'
import { BridgeWalletBadge } from '@/components/swap/bridge-wallet-badge'
import { BridgePriceImpact } from '@/components/swap/price-impact'
import { useTokenEstimate } from '@/components/swap/pusd-swap'
import { MetaSkeleton, QuotePlaceholder, useLastValue } from '@/components/swap/quote-placeholder'
import { useQuote } from '@/hooks/use-quote'
import { useSwapRates } from '@/hooks/use-rates'
import { useAssetTo } from '@/hooks/use-swap'
import { formatBaseUnits } from '@/lib/bridge'
import { bridgeSummary, formatUsd, pusdUsdPrice } from '@/lib/bridge-summary'
import { PUSD_TOKEN, sameToken } from '@/lib/cauldron-tokens'
import { isDollarStable } from '@/lib/dollar-stable'
import { useSwapStore } from '@/store/swap-store'
import { BchDestinationMenu, DestinationAddressInput } from '@/components/swap/automatic-bridge-controls'
import { useAutomaticBridge } from '@/hooks/use-automatic-bridge'

export const SwapInputTo = ({ selecting, onSelectOpenChange }: BridgeInputProps) => {
  const t = useTranslations('bridge.form')
  const assetTo = useAssetTo()
  const openNetworks = useSwapStore(state => state.openNetworks)
  const token = useSwapStore(state => (openNetworks ? null : state.bchToken))
  const { pasteAllowed } = useAutomaticBridge()
  const { quote, isLoading } = useQuote()
  const estimate = useTokenEstimate()
  const { rateFrom, rateTo } = useSwapRates()
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => {
    onSelectOpenChange(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }
  const output = !quote
    ? undefined
    : token
      ? estimate.output === undefined || estimate.error
        ? undefined
        : formatBaseUnits(estimate.output, token.decimals)
      : new USwapNumber(quote.expectedBuyAmount).toSignificant()
  const busy = isLoading || (!!token && estimate.isLoading)
  const previous = useLastValue(busy ? undefined : output)

  // USD of what arrives: BCH at its pool price; dollar stables at $1; other tokens at the live
  // Cauldron price (BCH price × pool rate). Non-stable tokens fall back to ≈$1 when BCH has no price.
  const bchUsd = rateTo ? Number(rateTo.toSignificant(12)) : undefined
  const leg = estimate.error ? undefined : estimate.quote
  const summary = quote && (!token || leg) ? bridgeSummary({
    sent: Number(quote.sellAmount),
    sentUsd: rateFrom ? Number(quote.sellAmount) * Number(rateFrom.toSignificant(12)) : undefined,
    bch: Number(quote.expectedBuyAmount),
    bchUsd,
    tokenTicker: token?.ticker,
    pusd: token && leg ? {
      output: Number(leg.output) / 10 ** token.decimals,
      spotOutput: leg.spotOutput / 10 ** token.decimals,
      sell: Number(leg.sell) / 1e8,
      tradeFee: Number(leg.tradeFeeSats) / 1e8,
      minerFee: leg.minerFeeSats === undefined ? undefined : Number(leg.minerFeeSats) / 1e8
    } : undefined
  }) : undefined
  const usd = (() => {
    if (busy || output === undefined || !quote) return undefined
    if (!token) return bchUsd === undefined ? undefined : formatUsd(Number(quote.expectedBuyAmount) * bchUsd)
    const leg = estimate.quote && { sell: Number(estimate.quote.sell) / 1e8, spotOutput: estimate.quote.spotOutput / 10 ** token.decimals }
    if (!isDollarStable(token.ticker) && !sameToken(token, PUSD_TOKEN) && (bchUsd === undefined || !leg)) return undefined
    const { price, estimate: approx } = pusdUsdPrice(bchUsd, leg, token.ticker)
    return `${approx ? '≈ ' : ''}${formatUsd(Number(output) * price)}`
  })()

  return (
    <BridgeInputSwitcher selecting={selecting}>
      <div className="bridge-input-switcher__slot" aria-hidden={selecting} inert={selecting}>
        <section className="bridge-input" aria-label={t('to')}>
          <div className="bridge-input-heading">
            <BridgeAssetButton
              ref={trigger}
              asset={assetTo}
              bch={!openNetworks}
              token={token}
              aria-label={t('to')}
              aria-expanded={selecting}
              onClick={() => onSelectOpenChange(true)}
            />
            {openNetworks ? (
              <BridgeWalletBadge kind="buy" />
            ) : pasteAllowed ? (
              <BchDestinationMenu />
            ) : (
              <BridgeWalletBadge kind="bch" />
            )}
          </div>
          {!openNetworks && <DestinationAddressInput />}
          <output className="bridge-amount" aria-label={t('receiveAmount')} aria-live="polite" aria-busy={busy}>
            {busy ? <QuotePlaceholder previous={previous} /> : (output ?? '')}
          </output>
          <div className="bridge-input-meta">
            <span>{busy ? <MetaSkeleton /> : (usd ?? t('receiveAmount'))}</span>
            <BridgePriceImpact percent={busy || output === undefined ? undefined : summary?.impactPercent} />
          </div>
        </section>
      </div>
      <div className="bridge-input-switcher__slot" aria-hidden={!selecting} inert={!selecting}>
        <BridgeAssetPicker side="to" bch={!openNetworks} open={selecting} onClose={close} />
      </div>
    </BridgeInputSwitcher>
  )
}

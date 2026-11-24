import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { USwapNumber } from '@tcswap/core'
import { ArrowRight, ChevronDown, Clock, Fuel, Route, TrendingDown, Wallet } from 'lucide-react'
import { QuoteResponseRoute } from '@tcswap/helpers/api'
import { CredenzaDescription, CredenzaHeader, CredenzaTitle } from '@/components/ui/credenza'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AssetIcon } from '@/components/asset-icon'
import { CopyButton } from '@/components/button-copy'
import { DecimalText } from '@/components/decimal/decimal-text'
import { Icon } from '@/components/icons'
import { useDialog } from '@/components/global-dialog'
import { chainLabel } from '@/components/connect-wallet/config'
import { PriceImpact } from '@/components/swap/price-impact'
import { SwapFeeDialog } from '@/components/swap/swap-fee-dialog'
import { SwapProvider } from '@/components/swap/swap-provider'
import { InfoTooltip } from '@/components/tooltip'
import { useSourceGas } from '@/hooks/use-source-gas'
import { houdiniQuoteRates, useRates, useSwapRates } from '@/hooks/use-rates'
import { useAssetFrom, useAssetTo, useSlippage } from '@/hooks/use-swap'
import { formatExpiration, isHoudiniProvider, isPrivateSend, resolveFees } from '@/lib/swap-helpers'
import { toCurrencyFixed, truncate } from '@/lib/utils'
import { shortBridgeAddress } from '@/components/swap/bridge-wallet-badge'
import { useTokenQuoteFor } from '@/components/swap/pusd-swap'
import type { CauldronToken } from '@/lib/cauldron-tokens'
import { formatBaseUnits, minOutputFor } from '@/lib/bridge'
import { bridgeName, bridgeSummary, firstLegSeconds, formatAmount, formatMinutes, formatPercent, formatUsd, PUSD_LEG_SECONDS } from '@/lib/bridge-summary'
import type { Asset } from '@/components/swap/asset'
import { BchMark, CauldronMark, HoverCard, NearMark, ShapeShiftMark, ThorchainMark, TokenMark as CauldronTokenMark } from '@/components/swap/bridge-marks'
import { isNearRoute } from '@/lib/near-intents'
import { isShapeShiftRoute } from '@/lib/shapeshift'

const THORCHAIN_FEES_URL = 'https://docs.thorchain.org/technical-documentation/technical-deep-dive/fees'
const NEAR_FEES_URL = 'https://docs.near-intents.org/resources/fees'
const SHAPESHIFT_FEES_URL = 'https://shapeshift.com/faq'
const toNumber = (value?: USwapNumber) => (value ? Number(value.toSignificant(12)) : undefined)

const TokenMark = ({ asset }: { asset: Asset }) => (
  <span className="bridge-confirm-token">
    <AssetIcon asset={asset} showNetworkIcons={false} />
  </span>
)

interface BridgeConfirmProps {
  quote: QuoteResponseRoute
  // The Cauldron token bought with the BCH, or null for native BCH.
  token: CauldronToken | null
  // The bound BCH wallet's address; the route pays it.
  bchAddress: string
  automatic?: { minPusd: string; refundAddress: string; contract?: boolean }
}

// The bridge's confirm screen: who sends to whom, how much arrives, and one collapsible block with
// the route, time, gas and the full price impact. Every figure is live (quote, pool prices, Cauldron).
export const BridgeConfirm = ({ quote, token, bchAddress, automatic }: BridgeConfirmProps) => {
  const t = useTranslations('bridge.confirm')
  const tAuto = useTranslations('automatic')
  const assetFrom = useAssetFrom()
  const [open, setOpen] = useState(false)
  const pusd = !!token
  // NEAR Intents prices its fee into the rate; THORChain lists its fees. ShapeShift's BCH quotes are NEAR Intents swaps
  // with ShapeShift's fee in the rate too.
  const shapeshift = isShapeShiftRoute(quote)
  const near = isNearRoute(quote) || shapeshift
  const BridgeMark = shapeshift ? ShapeShiftMark : near ? NearMark : ThorchainMark
  const bridge = bridgeName({ near, shapeshift })
  const pusdQuote = useTokenQuoteFor(token ? quote.expectedBuyAmount : undefined, token)

  const identifiers = useMemo(() => quote.fees.map(f => f.asset).sort(), [quote.fees])
  const { rates } = useRates(identifiers, quote.providers[0])
  const { rateFrom, rateTo } = useSwapRates()
  const { inbound, included } = resolveFees(quote, rates)
  const sourceGas = useSourceGas({ route: quote }).route

  const sent = Number(quote.sellAmount)
  const bch = Number(quote.expectedBuyAmount)
  const leg = pusdQuote.error ? undefined : pusdQuote.quote
  const summary = bridgeSummary({
    sent,
    sentUsd: rateFrom ? sent * toNumber(rateFrom)! : undefined,
    bch,
    bchUsd: toNumber(rateTo),
    thorFeeUsd: toNumber(included),
    // The same live deposit gas the route cards rank by (EVM); THORChain's own inbound estimate elsewhere.
    sourceGasUsd: sourceGas?.usd ?? (inbound && toNumber(inbound.usd) ? toNumber(inbound.usd) : undefined),
    thorSeconds: firstLegSeconds(quote.estimatedTime),
    tokenTicker: token?.ticker,
    pusd: leg && {
      output: Number(leg.output) / 10 ** token!.decimals,
      spotOutput: leg.spotOutput / 10 ** token!.decimals,
      sell: Number(leg.sell) / 1e8,
      tradeFee: Number(leg.tradeFeeSats) / 1e8,
      minerFee: leg.minerFeeSats === undefined ? undefined : Number(leg.minerFeeSats) / 1e8
    }
  })

  if (!assetFrom) return null

  const chain = chainLabel(assetFrom.chain)
  const bridgeSeconds = firstLegSeconds(quote.estimatedTime)
  const thorMinutes = bridgeSeconds ? formatMinutes(bridgeSeconds) : undefined
  const minutes = summary.seconds ? t('minutes', { minutes: formatMinutes(summary.seconds) }) : '—'
  const pusdPending = pusd && !leg
  const impact = pusdPending ? undefined : summary
  const received = pusdPending ? undefined : summary.received
  const receivedTicker = token ? token.ticker : 'BCH'
  const usd = (value?: number) => (value === undefined ? '—' : formatUsd(value))

  return (
    <>
      <CredenzaHeader>
        <CredenzaTitle>{t('title')}</CredenzaTitle>
        <CredenzaDescription className="sr-only">{t('transfer')}</CredenzaDescription>
      </CredenzaHeader>

      <ScrollArea className="relative flex min-h-0 flex-1 px-4 md:px-7" classNameViewport="flex-1 h-auto">
        <div className="bridge-confirm">
          <section className="bridge-confirm-transfer" aria-label={t('transfer')}>
            <div className="bridge-confirm-wallets">
              <span className="bridge-confirm-wallet" title={quote.sourceAddress}>
                <img src={`/networks/${assetFrom.chain.toLowerCase()}.svg`} width={22} height={22} alt="" />
                {quote.sourceAddress && quote.sourceAddress !== '{sourceAddress}' ? shortBridgeAddress(quote.sourceAddress) : chain}
              </span>
              <span className="bridge-confirm-arrow" aria-hidden="true">
                <ArrowRight size={18} />
              </span>
              <span className="bridge-confirm-wallet" title={bchAddress}>
                <img src="/networks/bch.svg" width={22} height={22} alt="" />
                {shortBridgeAddress(bchAddress)}
              </span>
            </div>
            <div className="bridge-confirm-amounts">
              <div>
                <div className="bridge-confirm-amount">
                  <TokenMark asset={assetFrom} />
                  <strong>{formatAmount(sent)}</strong>
                </div>
                <span>
                  {t('on', { ticker: assetFrom.ticker, chain })}
                  {rateFrom ? ` · ${usd(sent * toNumber(rateFrom)!)}` : ''}
                </span>
              </div>
              <div className="bridge-confirm-received">
                <div className="bridge-confirm-amount">
                  <strong className={pusdPending ? 'bridge-muted animate-pulse' : undefined}>
                    {automatic ? formatBaseUnits(automatic.minPusd, token?.decimals ?? 2) : received === undefined ? '···' : `${pusd ? '≈ ' : ''}${formatAmount(received)}`}
                  </strong>
                  {token ? <CauldronTokenMark token={token} /> : <BchMark />}
                </div>
                <span>
                  {automatic ? tAuto('minimumLabel', { ticker: receivedTicker }) : t('on', { ticker: receivedTicker, chain: 'Bitcoin Cash' })}
                  {!automatic && !pusdPending && summary.receivedUsd !== undefined ? ` · ${usd(summary.receivedUsd)}` : ''}
                </span>
              </div>
            </div>
            {pusdQuote.error && <p className="bridge-confirm-note">{t('pusdUnavailable', { ticker: receivedTicker })}</p>}
            {automatic && <div className="bridge-confirm-note">
              <p title={automatic.refundAddress}>{tAuto('fallback', { address: shortBridgeAddress(automatic.refundAddress) })}</p>
            </div>}
          </section>

          <section className="bridge-confirm-details">
            <button type="button" className="bridge-confirm-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
              <span className="bridge-confirm-rate">
                {summary.rate !== undefined && !pusdPending
                  ? t('rate', { from: assetFrom.ticker, amount: formatAmount(summary.rate), to: receivedTicker })
                  : t('details')}
              </span>
              <span className="bridge-confirm-chip">
                <Fuel size={16} aria-hidden="true" />
                <span className="sr-only">{t('gas')}</span>
                {usd(summary.gasUsd)}
              </span>
              <span className="bridge-confirm-chip">
                <Clock size={16} aria-hidden="true" />
                <span className="sr-only">{t('time')}</span>
                {minutes}
              </span>
              <ChevronDown size={18} className="bridge-confirm-chevron" aria-hidden="true" />
            </button>

            {open && (
              <dl className="bridge-confirm-rows">
                <div>
                  <dt>
                    <Route size={16} aria-hidden="true" />
                    {t('route')}
                  </dt>
                  <dd>
                    <HoverCard
                      label={
                        <>
                          <span>{pusd ? 2 : 1}</span>
                          <BridgeMark />
                          {pusd && <CauldronMark />}
                        </>
                      }
                    >
                      <span className="bridge-tip-row bridge-tip-head">
                        <span>{t('routeTransactions', { count: pusd ? 2 : 1 })}</span>
                        <span className="bridge-tip-label">{minutes}</span>
                      </span>
                      <span className="bridge-tip-sep" />
                      {pusd ? (
                        <span className="bridge-tip-steps">
                          <span className="bridge-tip-step">
                            <BridgeMark size={22} />
                            <span>
                              <strong>{t('routeBridge', { from: assetFrom.ticker })}</strong>
                              <span className="bridge-tip-label">
                                {t('routeBridgeDetail', { bridge, chain, minutes: thorMinutes ?? '—' })}
                              </span>
                            </span>
                          </span>
                          <span className="bridge-tip-step">
                            <CauldronMark size={22} />
                            <span>
                              <strong>{t('routeSwap', { ticker: receivedTicker })}</strong>
                              <span className="bridge-tip-label">{t('routeSwapDetail', { minutes: formatMinutes(PUSD_LEG_SECONDS) })}</span>
                            </span>
                          </span>
                        </span>
                      ) : (
                        <span className="bridge-tip-label">{t('routeSingle', { bridge, from: assetFrom.ticker, chain })}</span>
                      )}
                    </HoverCard>
                  </dd>
                </div>

                <div>
                  <dt>
                    <Clock size={16} aria-hidden="true" />
                    {t('time')}
                  </dt>
                  <dd>{minutes}</dd>
                </div>

                {pusd && (
                  <div>
                    <dt>
                      <Wallet size={16} aria-hidden="true" />
                      {t('minimumReceived')}
                    </dt>
                    <dd>{leg && token ? `${formatBaseUnits(minOutputFor(leg.output), token.decimals)} ${token.ticker}` : '—'}</dd>
                  </div>
                )}

                <div>
                  <dt>
                    <Fuel size={16} aria-hidden="true" />
                    {t('gas')}
                  </dt>
                  <dd>
                    <HoverCard label={usd(summary.gasUsd)}>
                      <span className="bridge-tip-row bridge-tip-head">
                        <span>{t('gasTotal')}</span>
                        <span>{usd(summary.gasUsd)}</span>
                      </span>
                      <span className="bridge-tip-sep" />
                      <span className="bridge-tip-row">
                        <span className="bridge-tip-label">{t('gasSource', { chain })}</span>
                        <span>{inbound ? `${formatAmount(Number(inbound.amount.toSignificant(12)))} ${inbound.ticker}` : '—'}</span>
                      </span>
                      {pusd && (
                        <span className="bridge-tip-row">
                          <span className="bridge-tip-label">{t('gasBch', { ticker: receivedTicker })}</span>
                          <span>{usd(summary.bchGasUsd)}</span>
                        </span>
                      )}
                    </HoverCard>
                  </dd>
                </div>

                <div>
                  <dt>
                    <TrendingDown size={16} aria-hidden="true" />
                    {t('priceImpact')}
                  </dt>
                  <dd>
                    <HoverCard label={impact?.impactPercent === undefined ? '—' : formatPercent(impact.impactPercent)}>
                      <span className="bridge-tip-row bridge-tip-head">
                        <span>{t('impactTotal')}</span>
                        <span className="bridge-tip-label">
                          {impact?.impactUsd === undefined
                            ? '—'
                            : `${formatUsd(impact.impactUsd)} (${formatPercent(impact.impactPercent ?? 0)})`}
                        </span>
                      </span>
                      <span className="bridge-tip-sep" />
                      <span className="bridge-tip-row">
                        <span className="bridge-tip-label">{near ? t('nearFee', { bridge }) : t('thorFee')}</span>
                        <span>{near ? t('nearFeeIncluded') : usd(included.gt(0) ? -toNumber(included)! : undefined)}</span>
                      </span>
                      {pusd && (
                        <span className="bridge-tip-row">
                          <span className="bridge-tip-label">{t('cauldronFee')}</span>
                          <span>{usd(summary.cauldronFeeUsd === undefined ? undefined : -summary.cauldronFeeUsd)}</span>
                        </span>
                      )}
                      <span className="bridge-tip-row">
                        <span className="bridge-tip-label">{t('poolImpact')}</span>
                        <span>{usd(impact?.poolImpactUsd)}</span>
                      </span>
                      <a className="bridge-tip-link" href={shapeshift ? SHAPESHIFT_FEES_URL : near ? NEAR_FEES_URL : THORCHAIN_FEES_URL} target="_blank" rel="noopener noreferrer">
                        {t('learnFees')}
                      </a>
                    </HoverCard>
                  </dd>
                </div>
              </dl>
            )}
          </section>
        </div>
      </ScrollArea>
    </>
  )
}

interface SwapConfirmProps {
  quote: QuoteResponseRoute & { refundAddress?: string; destinationMemo?: string }
  priceImpact?: USwapNumber
}

const isSameAsset = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export const SwapConfirm = ({ quote, priceImpact }: SwapConfirmProps) => {
  const t = useTranslations('swap')
  const assetFrom = useAssetFrom()
  const assetTo = useAssetTo()
  const slippage = useSlippage()

  const identifiers = useMemo(() => quote.fees.map(f => f.asset).sort(), [quote.fees])
  const { rates } = useRates(identifiers, quote.providers[0])
  const swapRates = useSwapRates()
  // A Houdini route prices its own pair (a pool's price can be stale or missing).
  const quoteRates = useMemo(() => houdiniQuoteRates(quote), [quote])
  const rateFrom = quoteRates.rateFrom ?? swapRates.rateFrom
  const rateTo = quoteRates.rateTo ?? swapRates.rateTo

  const sellAmount = new USwapNumber(quote.sellAmount)
  const expectedBuyAmount = new USwapNumber(quote.expectedBuyAmount)

  // Displayed Minimum Payout is derived from the residual.
  const slippageTolerance = useMemo(() => {
    if (slippage === undefined) return undefined
    const protection = new USwapNumber(slippage)
    if (!priceImpact) return protection
    const residual = protection.sub(priceImpact)
    return residual.gt(0) ? residual : new USwapNumber(0)
  }, [slippage, priceImpact])

  const minimumPayout = useMemo(() => {
    if (!slippageTolerance) return undefined
    return expectedBuyAmount.mul(new USwapNumber(100).sub(slippageTolerance)).div(100)
  }, [expectedBuyAmount, slippageTolerance])

  const feeRates = { ...rates }
  for (const { asset } of quote.fees) {
    const pairRate = isSameAsset(asset, quote.buyAsset) ? quoteRates.rateTo : isSameAsset(asset, quote.sellAsset) ? quoteRates.rateFrom : undefined
    if (pairRate) feeRates[asset] = pairRate
  }
  const { inbound, outbound, liquidity, platform, included } = resolveFees(quote, feeRates)
  const { openDialog } = useDialog()

  if (!assetFrom || !assetTo) return null

  // A private swap is priced floating and settled off-chain by Houdini: the payout is re-priced
  // when the deposit lands, so slippage protection has nothing to say about it. Price impact stays -
  // it is the USD cost of the route, which is what the user is weighing against privacy.
  const isPrivate = isHoudiniProvider(quote.providers[0])
  const isSend = isPrivateSend(isPrivate, assetFrom, assetTo)

  return (
    <>
      <CredenzaHeader>
        <CredenzaTitle>{isSend ? t('confirm.titlePrivateSend') : t('confirm.titleSwap')}</CredenzaTitle>
      </CredenzaHeader>

      <ScrollArea className="relative flex min-h-0 flex-1 px-4 md:px-8" classNameViewport="flex-1 h-auto">
        <div className="bg-sub-container-modal mb-2 rounded-xl border px-4 py-3">
          <div className="flex items-center gap-2 py-3">
            <div className="flex items-center gap-3">
              <AssetIcon asset={assetFrom} />
              <div className="flex flex-col">
                <span className="text-txt-high-contrast text-base font-semibold">
                  <DecimalText amount={sellAmount.toSignificant()} /> {assetFrom.ticker}
                </span>
                <span className="text-txt-label-small text-sm">
                  {rateFrom ? toCurrencyFixed(sellAmount.mul(rateFrom).toCurrency('$', { trimTrailingZeros: false })) : t('confirm.notAvailable')}
                </span>
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center">
              <Icon name="arrow-m-right" className="text-txt-label-small size-5" />
              <span className="text-txt-label-small text-xs">{isSend ? t('confirm.sendArrowLabel') : t('confirm.swapArrowLabel')}</span>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex flex-col items-end">
                <span className="text-txt-high-contrast text-base font-semibold">
                  <DecimalText amount={expectedBuyAmount.toSignificant()} /> {assetTo.ticker}
                </span>
                <span className="text-txt-label-small text-sm">
                  {rateTo ? toCurrencyFixed(expectedBuyAmount.mul(rateTo).toCurrency('$', { trimTrailingZeros: false })) : t('confirm.notAvailable')}
                </span>
              </div>
              <AssetIcon asset={assetTo} />
            </div>
          </div>

          {(quote.destinationAddress ||
            (quote.sourceAddress && quote.sourceAddress !== '{sourceAddress}') ||
            (quote.refundAddress && quote.sourceAddress != quote.refundAddress)) && (
            <div className="space-y-4 border-t py-3">
              {quote.sourceAddress && quote.sourceAddress !== '{sourceAddress}' && (
                <div className="text-txt-label-small flex justify-between text-sm">
                  <div className="flex items-center gap-1">
                    <span>{t('confirm.chainAddress', { chain: chainLabel(assetFrom.chain) })}</span>
                    <InfoTooltip>{isSend ? t('confirm.sourceAddressTooltipSend') : t('confirm.sourceAddressTooltip')}</InfoTooltip>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-txt-contrast-modal font-semibold">{truncate(quote.sourceAddress)}</span>
                    <CopyButton text={quote.sourceAddress} />
                  </div>
                </div>
              )}

              {quote.destinationAddress && (
                <div className="text-txt-label-small flex justify-between text-sm">
                  <div className="flex items-center gap-1">
                    <span>{t('confirm.chainAddress', { chain: chainLabel(assetTo.chain) })}</span>
                    <InfoTooltip>{isSend ? t('confirm.destinationAddressTooltipSend') : t('confirm.destinationAddressTooltip')}</InfoTooltip>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-txt-high-contrast font-semibold">{truncate(quote.destinationAddress)}</span>
                    <CopyButton text={quote.destinationAddress} />
                  </div>
                </div>
              )}

              {quote.destinationMemo && (
                <div className="text-txt-label-small flex justify-between text-sm">
                  <span>{t('confirm.destinationMemo')}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-txt-high-contrast font-semibold break-all">{quote.destinationMemo}</span>
                    <CopyButton text={quote.destinationMemo} />
                  </div>
                </div>
              )}

              {quote.refundAddress && quote.sourceAddress != quote.refundAddress && (
                <div className="text-txt-label-small flex justify-between text-sm">
                  <div className="flex items-center gap-1">
                    <span>{t('confirm.refundAddress')}</span>
                    <InfoTooltip>{isSend ? t('confirm.refundAddressTooltipSend') : t('confirm.refundAddressTooltip')}</InfoTooltip>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-txt-high-contrast font-semibold">{truncate(quote.refundAddress)}</span>
                    <CopyButton text={quote.refundAddress} />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4 border-t py-3">
            {isPrivate ? (
              <>
                <div className="text-txt-label-small flex justify-between text-sm">
                  <div className="flex items-center gap-1">
                    <span>{t('confirm.rate')}</span>
                    <InfoTooltip>{t('confirm.floatingRateTooltip')}</InfoTooltip>
                  </div>
                  <span className="text-txt-high-contrast font-semibold">{t('confirm.floatingRate')}</span>
                </div>

                {quote.meta?.houdini?.swapName && (
                  <div className="text-txt-label-small flex justify-between text-sm">
                    <div className="flex items-center gap-1">
                      <span>{t('confirm.route')}</span>
                      <InfoTooltip>{t('confirm.routeTooltip')}</InfoTooltip>
                    </div>
                    <span className="text-txt-high-contrast font-semibold">{quote.meta.houdini.swapName}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="text-txt-label-small flex justify-between text-sm">
                <div className="flex items-center gap-1">
                  <span>{t('confirm.minimumPayout')}</span>
                  <InfoTooltip>{t('confirm.minimumPayoutTooltip', { protection: slippage ? `${slippage}%` : '' })}</InfoTooltip>
                </div>
                {minimumPayout ? (
                  <span className="text-txt-high-contrast font-semibold">
                    <DecimalText amount={minimumPayout.toSignificant()} symbol={assetTo.ticker} />
                    {rateTo && ` (${toCurrencyFixed(minimumPayout.mul(rateTo).toCurrency('$', { trimTrailingZeros: false }))})`}
                  </span>
                ) : (
                  <span className="text-lucian font-semibold">{t('confirm.notProtected')}</span>
                )}
              </div>
            )}

            {priceImpact && (
              <div className="text-txt-label-small flex justify-between text-sm">
                <div className="flex items-center gap-1">
                  {t('confirm.priceImpact')}
                  <InfoTooltip>{t('confirm.priceImpactTooltip')}</InfoTooltip>
                </div>
                <PriceImpact priceImpact={priceImpact} className="font-semibold" />
              </div>
            )}

            {!isPrivate && slippageTolerance && slippageTolerance.gt(0) && (
              <div className="text-txt-label-small flex justify-between text-sm">
                <div className="flex items-center gap-1">
                  {t('confirm.slippageTolerance')}
                  <InfoTooltip>
                    {t('confirm.slippageToleranceTooltip1', { protection: slippage ? `${slippage}%` : '' })}
                    <br /> <br />
                    {t('confirm.slippageToleranceTooltip2')}
                  </InfoTooltip>
                </div>
                <PriceImpact priceImpact={slippageTolerance} className="font-semibold" />
              </div>
            )}

            {included.gt(0) && (
              <div
                className="text-txt-label-small flex cursor-pointer justify-between text-sm"
                onClick={() => openDialog(SwapFeeDialog, { outbound: outbound, liquidity: liquidity, platform: platform })}
              >
                <div className="flex items-center gap-1">
                  <span>{t('confirm.includedFees')}</span>
                  <InfoTooltip>{t('confirm.includedFeesTooltip')}</InfoTooltip>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-txt-high-contrast font-semibold">
                    {toCurrencyFixed(included.toCurrency('$', { trimTrailingZeros: false }))}
                  </span>
                  <Icon name="eye" className="size-5" />
                </div>
              </div>
            )}

            {quote.estimatedTime && quote.estimatedTime.total > 0 && (
              <div className="text-txt-label-small flex justify-between text-sm">
                <span>{t('confirm.estimatedTime')}</span>
                <span className="text-txt-high-contrast font-semibold">{formatExpiration(quote.estimatedTime.total)}</span>
              </div>
            )}

            {inbound && (
              <div className="text-txt-label-small flex justify-between text-sm">
                <span>{t('confirm.gasFee', { chain: chainLabel(assetFrom.chain) })}</span>
                <span className="text-txt-high-contrast font-semibold">
                  <DecimalText amount={inbound.amount.toSignificant()} /> {inbound.ticker}
                </span>
              </div>
            )}

            <div className="text-txt-label-small flex justify-between text-sm">
              <span>{t('confirm.exchange')}</span>
              <SwapProvider provider={quote.providers[0]} />
            </div>
          </div>
        </div>
      </ScrollArea>
    </>
  )
}

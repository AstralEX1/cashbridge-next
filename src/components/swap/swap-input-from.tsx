import { useRef } from 'react'
import { useTranslations } from 'next-intl'
import { DecimalInput } from '@/components/decimal/decimal-input'
import { BridgeAssetButton, BridgeAssetPicker, type BridgeInputProps } from '@/components/swap/bridge-asset-picker'
import { BridgeInputSwitcher } from '@/components/swap/bridge-input-switcher'
import { useRevealOnHover } from '@/components/swap/amount-presets'
import { SwapAmountPresets } from '@/components/swap/swap-amount-presets'
import { SwapBalance } from '@/components/swap/swap-balance'
import { BridgeWalletBadge } from '@/components/swap/bridge-wallet-badge'
import { useSwapRates } from '@/hooks/use-rates'
import { useAssetFrom, useSwap } from '@/hooks/use-swap'
import { toCurrencyFixed } from '@/lib/utils'

export const SwapInputFrom = ({ selecting, onSelectOpenChange }: BridgeInputProps) => {
  const t = useTranslations('bridge.form')
  const assetFrom = useAssetFrom()
  const { amountFrom, setAmountFrom, valueFrom } = useSwap()
  const { rateFrom } = useSwapRates()
  const trigger = useRef<HTMLButtonElement>(null)
  const reveal = useRevealOnHover()
  const close = () => {
    onSelectOpenChange(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }

  return (
    <BridgeInputSwitcher selecting={selecting}>
      <div className="bridge-input-switcher__slot" aria-hidden={selecting} inert={selecting}>
        <section className="bridge-input" aria-label={t('from')} {...reveal.handlers}>
          <div className="bridge-input-heading">
            <BridgeAssetButton
              ref={trigger}
              asset={assetFrom}
              aria-label={t('from')}
              aria-expanded={selecting}
              onClick={() => onSelectOpenChange(true)}
            />
            <BridgeWalletBadge kind="other" />
          </div>
          <label htmlFor="swap-sell-amount" className="sr-only">
            {t('sendAmount')}
          </label>
          <div className="bridge-amount-row">
            <DecimalInput id="swap-sell-amount" className="bridge-amount" amount={amountFrom} onAmountChange={setAmountFrom} autoComplete="off" />
            <SwapBalance />
          </div>
          <div className="bridge-input-meta">
            {/* No price (pool prices unavailable) shows nothing rather than a misleading $0.00. */}
            <span>{rateFrom ? toCurrencyFixed(valueFrom.mul(rateFrom).toCurrency('$', { trimTrailingZeros: false })) : null}</span>
            <SwapAmountPresets revealed={reveal.revealed} />
          </div>
        </section>
      </div>
      <div className="bridge-input-switcher__slot" aria-hidden={!selecting} inert={!selecting}>
        <BridgeAssetPicker side="from" bch={false} open={selecting} onClose={close} />
      </div>
    </BridgeInputSwitcher>
  )
}

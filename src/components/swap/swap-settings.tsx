import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Icon } from '@/components/icons'
import { GenericButton } from '@/components/generic-button'
import { InfoTooltip } from '@/components/tooltip'
import { useCustomInterval, useCustomQuantity, useSetCustomInterval, useSetCustomQuantity, useSetSlippage, useSlippage } from '@/hooks/use-swap'
import { cn } from '@/lib/utils'
import { INITIAL_CUSTOM_INTERVAL, INITIAL_CUSTOM_QUANTITY, INITIAL_SLIPPAGE } from '@/store/swap-store'

const slippageValues = [0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10]

export const SwapSettings = () => {
  const t = useTranslations('swap')
  const slippage = useSlippage()
  const setSlippage = useSetSlippage()
  const customInterval = useCustomInterval()
  const setCustomInterval = useSetCustomInterval()
  const customQuantity = useCustomQuantity()
  const setCustomQuantity = useSetCustomQuantity()

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [sliderValue, setSliderValue] = useState([toSliderValue(slippage)])
  const [localCustomInterval, setLocalCustomInterval] = useState(customInterval)
  const [localCustomQuantity, setLocalCustomQuantity] = useState(customQuantity)

  const enabledSteps = [...Array(22).keys(), 25]
  const ramExpansions = [slippageValues[0], t('settings.noProtection')]
  const currentSlippage = slippageValues[sliderValue[0]]

  const handleValueChange = (newValue: [number]) => {
    const targetValue = newValue[0]

    let closestStep = enabledSteps[0]
    let minDistance = Math.abs(targetValue - enabledSteps[0])

    for (const step of enabledSteps) {
      const distance = Math.abs(targetValue - step)
      if (distance < minDistance) {
        minDistance = distance
        closestStep = step
      }
    }

    setSliderValue([closestStep])
  }

  return (
    <DropdownMenu
      open={dropdownOpen}
      onOpenChange={open => {
        if (open) {
          setSliderValue([toSliderValue(slippage)])
          setLocalCustomInterval(customInterval)
          setLocalCustomQuantity(customQuantity)
        }

        setDropdownOpen(open)
      }}
    >
      <DropdownMenuTrigger asChild>
        <GenericButton
          size="small"
          aria-label={`${t('tab.swap')}: ${t('settings.priceProtection')}`}
          icon={<Icon name="manage" />}
          className="bg-btn-style-1-bg relative after:absolute after:-inset-1"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-w-sm p-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex justify-between text-sm font-semibold">
              <div className="flex items-center gap-1">
                <span>{t('settings.priceProtection')}</span>
                <InfoTooltip>
                  {t('settings.priceProtectionTooltip1')}
                  <br />
                  <br />
                  {t('settings.priceProtectionTooltip2')}
                </InfoTooltip>
              </div>
              <span>{currentSlippage ? `${currentSlippage}%` : t('settings.noProtection')}</span>
            </div>
            <span className="text-txt-label-small text-xs">{t('settings.priceProtectionDescription')}</span>
          </div>
          <div className="w-full">
            <Slider
              max={25}
              value={sliderValue}
              onValueChange={handleValueChange}
              classNameRange={cn({
                'bg-green-default': currentSlippage && currentSlippage <= 3,
                'bg-jacob': currentSlippage && currentSlippage > 3,
                'bg-lucian': !currentSlippage
              })}
            />
            <div className="text-txt-label-small mt-3 flex items-center justify-between text-[10px] font-semibold">
              {ramExpansions.map((expansion, index) => (
                <span key={expansion}>
                  {expansion}
                  {index === 0 ? '%' : null}
                </span>
              ))}
            </div>
          </div>

          {/* No streaming (TWAP) overrides: the bridge uses the aggregator's own streaming policy,
              and an executable memo is never edited after quoting. */}
          <Separator />

          <div className="flex gap-6">
            <GenericButton
              size="small"
              className="flex-1"
              onClick={() => {
                setSlippage(INITIAL_SLIPPAGE)
                setCustomInterval(INITIAL_CUSTOM_INTERVAL)
                setCustomQuantity(INITIAL_CUSTOM_QUANTITY)
                setDropdownOpen(false)
              }}
              disabled={slippage === INITIAL_SLIPPAGE && customInterval === INITIAL_CUSTOM_INTERVAL && customQuantity === INITIAL_CUSTOM_QUANTITY}
            >
              {t('settings.reset')}
            </GenericButton>

            <GenericButton
              colorType="3"
              size="small"
              className="flex-1"
              onClick={() => {
                setSlippage(currentSlippage)
                setCustomInterval(localCustomInterval)
                setCustomQuantity(localCustomQuantity)
                setDropdownOpen(false)
              }}
              disabled={currentSlippage === slippage && localCustomInterval === customInterval && localCustomQuantity === customQuantity}
            >
              {t('settings.save')}
            </GenericButton>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function toSliderValue(slippage?: number) {
  if (slippage) {
    const index = slippageValues.indexOf(slippage)
    if (index !== -1) return index
  }

  return 25
}

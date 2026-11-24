'use client'

import { useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { Coins, Loader } from 'lucide-react'
import { USwapNumber } from '@tcswap/core'
import { DecimalInput } from '@/components/decimal/decimal-input'
import { DecimalText } from '@/components/decimal/decimal-text'
import { useBchWallet } from '@/components/bch-wallet'
import { AmountPresets, useRevealOnHover } from '@/components/swap/amount-presets'
import { BridgeAssetButton, BridgeAssetPicker, type BridgeInputProps } from '@/components/swap/bridge-asset-picker'
import { BridgeInputSwitcher } from '@/components/swap/bridge-input-switcher'
import { BridgeWalletBadge } from '@/components/swap/bridge-wallet-badge'
import { PayoutAddressInput, PayoutDestinationMenu, usePayoutDestination } from '@/components/swap/payout-destination'
import { BridgePriceImpact } from '@/components/swap/price-impact'
import { MetaSkeleton, QuotePlaceholder, useLastValue } from '@/components/swap/quote-placeholder'
import { Tooltip } from '@/components/tooltip'
import { BridgeConfig } from '@/config'
import { useQuote } from '@/hooks/use-quote'
import { useRates } from '@/hooks/use-rates'
import { useAssetFrom } from '@/hooks/use-swap'
import { useTokenSale } from '@/hooks/use-token-sale'
import { listWalletCoins } from '@/lib/bch'
import { formatBaseUnits } from '@/lib/bridge'
import { percentOfUnits } from '@/lib/amount-presets'
import { formatUsd, valueImpact } from '@/lib/bridge-summary'
import type { CauldronToken } from '@/lib/cauldron-tokens'
import { isDollarStable } from '@/lib/dollar-stable'
import { checkInbound, DepositError, type InboundAddress, maxBchDeposit } from '@/lib/thorchain-deposit'
import { getInboundAddresses } from '@/lib/api'
import { useSwapStore } from '@/store/swap-store'

// The reverse direction's form: the BCH side on top (BCH or a Cauldron token, sent from the bound
// BCH wallet) and the other chain's asset below (paid out by THORChain to the wallet connected on that
// chain, or to an address pasted for it).

// What the bound address holds of the BCH-side asset: token-free BCH, or the token's fungible
// amount (outputs carrying an NFT are left alone). Only the bound address is seen, not the whole
// wallet, since that is the only address the bridge signs for.
export const useBchSideBalance = (token: CauldronToken | null) => {
  const { binding } = useBchWallet()
  const query = useQuery({
    queryKey: ['bch-side-balance', binding?.lockingBytecode],
    queryFn: () => listWalletCoins(binding!.lockingBytecode),
    enabled: !!binding,
    refetchInterval: 20_000,
    retry: 1
  })
  const utxos = query.data?.utxos
  const fee = useQuery({
    queryKey: ['bch-deposit-fee-rate'],
    queryFn: async () => {
      const inbounds = await getInboundAddresses() as unknown as InboundAddress[]
      const vault = inbounds.find(item => item.chain === 'BCH')?.address
      if (!vault) throw new DepositError('THORChain has no BCH vault right now')
      return checkInbound(inbounds, vault, 'THOR')
    },
    enabled: !!binding && !token,
    staleTime: 60_000,
    retry: 1
  })
  const units = utxos
    ? token
      ? utxos.reduce((sum, u) => sum + (u.token?.category === token.category && !u.token.nft ? u.token.amount : 0n), 0n)
      : utxos.reduce((sum, u) => sum + (u.hasToken ? 0n : u.value), 0n)
    : undefined
  const maxUnits = useMemo(() => token ? units : utxos && binding && fee.data !== undefined
    ? maxBchDeposit(utxos.filter(u => !u.hasToken).map(u => ({ txid: u.txid, vout: u.vout, value: u.value.toString() })), binding.lockingBytecode, fee.data.vaultScript, fee.data.feeRate)
    : undefined, [utxos, binding, fee.data, token, units])
  return {
    units, maxUnits, decimals: token ? token.decimals : 8,
    isLoading: !!binding && (query.isLoading || (!token && fee.isLoading)),
    refetch: () => {
      void query.refetch()
      if (!token) void fee.refetch()
    }
  }
}

const useBchUsd = () => {
  const { rates } = useRates([BridgeConfig.buyAsset])
  const rate = rates[BridgeConfig.buyAsset]
  return rate ? Number(rate.toSignificant(12)) : undefined
}

export const BchInputFrom = ({ selecting, onSelectOpenChange }: BridgeInputProps) => {
  const t = useTranslations('bridge.form')
  const tSwap = useTranslations('swap')
  const token = useSwapStore(state => state.bchToken)
  const amountFrom = useSwapStore(state => state.amountFrom)
  const setAmountFrom = useSwapStore(state => state.setAmountFrom)
  const balance = useBchSideBalance(token)
  const sale = useTokenSale(token, amountFrom)
  const bchUsd = useBchUsd()
  const trigger = useRef<HTMLButtonElement>(null)
  const reveal = useRevealOnHover()
  const close = () => {
    onSelectOpenChange(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }

  // Dollar stables are $1; other tokens are valued at what their sale brings in BCH; BCH at its pool price.
  const sentBch = token ? (sale.quote ? Number(sale.quote.output) / 1e8 : undefined) : Number(amountFrom) || undefined
  const usd = token && isDollarStable(token.ticker) && Number(amountFrom)
    ? formatUsd(Number(amountFrom))
    : sentBch !== undefined && bchUsd
      ? formatUsd(sentBch * bchUsd)
      : null
  // Sending all BCH leaves room for the deposit's fee.
  const max = balance.maxUnits

  return (
    <BridgeInputSwitcher selecting={selecting}>
      <div className="bridge-input-switcher__slot" aria-hidden={selecting} inert={selecting}>
        <section className="bridge-input" aria-label={t('from')} {...reveal.handlers}>
          <div className="bridge-input-heading">
            <BridgeAssetButton ref={trigger} bch token={token} aria-label={t('from')} aria-expanded={selecting} onClick={() => onSelectOpenChange(true)} />
            <BridgeWalletBadge kind="bch" />
          </div>
          <label htmlFor="swap-sell-amount" className="sr-only">
            {t('sendAmount')}
          </label>
          <div className="bridge-amount-row">
            <DecimalInput id="swap-sell-amount" className="bridge-amount" amount={amountFrom} onAmountChange={setAmountFrom} autoComplete="off" />
            {(balance.isLoading || max !== undefined) && (
              <Tooltip content={tSwap('balance.useMax')}>
                <button
                  type="button"
                  className="bridge-max-balance"
                  aria-label={tSwap('balance.useMax')}
                  disabled={max === undefined || max <= 0n}
                  onClick={() => max !== undefined && max > 0n && setAmountFrom(formatBaseUnits(max, balance.decimals))}
                >
                  <Coins size={15} aria-hidden="true" />
                  {balance.isLoading ? (
                    <Loader className="animate-spin" size={18} />
                  ) : (
                    <DecimalText amount={formatBaseUnits(balance.units ?? 0n, balance.decimals)} />
                  )}
                </button>
              </Tooltip>
            )}
          </div>
          <div className="bridge-input-meta">
            <span>{usd}</span>
            {max !== undefined && max > 0n && (
              <AmountPresets
                revealed={reveal.revealed}
                inputId="swap-sell-amount"
                onPercent={percent => setAmountFrom(formatBaseUnits(percentOfUnits(max, percent), balance.decimals))}
                onMax={() => setAmountFrom(formatBaseUnits(max, balance.decimals))}
              />
            )}
          </div>
        </section>
      </div>
      <div className="bridge-input-switcher__slot" aria-hidden={!selecting} inert={!selecting}>
        <BridgeAssetPicker side="from" bch open={selecting} onClose={close} />
      </div>
    </BridgeInputSwitcher>
  )
}

export const ReverseInputTo = ({ selecting, onSelectOpenChange }: BridgeInputProps) => {
  const t = useTranslations('bridge.form')
  const asset = useAssetFrom()
  const token = useSwapStore(state => state.bchToken)
  const amount = useSwapStore(state => state.amountFrom)
  const sale = useTokenSale(token, amount)
  const { quote, isLoading, error } = useQuote()
  const payout = usePayoutDestination()
  const { rates } = useRates([BridgeConfig.buyAsset, ...(asset ? [asset.identifier] : [])], quote?.providers[0])
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => {
    onSelectOpenChange(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }
  const output = quote ? new USwapNumber(quote.expectedBuyAmount).toSignificant() : undefined
  const previous = useLastValue(isLoading ? undefined : output)
  const rate = asset ? rates[asset.identifier] : undefined
  const receivedUsd = quote && rate ? Number(quote.expectedBuyAmount) * Number(rate.toSignificant(12)) : undefined
  const usd = receivedUsd !== undefined && !isLoading ? formatUsd(receivedUsd) : undefined
  const bchUsd = rates[BridgeConfig.buyAsset]
  const sentBch = token ? (!sale.error && sale.quote ? sale.quote.spotOutput / 1e8 : undefined) : Number(amount)
  const sentUsd = token && isDollarStable(token.ticker)
    ? Number(amount)
    : sentBch !== undefined && bchUsd
      ? sentBch * Number(bchUsd.toSignificant(12))
      : undefined
  const { impactPercent } = valueImpact(sentUsd, receivedUsd)

  return (
    <BridgeInputSwitcher selecting={selecting}>
      <div className="bridge-input-switcher__slot" aria-hidden={selecting} inert={selecting}>
        <section className="bridge-input" aria-label={t('to')}>
          <div className="bridge-input-heading">
            <BridgeAssetButton ref={trigger} asset={asset} aria-label={t('to')} aria-expanded={selecting} onClick={() => onSelectOpenChange(true)} />
            <PayoutDestinationMenu payout={payout} />
          </div>
          <PayoutAddressInput payout={payout} />
          <output className="bridge-amount" aria-label={t('receiveAmount')} aria-live="polite" aria-busy={isLoading}>
            {isLoading ? <QuotePlaceholder previous={previous} /> : (output ?? '')}
          </output>
          <div className="bridge-input-meta">
            <span>{isLoading ? <MetaSkeleton /> : (usd ?? (error ? t('noRoute') : t('receiveAmount')))}</span>
            <BridgePriceImpact percent={isLoading || (token && sale.isLoading) ? undefined : impactPercent} />
          </div>
        </section>
      </div>
      <div className="bridge-input-switcher__slot" aria-hidden={!selecting} inert={!selecting}>
        <BridgeAssetPicker side="to" bch={false} open={selecting} onClose={close} />
      </div>
    </BridgeInputSwitcher>
  )
}

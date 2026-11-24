'use client'

import { useState } from 'react'
import { ProviderName } from '@tcswap/helpers'
import { useTranslations } from 'next-intl'
import { Building2, LoaderCircle, QrCode, Wallet } from 'lucide-react'
import { Credenza, CredenzaContent, CredenzaDescription, CredenzaHeader, CredenzaTitle } from '@/components/ui/credenza'
import { Input } from '@/components/ui/input'
import { GenericButton } from '@/components/generic-button'
import { useDialog } from '@/components/global-dialog'
import { chainLabel } from '@/components/connect-wallet/config'
import { SwapError } from '@/components/swap/swap-error'
import { SwapAddressWarning } from '@/components/swap/swap-address-warning'
import { RouterUnavailable } from '@/components/swap/router-unavailable'
import { AutomaticOrderDialog } from '@/components/swap/auto-bridge-progress'
import { prepareAutomatic } from '@/components/swap/auto-bridge-confirm'
import { useAutomaticBridge } from '@/hooks/use-automatic-bridge'
import { useQuote } from '@/hooks/use-quote'
import { useSwapRates } from '@/hooks/use-rates'
import { useAssetFrom, useSlippage, useSwap } from '@/hooks/use-swap'
import { useConnectedAccount } from '@/hooks/use-wallets'
import { hasAddressShape } from '@/lib/address-shape'
import { RouterUnavailableError, startExchangeDeposit } from '@/lib/auto-bridge-client'
import { resolvePriceImpact } from '@/lib/swap-helpers'
import { autoBridgeStore, automaticPreference } from '@/store/auto-bridge-store'
import { useSwapStore } from '@/store/swap-store'
import type { Chain } from '@tcswap/core'

// Before the deposit address: where a refund goes. 1Click sends a deposit it cannot swap back to this address on the
// source chain, and an exchange's deposit address may not credit such a transfer, so the user's own wallet is asked for.
export const ExchangeStartDialog = ({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) => {
  const t = useTranslations('automatic.exchange')
  const tAuto = useTranslations('automatic')
  const from = useAssetFrom()
  const { valueFrom, setAmountFrom } = useSwap()
  const { routes } = useQuote()
  const { rateFrom, rateTo } = useSwapRates()
  const { recipient } = useAutomaticBridge()
  const token = useSwapStore(state => state.bchToken)
  const slippage = useSlippage()
  const account = useConnectedAccount(from?.chain, true)
  const remembered = automaticPreference(state => (from ? state.refunds?.[from.chain] : undefined))
  const setRefundFor = automaticPreference(state => state.setRefund)
  const { openDialog } = useDialog()
  const [refund, setRefund] = useState(remembered || account?.address || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  const [acceptedImpact, setAcceptedImpact] = useState(false)
  const route = routes?.near
  const impact = resolvePriceImpact(route, rateFrom, rateTo)
  const needsImpact = !!impact && impact.gt(2)
  const address = refund.trim()
  const valid = !!from && !!address && hasAddressShape(from.chain as Chain, address)

  const start = async () => {
    if (!from || !token || !route || !valid || busy || (needsImpact && !acceptedImpact)) return
    setBusy(true)
    setError(undefined)
    try {
      const prepared = await prepareAutomatic({
        source: { chain: from.chain, asset: from.identifier, amount: valueFrom.toSignificant(), address },
        sourceDecimals: from.decimals,
        token,
        recipient,
        expectedBuyAmount: route.expectedBuyAmount,
        provider: ProviderName.NEAR,
        slippage,
        exchange: true,
        messages: { invalidAddress: tAuto('invalidRecipient'), serviceUpdate: tAuto('serviceUpdate'), noRoute: tAuto('noRoute') }
      })
      try {
        await startExchangeDeposit(prepared.reference)
      } catch (failure) {
        autoBridgeStore.getState().remove(prepared.reference.id)
        throw failure
      }
      setRefundFor(from.chain, address)
      setAmountFrom('')
      onOpenChange(false)
      openDialog(AutomaticOrderDialog, { id: prepared.reference.id })
    } catch (failure) {
      setError(failure instanceof Error ? failure : new Error(tAuto('unavailable')))
    } finally {
      setBusy(false)
    }
  }

  const chain = from ? chainLabel(from.chain) : ''
  return (
    <Credenza open={isOpen} onOpenChange={open => !busy && onOpenChange(open)}>
      <CredenzaContent className="connect-wallet flex h-auto max-h-5/6 flex-col md:max-w-[460px]">
        <CredenzaHeader>
          <CredenzaTitle className="connect-wallet-title">{t('title')}</CredenzaTitle>
          <CredenzaDescription className="sr-only">{t('steps', { ticker: token?.ticker ?? '' })}</CredenzaDescription>
        </CredenzaHeader>
        <div className="space-y-4 px-4 pb-6 md:px-6">
          <ol className="bridge-exchange-steps" aria-label={t('steps', { ticker: token?.ticker ?? '' })}>
            <li><QrCode size={20} aria-hidden="true" /><span>{t('step1')}</span></li>
            <li><Building2 size={20} aria-hidden="true" /><span>{t('step2')}</span></li>
            <li><Wallet size={20} aria-hidden="true" /><span>{t('step3', { ticker: token?.ticker ?? '' })}</span></li>
          </ol>
          <div className="bridge-auto-recipient">
            <label>
              {t('refundLabel', { chain })}
              <Input
                value={refund}
                onChange={event => setRefund(event.target.value)}
                aria-invalid={!!address && !valid}
                spellCheck={false}
                autoComplete="off"
                placeholder={account?.address ?? ''}
              />
            </label>
            {address && !valid ? <p className="bridge-paste-error">{t('refundInvalid', { chain })}</p> : <p className="bridge-exchange-note">{t('refundHint', { ticker: from?.ticker ?? '' })}</p>}
          </div>
          {needsImpact && <SwapAddressWarning checked={acceptedImpact} onCheckedChange={setAcceptedImpact} text={tAuto('highImpact')} />}
          {error instanceof RouterUnavailableError ? <RouterUnavailable onRetry={start} disabled={busy} /> : error && <SwapError error={error} />}
          <GenericButton colorType="3" size="large" className="w-full" disabled={busy || !valid || !route || (needsImpact && !acceptedImpact)} onClick={start} aria-busy={busy}>
            {busy && <LoaderCircle size={20} className="animate-spin" />}
            <span>{busy ? t('preparing') : t('getAddress')}</span>
          </GenericButton>
        </div>
      </CredenzaContent>
    </Credenza>
  )
}

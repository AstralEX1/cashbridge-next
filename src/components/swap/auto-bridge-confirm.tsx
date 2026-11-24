'use client'

import { useEffect, useRef, useState } from 'react'
import { Chain, FeeOption, USwapNumber } from '@tcswap/core'
import { ProviderName } from '@tcswap/helpers'
import type { QuoteResponseRoute } from '@tcswap/helpers/api'
import { useTranslations } from 'next-intl'
import { LoaderCircle } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Credenza, CredenzaContent } from '@/components/ui/credenza'
import { GenericButton } from '@/components/generic-button'
import { BridgeConfirm } from '@/components/swap/swap-confirm'
import { SwapError } from '@/components/swap/swap-error'
import { RouterUnavailable } from '@/components/swap/router-unavailable'
import { SwapAddressWarning } from '@/components/swap/swap-address-warning'
import { useDialog } from '@/components/global-dialog'
import { AutomaticOrderDialog } from '@/components/swap/auto-bridge-progress'
import { chainLabel } from '@/components/connect-wallet/config'
import { PUSD_TOKEN, type CauldronToken } from '@/lib/cauldron-tokens'
import { useAssetFrom, useSwap } from '@/hooks/use-swap'
import { useSwapRates } from '@/hooks/use-rates'
import { AppConfig, BridgeConfig } from '@/config'
import { bchAddressProblem } from '@/lib/bch'
import { quoteLapsed, secondLegSellAmount, toBaseUnits } from '@/lib/bridge'
import { quoteToken } from '@/lib/cauldron'
import { checkNewOrder } from '@/lib/auto-bridge-order'
import { firstLegSeconds } from '@/lib/bridge-summary'
import { getQuotes, isBridgeRoute } from '@/lib/api'
import { assertAutomaticSaved, createAutomaticOrder, orderRequest, RouterUnavailableError, startAutomaticSource } from '@/lib/auto-bridge-client'
import { getNearQuote, isNearRoute, nearLegOf, nearSlippageBps, submitNearDeposit } from '@/lib/near-intents'
import { getShapeShiftBridgeRoute, isShapeShiftRoute, SHAPESHIFT_PROVIDER } from '@/lib/shapeshift'
import { getUSwap } from '@/lib/wallets'
import { newPageKey } from '@/lib/page-settle'
import { resolvePriceImpact } from '@/lib/swap-helpers'
import { autoBridgeStore, isAutomaticDraft, type SavedAutoOrder } from '@/store/auto-bridge-store'
import type { AutomaticSource, OrderIntent } from '@/lib/auto-bridge-contract'

export interface PreparedAutomatic {
  reference: SavedAutoOrder
  route: QuoteResponseRoute
}

type PrepareArgs = Parameters<typeof prepareOrder>[0]

// Runs behind the main button's "Preparing swap". A transfer that cannot be prepared leaves nothing behind, and one the
// user does not send is forgotten when its Confirm closes (AutoBridgeDialog): automatic transfers keep no drafts.
export const prepareAutomatic = async (args: Omit<PrepareArgs, 'id'>): Promise<PreparedAutomatic> => {
  const id = crypto.randomUUID()
  try {
    return await prepareOrder({ ...args, id })
  } catch (error) {
    autoBridgeStore.getState().remove(id)
    throw error
  }
}

// Saves the order reference (before any request, so a lost answer is recoverable), creates the order and takes an
// executable quote to its deposit address. The BCH fallback is the recipient itself. When the user picked NEAR
// Intents, that route is prepared — never swapped for a THORChain quote behind the scenes.
const prepareOrder = async ({
  id,
  source,
  sourceDecimals,
  token,
  recipient,
  expectedBuyAmount,
  provider,
  slippage,
  exchange,
  messages
}: {
  id: string
  source: AutomaticSource
  // The source asset's decimals, which ShapeShift's quote is asked in.
  sourceDecimals: number
  // The Cauldron token the Router buys.
  token: CauldronToken
  recipient: string
  expectedBuyAmount: string
  provider: ProviderName
  slippage?: number
  // Paid from an exchange: NEAR Intents only, and a deposit that may come in a little under the quote (FLEX_INPUT, down
  // to its minAmountIn) after the exchange takes its withdrawal fee. `source.address` is then the refund address.
  exchange?: boolean
  messages: { invalidAddress: string; serviceUpdate: string; noRoute: string }
}): Promise<PreparedAutomatic> => {
  if (exchange && provider !== ProviderName.NEAR) throw new Error(messages.noRoute)
  if (bchAddressProblem(recipient, true)) throw new Error(messages.invalidAddress)
  const intent: OrderIntent = { recipientAddress: recipient, refundAddress: recipient, source, expectedBchSats: toBaseUnits(expectedBuyAmount, 8).toString() }
  // PUSD orders leave the category out, so a Router that only knows PUSD still accepts them.
  if (token.category !== BridgeConfig.pusd.category) intent.category = token.category
  const openOrder = async () => {
    const page = newPageKey()
    const reference: SavedAutoOrder = {
      id,
      capability: (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', ''),
      createdAt: Date.now(),
      intent: { ...intent, pageKey: page.pubkey },
      token,
      pageSecret: page.secret
    }
    autoBridgeStore.getState().save(reference)
    assertAutomaticSaved(reference)
    const created = await createAutomaticOrder(reference)
    if (created.apiVersion !== 2 || created.recoveryRequired) throw new Error(messages.serviceUpdate)
    const own = await quoteToken({ category: token.category, side: 'buy', amount: secondLegSellAmount(BigInt(created.expectedBchSats)) })
    checkNewOrder(created, own.output)
    autoBridgeStore.getState().patch(reference.id, { order: created })
    return { reference, order: created }
  }

  const { reference: ref, order } = await openOrder()
  const validFor = (depositAddress: string, candidate?: QuoteResponseRoute): candidate is QuoteResponseRoute =>
    !!candidate &&
    isBridgeRoute(candidate, { sellAsset: source.asset, destinationAddress: depositAddress }) &&
    new USwapNumber(candidate.sellAmount).eqValue(source.amount)

  if (provider === ProviderName.NEAR || provider === SHAPESHIFT_PROVIDER) {
    // A one-use NEAR Intents deposit address paying the order's contract and refunding the source wallet: 1Click's own
    // quote, or ShapeShift's (its BCH quotes are NEAR Intents addresses, checked against 1Click).
    const quoteFor = async (depositAddress: string, now: number): Promise<QuoteResponseRoute | undefined> =>
      provider === ProviderName.NEAR
        ? getNearQuote({
            sellAsset: source.asset,
            buyAsset: BridgeConfig.buyAsset,
            sellAmount: source.amount,
            sourceAddress: source.address,
            recipient: depositAddress,
            refundTo: source.address,
            dry: false,
            slippageBps: nearSlippageBps(slippage),
            flexible: exchange,
            now
          })
        : getShapeShiftBridgeRoute({
            sellAsset: source.asset,
            buyAsset: BridgeConfig.buyAsset,
            sellAmount: source.amount,
            sellDecimals: sourceDecimals,
            buyDecimals: 8,
            slippage,
            sourceAddress: source.address,
            destinationAddress: depositAddress
          })
    const attachNear = async (reference: SavedAutoOrder, current: typeof order) => {
      const now = Date.now()
      const route = await quoteFor(current.depositAddress, now)
      const leg = route && (isNearRoute(route) ? nearLegOf(route) : isShapeShiftRoute(route) ? route.shapeshift.near : undefined)
      if (!route || !leg || !validFor(current.depositAddress, route)) return { status: 'unavailable' as const }
      const depositAddress = leg.depositAddress
      // The Router learns the deposit address before Confirm, so it finds the payout even if this tab closes.
      const noted = await orderRequest(reference, 'POST', { nearDepositAddress: depositAddress, ...(leg.shapeshiftQuoteId && { shapeshiftQuoteId: leg.shapeshiftQuoteId }) })
      if (noted.nearDepositAddress !== depositAddress) throw new Error(messages.noRoute)
      const paid =
        exchange && isNearRoute(route)
          ? { decimals: sourceDecimals, amountIn: route.near.quote.amountIn, minAmountIn: route.near.quote.minAmountIn, deadline: Number(route.expiration) * 1000 }
          : undefined
      if (exchange && !(paid && Number.isFinite(paid.deadline))) throw new Error(messages.noRoute)
      autoBridgeStore.getState().patch(reference.id, { order: noted, ...(paid && { exchange: paid }) })
      return { status: 'ok' as const, order: noted, route }
    }

    const result = await attachNear(ref, order)
    if (result.status !== 'ok') throw new Error(messages.noRoute)
    return { reference: { ...ref, order: result.order }, route: result.route }
  }

  const quotes = await getQuotes({
    buyAsset: BridgeConfig.buyAsset,
    sellAsset: source.asset,
    sellAmount: source.amount,
    sourceAddress: source.address,
    destinationAddress: order.depositAddress,
    refundAddress: source.address,
    dry: false,
    slippage: slippage ?? 99,
    providers: AppConfig.providers
  })
  const route = quotes.find(q => q.providers[0] === provider) ?? quotes[0]
  if (!validFor(order.depositAddress, route)) throw new Error(messages.noRoute)
  return { reference: { ...ref, order }, route }
}

interface Props {
  prepared: PreparedAutomatic
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

// The automatic transfer's confirm: the manual bridge's Confirm Swap with the guaranteed PUSD minimum,
// and one signature in the source wallet. Its progress then opens like the manual bridge's.
export const AutoBridgeDialog = ({ prepared, isOpen, onOpenChange }: Props) => {
  const t = useTranslations('automatic')
  const tSwap = useTranslations('swap')
  const tConfirm = useTranslations('bridge.confirm')
  const from = useAssetFrom()
  const { setAmountFrom } = useSwap()
  const { rateFrom, rateTo } = useSwapRates()
  const { openDialog } = useDialog()
  const { reference, route } = prepared
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  const [acceptedImpact, setAcceptedImpact] = useState(false)
  const [acceptedLtc, setAcceptedLtc] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const attempted = autoBridgeStore(state => !!state.orders.find(order => order.id === reference.id)?.sourceAttempted)
  const impact = resolvePriceImpact(route, rateFrom, rateTo)
  const needsImpact = !!impact && impact.gt(2)
  const needsLtc = from?.ticker === 'LTC'
  const blocked = (needsImpact && !acceptedImpact) || (needsLtc && !acceptedLtc)
  const order = reference.order!
  const source = reference.intent!.source!
  // Closed without sending: the order is forgotten at once, nothing is kept as a draft.
  const close = (open: boolean) => {
    const saved = autoBridgeStore.getState().orders.find(item => item.id === reference.id)
    if (!open && !busy && saved && isAutomaticDraft(saved)) autoBridgeStore.getState().remove(reference.id)
    onOpenChange(open)
  }

  const send = async () => {
    if (busy || attempted || blocked) return
    setBusy(true)
    setError(undefined)
    try {
      if (quoteLapsed(route)) throw new Error(t('changed'))
      const latest = await orderRequest(reference, 'GET')
      if (latest.apiVersion !== 2 || latest.recoveryRequired) throw new Error(t('serviceUpdate'))
      if (latest.minPusd !== order.minPusd || latest.depositAddress !== order.depositAddress) throw new Error(t('changed'))
      autoBridgeStore.getState().patch(reference.id, { order: latest, estimatedSeconds: firstLegSeconds(route.estimatedTime) })
      const near = isNearRoute(route) ? route.near.quote.depositAddress : isShapeShiftRoute(route) ? route.shapeshift.near?.depositAddress : undefined
      if (near && latest.nearDepositAddress !== near) throw new Error(t('changed'))
      const executable = from?.chain === Chain.Tron && route.expiration ? { ...route, expiration: undefined } : route
      const hash = await startAutomaticSource(
        reference,
        route,
        source.asset,
        () => getUSwap().swap({ route: executable as QuoteResponseRoute, feeOptionKey: FeeOption.Fast }) as Promise<string>,
        hash => orderRequest(reference, 'POST', { sourceHash: hash }),
        () => mounted.current
      )
      if (near) void submitNearDeposit(near, hash)
      toast.success(tSwap('toast.transactionSubmitted'))
      setAmountFrom('')
      onOpenChange(false)
      openDialog(AutomaticOrderDialog, { id: reference.id })
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure : new Error(t('unavailable')))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <Credenza open={isOpen} onOpenChange={close}>
      <CredenzaContent className="bridge-confirm-dialog flex h-auto max-h-5/6 flex-col md:max-w-[620px]">
        <BridgeConfirm quote={route} token={reference.token ?? PUSD_TOKEN} bchAddress={order.recipientAddress} automatic={{ minPusd: order.minPusd, refundAddress: order.refundAddress, contract: !!order.contract }} />
        <div className="space-y-3 p-4 pt-2 md:px-7 md:pb-7">
          {needsLtc && <SwapAddressWarning checked={acceptedLtc} onCheckedChange={setAcceptedLtc} text={t('ltcWarning')} />}
          {needsImpact && <SwapAddressWarning checked={acceptedImpact} onCheckedChange={setAcceptedImpact} text={t('highImpact')} />}
          {error instanceof RouterUnavailableError ? <RouterUnavailable onRetry={send} disabled={busy} /> : error && <SwapError error={error} />}
          {attempted && !busy && <p role="status" className="text-sm">{t('attempted')}</p>}
          <GenericButton colorType="3" size="large" className="w-full whitespace-normal" disabled={busy || attempted || blocked} onClick={send} aria-busy={busy}>
            {busy && <LoaderCircle size={20} className="animate-spin" />}
            <span>
              {busy
                ? tConfirm('openWallet', { chain: from ? chainLabel(from.chain) : '' })
                : tConfirm('send', { amount: new USwapNumber(route.sellAmount).toSignificant(), ticker: from?.ticker ?? '' })}
            </span>
          </GenericButton>
        </div>
      </CredenzaContent>
    </Credenza>
  )
}

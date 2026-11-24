import { useEffect, useState } from 'react'
import { Chain, EVMChain } from '@tcswap/core'
import { QuoteResponseRoute } from '@tcswap/helpers/api'
import { useTranslations } from 'next-intl'
import { toast } from '@/lib/toast'
import { AnimatedButton } from '@/components/animated-button'
import { useBchWallet } from '@/components/bch-wallet'
import { useTokenEstimate } from '@/components/swap/pusd-swap'
import { useActiveBridge } from '@/hooks/use-bridges'
import { chainLabel } from '@/components/connect-wallet/config'
import { ConnectWallet } from '@/components/connect-wallet/connect-wallet'
import { useDialog } from '@/components/global-dialog'
import { InstantSwapDialog } from '@/components/swap/instant-swap-dialog'
import { NetworkSwapDialog } from '@/components/swap/network-swap-dialog'
import { SwapDialog } from '@/components/swap/swap-dialog'
import { useBalance } from '@/hooks/use-balance'
import { useIsMemolessHalted } from '@/hooks/use-mimir'
import { useQuote } from '@/hooks/use-quote'
import { useSimulation } from '@/hooks/use-simulation'
import { useAssetFrom, useAssetTo, useSlippage, useSwap } from '@/hooks/use-swap'
import { useConnectedAccount, useExternalWalletMode, useSetExternalWalletMode } from '@/hooks/use-wallets'
import { readableError, resolveQuoteError } from '@/lib/errors'
import { isMayaProvider, isTaprootAddress, waitForAllowance } from '@/lib/swap-helpers'
import { getUSwap } from '@/lib/wallets'
import { useSwapStore } from '@/store/swap-store'
import { useAutomaticBridge, useBchDestination } from '@/hooks/use-automatic-bridge'
import { AutoBridgeDialog, prepareAutomatic } from '@/components/swap/auto-bridge-confirm'
import { RouterUnavailable } from '@/components/swap/router-unavailable'
import { RouterUnavailableError } from '@/lib/auto-bridge-client'
import { addressToLockingBytecode } from '@/lib/bch'
import { getQuotes } from '@/lib/api'
import { getNearQuote, isNearRoute, nearSlippageBps } from '@/lib/near-intents'
import { getShapeShiftBridgeRoute, isShapeShiftRoute } from '@/lib/shapeshift'
import { BridgeConfig } from '@/config'
import { USwapError } from '@tcswap/helpers'
import { QrCode } from 'lucide-react'
import { ExchangeStartDialog } from '@/components/swap/exchange-deposit'
import { exchangeChain } from '@/lib/exchange-deposit'

interface SwapButtonProps {
  onShowBridge: () => void
  instantSwapSupported: boolean
  instantSwapAvailable: boolean
}

interface ButtonState {
  text: string
  spinner: boolean
  accent: boolean
  onClick?: () => void
}

export const SwapButton = ({ instantSwapSupported, instantSwapAvailable, onShowBridge }: SwapButtonProps) => {
  const t = useTranslations('swap')
  const tWallet = useTranslations('wallet')
  const tAuto = useTranslations('automatic')
  const { automatic, recipient, pastedProblem } = useAutomaticBridge()
  const destination = useBchDestination()
  const slippage = useSlippage()
  const assetFrom = useAssetFrom()
  const assetTo = useAssetTo()
  const openNetworks = useSwapStore(state => state.openNetworks)
  const uSwap = getUSwap()
  const selectedAccount = useConnectedAccount(assetFrom?.chain, openNetworks)
  const externalWalletMode = useExternalWalletMode()
  const isMemolessHalted = useIsMemolessHalted()
  const setExternalWalletMode = useSetExternalWalletMode()
  const { valueFrom } = useSwap()
  const { quote, routes, isLoading: isQuoting, refetch: refetchQuote, minimum } = useQuote()
  const { isLoading: isSimulating, approveData } = useSimulation()
  const { balance, isLoading: isBalanceLoading, error: balanceError, refetch: refetchBalance } = useBalance()
  const isMayaChain = isMayaProvider(quote?.providers[0])
  const actionLabel = t('button.send')

  const [isApproving, setIsApproving] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [routerDown, setRouterDown] = useState(false)
  const activeBridge = useActiveBridge()
  const tokenEstimate = useTokenEstimate()
  const bchWallet = useBchWallet()
  const bchToken = useSwapStore(state => state.bchToken)

  const { openDialog } = useDialog()

  // Send prepares the executable route in place ("Preparing swap"), then opens straight on Confirm.
  const onSwap = async (quote: QuoteResponseRoute) => {
    if (!assetFrom || preparing) return
    const provider = quote.providers[0]
    // Free pairs sign directly in the connected source wallet.
    if (useSwapStore.getState().openNetworks) {
      openDialog(NetworkSwapDialog, { provider })
      return
    }
    if (!selectedAccount) return
    setPreparing(true)
    setRouterDown(false)
    try {
      if (automatic) {
        const prepared = await prepareAutomatic({
          source: { chain: assetFrom.chain, asset: assetFrom.identifier, amount: valueFrom.toSignificant(), address: selectedAccount.address },
          sourceDecimals: assetFrom.decimals,
          token: bchToken!,
          recipient,
          expectedBuyAmount: quote.expectedBuyAmount,
          provider,
          slippage,
          messages: { invalidAddress: tAuto('invalidRecipient'), serviceUpdate: tAuto('serviceUpdate'), noRoute: tAuto('noRoute') }
        })
        openDialog(AutoBridgeDialog, { prepared })
        return
      }
      const binding = destination.binding
      if (!binding) return
      if (isNearRoute(quote)) {
        // A fresh quote with a one-use deposit address, paying the bound wallet's plain address (1Click refuses z…)
        // and refunding the source wallet.
        const route = await getNearQuote({
          sellAsset: assetFrom.identifier,
          buyAsset: assetTo!.identifier,
          sellAmount: valueFrom.toSignificant(),
          sourceAddress: selectedAccount.address,
          recipient: binding.cashAddress,
          refundTo: selectedAccount.address,
          dry: false,
          slippageBps: nearSlippageBps(slippage)
        })
        if (!route) throw new Error(t('button.noValidQuotes'))
        openDialog(SwapDialog, { provider, quote: route, binding, walletName: destination.pasted ? undefined : (bchWallet.walletName ?? undefined), onShowBridge })
        return
      }
      if (isShapeShiftRoute(quote)) {
        // ShapeShift's BCH quote is a NEAR Intents deposit address; its 1Click swap must pay the bound wallet.
        const route = await getShapeShiftBridgeRoute({
          sellAsset: assetFrom.identifier,
          buyAsset: BridgeConfig.buyAsset,
          sellAmount: valueFrom.toSignificant(),
          sellDecimals: assetFrom.decimals,
          buyDecimals: 8,
          slippage,
          sourceAddress: selectedAccount.address,
          destinationAddress: binding.cashAddress
        })
        if (!route) throw new Error(t('button.noValidQuotes'))
        openDialog(SwapDialog, { provider, quote: route, binding, walletName: destination.pasted ? undefined : (bchWallet.walletName ?? undefined), onShowBridge })
        return
      }
      const quotes = await getQuotes({
        buyAsset: assetTo!.identifier,
        sellAsset: assetFrom.identifier,
        sellAmount: valueFrom.toSignificant(),
        sourceAddress: selectedAccount.address,
        destinationAddress: binding.cashAddress,
        refundAddress: selectedAccount.address,
        dry: false,
        slippage: slippage ?? 99,
        providers: [provider]
      })
      if (!quotes[0]) throw new Error(t('button.noValidQuotes'))
      openDialog(SwapDialog, { provider, quote: quotes[0], binding, walletName: destination.pasted ? undefined : (bchWallet.walletName ?? undefined), onShowBridge })
    } catch (error) {
      console.warn('Preparing the swap failed', error)
      // The form is untouched: the notice offers Try again, which prepares the same transfer once more.
      if (error instanceof RouterUnavailableError) return setRouterDown(true)
      toast.error(readableError(error instanceof USwapError ? resolveQuoteError(error) : error, t('toast.errorSubmitting')))
    } finally {
      setPreparing(false)
    }
  }

  const onInstantSwap = (quote: QuoteResponseRoute) => {
    openDialog(InstantSwapDialog, { provider: quote.providers[0] })
  }

  const connectSource = () => {
    if (!assetFrom) return
    if (externalWalletMode) {
      if (!isMemolessHalted) toast.warning(tWallet('externalWalletAssetUnsupported'))
      setExternalWalletMode(false)
    }
    openDialog(ConnectWallet, { chain: assetFrom.chain })
  }

  const onApprove = async () => {
    if (!approveData || !selectedAccount) return

    const wallet = uSwap.getWallet<EVMChain>(selectedAccount.provider, selectedAccount.network as EVMChain)
    if (!wallet) return

    const { contract, spender, amount } = approveData
    const from = selectedAccount.address
    const target = { assetAddress: contract, spenderAddress: spender }

    setIsApproving(true)

    const toastId = toast.loading(t('toast.approvalTransaction'))

    try {
      // USDT and other non-standard ERC-20s revert on approve() while a leftover non-zero allowance
      // is still set, so it has to be cleared - and mined - before the new allowance can be signed.
      const allowance = await wallet.approvedAmount({ ...target, from }).catch(() => 0n)

      if (allowance > 0n) {
        toast.loading(t('toast.resettingApproval'), { id: toastId })
        // '0' as a string on purpose: the SDK falls back to an unlimited approval for a falsy amount.
        await wallet.approve({ ...target, amount: '0' })
        const cleared = await waitForAllowance(async () => (await wallet.approvedAmount({ ...target, from })) === 0n)
        if (!cleared) throw new Error(t('toast.approvalNotConfirmed'))
        toast.loading(t('toast.approvalTransaction'), { id: toastId })
      }

      await wallet.approve({ ...target, amount })
      const approved = await waitForAllowance(() => wallet.isApproved({ ...target, from, amount }))
      if (!approved) throw new Error(t('toast.approvalNotConfirmed'))

      toast.success(t('toast.success'), { id: toastId })
    } catch (err) {
      console.error('Approval failed', err)
      toast.error(readableError(err, t('toast.errorSubmitting')), { id: toastId })
    } finally {
      setIsApproving(false)
      refetchQuote()
    }
  }

  const getState = (): ButtonState => {
    if (preparing) return { text: t('recipient.preparingSwap'), spinner: true, accent: true }
    // Open-networks swaps settle to the destination chain wallet via InstantSwap / SwapRecipient — no BCH bind.
    if (!openNetworks) {
      // The BCH side first, then the source wallet. A pasted address stands in for the BCH wallet.
      if (pastedProblem || destination.invalid) return { text: tAuto(automatic ? 'invalidTokenRecipient' : 'invalidRecipient'), spinner: false, accent: false }
      if (automatic ? !addressToLockingBytecode(recipient) : !destination.binding) {
        const connecting = bchWallet.state === 'connecting' || bchWallet.state === 'reconnecting'
        return {
          text: bchWallet.mismatch ? t('button.connectBoundBch') : t('button.connectBch'),
          spinner: connecting && !bchWallet.reconnectStalled,
          accent: true,
          onClick: bchWallet.reconnectStalled || bchWallet.mismatch || bchWallet.state === 'connected' ? bchWallet.pairAgain : connecting ? undefined : bchWallet.connect
        }
      }
    }
    // The QR deposit flow is THORChain's; NEAR Intents and ShapeShift free pairs send from the connected wallet.
    const walletOnly = !!quote && (isNearRoute(quote) || isShapeShiftRoute(quote))
    if (assetFrom && !selectedAccount && (!instantSwapSupported || (openNetworks && (isMemolessHalted || walletOnly)))) {
      return { text: t('button.connectWallet', { chain: chainLabel(assetFrom.chain) }), spinner: false, accent: true, onClick: connectSource }
    }
    if (activeBridge) return { text: t('button.viewBridge'), spinner: false, accent: true, onClick: onShowBridge }
    if (!assetFrom || !assetTo) return { text: '', spinner: true, accent: false }

    if (valueFrom.eqValue(0)) return { text: t('button.enterAmount'), spinner: false, accent: false }

    if (isQuoting || isSimulating) return { text: t('button.quoting'), spinner: true, accent: false }

    // A halt is called out by the banner under the button, so every no-quote case reads the same here.
    if (!quote && minimum) return { text: t('button.minimum', { amount: minimum, ticker: assetFrom.ticker }), spinner: false, accent: false }
    if (!quote) return { text: t('button.noValidQuotes'), spinner: false, accent: false }

    // Native BCH needs only the THORChain route; a token also needs an indicative Cauldron route.
    if (!openNetworks && bchToken) {
      if (tokenEstimate.isLoading) return { text: t('button.quoting'), spinner: true, accent: false }
      if (tokenEstimate.error || tokenEstimate.output === undefined || tokenEstimate.output <= 0n)
        return { text: t('button.noPusdRoute', { ticker: bchToken.ticker }), spinner: false, accent: false }
    }

    if (!selectedAccount) {
      if (instantSwapSupported) {
        const label = actionLabel
        if (!instantSwapAvailable) {
          return { text: label, spinner: false, accent: false }
        }

        return { text: label, spinner: false, accent: true, onClick: () => onInstantSwap(quote) }
      } else {
        return {
          text: t('button.connectWallet', { chain: chainLabel(assetFrom.chain) }),
          spinner: false,
          accent: false,
          onClick: connectSource
        }
      }
    }

    if (isMayaChain && selectedAccount.network === Chain.Bitcoin && isTaprootAddress(selectedAccount.address)) {
      return { text: t('button.taprootNotSupported'), spinner: false, accent: false }
    }

    // A balance still loading or failed to load is not a zero balance.
    if (isBalanceLoading) return { text: t('button.checkingBalance'), spinner: true, accent: false }
    if (balanceError || !balance) return { text: t('button.balanceUnavailable'), spinner: false, accent: false, onClick: () => refetchBalance() }

    if (balance.spendable.lt(valueFrom)) {
      return {
        text: t('button.insufficientBalance'),
        spinner: false,
        accent: false
      }
    }

    if (approveData) {
      return {
        text: t('button.approve', { ticker: assetFrom.ticker }),
        spinner: isApproving,
        accent: false,
        onClick: isApproving ? undefined : onApprove
      }
    }

    return {
      text: actionLabel,
      spinner: false,
      accent: true,
      onClick: () => onSwap(quote)
    }
  }

  const state = getState()
  // No wallet on the source chain: the Router's NEAR Intents route also takes a withdrawal from an exchange.
  const exchangeReady =
    automatic &&
    !openNetworks &&
    BridgeConfig.routerNear &&
    exchangeChain(assetFrom?.chain) &&
    !!routes?.near &&
    !valueFrom.eqValue(0) &&
    !!addressToLockingBytecode(recipient) &&
    !activeBridge &&
    !preparing &&
    !!bchToken &&
    (tokenEstimate.output ?? 0n) > 0n

  // The notice belongs to the transfer that failed: a different amount, asset or mode clears it.
  const transferKey = `${assetFrom?.identifier}|${valueFrom.toSignificant()}|${automatic}`
  useEffect(() => setRouterDown(false), [transferKey])

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
      {exchangeReady && (
        <button type="button" className="bridge-exchange-open" onClick={() => openDialog(ExchangeStartDialog, {})}>
          <QrCode size={16} aria-hidden="true" />
          {tAuto('exchange.open')}
        </button>
      )}
      {routerDown && (
        <RouterUnavailable
          onRetry={() => {
            setRouterDown(false)
            if (quote) void onSwap(quote)
          }}
        />
      )}
    </>
  )
}

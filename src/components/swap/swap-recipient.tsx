import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Chain } from '@tcswap/core'
import { WalletIcon } from '@/components/wallet-icon'
import { ProviderName, USwapError } from '@tcswap/helpers'
import { QuoteResponseRoute } from '@tcswap/helpers/api'
import { LoaderCircle } from 'lucide-react'
import { CredenzaHeader, CredenzaTitle } from '@/components/ui/credenza'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { chainLabel } from '@/components/connect-wallet/config'
import { Icon } from '@/components/icons'
import { Asset } from '@/components/swap/asset'
import { SwapAddressWarning } from '@/components/swap/swap-address-warning'
import { SwapError } from '@/components/swap/swap-error'
import { GenericButton } from '@/components/generic-button'
import { Tooltip } from '@/components/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { useAddressCode } from '@/hooks/use-address-code'
import { useResolvedName } from '@/hooks/use-resolved-name'
import { AddressCheck, useValidAddress } from '@/hooks/use-valid-address'
import { useAssetFrom, useAssetTo, useCustomInterval, useCustomQuantity, useSlippage, useSwap } from '@/hooks/use-swap'
import { useAccounts, useConnectedAccount, useSelectedAccount } from '@/hooks/use-wallets'
import { useSwapStore } from '@/store/swap-store'
import { getNetworkQuotes, getQuotes } from '@/lib/api'
import { getNetworkRoutes } from '@/lib/network-swap'
import { resolveQuoteError } from '@/lib/errors'
import {
  isDepositOnlyPrivateSell,
  isHoudiniProvider,
  isMayaProvider,
  isTaprootAddress,
  isValidDestinationMemo,
  supportsHoudiniMemo
} from '@/lib/swap-helpers'
import { cn, truncate } from '@/lib/utils'
import { WalletAccount } from '@/store/wallets-store'
import { useBchWallet } from '@/components/bch-wallet'

interface SwapRecipientProps {
  provider: ProviderName
  autoPrepare?: boolean
  onFetchQuote: (quote: QuoteResponseRoute & { destinationMemo?: string }) => void
}

// The form's hooks run only once both assets are chosen, so their order never changes between renders.
export const SwapRecipient = (props: SwapRecipientProps) => {
  const assetFrom = useAssetFrom()
  const assetTo = useAssetTo()
  return assetFrom && assetTo ? <RecipientForm {...props} assetFrom={assetFrom} assetTo={assetTo} /> : null
}

type Chosen = NonNullable<ReturnType<typeof useAssetFrom>>

const RecipientForm = ({
  provider,
  onFetchQuote,
  autoPrepare = false,
  assetFrom,
  assetTo
}: SwapRecipientProps & { assetFrom: Chosen; assetTo: NonNullable<ReturnType<typeof useAssetTo>> }) => {
  const t = useTranslations('swap')
  const isMobile = useIsMobile()
  const slippage = useSlippage()
  const customInterval = useCustomInterval()
  const customQuantity = useCustomQuantity()
  const openNetworks = useSwapStore(state => state.openNetworks)
  const accounts = useAccounts()
  const legacyAccount = useSelectedAccount()
  const sourceAccount = useConnectedAccount(assetFrom.chain, openNetworks)
  const selectedAccount = openNetworks ? sourceAccount : legacyAccount

  const { valueFrom } = useSwap()
  const [quoting, setQuoting] = useState(false)
  const autoFetched = useRef(false)
  const [quoteError, setQuoteError] = useState<Error | undefined>()

  // Bridge mode always pays the connected BCH wallet. Open networks pays the buy-chain wallet (editable).
  const { binding } = useBchWallet()
  const buyAccount = useConnectedAccount(assetTo.chain, openNetworks)
  const [typedDestination, setTypedDestination] = useState<string>()
  const destinationAddress = openNetworks
    ? typedDestination ?? buyAccount?.address ?? ''
    : (binding?.cashAddress ?? '')
  const setDestinationAddress = openNetworks ? setTypedDestination : (_: string) => {}
  const [refundAddress, setRefundAddress] = useState<string>('')
  const [destinationMemo, setDestinationMemo] = useState('')
  const [refundAsked, setRefundAsked] = useState(false)
  const [warningChecked, setWarningChecked] = useState(false)
  const [warningCheckedLTC, setWarningCheckedLTC] = useState(false)
  // Read-only on mobile until touched: focus gets moved into the field (e.g. by ticking the warning) and raises the keyboard.
  const [editingField, setEditingField] = useState<'refund' | 'destination'>()

  // Houdini pays out from its partner exchanges' wallets, not THORChain's Router, so an EIP-7702 delegated
  // address can receive it and the self-custody and LTC MWEB acknowledgements do not apply.
  const isHoudini = isHoudiniProvider(provider)
  // Without a wallet the user names the refund address - except for Houdini, which (like its own app)
  // needs one only when every route on offer asks for it.
  const depositOrder = (!selectedAccount && (provider === 'NEAR' || isHoudini)) || (isHoudini && isDepositOnlyPrivateSell(assetFrom.chain))
  const refundRequired = depositOrder && (!isHoudini || refundAsked)
  const options = accounts.filter(a => a.network === assetTo.chain)
  const isMayachain = isMayaProvider(provider)
  const isTaprootDestination = isMayachain && assetTo.chain === Chain.Bitcoin && isTaprootAddress(destinationAddress)
  // Optional: a self-custody wallet needs none, an exchange deposit address needs its memo / tag.
  const hasMemo = isHoudini && supportsHoudiniMemo(assetTo.chain)
  const memo = hasMemo ? destinationMemo.trim() : ''
  const isMemoInvalid = hasMemo && !isValidDestinationMemo(assetTo.chain, memo)

  const destinationCheck = useValidAddress(destinationAddress, assetTo.chain)
  const refundCheck = useValidAddress(refundAddress, assetFrom.chain)

  // A THORName / MAYAName typed instead of an address is replaced by the
  // address it registered for the chain. Only input that has been validated and
  // rejected as an address is looked up, so a pasted address is never swapped
  // out for someone's alias, and a field waiting on either answer never reads
  // as invalid in between.
  const destinationName = useResolvedName(destinationCheck.isInvalid ? destinationAddress : '', assetTo.chain)
  const refundName = useResolvedName(refundCheck.isInvalid ? refundAddress : '', assetFrom.chain)

  // THORChain pays a native outbound through the Router's `to.send()`, so an address that runs code
  // on receipt - a contract, or an EOA that delegated itself away under EIP-7702 - cannot be paid.
  // Houdini rejects only a contract ("addressTo cannot be a token contract address").
  const destinationCode = useAddressCode(destinationAddress, assetTo.chain, destinationCheck.isValid && !destinationName.isResolving)
  const isDelegatedDestination = !isHoudini && destinationCode.isDelegated
  const isUnsupportedDestination = isDelegatedDestination || destinationCode.isContract

  useEffect(() => {
    if (destinationName.address) setDestinationAddress(destinationName.address)
  }, [destinationName.address])

  useEffect(() => {
    if (refundName.address) setRefundAddress(refundName.address)
  }, [refundName.address])

  const fetchQuote = () => {
    setQuoting(true)

    const isThorchain = provider === 'THORCHAIN' || provider === 'THORCHAIN_STREAMING'
    const supportsStreaming = isThorchain || isMayachain

    ;(openNetworks
      ? (request: Parameters<typeof getNetworkQuotes>[0]) =>
          getNetworkRoutes(provider, { ...request, sellDecimals: assetFrom.decimals, buyDecimals: assetTo.decimals, percentSlippage: slippage })
      : getQuotes)({
      ...(openNetworks && { buyAssetShortCode: assetTo.shortCode }),
      buyAsset: assetTo.identifier,
      sellAsset: assetFrom.identifier,
      sellAmount: valueFrom.toSignificant(),
      sourceAddress: selectedAccount?.address,
      destinationAddress: destinationAddress,
      refundAddress: refundRequired ? refundAddress : provider === 'MAYACHAIN' ? undefined : selectedAccount?.address,
      dry: !(depositOrder || selectedAccount),
      slippage: slippage ?? 99,
      providers: [provider]
    })
      .then(quotes => {
        const quote = quotes[0]
        if (!quote) throw new Error(t('button.noValidQuotes'))

        // Carried on the quote so the confirm screen can show it; the route itself does not echo it.
        onFetchQuote(memo ? { ...quote, destinationMemo: memo } : quote)
      })
      .catch(error => {
        const resolved = error instanceof USwapError ? resolveQuoteError(error) : error
        if (isHoudini && depositOrder && resolved?.message?.includes('refund address')) setRefundAsked(true)
        setQuoteError(resolved)
      })
      .finally(() => setQuoting(false))
  }

  const isLTC = !isHoudini && (assetFrom.ticker === 'LTC' || assetTo.ticker === 'LTC')
  const buttonEnabled =
    destinationCheck.isValid &&
    destinationAddress.length &&
    !isTaprootDestination &&
    !isUnsupportedDestination &&
    !isMemoInvalid &&
    !destinationCode.isChecking &&
    !destinationCode.isUnverified &&
    !quoting &&
    (refundRequired ? refundCheck.isValid && refundAddress.length : true)

  useEffect(() => {
    if (!autoPrepare || autoFetched.current || !buttonEnabled) return
    autoFetched.current = true
    fetchQuote()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buttonEnabled, autoPrepare])

  const addressInput = (
    field: 'refund' | 'destination',
    asset: Asset,
    address: string,
    setAddress: (address: string) => void,
    check: AddressCheck,
    resolving: boolean,
    options: WalletAccount[] = []
  ) => {
    const currentOption = options.find(a => a.address.toLowerCase() === address.toLowerCase())
    // Nothing is wrong with a field that is still being checked or resolved.
    const isInvalid = check.isInvalid && !resolving
    const busy = check.isChecking || resolving

    return (
      <>
        <div className="relative">
          <Textarea
            placeholder={t('recipient.addressPlaceholder', { chain: chainLabel(asset.chain) })}
            value={address}
            aria-invalid={isInvalid}
            onChange={e => setAddress(e.target.value)}
            enterKeyHint="done"
            readOnly={isMobile && editingField !== field}
            onPointerDown={() => setEditingField(field)}
            onBlur={() => setEditingField(undefined)}
            className={cn(
              'bg-input-modal-bg-active border-border-sub-container-modal-low',
              address.length ? 'pe-20' : options.length ? 'pe-28' : 'md:pe-24',
              { 'pl-12': currentOption }
            )}
            tabIndex={isMobile ? -1 : 0}
          />

          {currentOption && (
            <WalletIcon
              walletKey={currentOption.provider.toLowerCase()}
              alt={currentOption.provider}
              width={24}
              height={24}
              className="absolute top-1/2 left-4 -translate-y-1/2"
            />
          )}

          {address.length ? (
            <>
              {/* Beside the clear button, not in place of it: waiting on a name lasts long enough that losing the button would be felt. */}
              {busy && <LoaderCircle size={20} className="text-txt-label-small absolute end-14 top-1/2 -translate-y-1/2 animate-spin" />}

              <GenericButton
                size="small"
                icon={<Icon name="trash" />}
                className="absolute end-4 top-1/2 -translate-y-1/2"
                onClick={() => {
                  setAddress('')
                }}
              />
            </>
          ) : (
            <div className="absolute end-4 top-1/2 flex -translate-y-1/2 gap-2">
              {[...options].map((account, index) => (
                <Tooltip key={index} content={truncate(account.address)}>
                  <GenericButton
                    size="small"
                    className="rounded-xl"
                    icon={<WalletIcon walletKey={account.provider.toLowerCase()} alt={account.provider} width={24} height={24} />}
                    onClick={() => setDestinationAddress(account.address)}
                  />
                </Tooltip>
              ))}

              <GenericButton
                size="small"
                className="hidden md:block"
                onClick={() => {
                  navigator.clipboard.readText().then(text => {
                    setAddress(text)
                  })
                }}
              >
                {t('recipient.paste')}
              </GenericButton>
            </div>
          )}
        </div>

        {isInvalid && <div className="text-lucian text-xs font-semibold">{t('recipient.invalidAddress', { chain: chainLabel(asset.chain) })}</div>}
      </>
    )
  }

  const nextButton = (
    <GenericButton
      colorType="3"
      size="large"
      className="w-full"
      onClick={fetchQuote}
      disabled={!buttonEnabled || (!autoPrepare && ((!isHoudini && !warningChecked) || (isLTC && !warningCheckedLTC)))}
    >
      {quoting && <LoaderCircle size={20} className="animate-spin" />}
      <span>{quoting ? t('recipient.preparingSwap') : autoPrepare ? t('button.send') : t('recipient.next')}</span>
    </GenericButton>
  )

  return (
    <>
      <CredenzaHeader>
        <CredenzaTitle>{refundRequired ? t('recipient.titleAddresses') : t('recipient.titleReceiving')}</CredenzaTitle>
      </CredenzaHeader>

      <ScrollArea className="relative flex min-h-0 flex-1 px-4 md:px-8" classNameViewport="flex-1 h-auto">
        <div className="mb-2 flex flex-col gap-6">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-6">
              {refundRequired && (
                <div className="flex flex-col gap-3">
                  <div className="text-txt-label-small text-sm font-semibold">{t('recipient.enterRefundAddress')}</div>
                  {addressInput('refund', assetFrom, refundAddress, setRefundAddress, refundCheck, refundName.isResolving)}
                </div>
              )}

              <div className="flex flex-col gap-3">
                {refundRequired && <div className="text-txt-label-small text-sm font-semibold">{t('recipient.enterReceivingAddress')}</div>}
                <div className="text-txt-label-small text-sm font-semibold">{t('recipient.bridgeDestination')}</div>
                {openNetworks ? (
                  addressInput('destination', assetTo, destinationAddress, setDestinationAddress, destinationCheck, destinationName.isResolving)
                ) : (
                  <div className="bg-input-modal-bg-active border-border-sub-container-modal-low rounded-xl border p-4 text-sm break-all">
                    {destinationAddress || t('recipient.bridgeNoWallet')}
                  </div>
                )}
                {isTaprootDestination && <div className="text-lucian text-xs font-semibold">{t('recipient.taprootNotSupported')}</div>}
                {isDelegatedDestination && <div className="text-lucian text-xs font-semibold">{t('recipient.delegatedNotSupported')}</div>}
                {destinationCode.isContract && <div className="text-lucian text-xs font-semibold">{t('recipient.contractNotSupported')}</div>}
                {destinationCode.isUnverified && (
                  <div className="text-lucian text-xs font-semibold">
                    {t('recipient.addressCheckFailed')}{' '}
                    <button type="button" className="underline" onClick={destinationCode.retry}>
                      {t('recipient.addressCheckRetry')}
                    </button>
                  </div>
                )}
              </div>

              {/* One field for a destination tag, memo or comment, whatever the chain calls it - as Houdini's own app does. */}
              {hasMemo && (
                <div className="flex flex-col gap-3">
                  <Input
                    value={destinationMemo}
                    onChange={e => setDestinationMemo(e.target.value)}
                    placeholder={t('recipient.memoPlaceholder')}
                    aria-invalid={isMemoInvalid}
                    className="bg-input-modal-bg-active border-border-sub-container-modal-low"
                  />
                  {isMemoInvalid && (
                    <div className="text-lucian text-xs font-semibold">
                      {assetTo.chain === Chain.Ripple ? t('recipient.destinationTagInvalid') : t('recipient.memoInvalid')}
                    </div>
                  )}
                </div>
              )}
            </div>

            {!autoPrepare && !isHoudini && (
              <SwapAddressWarning
                checked={warningChecked}
                onCheckedChange={setWarningChecked}
                text={t('warning.selfCustody')}
                textAccent={t('warning.lossOfFunds')}
              />
            )}

            {!autoPrepare && isLTC && (
              <SwapAddressWarning
                checked={warningCheckedLTC}
                onCheckedChange={setWarningCheckedLTC}
                text={t('warning.ltcMweb')}
                textAccent={t('warning.lossOfFunds')}
              />
            )}
          </div>

          {quoteError && <SwapError error={quoteError} />}
        </div>

        {isMobile && <div className="pt-2 pb-4">{nextButton}</div>}

        <div className="from-modal pointer-events-none absolute inset-x-0 -bottom-px h-4 bg-linear-to-t to-transparent" />
      </ScrollArea>

      {!isMobile && <div className="p-8 pt-2">{nextButton}</div>}
    </>
  )
}

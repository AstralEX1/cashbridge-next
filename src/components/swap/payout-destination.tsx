'use client'

import { useId } from 'react'
import { useTranslations } from 'next-intl'
import { create } from 'zustand'
import { Chain } from '@tcswap/core'
import { Building2, Check, ChevronDown, ClipboardPaste, LogOut, Wallet, X } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { chainLabel } from '@/components/connect-wallet/config'
import { ConnectWallet } from '@/components/connect-wallet/connect-wallet'
import { useDialog } from '@/components/global-dialog'
import { shortBridgeAddress } from '@/components/swap/bridge-wallet-badge'
import { useAddressCode } from '@/hooks/use-address-code'
import { useAssetFrom } from '@/hooks/use-swap'
import { useValidAddress } from '@/hooks/use-valid-address'
import { useConnectedAccount, useDisconnect, useSetExternalWalletMode } from '@/hooks/use-wallets'
import { exchangePayoutBlocked, internalPayout } from '@/lib/exchange-deposit'

// The reverse direction's payout address: the wallet connected on the payout chain, or an address
// pasted for that chain, marked when it is an exchange's deposit address. A paste is kept only for the
// chain it was made for and is not saved.
const usePayoutPaste = create<{
  chain?: Chain
  address: string
  exchange: boolean
  open: boolean
  set: (chain: Chain | undefined, address: string, exchange?: boolean) => void
  setOpen: (open: boolean) => void
}>(set => ({
  address: '',
  exchange: false,
  open: false,
  set: (chain, address, exchange = false) => set({ chain, address, exchange }),
  setOpen: open => set({ open })
}))

const usePasted = (chain?: Chain) => usePayoutPaste(state => (chain && state.chain === chain ? state.address : ''))
const useToExchange = (chain?: Chain) => usePayoutPaste(state => !!chain && state.chain === chain && state.exchange)

// Where the payout goes, without checking it (the form checks it before Send opens the confirm).
export const usePayoutAddress = () => {
  const asset = useAssetFrom()
  const account = useConnectedAccount(asset?.chain)
  return usePasted(asset?.chain).trim() || account?.address
}

export type PayoutProblem = 'tag' | 'invalid' | 'contract' | 'delegated' | 'unverified'

// The payout address with its checks: the chain's address form, and on EVM chains whether the
// address runs code, which THORChain's Router cannot pay (see useAddressCode). An exchange address is
// refused outright on a chain where the exchange needs a memo or tag (exchangePayoutBlocked).
export const usePayoutDestination = () => {
  const asset = useAssetFrom()
  const chain = asset?.chain
  const account = useConnectedAccount(chain)
  const pasted = usePasted(chain).trim()
  const exchange = useToExchange(chain)
  const valid = useValidAddress(pasted, chain ?? Chain.Ethereum)
  const code = useAddressCode(pasted, chain ?? Chain.Ethereum, !!chain && !!pasted && valid.isValid)
  const problem: PayoutProblem | undefined =
    exchange && exchangePayoutBlocked(chain)
      ? 'tag'
      : !pasted
        ? undefined
        : valid.isInvalid
          ? 'invalid'
          : code.isContract
            ? 'contract'
            : code.isDelegated
              ? 'delegated'
              : code.isUnverified
                ? 'unverified'
                : undefined
  return {
    asset,
    chain,
    account,
    pasted,
    exchange,
    address: pasted || account?.address,
    problem,
    checking: !!pasted && (valid.isChecking || code.isChecking),
    retry: code.retry
  }
}

type PayoutDestination = ReturnType<typeof usePayoutDestination>

// The payout side's wallet pill: the connected wallet, connecting one, or pasting an address instead.
export const PayoutDestinationMenu = ({ payout }: { payout: PayoutDestination }) => {
  const t = useTranslations('bridge.wallet')
  const tReverse = useTranslations('bridge.reverse')
  const { chain, account, pasted, problem, exchange } = payout
  const set = usePayoutPaste(state => state.set)
  const setOpen = usePayoutPaste(state => state.setOpen)
  const disconnect = useDisconnect()
  const setExternalWalletMode = useSetExternalWalletMode()
  const { openDialog } = useDialog()
  if (!chain) return null

  const selectWallet = () => {
    set(chain, '')
    setOpen(false)
  }
  const connect = () => {
    selectWallet()
    setExternalWalletMode(false)
    openDialog(ConnectWallet, { chain })
  }
  const toExchange = () => {
    set(chain, '', true)
    setOpen(true)
  }
  // A one-word clipboard value goes into the field, marked if it is wrong; anything else opens the field.
  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (/^\S{1,100}$/.test(text)) {
        set(chain, text)
        setOpen(false)
        return
      }
    } catch {
      // No clipboard access: the user pastes into the field.
    }
    set(chain, pasted)
    setOpen(true)
  }

  const shown = pasted || account?.address
  const pastedValid = !!pasted && !problem
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={`bridge-wallet-badge bridge-wallet-menu${shown ? '' : ' bridge-wallet-connect'}`} aria-label={tReverse('payoutMenu')}>
          {shown ? <span className={`bridge-wallet-dot${problem ? ' is-invalid' : ''}`} aria-hidden="true" /> : <Wallet size={14} aria-hidden="true" />}
          <span title={shown || undefined}>{shown ? shortBridgeAddress(shown) : t('connectSource')}</span>
          <ChevronDown size={16} className="bridge-wallet-chevron" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="bridge-wallet-dropdown">
        {account && (
          <DropdownMenuItem className="bridge-wallet-option" data-active={!pasted || undefined} onSelect={selectWallet}>
            <span className="bridge-wallet-dot" aria-hidden="true" />
            <span className="bridge-wallet-option-text">
              <strong>{shortBridgeAddress(account.address)}</strong>
              <small>{t('payout')}</small>
            </span>
            {!pasted && <Check size={16} className="bridge-wallet-check" aria-hidden="true" />}
          </DropdownMenuItem>
        )}
        {pastedValid && (
          <DropdownMenuItem className="bridge-wallet-option" data-active onSelect={() => setOpen(true)}>
            {exchange ? <Building2 size={16} aria-hidden="true" /> : <ClipboardPaste size={16} aria-hidden="true" />}
            <span className="bridge-wallet-option-text">
              <strong>{shortBridgeAddress(pasted)}</strong>
              <small>{exchange ? tReverse('exchangeAddress') : t('pastedAddress')}</small>
            </span>
            <Check size={16} className="bridge-wallet-check" aria-hidden="true" />
          </DropdownMenuItem>
        )}
        {(account || pastedValid) && <DropdownMenuSeparator className="bridge-wallet-separator" />}
        <DropdownMenuItem className="bridge-wallet-option" onSelect={connect}>
          <Wallet size={16} aria-hidden="true" />
          {t(account ? 'connectNew' : 'connectSource')}
        </DropdownMenuItem>
        <DropdownMenuItem className="bridge-wallet-option" onSelect={paste}>
          <ClipboardPaste size={16} aria-hidden="true" />
          {t('pasteAddress')}
        </DropdownMenuItem>
        <DropdownMenuItem className="bridge-wallet-option" onSelect={toExchange}>
          <Building2 size={16} aria-hidden="true" />
          {tReverse('exchangeOpen')}
        </DropdownMenuItem>
        {account && (
          <DropdownMenuItem className="bridge-wallet-option is-muted" onSelect={() => disconnect(account.provider)}>
            <LogOut size={16} aria-hidden="true" />
            {t('disconnect')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Opened from the menu (or kept open by a refused address): the payout address for the chosen chain.
export const PayoutAddressInput = ({ payout }: { payout: PayoutDestination }) => {
  const tReverse = useTranslations('bridge.reverse')
  const tRecipient = useTranslations('swap.recipient')
  const id = useId()
  const { chain, problem, account, exchange, asset } = payout
  const value = usePasted(chain)
  const open = usePayoutPaste(state => state.open)
  const set = usePayoutPaste(state => state.set)
  const setOpen = usePayoutPaste(state => state.setOpen)
  if (!chain || (!open && !problem)) return null
  const close = () => {
    set(chain, '')
    setOpen(false)
  }
  const label = chainLabel(chain)
  if (problem === 'tag')
    return (
      <div className="bridge-auto-recipient">
        <p className="bridge-paste-error" role="alert">
          {tReverse('exchangeNeedsTag', { chain: label })}{' '}
          <button type="button" className="underline" onClick={close}>
            {tReverse('exchangeOwnWallet')}
          </button>
        </p>
      </div>
    )
  const ticker = asset?.ticker ?? ''
  const message =
    problem === 'invalid'
      ? tRecipient('invalidAddress', { chain: label })
      : problem === 'contract'
        ? tRecipient('contractNotSupported')
        : problem === 'delegated'
          ? tRecipient('delegatedNotSupported')
          : tRecipient('addressCheckFailed')
  return (
    <div className="bridge-auto-recipient">
      <label htmlFor={id}>{tReverse(exchange ? 'exchangeRecipient' : 'payoutRecipient', { chain: label })}</label>
      <div className="bridge-paste-field">
        <Input
          id={id}
          value={value}
          onChange={event => set(chain, event.target.value, exchange)}
          placeholder={tReverse(exchange ? 'exchangePlaceholder' : 'payoutPlaceholder', { chain: label, ticker })}
          autoComplete="off"
          spellCheck={false}
          autoFocus={!value}
          aria-invalid={!!problem}
          aria-describedby={problem ? `${id}-error` : undefined}
        />
        <button
          type="button"
          className="bridge-paste-clear"
          aria-label={tReverse(account ? 'payoutUseWallet' : 'payoutClear')}
          title={tReverse(account ? 'payoutUseWallet' : 'payoutClear')}
          onClick={close}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {problem ? (
        <p id={`${id}-error`} className="bridge-paste-error" role="alert">
          {message}
          {problem === 'unverified' && (
            <>
              {' '}
              <button type="button" className="underline" onClick={payout.retry}>
                {tRecipient('addressCheckRetry')}
              </button>
            </>
          )}
        </p>
      ) : exchange ? (
        <p className="bridge-input-meta">
          {tReverse('exchangeHint', { chain: label, ticker })}
          {asset && internalPayout(asset.identifier) && <> {tReverse('exchangeInternal', { ticker })}</>}
        </p>
      ) : (
        <p className="bridge-input-meta">{tReverse('payoutHint')}</p>
      )}
    </div>
  )
}

'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Chain } from '@tcswap/core'
import { explorerAddressUrl } from '@/lib/explorer'
import { Check, Copy, ExternalLink, LoaderCircle, Wallet, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from '@/lib/toast'
import { useBchWallet } from '@/components/bch-wallet'
import { ConnectWallet } from '@/components/connect-wallet/connect-wallet'
import { useDialog } from '@/components/global-dialog'
import { Tooltip } from '@/components/tooltip'
import { useAssetFrom, useAssetTo } from '@/hooks/use-swap'
import { useConnectedAccount, useDisconnect, useHasHydrated, useSetExternalWalletMode } from '@/hooks/use-wallets'
import { useSwapStore } from '@/store/swap-store'

export const shortBridgeAddress = (address: string) => {
  const display = address.startsWith('bitcoincash:') ? address.slice('bitcoincash:'.length) : address
  return display.length > 14 ? `${display.slice(0, 6)}…${display.slice(-4)}` : display
}

// The wallet of one side of the form: source ('other'), BCH destination ('bch'), or open-networks buy side ('buy').
export const BridgeWalletBadge = ({ kind }: { kind: 'other' | 'bch' | 'buy' }) => {
  const side = kind === 'other' ? 'from' : 'to'
  const reverse = useSwapStore(state => state.reverse)
  const openNetworks = useSwapStore(state => state.openNetworks)
  const t = useTranslations('bridge.wallet')
  const assetFrom = useAssetFrom()
  const assetTo = useAssetTo()
  const buyChain = kind === 'buy' ? assetTo?.chain : undefined
  const account = useConnectedAccount(kind === 'buy' ? buyChain : assetFrom?.chain, openNetworks)
  const disconnectSource = useDisconnect()
  const hasHydrated = useHasHydrated()
  const setExternalWalletMode = useSetExternalWalletMode()
  const { openDialog } = useDialog()
  const bch = useBchWallet()
  const address =
    kind === 'buy'
      ? account?.address
      : side === 'from'
        ? assetFrom
          ? account?.address
          : undefined
        : bch.binding?.cashAddress
  const chain = kind === 'buy' ? buyChain : side === 'from' ? assetFrom?.chain : Chain.BitcoinCash

  if (!chain) return null

  if (!address) {
    const connecting =
      kind === 'buy' || side === 'from' ? !hasHydrated : bch.state === 'connecting' || bch.state === 'reconnecting'
    const retryBch = bch.reconnectStalled || bch.mismatch || bch.state === 'connected'
    return (
      <button
        type="button"
        className="bridge-wallet-badge bridge-wallet-connect"
        disabled={kind === 'bch' && connecting && !bch.reconnectStalled}
        onClick={() => {
          if (kind === 'bch') {
            if (retryBch) bch.pairAgain()
            else bch.connect()
          } else {
            setExternalWalletMode(false)
            openDialog(ConnectWallet, { chain })
          }
        }}
      >
        <img className="bridge-wallet-chain" src={`/networks/${chain.toLowerCase()}.svg`} width={18} height={18} alt="" />
        {connecting && !(kind === 'bch' && bch.reconnectStalled) ? (
          <LoaderCircle size={14} className="animate-spin" />
        ) : (
          <Wallet size={14} />
        )}
        {t(
          connecting && !(kind === 'bch' && bch.reconnectStalled)
            ? 'connecting'
            : kind === 'bch'
              ? 'connectDestination'
              : 'connectSource'
        )}
      </button>
    )
  }

  return (
    <WalletAddressBadge
      address={address}
      chain={chain}
      label={t(kind === 'buy' ? 'payout' : side === 'from' ? (reverse ? 'payout' : 'source') : 'destination')}
      showChainIcon
      onDisconnect={() => {
        if ((kind === 'buy' || side === 'from') && account) disconnectSource(account.provider)
        else if (kind === 'bch') void bch.disconnect()
      }}
    />
  )
}

// A wallet address as a pill: the green dot and short address, with Copy, View in explorer and,
// when `onDisconnect` is given, Disconnect sliding out on hover or focus (always shown on touch).
// The progress screen passes no `onDisconnect`: a running operation's wallets stay as recorded.
export const WalletAddressBadge = ({
  address,
  chain,
  label,
  showChainIcon = false,
  onDisconnect
}: {
  address: string
  chain: Chain
  label: string
  showChainIcon?: boolean
  onDisconnect?: () => void
}) => {
  const t = useTranslations('bridge.wallet')
  const [copied, setCopied] = useState(false)
  const badge = useRef<HTMLDivElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const disconnectable = !!onDisconnect

  // The actions' full width, for the row to keep reserved (bridge.css). Offsets ignore the slide-in transform.
  useLayoutEffect(() => {
    const inner = actions.current
    const first = inner?.firstElementChild as HTMLElement | null
    const last = inner?.lastElementChild as HTMLElement | null
    if (!inner || !first || !last) return
    const style = getComputedStyle(inner)
    const width = last.offsetLeft + last.offsetWidth - first.offsetLeft + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    badge.current?.style.setProperty('--wallet-actions', `${width}px`)
  }, [disconnectable])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  return (
    <div ref={badge} className="bridge-wallet-badge" role="group" tabIndex={0} aria-label={`${label}: ${address}`}>
      {showChainIcon ? (
        <img className="bridge-wallet-chain" src={`/networks/${chain.toLowerCase()}.svg`} width={18} height={18} alt="" />
      ) : (
        <span className="bridge-wallet-dot" aria-hidden="true" />
      )}
      <span title={address}>{shortBridgeAddress(address)}</span>
      <div className="bridge-wallet-actions">
        <div ref={actions} className="bridge-wallet-actions-inner">
          <Tooltip content={t('copy')}>
            <button type="button" aria-label={t('copy')} onClick={copy}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </Tooltip>
          <Tooltip content={t('explorer')}>
            <a aria-label={t('explorer')} href={explorerAddressUrl({ chain, address })} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} />
            </a>
          </Tooltip>
          {onDisconnect && (
            <Tooltip content={t('disconnect')}>
              <button type="button" aria-label={t('disconnect')} onClick={onDisconnect}>
                <X size={17} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Copy, LoaderCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import qrcode from 'qrcode-generator'
import { Credenza, CredenzaContent, CredenzaDescription, CredenzaHeader, CredenzaTitle } from '@/components/ui/credenza'
import {
  detectPaytacaExtension,
  detectZapitExtension,
  openWalletConnectVia,
  type WalletConnectState,
  type WalletConnectVia
} from '@/components/bch-walletconnect'

export type BchConnection = 'wizardconnect' | 'walletconnect'
// Connection paths the chooser can start: WizardConnect, a WalletConnect QR, or a wallet opened
// with the pairing URI (Paytaca/Zapit extension, Cashonize web wallet).
export type BchChoice = BchConnection | Exclude<WalletConnectVia, 'walletconnect'>

// CashTokens wallets, routed the way their docs recommend:
// - WizardConnect first (Selene, Paytaca, Cashonize HD).
// - Paytaca: browser extension over WalletConnect when installed, otherwise WizardConnect.
// - Cashonize: WalletConnect, opened on cashonize.com/#/wc with the pairing URI.
// - Zapit: browser extension when installed, otherwise a WalletConnect QR.
const WALLETS: {
  id: string
  name: string
  logos: string[]
  // Preferred protocol label when no extension shortcut applies.
  protocol: 'WizardConnect' | 'WalletConnect'
  kind: BchChoice
  extension?: 'paytaca' | 'zapit'
}[] = [
  { id: 'wizardconnect', name: 'WizardConnect', logos: ['/integrations/wizardconnect.png'], protocol: 'WizardConnect', kind: 'wizardconnect' },
  { id: 'selene', name: 'Selene', logos: ['/wallets/selene.png'], protocol: 'WizardConnect', kind: 'wizardconnect' },
  { id: 'paytaca', name: 'Paytaca', logos: ['/wallets/paytaca.png'], protocol: 'WizardConnect', kind: 'wizardconnect', extension: 'paytaca' },
  { id: 'cashonize', name: 'Cashonize', logos: ['/wallets/cashonize.png'], protocol: 'WalletConnect', kind: 'cashonize' },
  { id: 'zapit', name: 'Zapit', logos: ['/wallets/zapit.png'], protocol: 'WalletConnect', kind: 'walletconnect', extension: 'zapit' }
]

export const BchWalletChooser = ({
  open,
  onOpenChange,
  onChoose
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChoose: (kind: BchChoice) => void
}) => {
  const t = useTranslations('bridge.wallet')
  const [paytaca, setPaytaca] = useState(false)
  const [zapit, setZapit] = useState(false)
  useEffect(() => {
    if (!open) return
    let current = true
    void detectPaytacaExtension().then(found => current && setPaytaca(found))
    void detectZapitExtension().then(found => current && setZapit(found))
    return () => {
      current = false
    }
  }, [open])

  const choose = (wallet: (typeof WALLETS)[number]) => {
    if (wallet.extension === 'paytaca' && paytaca) onChoose('paytaca-extension')
    else if (wallet.extension === 'zapit' && zapit) onChoose('zapit-extension')
    else onChoose(wallet.kind)
  }

  return (
    <Credenza open={open} onOpenChange={onOpenChange}>
      <CredenzaContent className="connect-wallet flex h-auto max-h-5/6 flex-col md:max-w-[460px]">
        <CredenzaHeader>
          <CredenzaTitle className="connect-wallet-title">
            {t('connectDestination')}
            <img src="/networks/bch.svg" width={22} height={22} alt="" />
          </CredenzaTitle>
          <CredenzaDescription className="sr-only">{t('chooseConnection')}</CredenzaDescription>
        </CredenzaHeader>
        <ul className="connect-wallet-list">
          {WALLETS.map(wallet => {
            const viaExtension =
              (wallet.extension === 'paytaca' && paytaca) || (wallet.extension === 'zapit' && zapit)
            return (
              <li key={wallet.id}>
                <button type="button" className="connect-wallet-row" onClick={() => choose(wallet)}>
                  <span className="connect-wallet-icons">
                    {wallet.logos.map(src => (
                      <img key={src} src={src} width={32} height={32} alt="" className="connect-wallet-icon" />
                    ))}
                  </span>
                  <span className="connect-wallet-name">{wallet.name}</span>
                  <span className="connect-wallet-status connect-wallet-install">
                    {viaExtension ? t('browserExtension') : wallet.protocol}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </CredenzaContent>
    </Credenza>
  )
}

// A WalletConnect URI is mixed case with punctuation, so it is encoded in byte mode (WizardConnect's
// dialog only does alphanumeric). Drawn as one SVG path so it stays sharp at any size.
export const qrPath = (value: string) => {
  const qr = qrcode(0, 'M')
  qr.addData(value, 'Byte')
  qr.make()
  const count = qr.getModuleCount()
  let d = ''
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`
  return { d, count }
}

const openViaLabel = (via: WalletConnectVia) => {
  if (via === 'paytaca-extension') return 'openPaytacaExtension' as const
  if (via === 'zapit-extension') return 'openZapitExtension' as const
  if (via === 'cashonize') return 'openCashonize' as const
  return null
}

export const WalletConnectDialog = ({
  state,
  uri,
  via = 'walletconnect',
  onClose
}: {
  state: WalletConnectState
  uri?: string
  // How this pairing was started: a named wallet/extension may need a reopen button if the popup was blocked.
  via?: WalletConnectVia
  onClose: () => void
}) => {
  const t = useTranslations('bridge.wallet')
  const qr = useMemo(() => (uri ? qrPath(uri) : undefined), [uri])
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [uri])
  const open = (state === 'connecting' && !!uri) || state === 'verifying'
  const windowVia = via !== 'walletconnect'
  const reopen = openViaLabel(via)

  return (
    <Credenza open={open} onOpenChange={next => !next && onClose()}>
      <CredenzaContent className="connect-wallet flex h-auto max-h-5/6 flex-col md:max-w-[420px]">
        <CredenzaHeader>
          <CredenzaTitle className="connect-wallet-title">{t('walletConnectTitle')}</CredenzaTitle>
          <CredenzaDescription>
            {state === 'verifying'
              ? t('walletConnectVerify')
              : via === 'cashonize'
                ? t('openCashonize')
                : windowVia
                  ? t('browserExtension')
                  : t('walletConnectScan')}
          </CredenzaDescription>
        </CredenzaHeader>
        <div className="flex flex-col items-center gap-4 px-4 pb-6 md:px-6">
          {reopen && (
            <button
              type="button"
              className="connect-wallet-row w-full justify-center"
              onClick={() => openWalletConnectVia(via, state === 'verifying' ? undefined : uri)}
            >
              {t(reopen)}
            </button>
          )}
          {state === 'verifying' || windowVia ? (
            <LoaderCircle size={36} className="animate-spin" aria-label={t('connecting')} />
          ) : (
            qr &&
            uri && (
              <>
                <svg
                  viewBox={`-4 -4 ${qr.count + 8} ${qr.count + 8}`}
                  width={264}
                  height={264}
                  role="img"
                  aria-label={t('walletConnectQr')}
                  className="rounded-2xl bg-white"
                  shapeRendering="crispEdges"
                >
                  <path d={qr.d} fill="#111" />
                </svg>
                <div className="flex w-full gap-2">
                  <button
                    type="button"
                    className="connect-wallet-row justify-center"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(uri)
                        .then(() => setCopied(true))
                        .catch(() => {})
                    }
                  >
                    <Copy size={18} />
                    {copied ? t('walletConnectCopied') : t('walletConnectCopy')}
                  </button>
                  <a className="connect-wallet-row justify-center" href={uri}>
                    {t('walletConnectOpen')}
                  </a>
                </div>
              </>
            )
          )}
        </div>
      </CredenzaContent>
    </Credenza>
  )
}

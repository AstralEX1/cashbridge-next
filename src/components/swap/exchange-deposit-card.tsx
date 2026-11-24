'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDownToLine, Check, Copy } from 'lucide-react'
import { qrPath } from '@/components/bch-wallet-dialogs'
import { chainLabel } from '@/components/connect-wallet/config'
import { shortBridgeAddress } from '@/components/swap/bridge-wallet-badge'
import { orderRequest } from '@/lib/auto-bridge-client'
import type { PublicOrder } from '@/lib/auto-bridge-contract'
import { formatBaseUnits } from '@/lib/bridge'
import { paymentRequest, watchExchangeDeposit, type ExchangeWatch } from '@/lib/exchange-deposit'
import { getNearStatus } from '@/lib/near-intents'
import { payoutByHash } from '@/lib/reverse-bridge'
import { sourceTransactionId } from '@/lib/source-transaction'
import { autoBridgeStore, type SavedAutoOrder } from '@/store/auto-bridge-store'

const tickerOf = (asset: string) => asset.split('.')[1]?.split('-')[0] ?? asset

const CopyValue = ({ value, label }: { value: string; label: string }) => {
  const t = useTranslations('automatic.exchange')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button type="button" className="bridge-exchange-copy" onClick={copy} aria-label={`${t(copied ? 'copied' : 'copy')}: ${label}`}>
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
    </button>
  )
}

const countdown = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`
}

// Whether the order still waits for the exchange's withdrawal: the deposit card shows while it does.
export const awaitingExchange = (reference?: SavedAutoOrder, order?: PublicOrder) =>
  !!reference?.exchange && !!order?.nearDepositAddress && !reference.sourceHash && !order.sourceHash && BigInt(order.receivedSats || '0') === 0n && ['awaiting_deposit', 'streaming'].includes(order.state)

// The deposit address with coin, network and amount: a QR code (a payment request, or the bare address for exchange
// apps that read only that), copy buttons, the window, and what arrived so far, read from the source chain.
export const ExchangeDepositCard = ({ reference, order, now }: { reference: SavedAutoOrder; order: PublicOrder; now: number }) => {
  const t = useTranslations('automatic.exchange')
  const source = order.source ?? reference.intent?.source
  const exchange = reference.exchange!
  const deposit = order.nearDepositAddress!
  const [bare, setBare] = useState(false)
  // The Router marks the order 'streaming' once 1Click reports a deposit: no QR code flashes up before the first check.
  const [watch, setWatch] = useState<ExchangeWatch>({ kind: order.state === 'streaming' ? 'arriving' : 'waiting' })
  const ticker = source ? tickerOf(source.asset) : ''
  const chain = source ? chainLabel(source.chain) : ''
  const amount = formatBaseUnits(exchange.amountIn, exchange.decimals)
  const minimum = formatBaseUnits(exchange.minAmountIn, exchange.decimals)
  const left = exchange.deadline - now
  const expired = left <= 0 && watch.kind !== 'short'
  const request = useMemo(() => (source ? paymentRequest(source.asset, deposit, BigInt(exchange.amountIn), exchange.decimals) : deposit), [source, deposit, exchange])
  const qr = useMemo(() => qrPath(bare ? deposit : request), [bare, deposit, request])

  // 1Click names the deposit's transaction; the source chain's own node must show it paying this address. The Router
  // learns the hash too, so the scanner and this browser's history show it.
  useEffect(() => {
    if (!source) return
    let stopped = false
    const tick = async () => {
      try {
        const next = await watchExchangeDeposit(source, deposit, await getNearStatus(deposit), payoutByHash)
        if (stopped) return
        setWatch(next)
        const saved = autoBridgeStore.getState().orders.find(item => item.id === reference.id)
        const hash = next.kind === 'seen' ? sourceTransactionId(next.hash) : undefined
        if (!hash || !saved || saved.sourceHash) return
        autoBridgeStore.getState().patch(reference.id, { sourceHash: hash })
        const updated = await orderRequest(saved, 'POST', { sourceHash: hash }).catch(() => undefined)
        if (updated) autoBridgeStore.getState().patch(reference.id, { order: updated })
      } catch {
        // The next tick asks again; the Router watches the same address on its own.
      }
    }
    void tick()
    const timer = setInterval(tick, 8000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [source, deposit, reference.id])

  const deadline = new Date(exchange.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (watch.kind === 'arriving' || watch.kind === 'seen')
    return (
      <p role="status" className="bridge-exchange-status">
        <ArrowDownToLine size={16} aria-hidden="true" />
        <span>{t('arriving', { ticker, chain })}</span>
      </p>
    )
  return (
    <section className="bridge-exchange" aria-label={t('title')} data-expired={expired || undefined}>
      <div className="bridge-exchange-qr">
        <svg viewBox={`-2 -2 ${qr.count + 4} ${qr.count + 4}`} role="img" aria-label={t(bare ? 'qrAddress' : 'qrLink')} shapeRendering="crispEdges">
          <rect x={-2} y={-2} width={qr.count + 4} height={qr.count + 4} fill="#fff" />
          <path d={qr.d} fill="#0f1820" />
        </svg>
      </div>
      <div className="bridge-exchange-toggle" role="group" aria-label={t('qrKind')}>
        <button type="button" aria-pressed={!bare} onClick={() => setBare(false)}>{t('qrLink')}</button>
        <button type="button" aria-pressed={bare} onClick={() => setBare(true)}>{t('qrAddress')}</button>
      </div>
      <ul className="bridge-exchange-chips">
        <li>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {source && <img src={`/networks/${source.chain.toLowerCase()}.svg`} width={14} height={14} alt="" />}
          {t('network', { chain })}
        </li>
        <li>{t('min', { amount: minimum, ticker })}</li>
        {source && <li title={source.address}>{t('refund', { address: shortBridgeAddress(source.address) })}</li>}
      </ul>
      <div className="bridge-exchange-row">
        <span>
          <small>{t('amount')}</small>
          <strong>{amount} {ticker}</strong>
        </span>
        <CopyValue value={amount} label={t('amount')} />
      </div>
      <div className="bridge-exchange-row">
        <span>
          <small>{t('address')}</small>
          <code>{deposit}</code>
        </span>
        <CopyValue value={deposit} label={t('address')} />
      </div>
      {watch.kind === 'short' ? (
        <p role="alert" className="bridge-exchange-status is-warning">
          {watch.received > 0n
            ? t('short', { received: formatBaseUnits(watch.received, exchange.decimals), ticker, missing: formatBaseUnits(BigInt(exchange.minAmountIn) - watch.received > 0n ? BigInt(exchange.minAmountIn) - watch.received : 0n, exchange.decimals), time: deadline })
            : t('shortUnknown', { min: minimum, ticker, time: deadline })}
        </p>
      ) : expired ? (
        <p role="alert" className="bridge-exchange-status is-warning">{t('expired')}</p>
      ) : (
        <p role="status" className="bridge-exchange-status">
          <ArrowDownToLine size={16} aria-hidden="true" />
          <span>{t('watching', { ticker })}</span>
          <span className="bridge-exchange-time">{countdown(left)}</span>
        </p>
      )}
      <p className="bridge-exchange-note">{t('fee', { ticker, chain, min: minimum })}</p>
    </section>
  )
}

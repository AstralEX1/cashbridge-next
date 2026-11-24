'use client'

import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight, ArrowUpRight, CircleCheck, CircleDollarSign, LifeBuoy, LoaderCircle, LogIn, LogOut, Search, SearchX, TriangleAlert, Undo2, Wallet, X, Zap } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { NumberTicker } from '@/components/landing/number-ticker'
import { isScanAddress } from '@/lib/auto-bridge-contract'
import { localWallets } from '@/lib/local-scan'
import { chainIcon, chainName, directionOf, hashLookups, matchesQuery, rowUsd, type ScanDirection, type ScanRow, type ScanStatus } from '@/lib/scanner'
import { getThorPools } from '@/lib/thorchain-api'
import { autoBridgeStore } from '@/store/auto-bridge-store'
import { transactionStore } from '@/store/transaction-store'
import { LiveDot } from './live-dot'
import { ScanList } from './scan-list'
import { statusLabel } from './status-label'
import { useScanFeed } from './use-scan-feed'
import { useWalletScan } from './use-wallet-scan'

const noSubscribe = () => () => {}

type Filter = 'all' | 'router' | 'manual'
const FILTERS: [Filter, string, React.ReactNode][] = [
  ['all', 'All transfers', 'All'],
  ['router', 'Cashbridge Router', <Zap key="router" size={16} aria-hidden />],
  ['manual', 'Manual', <Wallet key="manual" size={16} aria-hidden />]
]
const DIRECTIONS: [ScanDirection, string, React.ReactNode][] = [
  ['in', 'Into Bitcoin Cash', <LogIn key="in" size={16} aria-hidden />],
  ['out', 'Out of Bitcoin Cash', <LogOut key="out" size={16} aria-hidden />]
]
const STATUSES: [ScanStatus, React.ReactNode][] = [
  ['completed', <CircleCheck key="completed" size={16} aria-hidden />],
  ['pending', <LoaderCircle key="pending" size={16} aria-hidden />],
  ['refunded', <Undo2 key="refunded" size={16} aria-hidden />],
  ['review', <TriangleAlert key="review" size={16} aria-hidden />]
]

// Pills that each narrow the list to rows matching them, with how many rows each would show; pressing the active pill
// shows all again.
function Facets<T extends string>({ label, value, options, count, onChange }: {
  label: string
  value?: T
  options: [T, string, React.ReactNode][]
  count: (option: T) => number
  onChange: (next?: T) => void
}) {
  return (
    <div className="scanner-filters scanner-facets" role="group" aria-label={label}>
      {options.map(([option, name, icon]) => {
        const n = count(option)
        return (
          <button key={option} type="button" aria-pressed={value === option} aria-label={`${name}: ${n}`} title={name} disabled={!n && value !== option} onClick={() => onChange(value === option ? undefined : option)}>
            {icon}
            <span>{n}</span>
          </button>
        )
      })}
    </div>
  )
}

const shortAddress = (address: string) => {
  const bare = address.replace(/^bitcoincash:/i, '')
  return bare.length > 14 ? `${bare.slice(0, 6)}…${bare.slice(-4)}` : bare
}

// Img for a chain mark, or nothing for a chain without one.
const ChainMark = ({ chain, size }: { chain: string; size: number }) => {
  const icon = chainIcon(chain)
  // eslint-disable-next-line @next/next/no-img-element
  return icon ? <img src={icon} alt="" width={size} height={size} /> : null
}

export function ScannerView() {
  const { rows, now, live } = useScanFeed()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [direction, setDirection] = useState<ScanDirection>()
  const [status, setStatus] = useState<ScanStatus>()
  // THORChain's own price of BCH, for transfers with no dollar-stable side.
  const { data: bchUsd } = useQuery({
    queryKey: ['scanner-bch-usd'],
    queryFn: async () => Number((await getThorPools()).find(pool => pool.asset === 'BCH.BCH')?.asset_tor_price) / 1e8 || null,
    staleTime: 5 * 60_000
  })
  // This browser's own wallets sit under the search; the server render has none.
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false)
  const transactions = transactionStore(state => state.transactions)
  const orders = autoBridgeStore(state => state.orders)
  const wallets = useMemo(() => (hydrated ? localWallets(transactions, orders).slice(0, 4) : []), [hydrated, transactions, orders])

  // A wallet link (/scanner?address=…) opens on that wallet.
  useEffect(() => {
    const address = new URLSearchParams(window.location.search).get('address')
    if (address) setQuery(address)
  }, [])

  const text = query.trim()
  const [address, setAddress] = useState<string>()
  // Typing settles before the wallet is looked up; the address goes in the URL so the view can be shared.
  useEffect(() => {
    const next = isScanAddress(text) ? text : undefined
    const timer = setTimeout(() => {
      setAddress(next)
      const url = new URL(window.location.href)
      if (next) url.searchParams.set('address', next)
      else url.searchParams.delete('address')
      window.history.replaceState(window.history.state, '', url)
    }, next ? 350 : 0)
    return () => clearTimeout(timer)
  }, [text])

  const walletRows = useWalletScan(address, rows)
  const searching = !!address
  const base = searching ? (walletRows ?? []) : rows
  const matched = base.filter(row => (filter === 'all' || row.router === (filter === 'router')) && (searching || matchesQuery(row, query)))
  const inDirection = (row: ScanRow) => !direction || directionOf(row) === direction
  const inStatus = (row: ScanRow) => !status || row.status === status
  const shown = matched.filter(row => inDirection(row) && inStatus(row))
  const moved = Math.round(base.reduce((sum, row) => sum + (rowUsd(row, bchUsd ?? undefined) ?? 0), 0))
  const loading = (searching && !walletRows) || (!!text && isScanAddress(text) && address !== text)
  const lookups = shown.length || searching ? [] : hashLookups(query)
  const chains = [...new Set(base.flatMap(row => [row.from.chain, row.to.chain]))]
  const stats: [string, React.ReactNode, number][] = [
    ['Transfers', <ArrowLeftRight key="all" size={18} aria-hidden />, base.length],
    ['Router', <Zap key="router" size={18} aria-hidden />, base.filter(row => row.router).length]
  ]

  return (
    <>
      <div className="scanner-head">
        <h1 className="scanner-title">
          Scanner <LiveDot live={live} />
        </h1>
        <Link href="/docs/stuck" className="scanner-help">
          <LifeBuoy size={16} aria-hidden />
          Transaction got stuck?
        </Link>
      </div>

      <dl className="scanner-stats">
        {stats.map(([label, icon, value]) => (
          <div key={label}>
            <dt>
              {icon}
              <span>{label}</span>
            </dt>
            <dd>
              <NumberTicker value={value} />
            </dd>
          </div>
        ))}
        <div title="Dollar-stable sides at face value, BCH at THORChain's price">
          <dt>
            <CircleDollarSign size={18} aria-hidden />
            <span>Moved</span>
          </dt>
          <dd>
            $<NumberTicker value={moved} />
          </dd>
        </div>
        <div>
          <dt>
            <span>Chains</span>
          </dt>
          <dd className="scanner-chains">
            <NumberTicker value={chains.length} />
            <span className="scanner-stack">
              {chains.map(chain => {
                const icon = chainIcon(chain)
                return (
                  icon && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={chain} src={icon} alt={chainName(chain)} title={chainName(chain)} width={26} height={26} />
                  )
                )
              })}
            </span>
          </dd>
        </div>
      </dl>

      <div className="scanner-tools">
        <label className="scanner-search">
          {searching ? <Wallet size={18} aria-hidden /> : <Search size={18} aria-hidden />}
          <span className="sr-only">Search transfers by wallet address, hash, token or chain</span>
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Wallet address, hash or token"
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button type="button" className="scanner-clear" aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={16} aria-hidden />
            </button>
          )}
        </label>
        <div className="scanner-filters" role="group" aria-label="Filter by mode">
          {FILTERS.map(([value, label, content]) => (
            <button key={value} type="button" aria-pressed={filter === value} aria-label={label} title={label} onClick={() => setFilter(value)}>
              {content}
            </button>
          ))}
        </div>
      </div>

      <div className="scanner-tools scanner-tools--facets">
        <Facets label="Filter by direction" value={direction} options={DIRECTIONS} count={d => matched.filter(row => directionOf(row) === d && inStatus(row)).length} onChange={setDirection} />
        <Facets
          label="Filter by status"
          value={status}
          options={STATUSES.map(([s, icon]) => [s, statusLabel(s), icon])}
          count={s => matched.filter(row => row.status === s && inDirection(row)).length}
          onChange={setStatus}
        />
      </div>

      {!query && wallets.length > 0 && (
        <div className="scanner-wallets" role="group" aria-label="Your wallets on this device">
          {wallets.map(wallet => (
            <button
              key={wallet.address}
              type="button"
              title={`${chainName(wallet.chain)} · ${wallet.address}`}
              aria-label={`Transfers of ${chainName(wallet.chain)} wallet ${shortAddress(wallet.address)}`}
              onClick={() => setQuery(wallet.address)}
            >
              <ChainMark chain={wallet.chain} size={18} />
              <span>{shortAddress(wallet.address)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="scanner-table" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="scanner-empty">
            <LoaderCircle size={28} className="scanner-spin" aria-hidden />
            <span className="sr-only">Looking up this wallet</span>
          </div>
        ) : shown.length > 0 ? (
          <ScanList rows={shown} now={now} />
        ) : (
          <div className="scanner-empty">
            <SearchX size={28} aria-hidden />
            <p>No match</p>
            {lookups.map(leg => (
              <a key={leg.label} href={leg.url} target="_blank" rel="noopener noreferrer">
                {leg.label}
                <ArrowUpRight size={14} aria-hidden />
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

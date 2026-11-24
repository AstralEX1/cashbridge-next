import type { Chain } from '@tcswap/core'
import { explorerTxUrl } from '@/lib/explorer'
import { getChainConfig } from '@tcswap/helpers'
import type { FeedOrder, OrderState } from '@/lib/auto-bridge-contract'
import { formatBaseUnits } from '@/lib/bridge'
import { FEATURED_TOKENS } from '@/lib/cauldron-tokens'
import { isDollarStable } from '@/lib/dollar-stable'
import type { Run } from '@/lib/mainnet-runs'
import { isEvmChain } from '@/lib/payout-chains'
import { nearExplorerUrl } from '@/lib/near-intents'

// The scanner's view of one transfer, from a Cashbridge Router order or from a run verified by hand.
export type ScanStatus = 'completed' | 'pending' | 'refunded' | 'review'
export interface ScanSide {
  amount?: string
  ticker: string
  chain: string
  icon?: string
  // The chain's mark on the coin, when the coin alone does not say which chain it is on.
  badge?: string
}
export interface ScanLeg {
  label: string
  url: string
  hash: string
  // The chain whose explorer the link opens.
  icon?: string
}
export interface ScanRow {
  key: string
  // Router orders carry the time they were created; a verified run carries its date as written in the proof table.
  time?: number
  date?: string
  router: boolean
  verified: boolean
  from: ScanSide
  to: ScanSide
  status: ScanStatus
  legs: ScanLeg[]
}

// Into Bitcoin Cash or out of it; a swap between two other chains (one this browser made) is neither.
export type ScanDirection = 'in' | 'out'
export const directionOf = ({ from, to }: Pick<ScanRow, 'from' | 'to'>): ScanDirection | undefined =>
  to.chain === 'BCH' && from.chain !== 'BCH' ? 'in' : from.chain === 'BCH' && to.chain !== 'BCH' ? 'out' : undefined

// What a transfer moved in US dollars: a dollar-stable side at face value, else its BCH side at `bchUsd`.
export const rowUsd = ({ from, to }: Pick<ScanRow, 'from' | 'to'>, bchUsd?: number) => {
  const value = (side: ScanSide, price: number) => (side.amount && Number(side.amount) > 0 ? Number(side.amount) * price : undefined)
  const stable = [from, to].find(side => isDollarStable(side.ticker))
  const bch = [from, to].find(side => side.chain === 'BCH' && side.ticker === 'BCH')
  return (stable && value(stable, 1)) ?? (bch && bchUsd ? value(bch, bchUsd) : undefined)
}

// Chains with a logo in public/networks (test/network-icons.test.mjs keeps this in step with the folder).
const CHAIN_ICONS = new Set([
  'ada', 'arb', 'aurora', 'avax', 'base', 'bch', 'bera', 'bsc', 'btc', 'dash', 'doge', 'eth', 'gaia', 'gno', 'kuji', 'ltc', 'maya', 'megaeth',
  'monad', 'near', 'noble', 'op', 'osmo', 'pol', 'sol', 'sui', 'tao', 'thor', 'ton', 'tron', 'xlayer', 'xlm', 'xmr', 'xrd', 'xrp', 'zec'
])
export const chainIcon = (chain: string) => (CHAIN_ICONS.has(chain.toLowerCase()) ? `/networks/${chain.toLowerCase()}.svg` : undefined)

const CHAIN_NAMES: Record<string, string> = {
  ARB: 'Arbitrum',
  AVAX: 'Avalanche',
  BASE: 'Base',
  BCH: 'Bitcoin Cash',
  BSC: 'BNB Chain',
  BTC: 'Bitcoin',
  DOGE: 'Dogecoin',
  ETH: 'Ethereum',
  GAIA: 'Cosmos',
  LTC: 'Litecoin',
  OP: 'Optimism',
  POL: 'Polygon',
  SOL: 'Solana',
  THOR: 'THORChain',
  TRON: 'TRON',
  TON: 'TON',
  XRP: 'XRP Ledger',
  ZEC: 'Zcash'
}
export const chainName = (chain: string) => CHAIN_NAMES[chain.toUpperCase()] ?? getChainConfig(chain.toUpperCase() as Chain)?.name ?? chain

// Coins with a mark in public/, and the chain each native coin belongs to.
const TICKER_ICONS: Record<string, string> = {
  BTC: 'btc', ETH: 'eth', BNB: 'bsc', AVAX: 'avax', SOL: 'sol', DOGE: 'doge', LTC: 'ltc', XRP: 'xrp', TRX: 'tron', ATOM: 'gaia', RUNE: 'thor', ZEC: 'zec', BCH: 'bch',
  ADA: 'ada', TON: 'ton', SUI: 'sui', NEAR: 'near', DASH: 'dash', MON: 'monad', BERA: 'bera', OKB: 'xlayer', XDAI: 'gno', POL: 'pol', CACAO: 'maya', XLM: 'xlm', XMR: 'xmr', TAO: 'tao'
}
const DOLLARS: Record<string, string> = { USDC: '/tokens/usdc.svg', USDT: '/tokens/usdt.svg' }
const NATIVE_CHAIN: Record<string, string> = { BNB: 'BSC', TRX: 'TRON', ATOM: 'GAIA', RUNE: 'THOR', MON: 'MONAD', OKB: 'XLAYER', XDAI: 'GNO', CACAO: 'MAYA' }
const mark = (ticker: string, chain: string, icon?: string): Pick<ScanSide, 'icon' | 'badge'> => {
  const t = ticker.toUpperCase()
  const own = icon ?? DOLLARS[t] ?? (TICKER_ICONS[t] && chainIcon(TICKER_ICONS[t]))
  const native = TICKER_ICONS[t] && (NATIVE_CHAIN[t] ?? t) === chain.toUpperCase()
  const badge = native ? undefined : chainIcon(chain)
  return { ...(own && { icon: own }), ...(badge && { badge }) }
}

// Explorers by address, for the chain mark on each step's link.
const EXPLORERS: [RegExp, string][] = [
  [/thorchain\.net|runescan/, 'thor'],
  [/near-intents/, 'near'],
  [/bitcoin-cash|bch\.|cashscript|salemkode|explorer\.selene/, 'bch'],
  [/bscscan/, 'bsc'],
  [/snowscan|snowtrace|avascan/, 'avax'],
  [/basescan/, 'base'],
  [/arbiscan/, 'arb'],
  [/optimistic\.etherscan/, 'op'],
  [/polygonscan/, 'pol'],
  [/etherscan/, 'eth'],
  [/solscan|solana\.fm/, 'sol'],
  [/tronscan/, 'tron'],
  [/xrpscan|xrpl/, 'xrp'],
  [/mintscan/, 'gaia'],
  [/blockchair\.com\/bitcoin\/|mempool\.space/, 'btc'],
  [/litecoin/, 'ltc'],
  [/dogecoin/, 'doge'],
  [/zcash/, 'zec'],
  [/blockchair\.com\/dash\//, 'dash'],
  [/tonscan|tonviewer/, 'ton'],
  [/suiscan|suivision/, 'sui'],
  [/cexplorer|cardanoscan/, 'ada'],
  [/nearblocks/, 'near'],
  [/monvision|monadexplorer/, 'monad'],
  [/x-layer/, 'xlayer'],
  [/berascan/, 'bera'],
  [/gnosisscan/, 'gno'],
  [/aurorascan|aurora\.dev/, 'aurora'],
  [/mayascan/, 'maya']
]
export const explorerIcon = (url: string) => {
  const found = EXPLORERS.find(([pattern]) => pattern.test(url))
  return found && chainIcon(found[1])
}
export const leg = (label: string, url: string, hash: string, mark?: string): ScanLeg => {
  const icon = mark ?? explorerIcon(url)
  return { label, url, hash, ...(icon && { icon }) }
}

const tokenOf = (category: string) => FEATURED_TOKENS.find(token => token.category === category)
const bchSide = (category: string, amount?: string): ScanSide => {
  const token = tokenOf(category)
  return {
    ticker: token?.ticker ?? `${category.slice(0, 6)}…`,
    chain: 'BCH',
    ...mark('', 'BCH', token?.icon),
    // A token outside the pinned list has unknown decimals here, so its amount is left to the explorer.
    ...(token && amount !== undefined && { amount: formatBaseUnits(amount, token.decimals) })
  }
}
// THORChain asset ids: CHAIN.TICKER or CHAIN.TICKER-CONTRACT.
const assetSide = (asset: string, amount?: string): ScanSide => {
  const [chain, rest = ''] = asset.split('.')
  const ticker = rest.split('-')[0] || chain
  return { ticker, chain, ...mark(ticker, chain), ...(amount !== undefined && { amount }) }
}

// One end of a transfer this page knows by its ticker and chain, e.g. a saved transfer's asset.
export const sideOf = (ticker: string, chain: string, amount?: string, icon?: string): ScanSide => {
  const token = chain.toUpperCase() === 'BCH' ? FEATURED_TOKENS.find(t => t.ticker === ticker) : undefined
  return { ticker, chain: chain.toUpperCase(), ...mark(ticker, chain, token?.icon ?? icon), ...(amount !== undefined && { amount }) }
}

export const thorchainTxUrl = (hash: string) => `https://thorchain.net/tx/${hash.replace(/^0x/i, '').toLowerCase()}`
export const bchTxUrl = (txid: string) => explorerTxUrl({ chain: 'BCH' as Chain, txHash: txid })
export const sourceTxUrl = (chain: string, hash: string) =>
  explorerTxUrl({ chain: chain as Chain, txHash: isEvmChain(chain) && /^[0-9a-f]{64}$/i.test(hash) ? `0x${hash}` : hash }) || thorchainTxUrl(hash)

const STATUS: Partial<Record<OrderState, ScanStatus>> = {
  completed: 'completed',
  refunded: 'refunded',
  source_refunded: 'refunded',
  manual_review: 'review'
}

// The bridge that carried the order's BCH leg, and its own tracker for that leg.
const bridgeOf = (order: FeedOrder) => (order.shapeshift ? 'ShapeShift' : order.near ? 'NEAR Intents' : 'THORChain')
const bridgeLeg = (order: FeedOrder, thorchainHash: string) =>
  !order.near
    ? leg('THORChain swap', thorchainTxUrl(thorchainHash), thorchainHash)
    : order.nearDeposit
      ? leg(`${bridgeOf(order)} swap`, nearExplorerUrl(order.nearDeposit), order.nearDeposit, order.shapeshift ? '/providers/shapeshift.svg' : undefined)
      : undefined

export const rowFromOrder = (order: FeedOrder): ScanRow => {
  const legs: ScanLeg[] = []
  const add = (step?: ScanLeg) => step && legs.push(step)
  const paid = order.settlement
  if (order.kind === 'forward') {
    if (order.sourceHash && order.source) {
      add(leg(`${chainName(order.source.chain)} deposit`, sourceTxUrl(order.source.chain, order.sourceHash), order.sourceHash))
      add(bridgeLeg(order, order.sourceHash))
    } else if (order.near) add(bridgeLeg(order, ''))
    for (const receipt of order.bchReceipts) add(leg('BCH to order', bchTxUrl(receipt.txid), receipt.txid))
    if (paid) add(leg(paid.kind === 'refund' ? 'BCH refund' : `${bchSide(order.category).ticker} payout`, bchTxUrl(paid.txid), paid.txid))
  } else {
    for (const receipt of order.bchReceipts) add(leg('Tokens to contract', bchTxUrl(receipt.txid), receipt.txid))
    if (paid?.kind === 'deposit') {
      add(leg(`Sale and ${bridgeOf(order)} deposit`, bchTxUrl(paid.txid), paid.txid))
      add(bridgeLeg(order, paid.txid))
    } else if (paid) add(leg('Refund', bchTxUrl(paid.txid), paid.txid))
  }
  const bch = (sats: string): ScanSide => ({ ticker: 'BCH', chain: 'BCH', ...mark('BCH', 'BCH'), amount: formatBaseUnits(sats, 8) })
  // An order saved without its source starts at the BCH that reached the Router.
  const from =
    order.kind === 'sale' && order.sale
      ? bchSide(order.category, order.sale.tokenAmount)
      : order.source
        ? assetSide(order.source.asset, order.source.amount)
        : bch(order.expectedBchSats)
  const to =
    order.kind === 'sale' && order.sale
      ? assetSide(order.sale.buyAsset)
      : paid?.kind === 'refund'
        ? bch(paid.bchAmount)
        : bchSide(order.category, paid?.tokenAmount)
  // Done as soon as the payout is on the network ('submitted'), not after the Router's confirmations. A sale's
  // deposit is not its payout: that lands on the other chain.
  const sent = order.state === 'submitted' && paid && paid.kind !== 'deposit' ? (paid.kind === 'refund' ? 'refunded' : 'completed') : undefined
  return { key: order.ref, time: order.createdAt, router: true, verified: false, from, to, status: sent ?? STATUS[order.state] ?? 'pending', legs }
}

const side = (text: string): ScanSide => {
  const [amount, ticker = ''] = text.trim().split(/\s+/)
  const token = FEATURED_TOKENS.find(t => t.ticker === ticker)
  const chain = token || ticker === 'BCH' ? 'BCH' : ticker === 'BNB' ? 'BSC' : ticker
  return { amount, ticker, chain, ...mark(ticker, chain, token?.icon) }
}

// A proof-table run: its amounts read "0.0062 BNB → 0.01639004 BCH → 3.39 PUSD", first and last are the two ends.
export const rowFromRun = (run: Run): ScanRow => {
  const amounts = run.amounts.split('→')
  return {
    key: run.links[0][1],
    date: run.date,
    router: !!run.router,
    verified: true,
    from: side(amounts[0]),
    to: side(amounts[amounts.length - 1]),
    status: 'completed',
    legs: run.links.map(([label, url]) => leg(label, url, url.slice(url.lastIndexOf('/') + 1)))
  }
}

// The day of Cash Bridge's first transfer (UTC). Earlier transfers, even of the same wallets, are not Cash Bridge's,
// so the scanner and its totals start here. A row without a time (a verified run) is listed by its own date.
export const SCAN_START = Date.UTC(2026, 10, 14)
const sinceStart = (row: ScanRow) => row.time === undefined || row.time >= SCAN_START

// Router orders first (newest first), then the verified runs, newest last-added first; a run the Router feed also lists is kept once.
export const scanRows = (orders: FeedOrder[], runs: Run[]) => {
  const live = orders.map(rowFromOrder).filter(sinceStart).sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
  const seen = new Set(live.flatMap(row => row.legs.map(leg => normalHash(leg.hash))))
  return [
    ...live,
    ...runs
      .map(rowFromRun)
      .reverse()
      .filter(row => !row.legs.some(leg => seen.has(normalHash(leg.hash))))
  ]
}

const normalHash = (hash: string) => hash.replace(/^0x/i, '').toLowerCase()

// The first row of each transfer, where rows from different sources share a transaction hash.
export const uniqueRows = (rows: ScanRow[]) => {
  const seen = new Set<string>()
  return rows.filter(row => {
    const hashes = [`key:${row.key}`, ...row.legs.map(leg => normalHash(leg.hash))]
    if (hashes.some(hash => seen.has(hash))) return false
    hashes.forEach(hash => seen.add(hash))
    return true
  })
}

// A wallet's transfers: its Router orders, then any listed transfer that shares a hash with its own saved or
// THORChain transfers (it carries more steps), then those; newest first.
export const walletRows = ({ router, feed, local, thorchain }: { router: FeedOrder[]; feed: ScanRow[]; local: ScanRow[]; thorchain: ScanRow[] }) => {
  const hashes = new Set([...local, ...thorchain].flatMap(row => row.legs.map(leg => normalHash(leg.hash))))
  const linked = feed.filter(row => row.legs.some(leg => hashes.has(normalHash(leg.hash))))
  return uniqueRows([...router.map(rowFromOrder), ...linked, ...local, ...thorchain].filter(sinceStart)).sort(
    (a, b) => (b.time ?? -1) - (a.time ?? -1)
  )
}

// One action from Midgard's /v2/actions: amounts are 1e8 base units for every asset.
interface MidgardTx {
  address: string
  txID: string
  coins: { asset: string; amount: string }[]
}
export interface MidgardAction {
  date: string
  status: string
  type: string
  in: MidgardTx[]
  out: MidgardTx[]
  metadata?: { swap?: { memo?: string }; refund?: { memo?: string } }
}
// Secured and trade assets (BTC-BTC, BTC~BTC) read as the chain asset they stand for.
const chainAsset = (asset: string) => (asset.includes('.') ? asset : asset.replace(/[-~/]/, '.'))
const BCH_TARGETS = ['BCH.BCH', 'BCH', 'C']
// THORChain carries no Cash Bridge tag, so its swaps into or out of BCH stand for the bridge.
const touchesBch = (action: MidgardAction) => {
  const memo = (action.metadata?.swap?.memo ?? action.metadata?.refund?.memo ?? '').split(':')
  return (
    [...action.in, ...action.out].some(tx => tx.coins.some(coin => chainAsset(coin.asset) === 'BCH.BCH')) ||
    (['=', 'S', 'SWAP'].includes(memo[0]?.toUpperCase()) && BCH_TARGETS.includes(memo[1]?.toUpperCase()))
  )
}
const realHash = (hash?: string) => !!hash && /^[0-9a-zA-Z]{32,128}$/.test(hash) && !/^0+$/.test(hash)
const units = (amount?: string) => (amount && /^\d{1,30}$/.test(amount) ? formatBaseUnits(amount, 8) : undefined)

// A wallet's THORChain swaps and refunds that bridge BCH, as scanner rows.
export const rowsFromThorchain = (actions: MidgardAction[]): ScanRow[] =>
  actions
    .filter(
      action =>
        (action?.type === 'swap' || action?.type === 'refund') &&
        Array.isArray(action.in) &&
        Array.isArray(action.out) &&
        [...action.in, ...action.out].every(tx => Array.isArray(tx?.coins)) &&
        action.in.length > 0 &&
        touchesBch(action)
    )
    .map(action => {
      const source = action.in[0]
      const coin = source.coins[0]
      const fromAsset = chainAsset(coin?.asset ?? 'THOR.RUNE')
      const refund = action.type === 'refund'
      const paid = action.out.flatMap(tx => tx.coins.map(c => ({ tx, asset: chainAsset(c.asset), amount: c.amount })))
      const payout = refund ? paid[0] : (paid.find(p => p.asset !== fromAsset) ?? paid[0])
      const legs: ScanLeg[] = []
      const fromChain = fromAsset.split('.')[0]
      if (realHash(source.txID)) {
        if (fromChain !== 'THOR') legs.push(leg(`${chainName(fromChain)} deposit`, sourceTxUrl(fromChain, source.txID), source.txID))
        legs.push(leg('THORChain swap', thorchainTxUrl(source.txID), source.txID))
      }
      for (const tx of action.out) {
        const chain = chainAsset(tx.coins[0]?.asset ?? '').split('.')[0]
        if (realHash(tx.txID) && chain && chain !== 'THOR') legs.push(leg(refund ? 'Refund' : 'Payout', sourceTxUrl(chain, tx.txID), tx.txID))
      }
      return {
        key: `thorchain:${source.txID}`,
        time: Math.floor(Number(action.date) / 1e6),
        router: false,
        verified: false,
        from: assetSide(fromAsset, units(coin?.amount)),
        to: payout ? assetSide(payout.asset, units(payout.amount)) : assetSide('BCH.BCH'),
        // A payout with its hash is on its way to the wallet: done, whatever THORChain still waits for.
        status: refund ? 'refunded' : action.status === 'success' || legs.some(item => item.label === 'Payout') ? 'completed' : 'pending',
        legs
      }
    })

export const matchesQuery = (row: ScanRow, query: string) => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hash = normalHash(q)
  return (
    row.legs.some(leg => normalHash(leg.hash).includes(hash)) ||
    [row.from, row.to].some(s => s.ticker.toLowerCase() === q || s.chain.toLowerCase() === q || chainName(s.chain).toLowerCase().includes(q))
  )
}

// Where to look up a hash the list does not have.
export const hashLookups = (query: string): ScanLeg[] => {
  const q = query.trim()
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(q)) return []
  return [
    leg('THORChain explorer', thorchainTxUrl(q), q),
    ...(q.startsWith('0x') ? [] : [leg('Bitcoin Cash explorer', bchTxUrl(q), q)])
  ]
}

export const shortHash = (hash: string) => (hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash)

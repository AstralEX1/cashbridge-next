import { isDollarStable } from '@/lib/dollar-stable'

// What the confirm screen states about a bridge, from live figures only: the THORChain quote, the
// pool prices in USD, and for PUSD the Cauldron quote on the BCH the first leg is expected to deliver.
// Display values, so plain numbers; amounts are in whole units (ETH, BCH, PUSD), prices in USD.
// Dollar stables (USDC, USDT, PUSD, …) are always valued at $1.

// The second leg's own time: one BCH confirmation is not waited for, the wallet signs and broadcasts.
export const PUSD_LEG_SECONDS = 60

export interface PusdLeg {
  // PUSD the trade buys, and what the same sale would buy at the pools' prices with no fee or impact.
  output: number
  spotOutput: number
  // BCH the trade sells, the pools' liquidity provider fee on it, and the trade transaction's miner fee.
  sell: number
  tradeFee: number
  minerFee?: number
}

export interface BridgeSummaryInput {
  sent: number
  sentUsd?: number
  // BCH the first leg delivers, and one BCH in USD.
  bch: number
  bchUsd?: number
  // THORChain fees taken from the route (outbound, liquidity, affiliate) and the source chain's gas, in USD.
  thorFeeUsd?: number
  sourceGasUsd?: number
  thorSeconds?: number
  // Cauldron destination ticker; dollar stables (PUSD, MUSD, …) are valued at $1.
  tokenTicker?: string
  pusd?: PusdLeg
}

export interface BridgeSummary {
  // What the user ends up with: PUSD for a PUSD destination, BCH otherwise.
  received: number
  receivedUsd?: number
  // Received per one unit sent.
  rate?: number
  gasUsd?: number
  bchGasUsd?: number
  seconds?: number
  // Everything lost between the sent value and the received value except gas, as USD and percent.
  impactUsd?: number
  impactPercent?: number
  cauldronFeeUsd?: number
  poolImpactUsd?: number
  // One PUSD in USD at the traded pools' prices.
  pusdUsd?: number
}

const known = (...values: (number | undefined)[]) => values.every(v => v !== undefined && Number.isFinite(v))

export const valueImpact = (sentUsd?: number, receivedUsd?: number) => {
  const impactUsd = known(sentUsd, receivedUsd) && sentUsd! > 0 ? receivedUsd! - sentUsd! : undefined
  return { impactUsd, impactPercent: impactUsd === undefined ? undefined : (impactUsd / sentUsd!) * 100 }
}

export const bridgeSummary = (input: BridgeSummaryInput): BridgeSummary => {
  const { sent, sentUsd, bch, bchUsd, thorFeeUsd, sourceGasUsd, thorSeconds, tokenTicker, pusd } = input
  const seconds = thorSeconds !== undefined && thorSeconds > 0 ? thorSeconds + (pusd ? PUSD_LEG_SECONDS : 0) : undefined

  if (!pusd) {
    const receivedUsd = known(bchUsd) ? bch * bchUsd! : undefined
    const { impactUsd, impactPercent } = valueImpact(sentUsd, receivedUsd)
    return {
      received: bch,
      receivedUsd,
      rate: sent > 0 ? bch / sent : undefined,
      gasUsd: sourceGasUsd,
      seconds,
      impactUsd,
      impactPercent,
      poolImpactUsd: known(impactUsd, thorFeeUsd) ? Math.min(0, impactUsd! + thorFeeUsd!) : undefined
    }
  }

  const pegged = !!tokenTicker && isDollarStable(tokenTicker)
  const pusdUsd = pegged ? 1 : known(bchUsd) && pusd.spotOutput > 0 ? (pusd.sell * bchUsd!) / pusd.spotOutput : undefined
  const receivedUsd = known(pusdUsd) ? pusd.output * pusdUsd! : undefined
  // BCH the trade does not spend comes back to the wallet as change; the miner fee is gas.
  const changeUsd = known(bchUsd) ? Math.max(0, bch - pusd.sell - (pusd.minerFee ?? 0)) * bchUsd! : undefined
  const bchGasUsd = known(bchUsd, pusd.minerFee) ? pusd.minerFee! * bchUsd! : undefined
  const keptUsd = known(receivedUsd, changeUsd) ? receivedUsd! + changeUsd! + (bchGasUsd ?? 0) : undefined
  const { impactUsd, impactPercent } = valueImpact(sentUsd, keptUsd)
  const cauldronFeeUsd = known(bchUsd) ? pusd.tradeFee * bchUsd! : undefined

  return {
    received: pusd.output,
    receivedUsd,
    rate: sent > 0 ? pusd.output / sent : undefined,
    gasUsd: known(sourceGasUsd) || known(bchGasUsd) ? (sourceGasUsd ?? 0) + (bchGasUsd ?? 0) : undefined,
    bchGasUsd,
    seconds,
    impactUsd,
    impactPercent,
    cauldronFeeUsd,
    poolImpactUsd: known(impactUsd, thorFeeUsd, cauldronFeeUsd) ? Math.min(0, impactUsd! + thorFeeUsd! + cauldronFeeUsd!) : undefined,
    pusdUsd
  }
}

// "$2.31", "<$0.01", and signed losses as "−$0.28".
export const formatUsd = (value: number) => {
  const abs = Math.abs(value)
  if (abs > 0 && abs < 0.01) return `${value < 0 ? '−' : ''}<$0.01`
  const text = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${value < 0 ? '−' : ''}$${text}`
}

export const formatPercent = (value: number) => `${value < 0 ? '−' : value > 0 ? '+' : ''}${Math.abs(value).toFixed(Math.abs(value) < 10 ? 2 : 1)}%`

// Whole minutes, at least one.
export const formatMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60))

// A rate or amount with a sensible number of significant digits.
export const formatAmount = (value: number, significant = 6) => {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return Number(value.toPrecision(significant)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

// One token in USD. Dollar stables are always $1; other CashTokens use the Cauldron pools' price
// (BCH sold per token at spot) times BCH's USD price. Without a BCH price only the $1 peg is left.
export const pusdUsdPrice = (bchUsd: number | undefined, leg?: { sell: number; spotOutput: number }, ticker?: string) => {
  if (ticker && isDollarStable(ticker)) return { price: 1, estimate: false }
  if (bchUsd !== undefined && Number.isFinite(bchUsd) && leg && leg.spotOutput > 0) return { price: (leg.sell * bchUsd) / leg.spotOutput, estimate: false }
  return { price: 1, estimate: true }
}

// THORChain signs and broadcasts the BCH outbound about this long after the swap.
export const OUTBOUND_BROADCAST_SECONDS = 90
// The aggregator's outbound time includes waiting for a BCH block (~10 min). The bridge accepts the
// BCH at 0 confirmations, so only time beyond that wait (THORChain's own outbound delay) counts.
const BCH_BLOCK_SECONDS = 600

// Seconds until the BCH of the first leg reaches the wallet: inbound confirmation and the swap as
// quoted, then the outbound broadcast (and any THORChain outbound delay), without a BCH block wait.
export const firstLegSeconds = (estimated?: { inbound?: number; swap?: number; outbound?: number; total?: number }) => {
  if (!estimated) return undefined
  const { inbound, swap, outbound } = estimated
  if (![inbound, swap, outbound].every(v => typeof v === 'number' && Number.isFinite(v))) return estimated.total || undefined
  return inbound! + swap! + Math.min(outbound!, OUTBOUND_BROADCAST_SECONDS) + Math.max(0, outbound! - BCH_BLOCK_SECONDS)
}

// The bridge by name. ShapeShift's BCH swaps are NEAR Intents swaps it quoted, so they carry both marks.
export const bridgeName = (via: { near?: boolean; shapeshift?: boolean }) => (via.shapeshift ? 'ShapeShift' : via.near ? 'NEAR Intents' : 'THORChain')

export const usdText = (value?: number) => (value === undefined || !Number.isFinite(value) ? undefined : formatUsd(value))
export const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

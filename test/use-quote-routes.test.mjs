// Route compare + NEAR first-leg quoting contracts for CashToken destinations.
// Run: npm run test:bridge (or node --test this file with the TS alias register).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BridgeConfig } from '../src/config.ts'
import { bestRoute, fundsTokenSale } from '../src/hooks/use-quote.ts'
import { nearQuoteBody, NEAR_BCH } from '../src/lib/near-intents.ts'
import { GAS_UNITS, gasCost, routeGasUnits } from '../src/lib/source-gas.ts'

const quoteSource = readFileSync(new URL('../src/hooks/use-quote.ts', import.meta.url), 'utf8')
const compareSource = readFileSync(new URL('../src/components/swap/route-compare.tsx', import.meta.url), 'utf8')
const flowToastsSource = readFileSync(new URL('../src/components/swap/flow-toasts.tsx', import.meta.url), 'utf8')
const pusdSource = readFileSync(new URL('../src/components/swap/pusd-swap.tsx', import.meta.url), 'utf8')
const prepareSource = readFileSync(new URL('../src/components/swap/auto-bridge-confirm.tsx', import.meta.url), 'utf8')

const usdc = {
  assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  decimals: 6,
  blockchain: 'base',
  symbol: 'USDC',
  price: 1,
  contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
}
const bch = { assetId: NEAR_BCH, decimals: 8, blockchain: 'bch', symbol: 'BCH', price: 200, contractAddress: null }

test('forward bridge quotes buy native BCH', () => {
  assert.equal(BridgeConfig.buyAsset, 'BCH.BCH')
  // buyAsset spans several lines once open-networks mode is present; pull the whole binding.
  const expression = quoteSource.match(/const buyAsset = ([\s\S]*?)\n  const sellAmount/)?.[1]?.trim()
  assert.ok(expression)
  const destination = new Function(
    'openNetworks',
    'reverse',
    'assetFrom',
    'assetTo',
    'BridgeConfig',
    `return (${expression})`
  )
  assert.equal(destination(false, false, { identifier: 'BASE.USDC' }, { identifier: 'PUSD' }, BridgeConfig), 'BCH.BCH')
  assert.equal(destination(false, false, { identifier: 'BASE.USDC' }, { identifier: 'ETH.ETH' }, BridgeConfig), 'BCH.BCH')
  assert.equal(destination(false, true, { identifier: 'BASE.USDC' }, { identifier: 'BCH.BCH' }, BridgeConfig), 'BASE.USDC')
  assert.equal(destination(true, false, { identifier: 'ETH.ETH' }, { identifier: 'BASE.USDC' }, BridgeConfig), 'BASE.USDC')
  assert.match(quoteSource, /buyAsset: openNetworks \|\| reverse \? buyAsset : BridgeConfig\.buyAsset/)
  const body = nearQuoteBody(
    { sellAsset: 'BASE.USDC-0X8335', buyAsset: BridgeConfig.buyAsset, sellAmount: '10', dry: true, slippageBps: 100, now: 0 },
    usdc,
    bch
  )
  assert.equal(body.destinationAsset, NEAR_BCH)
  assert.equal(body.originAsset, usdc.assetId)
})

test('routes stay visible while refetching; RouteCompare does not require a successful NEAR quote', () => {
  assert.match(quoteSource, /routes: error \? undefined : routes/)
  assert.doesNotMatch(compareSource, /if \(!routes\?\.near\) return null/)
  assert.match(compareSource, /nearAllowed/)
  assert.match(compareSource, /amountSet/)
  assert.match(compareSource, /ThorchainMark/)
  assert.match(compareSource, /NearMark/)
})

test('leaving a tracking flow keeps toasts via persist + background owner', () => {
  assert.match(flowToastsSource, /persist\?: boolean/)
  assert.match(pusdSource, /BackgroundBridgeToasts/)
  assert.match(pusdSource, /persistToasts: !terminal/)
})

test('bestRoute still prefers the higher payout and THORChain on a tie', () => {
  const thor = { expectedBuyAmount: '1' }
  assert.equal(bestRoute({ thorchain: thor, near: { expectedBuyAmount: '1.1' } }), 'near')
  assert.equal(bestRoute({ thorchain: thor, near: { expectedBuyAmount: '1' } }), 'thorchain')
  assert.equal(bestRoute({ thorchain: thor }), 'thorchain')
  assert.equal(bestRoute({ near: { expectedBuyAmount: '2' } }), 'near')
})

// A dry THORChain quote names its router as the target and the vault as the inbound address, and a spender for a token.
const thorToken = { targetAddress: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146', inboundAddress: '0x489db109a54f37ffe5464b86c0668ce84dd9cb02', meta: { approvalAddress: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146' } }
const thorNative = { targetAddress: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146', inboundAddress: '0xf577a1669eafca8c4de5226d7e28c1a41f7d4d57', meta: {} }

test('each route is charged the gas of what its wallet signs, the same rule for every bridge', () => {
  assert.equal(routeGasUnits(thorToken, { token: true }), GAS_UNITS.approve + GAS_UNITS.call.token)
  assert.equal(routeGasUnits(thorToken, { token: true, approved: true }), GAS_UNITS.call.token)
  assert.equal(routeGasUnits(thorNative, { token: false }), GAS_UNITS.call.native)
  // NEAR Intents and ShapeShift: a dry quote has no deposit address, a live one the same address twice; both are one transfer.
  assert.equal(routeGasUnits({}, { token: true }), GAS_UNITS.transfer.token)
  assert.equal(routeGasUnits({ targetAddress: '0xAbC', inboundAddress: '0xabc' }, { token: false }), 21_000n)
  // 100k gas at 2 gwei with ETH at $3,000 and BCH at $500: $0.60, 0.0012 BCH.
  const cost = gasCost(100_000n, 2_000_000_000n, 3000, 500)
  assert.ok(Math.abs(cost.usd - 0.6) < 1e-9 && Math.abs(cost.buy - 0.0012) < 1e-12)
  assert.equal(gasCost(100_000n, 1n, undefined, 500), undefined)
})

test('bestRoute ranks the payout net of each route\'s gas, and only when every route is priced', () => {
  const routes = { thorchain: { expectedBuyAmount: '0.0500' }, near: { expectedBuyAmount: '0.0495' } }
  assert.equal(bestRoute(routes), 'thorchain')
  assert.equal(bestRoute(routes, { thorchain: { buy: 0.0008 }, near: { buy: 0.0002 } }), 'near')
  assert.equal(bestRoute(routes, { thorchain: { buy: 0.0003 }, near: { buy: 0.0002 } }), 'thorchain')
  // One route without a price: gross amounts decide, as before.
  assert.equal(bestRoute(routes, { thorchain: { buy: 0.0008 } }), 'thorchain')
  assert.match(quoteSource, /const best = bestRoute\(usable, gas\)/)
  assert.match(compareSource, /gas\[key\]/)
})

test('Automatic prepare keeps a selected NEAR or ShapeShift route on it (no silent THOR fallback), and keeps no drafts', () => {
  const nearBranch = prepareSource.match(/if \(provider === ProviderName\.NEAR \|\| provider === SHAPESHIFT_PROVIDER\) \{([\s\S]*?)\n  \}\n\n  const quotes = await getQuotes/)?.[1]
  assert.ok(nearBranch, 'NEAR prepare must return before getQuotes')
  assert.doesNotMatch(nearBranch, /getQuotes/)
  assert.doesNotMatch(nearBranch, /quote\.deadline \?/, '1Click quote.deadline is the deposit address lifetime, not the refund deadline')
  // Automatic transfers keep no drafts: every prepare opens a new order, and a failed one is forgotten.
  assert.doesNotMatch(prepareSource, /const reusable = /)
  assert.match(prepareSource, /catch \(error\) \{\n    autoBridgeStore\.getState\(\)\.remove\(id\)/)
  assert.match(nearBranch, /return \{ reference: \{ \.\.\.ref, order: result\.order \}, route: result\.route \}/)
})

test('a forward route whose BCH cannot fund the token sale is not offered', () => {
  // ShapeShift's answers for 0.00156 and 5 USDT on Ethereum: 760 sats and 2,442,631 sats.
  assert.equal(fundsTokenSale({ expectedBuyAmount: '0.0000076' }), false)
  assert.equal(fundsTokenSale({ expectedBuyAmount: '0.02442631' }), true)
  assert.equal(fundsTokenSale(undefined), true)
  assert.match(quoteSource, /shapeshift:\s+shapeRoute\.status === 'fulfilled' && \(openNetworks \|\| reverse \|\| fundsTokenSale\(shapeRoute\.value\)\)/)
})

test('Any network route cards name the asset bought, not BCH', () => {
  assert.match(compareSource, /openNetworks \? buyAsset\?\.ticker : reverse \? payout\?\.ticker : 'BCH'/)
})

test('NEAR-only rows rank NEAR Intents and ShapeShift alike and only drop THORChain', () => {
  assert.match(quoteSource, /nearOnly && routes \? \{ \.\.\.routes, thorchain: undefined \} : routes/)
  assert.doesNotMatch(quoteSource, /nearOnly \? \(routes\?\.near \? 'near'/)
  assert.equal(bestRoute({ near: { expectedBuyAmount: '1.77102' }, shapeshift: { expectedBuyAmount: '1.93766' } }), 'shapeshift')
  assert.equal(bestRoute({ near: { expectedBuyAmount: '1.797605' }, shapeshift: { expectedBuyAmount: '1.775621' } }), 'near')
})

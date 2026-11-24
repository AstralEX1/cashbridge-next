// NEAR Intents (1Click) as the bridge's second route: token matching, the quote request, the route built from
// the answer, the status the tracker acts on, and the on-chain check of a payout without a memo.
// Run: npm run test:bridge
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hexToBin } from '@bitauth/libauth'
import { checkPayment, bindingFromPubkey, decodeTx, txidOf } from '../src/lib/bch.ts'
import { Chain, ProviderName } from '@tcswap/helpers'
import { catalogBalance, assetsFromNearTokens, findNearToken, nudgeNearDeposit, nearTxHash, getNearQuote, interpretNearStatus, isNearRoute, mergeNearAssets, nearAssetIdentifier, nearLegOf, nearQuoteBody, nearRoute, nearSlippageBps, NEAR_BCH } from '../src/lib/near-intents.ts'
import { isAssetInMode, isNearOnlyAsset } from '../src/hooks/use-assets.ts'
import { bestRoute } from '../src/hooks/use-quote.ts'
import { isBridgeRoute } from '../src/lib/api.ts'
import { BridgeConfig } from '../src/config.ts'
import { otherPubkey, outboundTx, PUSD, pubkey } from './fixtures/bridge-fixtures.mjs'

// Entries shaped as /v0/tokens lists them.
const TOKENS = [
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 1, contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { assetId: 'nep141:base.omft.near', decimals: 18, blockchain: 'base', symbol: 'ETH', price: 1800, contractAddress: null },
  { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH', price: 1800, contractAddress: null },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', decimals: 6, blockchain: 'sol', symbol: 'USDC', price: 1, contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 63000 },
  { assetId: '1cs_v1:btc:native:coin', decimals: 8, blockchain: 'btc', symbol: 'BTC(OMNI)', price: 63000 },
  { assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near', decimals: 6, blockchain: 'tron', symbol: 'USDT', price: 1, contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
  { assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL', price: 140, contractAddress: null },
  {
    assetId: 'nep141:sol-5ebsggvtubrd7shjge89k6nc2bnlzqgcjxb2ejrhtdbk.omft.near',
    decimals: 9,
    blockchain: 'sol',
    symbol: 'kV-gtSOLb',
    price: 1,
    contractAddress: '5EBsGgVTubrd7ShJgE89k6nC2bnLzqGCjXb2ejrhtdBK'
  },
  { assetId: 'nep141:arb.omft.near', decimals: 18, blockchain: 'arb', symbol: 'ETH', price: 1800, contractAddress: null },
  { assetId: 'nep141:xrp.omft.near', decimals: 6, blockchain: 'xrp', symbol: 'XRP', price: 1 },
  { assetId: 'nep141:gnosis.omft.near', decimals: 18, blockchain: 'gnosis', symbol: 'xDAI', price: 1, contractAddress: null },
  { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 3, contractAddress: 'wrap.near' },
  { assetId: 'nep141:sui.omft.near', decimals: 9, blockchain: 'sui', symbol: 'SUI', price: 2, contractAddress: null },
  { assetId: 'nep141:monad.omft.near', decimals: 18, blockchain: 'monad', symbol: 'MON', price: 1, contractAddress: null },
  { assetId: 'nep245:v2_1.omni.hot.tg:1117_', decimals: 9, blockchain: 'ton', symbol: 'GRAM', price: 1, contractAddress: null },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR',
    decimals: 6,
    blockchain: 'ton',
    symbol: 'USDT',
    price: 1,
    contractAddress: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
  },
  {
    assetId: 'nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near',
    decimals: 6,
    blockchain: 'sui',
    symbol: 'USDC',
    price: 1,
    contractAddress: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
  },
  { assetId: 'nep141:cardano.omft.near', decimals: 6, blockchain: 'cardano', symbol: 'ADA', price: 0.15, contractAddress: null },
  { assetId: NEAR_BCH, decimals: 8, blockchain: 'bch', symbol: 'BCH', price: 207, contractAddress: null }
]
const usdc = TOKENS[0]
const bch = TOKENS.at(-1)
const binding = bindingFromPubkey(pubkey, 0)

test('THORChain identifiers map to 1Click tokens by chain and contract, or by ticker for a chain’s own coin', () => {
  assert.equal(findNearToken(TOKENS, 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913')?.assetId, usdc.assetId)
  assert.equal(findNearToken(TOKENS, 'BASE.ETH')?.assetId, 'nep141:base.omft.near')
  assert.equal(findNearToken(TOKENS, 'ETH.ETH')?.assetId, 'nep141:eth.omft.near')
  assert.equal(findNearToken(TOKENS, 'BCH.BCH')?.assetId, NEAR_BCH)
  assert.equal(findNearToken(TOKENS, 'BTC.BTC')?.assetId, 'nep141:btc.omft.near')
  // THORChain upper-cases base58 contracts too.
  assert.equal(findNearToken(TOKENS, 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T')?.decimals, 6)
  assert.equal(findNearToken(TOKENS, 'SOL.USDC-EPJFWDD5AUFQSSQEM2QN1XZYBAPC8G4WEGGKZWYTDT1V')?.decimals, 6)
  assert.equal(findNearToken(TOKENS, 'BASE.USDC-0X0000000000000000000000000000000000000001'), undefined)
  // Ticker itself contains `-`: match by contract suffix, not the first dash.
  assert.equal(findNearToken(TOKENS, 'SOL.kV-gtSOLb-5EBsGgVTubrd7ShJgE89k6nC2bnLzqGCjXb2ejrhtdBK')?.assetId, TOKENS[8].assetId)
  assert.equal(findNearToken(TOKENS, 'ARB.ETH')?.assetId, 'nep141:arb.omft.near')
  // Not listed by 1Click, or a deposit that needs a memo the wallet send does not carry.
  assert.equal(findNearToken(TOKENS, 'DOGE.DOGE'), undefined)
  assert.equal(findNearToken(TOKENS, 'XRP.XRP'), undefined)
})

test('1Click rows become picker assets with findNearToken-compatible identifiers under NEAR', () => {
  assert.equal(nearAssetIdentifier(usdc), 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913')
  assert.equal(nearAssetIdentifier(TOKENS[3]), 'SOL.USDC-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  assert.equal(nearAssetIdentifier(TOKENS[8]), 'SOL.kV-gtSOLb-5EBsGgVTubrd7ShJgE89k6nC2bnLzqGCjXb2ejrhtdBK')
  assert.equal(nearAssetIdentifier(TOKENS[10]), undefined, 'XRP is not a mapped wallet chain')
  assert.equal(nearAssetIdentifier({ ...TOKENS[4], symbol: 'BTC(OMNI)', assetId: '1cs_v1:btc:native:coin' }), undefined)
  assert.equal(nearAssetIdentifier(TOKENS[11]), 'GNO.xDAI')
  assert.equal(nearAssetIdentifier(TOKENS[12]), 'NEAR.wNEAR-wrap.near')
  assert.equal(nearAssetIdentifier(TOKENS[13]), 'SUI.SUI')
  assert.equal(nearAssetIdentifier(TOKENS[14]), 'MONAD.MON')
  // 1Click calls Toncoin GRAM; the picker and wallets use the SDK's TON.
  assert.equal(nearAssetIdentifier(TOKENS[15]), 'TON.TON')
  assert.equal(findNearToken(TOKENS, 'TON.TON')?.assetId, TOKENS[15].assetId)
  // Jetton masters and Sui coin types keep their catalog case, which the wallet sends with.
  assert.equal(nearAssetIdentifier(TOKENS[16]), 'TON.USDT-EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')
  assert.equal(findNearToken(TOKENS, 'TON.USDT-EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')?.decimals, 6)
  assert.equal(nearAssetIdentifier(TOKENS[17]), 'SUI.USDC-0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC')
  assert.equal(findNearToken(TOKENS, 'SUI.USDC-0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC')?.decimals, 6)
  assert.equal(nearAssetIdentifier(TOKENS[18]), 'ADA.ADA')
  const ton = assetsFromNearTokens(TOKENS).filter(a => a.chain === Chain.Ton)
  assert.deepEqual(ton.map(a => [a.ticker, a.address, a.logoURI]), [
    ['TON', undefined, '/networks/ton.svg'],
    ['USDT', 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', '/tokens/usdt.svg']
  ])

  const assets = assetsFromNearTokens(TOKENS)
  assert.ok(assets.every(a => a.providers.length === 1 && a.providers[0] === ProviderName.NEAR), 'NEAR-only stamp; never THORCHAIN')
  const solUsdc = assets.find(a => a.identifier === 'SOL.USDC-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  assert.equal(solUsdc?.chain, 'SOL')
  assert.equal(solUsdc?.decimals, 6)
  assert.equal(solUsdc?.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  assert.notEqual(solUsdc?.address, solUsdc.address.toUpperCase(), 'Solana mint stays case-exact for wallet send')
  assert.equal(findNearToken(TOKENS, solUsdc.identifier)?.assetId, TOKENS[3].assetId)
  const arbEth = assets.find(a => a.identifier === 'ARB.ETH')
  assert.equal(arbEth?.ticker, 'ETH')
  assert.equal(arbEth?.address, undefined, 'native gas has no contract')
  assert.equal(findNearToken(TOKENS, arbEth.identifier)?.blockchain, 'arb')
  assert.equal(assets.some(a => a.identifier === 'XRP.XRP'), false)
  assert.equal(assets.find(a => a.identifier === 'GNO.xDAI')?.chain, 'GNO')
  assert.equal(assets.find(a => a.identifier === 'NEAR.wNEAR-wrap.near')?.address, 'wrap.near')
  assert.equal(findNearToken(TOKENS, 'NEAR.wNEAR-wrap.near')?.assetId, 'nep141:wrap.near')
  assert.equal(isAssetInMode(solUsdc), BridgeConfig.nearIntents)
  assert.equal(isNearOnlyAsset(solUsdc), true)
  assert.equal(isNearOnlyAsset({ ...solUsdc, providers: [ProviderName.THORCHAIN, ProviderName.NEAR] }), false)
})

test('native vs contract identity stays exact; dashed tickers and malformed catalog are rejected or deduped', () => {
  const withWeth = [
    ...TOKENS,
    { assetId: 'nep141:base-0x4200000000000000000000000000000000000006.omft.near', decimals: 18, blockchain: 'base', symbol: 'WETH', price: 1, contractAddress: '0x4200000000000000000000000000000000000006' }
  ]
  assert.equal(findNearToken(withWeth, 'BASE.ETH')?.assetId, 'nep141:base.omft.near')
  assert.equal(findNearToken(withWeth, 'BASE.ETH')?.contractAddress ?? null, null)
  assert.equal(findNearToken(withWeth, 'BASE.WETH-0X4200000000000000000000000000000000000006')?.symbol, 'WETH')
  assert.notEqual(findNearToken(withWeth, 'BASE.ETH')?.assetId, findNearToken(withWeth, 'BASE.WETH-0X4200000000000000000000000000000000000006')?.assetId)

  const dashed = assetsFromNearTokens([TOKENS[8]])
  assert.equal(dashed[0]?.identifier, 'SOL.kV-gtSOLb-5EBsGgVTubrd7ShJgE89k6nC2bnLzqGCjXb2ejrhtdBK')
  assert.equal(findNearToken([TOKENS[8]], dashed[0].identifier)?.assetId, TOKENS[8].assetId)

  const malformed = [
    null,
    undefined,
    { assetId: '', decimals: 6, blockchain: 'eth', symbol: 'X', price: 1 },
    { assetId: 'x', decimals: NaN, blockchain: 'eth', symbol: 'X', price: 1 },
    { assetId: 'x', decimals: 6.5, blockchain: 'eth', symbol: 'FRAC', price: 1, contractAddress: '0x1111111111111111111111111111111111111111' },
    { assetId: 'x', decimals: 6, blockchain: 'eth', symbol: '', price: 1 },
    { assetId: 'x', decimals: 6, blockchain: 'eth', symbol: 'BAD', price: 1, contractAddress: '   ' },
    { assetId: 'x', decimals: 6, blockchain: 'xrp', symbol: 'XRP', price: 1 },
    { assetId: 'dup', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 1, contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    { assetId: 'dup2', decimals: 8, blockchain: 'base', symbol: 'USDC', price: 1, contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }
  ]
  const cleaned = assetsFromNearTokens(malformed)
  assert.equal(cleaned.length, 1, 'null/fractional decimals/blank contract rejected; EVM duplicates collapse to first')
  assert.equal(cleaned[0].decimals, 6)
  assert.equal(cleaned[0].providers.includes(ProviderName.THORCHAIN), false)
  assert.deepEqual(assetsFromNearTokens(undefined), [])
})

test('Solana mint identity is case-sensitive: distinct rows, exact lookup, unambiguous legacy only', () => {
  const mintA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const mintB = 'ePjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const a = { assetId: 'a', decimals: 6, blockchain: 'sol', symbol: 'A', price: 1, contractAddress: mintA }
  const b = { assetId: 'b', decimals: 6, blockchain: 'sol', symbol: 'A', price: 1, contractAddress: mintB }
  const rows = assetsFromNearTokens([a, b])
  assert.equal(rows.length, 2, 'case-distinct Solana mints stay two picker rows')
  assert.deepEqual(rows.map(r => r.address).sort(), [mintA, mintB].sort())
  assert.equal(findNearToken([a, b], `SOL.A-${mintB}`)?.assetId, 'b', 'exact mint wins over case-folded twin')
  assert.equal(findNearToken([a, b], `SOL.A-${mintA}`)?.assetId, 'a')
  assert.equal(findNearToken([a, b], `SOL.A-${mintA.toUpperCase()}`), undefined, 'ambiguous uppercase aggregator match fails closed')
  assert.equal(findNearToken([a], `SOL.A-${mintA.toUpperCase()}`)?.assetId, 'a', 'legacy uppercase ok when only one mint matches')

  const map = new Map()
  mergeNearAssets(map, [a, b])
  assert.equal(map.size, 2, 'merge keeps both canonical mints')
  const thorUpper = {
    address: mintA.toUpperCase(),
    chain: Chain.Solana,
    chainId: 'solana',
    decimals: 6,
    identifier: `SOL.A-${mintA.toUpperCase()}`,
    name: 'A',
    providers: [ProviderName.THORCHAIN],
    ticker: 'A'
  }
  const withThor = new Map([[`${thorUpper.chain}-${thorUpper.identifier}`.toLowerCase(), { ...thorUpper, providers: [...thorUpper.providers] }]])
  mergeNearAssets(withThor, [a, b])
  const restored = [...withThor.values()].find(asset => asset.providers.includes(ProviderName.THORCHAIN))
  assert.equal(restored.address, mintA.toUpperCase(), 'ambiguous THOR identity is not rewritten to the first catalog mint')
  assert.deepEqual(restored.providers, [ProviderName.THORCHAIN], 'ambiguous legacy identity must not gain NEAR authority')
  assert.equal(withThor.size, 3, 'both exact NEAR mints stay separate from unresolved THOR identity')
  assert.equal([...withThor.values()].some(asset => asset.address === mintB), true, 'other case-sensitive mint not overwritten')
})

test('token lookup skips malformed rows and does not normalize an unknown mixed-case mint', () => {
  const token = TOKENS[3]
  assert.equal(findNearToken([null, token], `SOL.USDC-${token.contractAddress}`)?.assetId, token.assetId)
  const unknown = token.contractAddress.replace('Auf', 'auF')
  assert.equal(findNearToken([token], `SOL.USDC-${unknown}`), undefined)
})

test('mergeNearAssets tags overlap with NEAR, restores Solana case, and leaves THOR alone on catalog failure', () => {
  const thorSol = {
    address: 'EPJFWDD5AUFQSSQEM2QN1XZYBAPC8G4WEGGKZWYTDT1V',
    chain: Chain.Solana,
    chainId: 'solana',
    decimals: 6,
    identifier: 'SOL.USDC-EPJFWDD5AUFQSSQEM2QN1XZYBAPC8G4WEGGKZWYTDT1V',
    name: 'USDC',
    providers: [ProviderName.THORCHAIN],
    ticker: 'USDC'
  }
  const thorBtc = {
    chain: Chain.Bitcoin,
    chainId: 'bitcoin',
    decimals: 8,
    identifier: 'BTC.BTC',
    name: 'Bitcoin',
    providers: [ProviderName.THORCHAIN],
    ticker: 'BTC',
    logoURI: '/networks/btc.svg'
  }
  const map = new Map([
    [`${thorSol.chain}-${thorSol.identifier}`.toLowerCase(), { ...thorSol, providers: [...thorSol.providers] }],
    [`${thorBtc.chain}-${thorBtc.identifier}`.toLowerCase(), { ...thorBtc, providers: [...thorBtc.providers] }]
  ])
  const before = map.size
  mergeNearAssets(map, [])
  assert.equal(map.size, before, 'empty catalog (failure path) keeps the THOR list')
  assert.equal(isNearOnlyAsset(map.get(`${thorBtc.chain}-${thorBtc.identifier}`.toLowerCase())), false)

  mergeNearAssets(map, TOKENS)
  const mergedSol = [...map.values()].find(a => a.ticker === 'USDC' && a.chain === Chain.Solana)
  assert.ok(mergedSol.providers.includes(ProviderName.THORCHAIN) && mergedSol.providers.includes(ProviderName.NEAR))
  assert.equal(isNearOnlyAsset(mergedSol), false)
  assert.equal(mergedSol.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'wallet send gets case-exact mint')
  assert.match(mergedSol.identifier, /EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/)

  const nearOnly = [...map.values()].find(a => a.identifier === 'ARB.ETH')
  assert.ok(nearOnly)
  assert.equal(isNearOnlyAsset(nearOnly), true)
  assert.deepEqual(nearOnly.providers, [ProviderName.NEAR])
  const btc = map.get(`${thorBtc.chain}-${thorBtc.identifier}`.toLowerCase())
  assert.equal(btc.identifier, 'BTC.BTC', 'default sell BTC.BTC untouched — no rewrite to ETH')
  assert.equal(btc.providers.includes(ProviderName.THORCHAIN), true)
  assert.equal(isNearOnlyAsset(btc), false)
})

test('a forward quote asks exact input in base units, pays the plain BCH address and refunds the source', () => {
  const now = Date.parse('2030-01-01T07:00:00Z')
  const body = nearQuoteBody({ sellAsset: 'BASE.USDC-0X8335', buyAsset: 'BCH.BCH', sellAmount: '5.1234567', recipient: binding.cashAddress, refundTo: '0xabc', dry: false, slippageBps: 100, now }, usdc, bch)
  assert.equal(body.amount, '5123456', 'extra precision is cut, never rounded up')
  assert.equal(body.swapType, 'EXACT_INPUT')
  assert.equal(body.recipient, binding.cashAddress)
  assert.ok(body.recipient.startsWith('bitcoincash:q'), '1Click refuses token-aware z… addresses')
  assert.equal(body.refundTo, '0xabc')
  assert.equal(body.deadline, '2030-01-01T09:00:00.000Z', 'two hours: a Bitcoin deposit can take about one to confirm')
  assert.equal(body.originAsset, usdc.assetId)
  assert.equal(body.destinationAsset, NEAR_BCH)
  assert.equal(body.dry, false)
})

test('a dry quote carries placeholder addresses of each side’s chain, and coming out waits longer', () => {
  const now = 0
  const forward = nearQuoteBody({ sellAsset: 'x', buyAsset: 'BCH.BCH', sellAmount: '1', dry: true, slippageBps: 100, now }, usdc, bch)
  assert.ok(forward.recipient.startsWith('bitcoincash:q'))
  assert.ok(forward.refundTo.startsWith('0x'))
  const fromBitcoin = nearQuoteBody({ sellAsset: 'BTC.BTC', buyAsset: 'BCH.BCH', sellAmount: '0.0001', dry: true, slippageBps: 100, now }, TOKENS[4], bch)
  assert.equal(fromBitcoin.refundTo, '122ALQhLw63cHbrSnTG9uuUao8SNd3S7K2', 'a refund placeholder of the source chain')
  assert.equal(fromBitcoin.amount, '10000')
  const reverse = nearQuoteBody({ sellAsset: 'BCH.BCH', buyAsset: 'x', sellAmount: '0.1', dry: true, slippageBps: 100, flexible: true, now }, bch, usdc)
  assert.ok(reverse.refundTo.startsWith('bitcoincash:'))
  assert.equal(reverse.swapType, 'FLEX_INPUT')
  assert.equal(Date.parse(reverse.deadline), 4 * 60 * 60_000)
})

const answer = {
  correlationId: 'c0ffee',
  timestamp: '2030-01-01T07:00:00.000Z',
  signature: 'ed25519:sig',
  quote: {
    depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8',
    amountIn: '5000000',
    amountInFormatted: '5',
    minAmountIn: '5000000',
    amountOut: '2400565',
    amountOutFormatted: '0.02400565',
    minAmountOut: '2376559',
    deadline: '2030-01-01T08:00:00.000Z',
    timeEstimate: 152
  }
}

test('the 1Click answer becomes a NEAR route the bridge checks like any other', () => {
  const request = { sellAsset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', buyAsset: 'BCH.BCH', sellAmount: '5', recipient: binding.cashAddress, refundTo: '0xabc', sourceAddress: '0xabc', dry: false, slippageBps: 100 }
  const route = nearRoute(answer, request, usdc, bch)
  assert.ok(isNearRoute(route))
  assert.equal(route.sellAmount, '5')
  assert.equal(route.expectedBuyAmount, '0.02400565')
  assert.equal(route.expectedBuyAmountMaxSlippage, '0.02376559')
  assert.equal(route.inboundAddress, answer.quote.depositAddress)
  assert.equal(route.expiration, String(Date.parse(answer.quote.deadline) / 1000))
  assert.equal(route.estimatedTime.total, 152)
  assert.equal(route.memo, undefined)
  assert.equal(route.meta.near.sellAsset, usdc.assetId, 'the deposit plugin needs it')
  assert.ok(isBridgeRoute(route, { sellAsset: request.sellAsset, destinationAddress: binding.cashAddress }))
  assert.ok(isBridgeRoute(route, { sellAsset: request.sellAsset, destinationAddress: binding.tokenAddress }), 'z… and q… pay the same script')
  assert.equal(isBridgeRoute(route, { sellAsset: request.sellAsset, destinationAddress: bindingFromPubkey(otherPubkey, 0).cashAddress }), false)
  // A route that only claims to be NEAR's (no 1Click answer kept) is not one this app built.
  const { near, ...claimed } = route
  assert.equal(isBridgeRoute(claimed, { sellAsset: request.sellAsset }), false)
  assert.deepEqual(nearLegOf(route), {
    depositAddress: answer.quote.depositAddress,
    correlationId: 'c0ffee',
    signature: 'ed25519:sig',
    quotedAt: answer.timestamp,
    deadline: answer.quote.deadline,
    amountIn: '5000000',
    amountOut: '2400565',
    minAmountOut: '2376559'
  })
  assert.ok(near)
})

test('a NEAR route expires when its refund starts, not when its deposit address goes inactive', () => {
  const request = { sellAsset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', buyAsset: 'BCH.BCH', sellAmount: '5', recipient: binding.cashAddress, refundTo: '0xabc', dry: false, slippageBps: 100 }
  const echoed = { ...answer, quoteRequest: { deadline: '2030-01-01T09:00:00.000Z' }, quote: { ...answer.quote, deadline: '2030-01-04T07:00:00.000Z' } }
  const route = nearRoute(echoed, request, usdc, bch)
  assert.equal(route.expiration, String(Date.parse('2030-01-01T09:00:00.000Z') / 1000))
  assert.equal(nearLegOf(route).deadline, '2030-01-01T09:00:00.000Z')
})

test('an executable NEAR quote that needs a deposit memo is refused', async t => {
  const original = globalThis.fetch
  t.after(() => (globalThis.fetch = original))
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/tokens')) return Response.json([usdc, bch])
    const body = JSON.parse(init.body)
    return Response.json({ ...answer, quoteRequest: body, quote: { ...answer.quote, depositMemo: '12345' } })
  }
  await assert.rejects(
    getNearQuote({ sellAsset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', buyAsset: 'BCH.BCH', sellAmount: '5', recipient: binding.cashAddress, refundTo: '0xabc', dry: false, slippageBps: 100 }),
    /deposit memo/
  )
})

test('the better route is taken, THORChain on a tie or when NEAR does not quote', () => {
  const thor = { expectedBuyAmount: '0.024' }
  assert.equal(bestRoute({ thorchain: thor, near: { expectedBuyAmount: '0.0241' } }), 'near')
  assert.equal(bestRoute({ thorchain: thor, near: { expectedBuyAmount: '0.024' } }), 'thorchain')
  assert.equal(bestRoute({ thorchain: thor }), 'thorchain')
  assert.equal(bestRoute({ near: { expectedBuyAmount: '0.01' } }), 'near')
  assert.equal(bestRoute(undefined), undefined)
  assert.equal(nearSlippageBps(1), 100)
  assert.equal(nearSlippageBps(undefined), 100)
  assert.equal(nearSlippageBps(0.5), 50)
})

test('1Click status: payout hashes are pointers to check on chain; refunds, failures and short deposits are told apart', () => {
  const paid = { hash: 'ab'.repeat(32), explorerUrl: '' }
  assert.deepEqual(interpretNearStatus({ status: 'SUCCESS', swapDetails: { destinationChainTxHashes: [paid], amountOut: '1' } }), { kind: 'paid', txids: [paid.hash], amountOut: '1' })
  assert.equal(interpretNearStatus({ status: 'SUCCESS', swapDetails: {} }).kind, 'pending')
  assert.equal(interpretNearStatus({ status: 'PROCESSING', swapDetails: { destinationChainTxHashes: [paid] } }).kind, 'paid', 'a payout on its way counts')
  assert.equal(interpretNearStatus({ status: 'PENDING_DEPOSIT' }).kind, 'pending')
  assert.equal(interpretNearStatus({ status: 'KNOWN_DEPOSIT_TX' }).kind, 'pending')
  assert.ok(interpretNearStatus({ status: 'INCOMPLETE_DEPOSIT' }).detail)
  assert.deepEqual(interpretNearStatus({ status: 'REFUNDED', swapDetails: { refundedAmount: '4990000', refundedAmountFormatted: '4.99', refundReason: 'X' } }), {
    kind: 'refunded',
    amount: '499000000',
    reason: 'X'
  })
  assert.equal(interpretNearStatus({ status: 'FAILED' }).kind, 'failed')
})

test('a payout without a memo is counted only from its plain outputs to the bound address', () => {
  const ownScript = hexToBin(binding.lockingBytecode)
  const hex = outboundTx({ to: ownScript, amount: 2_400_000n, memo: 'anything' })
  const raw = { hex, tx: decodeTx(hex) }
  const txid = txidOf(hex)
  const ok = checkPayment(raw, binding.lockingBytecode, { tip: 10, utxos: [{ txid, vout: 0, value: 2_400_000n, height: 0, hasToken: false }] })
  assert.equal(ok.kind, 'ok')
  assert.equal(ok.total, '2400000')
  assert.equal(ok.outputs[0].unspent, true)
  assert.equal(ok.confirmations, 0)
  const other = bindingFromPubkey(otherPubkey, 0)
  assert.equal(checkPayment(raw, other.lockingBytecode, { tip: 10, utxos: [] }).kind, 'invalid')
  const tokenHex = outboundTx({ to: ownScript, amount: 1000n, token: { category: hexToBin(PUSD), amount: 1n } })
  assert.equal(checkPayment({ hex: tokenHex, tx: decodeTx(tokenHex) }, binding.lockingBytecode, { tip: 10, utxos: [] }).kind, 'invalid')
})

test('TON native catalogue entries match SDK gas balances and both TON and legacy GRAM identifiers', () => {
  const native = { assetId: 'nep141:ton.omft.near', blockchain: 'ton', symbol: 'GRAM', decimals: 9 }
  const master = 'EQCxE6mUtQJKFnwDF4';
  const usdt = { assetId: 'nep141:ton-usdt.omft.near', blockchain: 'ton', symbol: 'USDT', decimals: 6, contractAddress: master }
  const assets = assetsFromNearTokens([native, usdt])
  assert.equal(assets[0].identifier, 'TON.TON')
  assert.equal(assets[0].ticker, 'TON')
  assert.equal(findNearToken([native], 'TON.TON'), native)
  assert.equal(findNearToken([native], 'TON.GRAM'), native)
  assert.equal(assets[1].address, master)
  const balance = catalogBalance(assets[0], '1500000000')
  assert.equal(balance.isGasAsset, true)
  assert.equal(balance.getValue('string'), '1.5')
})

test('1Click rows show the coin’s own logo: CoinGecko by catalog id, then per-token fixes, then the old marks', async () => {
  const { nearTokenLogo, thorchainTokenLogo } = await import('../src/lib/token-logos.ts')
  const { existsSync } = await import('node:fs')
  const row = (blockchain, symbol, contractAddress, coingeckoId, assetId = `nep141:${blockchain}-${contractAddress ?? symbol}.omft.near`) => ({
    assetId, decimals: 18, blockchain, symbol, price: 1, contractAddress, coingeckoId
  })
  const [opEth, trump, cnear, unknownCoin, unknownNative] = assetsFromNearTokens([
    row('op', 'ETH', undefined, 'ethereum'),
    row('sol', 'TRUMP', '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', 'official-trump'),
    row('near', 'cNEAR', 'cnear.assetize.near', undefined, 'nep141:cnear.assetize.near'),
    row('base', 'NEWCOIN', '0x0000000000000000000000000000000000000001', 'not-on-the-list'),
    row('arb', 'ETH', undefined, undefined)
  ])
  assert.match(opEth.logoURI, /coingecko\.com\/coins\/images\/279\//, 'ETH on Optimism is the ETH coin, not the OP network mark')
  assert.match(trump.logoURI, /coingecko\.com\/coins\/images\/53746\//)
  assert.equal(cnear.logoURI, '/tokens/cnear.webp')
  assert.equal(unknownCoin.logoURI, undefined, 'no guess: the icon falls back to the ticker letter')
  assert.equal(unknownNative.logoURI, '/networks/arb.svg')
  for (const id of ['nep141:abg-966.meme-cooking.near', 'nep141:noear-324.meme-cooking.near', 'nep141:gnear-229.meme-cooking.near', 'nep141:itlx.intellex_xyz.near', 'nep141:cnear.assetize.near']) {
    const logo = nearTokenLogo({ assetId: id })
    assert.ok(logo && existsSync(new URL(`../public${logo}`, import.meta.url)), `${id} has its file in public/`)
  }
  assert.match(thorchainTokenLogo('ETH.VTHOR-0x815C23eCA83261b6Ec689b60Cc4a58b54BC24D8D', 'https://gone.example/vthor.png'), /static\.thorswap\.net/)
  assert.equal(thorchainTokenLogo('ETH.ETH', 'https://kept.example/eth.png'), 'https://kept.example/eth.png')
})

test('the 1Click deposit notice repeats once a minute while 1Click still waits for the deposit, in the chain\'s hash form', () => {
  const sent = []
  const submit = async (...notice) => (sent.push(notice), true)
  const pending = { status: 'PENDING_DEPOSIT' }
  assert.equal(nudgeNearDeposit(pending, 'dep-a', undefined, submit, 0), false, 'no hash yet')
  assert.equal(nudgeNearDeposit({ status: 'KNOWN_DEPOSIT_TX' }, 'dep-a', 'h', submit, 0), false, '1Click has it')
  assert.equal(nudgeNearDeposit(pending, 'dep-a', 'h', submit, 1000), true)
  assert.equal(nudgeNearDeposit(pending, 'dep-a', 'h', submit, 30_000), false, 'not again within a minute')
  assert.equal(nudgeNearDeposit(pending, 'dep-b', 'h2', submit, 30_000), true, 'each deposit address on its own')
  assert.equal(nudgeNearDeposit(pending, 'dep-a', 'h', submit, 61_000), true)
  assert.deepEqual(sent, [['dep-a', 'h'], ['dep-b', 'h2'], ['dep-a', 'h']])
  assert.equal(nearTxHash(`0x${'12'.repeat(20)}`, 'ab'.repeat(32)), `0x${'ab'.repeat(32)}`)
  assert.equal(nearTxHash('bitcoincash:qrmu5j4fqddjpgttkwl8p820vynrwy969vs0gmpelz', 'ab'.repeat(32)), 'ab'.repeat(32))
  assert.equal(nearTxHash('cosmos1deposit', `${'ab'.repeat(32)}-2`), 'ab'.repeat(32))
})

test('a catalog token the SDK token list lacks is sent in its catalog decimals, not the chain default', async () => {
  const { AssetValue } = await import('@tcswap/helpers')
  const monadUsdc = { assetId: 'nep141:monad-0x754704bc059f8c67012fed69bc8a327a5aafb603.omft.near', decimals: 6, blockchain: 'monad', symbol: 'USDC', price: 1, contractAddress: '0x754704bc059f8c67012fed69bc8a327a5aafb603' }
  const nearToken = { assetId: 'nep141:token.example.near', decimals: 18, blockchain: 'near', symbol: 'EXT', price: 1, contractAddress: 'token.example.near' }
  const [usdc, ext] = assetsFromNearTokens([monadUsdc, nearToken])
  // The NEAR Intents and ShapeShift plugins build the deposit amount this way (no async token lookup).
  assert.equal(AssetValue.from({ asset: usdc.identifier, value: '1.5' }).getBaseValue('string'), '1500000')
  assert.equal(AssetValue.from({ asset: ext.identifier, value: '2' }).getBaseValue('string'), '2000000000000000000')
  assert.equal(AssetValue.from({ asset: ext.identifier, value: '2' }).address, 'token.example.near')
})

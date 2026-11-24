import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import * as api from '../src/lib/api.ts'

const storage = new Map()
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key)
}
globalThis.window = { localStorage: globalThis.localStorage, location: { origin: 'https://cashbridge.example', search: '' } }

const request = { sellAsset: 'ETH.ETH', buyAsset: 'BTC.BTC', sellAmount: '1', providers: ['THORCHAIN'] }
const route = { ...request, expectedBuyAmount: '0.03', destinationAddress: 'bc1qdestination', memo: '=:BTC.BTC:bc1qdestination:0' }

test('a free-pair quote forwards both selected assets while the bridge quote stays BCH-only', async t => {
  let sent
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body)
    return Response.json({ routes: [route] })
  })
  const result = await (api.getNetworkQuotes ?? api.getQuotes)(request)
  assert.equal(sent.buyAsset, 'BTC.BTC')
  assert.equal(result[0].buyAsset, 'BTC.BTC')
  await assert.rejects(api.getQuotes(request), /Only BCH.BCH/)
})

test('free-pair executable quotes reject another destination, pair, provider, or memo recipient', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ routes: [
    route,
    { ...route, buyAsset: 'BCH.BCH' },
    { ...route, destinationAddress: 'bc1qother' },
    { ...route, memo: '=:BTC.BTC:bc1qother:0' },
    { ...route, memo: '=:ETH.ETH:bc1qdestination:0' },
    { ...route, providers: ['NEAR'] }
  ] }))
  const quotes = await (api.getNetworkQuotes ?? api.getQuotes)({ ...request, destinationAddress: 'bc1qdestination', dry: false })
  assert.deepEqual(quotes, [route])
})

test('a native buy asset permits its listed memo shortcode', async t => {
  const shortened = { ...route, memo: '=:b:bc1qdestination:0' }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ routes: [shortened] }))
  const quotes = await api.getNetworkQuotes({ ...request, destinationAddress: 'bc1qdestination', buyAssetShortCode: 'b' })
  assert.deepEqual(quotes, [shortened])
})

test('a streaming quote can prepare its executable THORChain route', async t => {
  let sent
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body)
    return Response.json({ routes: [route] })
  })
  await (api.getNetworkQuotes ?? api.getQuotes)({ ...request, providers: ['THORCHAIN_STREAMING'] })
  assert.deepEqual(sent.providers, ['THORCHAIN'])
})

test('a THORChain quote is refused while THORChain holds payouts on either end, and goes ahead when mimir is unreadable', async t => {
  let mimir = { HALTOUTBOUNDBTC: 1 }
  t.mock.method(globalThis, 'fetch', async url =>
    String(url).endsWith('/thorchain/mimir') ? (mimir ? Response.json(mimir) : new Response('down', { status: 502 })) : Response.json({ routes: [route] }))
  await assert.rejects(api.getNetworkQuotes(request), /holding payouts/)
  mimir = { HALTSIGNINGETH: 5, HALTOUTBOUNDBTC: 0 }
  await assert.rejects(api.getNetworkQuotes(request), /holding payouts/, 'the sell chain counts too')
  mimir = undefined
  assert.deepEqual(await api.getNetworkQuotes(request), [route])
})

test('reverse bridge destination picks still update the stored non-BCH asset', () => {
  const source = readFileSync(new URL('../src/components/swap/bridge-asset-picker.tsx', import.meta.url), 'utf8')
  const handler = source.match(/const pickAsset = \(asset: Asset\) => \{\s+([\s\S]*?)\s+onClose\(\)/)?.[1]
  assert.ok(handler)
  let changed
  let local = 'kept'
  const choose = new Function('openNetworks', 'side', 'asset', 'setAssetTo', 'setAssetFrom', 'localSide', 'setLocalTo', handler)
  choose(false, 'to', { identifier: 'ETH.ETH' }, () => { changed = 'to' }, () => { changed = 'from' }, true, token => { local = token })
  assert.equal(changed, 'from')
  assert.equal(local, undefined, 'an asset on another chain ends a swap on Bitcoin Cash')
  choose(true, 'to', { identifier: 'ETH.ETH' }, () => { changed = 'to' }, () => { changed = 'from' }, false, () => assert.fail('no swap on Bitcoin Cash here'))
  assert.equal(changed, 'to')
})

test('free-pair mode excludes NEAR-only catalog rows and retains THORChain rows', async () => {
  const { isNetworkAsset } = await import('../src/store/swap-store.ts')
  const listed = isNetworkAsset ?? (() => true)
  assert.equal(listed({ identifier: 'BASE.USDC', providers: ['NEAR'] }), false)
  assert.equal(listed({ identifier: 'ETH.ETH', providers: ['THORCHAIN', 'NEAR'] }), true)
  assert.equal(listed({ identifier: 'ETH.ETH' }), false)
})

test('free-pair URLs carry both selected identifiers and their mode', () => {
  const source = readFileSync(new URL('../src/hooks/use-url-params.ts', import.meta.url), 'utf8')
  assert.match(source, /searchParams\.get\('networks'\)/)
  assert.match(source, /params\.set\('networks', 'true'\)/)
  assert.match(source, /encodeURIComponent\(assetTo\.identifier\)/)
  assert.match(source, /savedTo\?\.identifier/)
})

test('leaving ETH to BTC free pairs restores a quotable native-BCH bridge destination', async () => {
  const { useSwapStore } = await import('../src/store/swap-store.ts')
  const asset = identifier => ({ identifier, chain: identifier.split('.')[0], providers: ['THORCHAIN'] })
  const assets = [asset('ETH.ETH'), asset('BTC.BTC'), asset('BCH.BCH')]
  useSwapStore.setState({ openNetworks: true, assetFrom: assets[0], assetTo: assets[1] })
  useSwapStore.getState().setOpenNetworks(false)
  const state = useSwapStore.getState()
  const source = readFileSync(new URL('../src/components/swap/swap.tsx', import.meta.url), 'utf8')
  const body = source.match(/const inMode =[\s\S]*?if \(nextTo && nextTo !== assetTo\) setAssetTo\(nextTo\)/)?.[0]
  assert.ok(body)
  const { outputText } = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  const repair = new Function('assets', 'assetFrom', 'assetTo', 'isAssetInMode', 'DEFAULT_SELL', 'DEFAULT_BUY', 'urlBuyAsset', 'setAssetFrom', 'setAssetTo', outputText)
  repair(assets, state.assetFrom, state.assetTo, () => true, 'BTC.BTC', 'BCH.BCH', () => assets[2], state.setAssetFrom, state.setAssetTo)
  assert.equal(useSwapStore.getState().assetTo.identifier, 'BCH.BCH')
  assert.equal(useSwapStore.getState().assetFrom.identifier, 'ETH.ETH')
})

test('a manual swap is recorded before signing, remains unknown on timeout, and records the returned hash', async () => {
  const { transactionStore } = await import('../src/store/transaction-store.ts')
  const { startNetworkSwap } = await import('../src/lib/network-swap.ts').catch(() => ({}))
  assert.equal(typeof startNetworkSwap, 'function', 'free-pair wallet execution must persist before broadcast')
  const base = {
    provider: 'THORCHAIN', chainId: '1', timestamp: new Date(),
    assetFrom: { identifier: 'ETH.ETH', chain: 'ETH' }, assetTo: { identifier: 'BTC.BTC', chain: 'BTC', decimals: 8 },
    amountFrom: '1', amountTo: '0.03', addressFrom: '0xsource', addressTo: 'bc1qdestination'
  }
  transactionStore.setState({ transactions: [] })
  await assert.rejects(startNetworkSwap({ base, route, execute: async () => {
    assert.equal(transactionStore.getState().transactions.at(-1).status, 'unknown')
    throw new Error('Timed out after signing')
  } }), /Timed out/)
  assert.equal(transactionStore.getState().transactions.at(-1).status, 'unknown')
  let retried = false
  await assert.rejects(startNetworkSwap({ base, route, execute: async () => { retried = true; return '0xduplicate' } }), /unknown|unresolved/i)
  assert.equal(retried, false, 'reopening confirmation cannot duplicate an unresolved send')
  transactionStore.getState().removeTransaction(transactionStore.getState().transactions.at(-1).uid)
  const hash = await startNetworkSwap({ base, route, execute: async () => '0xsent' })
  assert.equal(hash, '0xsent')
  assert.equal(transactionStore.getState().transactions.at(-1).hash, '0xsent')
  assert.equal(transactionStore.getState().transactions.at(-1).status, 'pending')
  await assert.rejects(startNetworkSwap({ base, route, execute: async () => { throw { code: 4001 } } }))
  assert.equal(transactionStore.getState().transactions.length, 1, 'rejection leaves no phantom send')
})

test('executable EVM source echoes may change checksum case', async () => {
  const { transactionStore } = await import('../src/store/transaction-store.ts')
  const { startNetworkSwap } = await import('../src/lib/network-swap.ts')
  transactionStore.setState({ transactions: [] })
  const base = {
    provider: 'THORCHAIN', chainId: '1', timestamp: new Date(),
    assetFrom: { identifier: 'ETH.ETH', chain: 'ETH' }, assetTo: { identifier: 'BTC.BTC', chain: 'BTC', decimals: 8 },
    amountFrom: '1', amountTo: '0.03', addressFrom: '0xAbCd', addressTo: 'bc1qdestination'
  }
  assert.equal(await startNetworkSwap({ base, route: { ...route, sourceAddress: '0xabcd' }, execute: async () => '0xcase' }), '0xcase')
})

test('unknown swap recovery matches the recorded source, amount and memo before accepting a hash', async t => {
  const { networkIntentMatches } = await import('../src/lib/network-swap.ts')
  assert.equal(typeof networkIntentMatches, 'function')
  const saved = {
    amountFrom: '1', addressFrom: '0xAbCd', assetFrom: { chain: 'ETH', identifier: 'ETH.ETH' },
    networkSwap: { minOutput: '1', memo: route.memo }
  }
  const deposit = { chain: 'ETH', from_address: '0xabcd', coins: [{ asset: 'ETH.ETH', amount: '100000000' }], memo: route.memo }
  assert.equal(networkIntentMatches(saved, deposit), true)
  assert.equal(networkIntentMatches(saved, { ...deposit, from_address: '0xother' }), false)
  assert.equal(networkIntentMatches(saved, { ...deposit, coins: [{ asset: 'ETH.ETH', amount: '200000000' }] }), false)
  assert.equal(networkIntentMatches(saved, { ...deposit, memo: '=:BTC.BTC:another:0' }), false)
})

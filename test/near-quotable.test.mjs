import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findNearUnquotable } from '../src/lib/near-quotable.ts'

const tokens = [
  { assetId: 'nep141:bch.omft.near', decimals: 8, blockchain: 'bch', symbol: 'BCH', price: 200 },
  { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH', price: 1600 },
  { assetId: 'nep141:eth-0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.omft.near', decimals: 18, blockchain: 'eth', symbol: 'WETH', price: 1600, contractAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  { assetId: 'nep141:eth-0x853d955acef822db058eb8505911ed77f175b99e.omft.near', decimals: 18, blockchain: 'eth', symbol: 'FRAX', price: 1, contractAddress: '0x853d955acef822db058eb8505911ed77f175b99e' },
  { assetId: 'nep141:eth-0x1111111111111111111111111111111111111111.omft.near', decimals: 18, blockchain: 'eth', symbol: 'NOPRICE', contractAddress: '0x1111111111111111111111111111111111111111' }
]

test('only a plain no-route answer hides a NEAR token, one direction at a time', async () => {
  const asked = []
  const quote = async (sell, buy, amount) => {
    asked.push([sell, buy, amount])
    const token = sell === 'BCH.BCH' ? buy : sell
    if (token.includes('WETH')) throw new Error('NEAR Intents: No liquidity available')
    if (token.includes('FRAX') && sell === 'BCH.BCH') throw new Error('NEAR Intents: Quote error. NO_QUOTE')
    if (token.includes('NOPRICE')) throw new Error('NEAR Intents: Internal server error')
    if (token === 'ETH.ETH' && sell === 'BCH.BCH') throw new Error('NEAR Intents: HTTP 429')
    return {}
  }
  const found = await findNearUnquotable(tokens, quote, Date.now() + 60_000)
  assert.deepEqual(found.forward.map(id => id.split('-')[0]), ['ETH.WETH'])
  assert.deepEqual(found.reverse.map(id => id.split('-')[0]).sort(), ['ETH.FRAX', 'ETH.WETH'], 'a rate limit or a server error keeps a token')
  assert.ok(!asked.some(([sell]) => sell.includes('NOPRICE')), 'a token without a price is not sized, so not probed going in')
  assert.ok(asked.some(([sell, buy, amount]) => sell === 'ETH.ETH' && buy === 'BCH.BCH' && amount === '0.03125000'), 'probed with $50 of the token')
  assert.deepEqual(await findNearUnquotable(tokens, quote, Date.now() - 1), { forward: [], reverse: [] }, 'past the deadline nothing is hidden')
})

test('a quotable list that could not be built is not cached', async t => {
  const { GET } = await import('../src/app/api/near-intents/quotable/route.ts')
  t.mock.method(globalThis, 'fetch', async () => new Response('down', { status: 503 }))
  const res = await GET()
  assert.deepEqual(await res.json(), { forward: [], reverse: [] })
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

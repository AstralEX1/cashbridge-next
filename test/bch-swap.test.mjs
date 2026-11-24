import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PURCHASE_FEE_ROOM, purchaseCoins, quoteBchSwap } from '../src/lib/bch-swap.ts'

const coin = (value, hasToken = false) => ({ txid: String(value), vout: 0, value: BigInt(value), hasToken })

test('a purchase spends the largest plain BCH coins until the sale and its fee are covered', () => {
  const coins = [coin(1_000), coin(50_000), coin(900_000, true), coin(20_000), coin(200_000)]
  assert.deepEqual(purchaseCoins(coins, 100_000n).map(c => c.value), [200_000n])
  assert.deepEqual(purchaseCoins(coins, 200_000n).map(c => c.value), [200_000n, 50_000n], 'room for the fee pulls in the next coin')
  assert.deepEqual(purchaseCoins(coins, 1_000_000n).map(c => c.value), [200_000n, 50_000n, 20_000n, 1_000n], 'short: every plain coin, never a token coin')
  assert.equal(purchaseCoins([coin(5_000, true)], 1_000n).length, 0)
  assert.ok(PURCHASE_FEE_ROOM > 0n)
})

test('a swap on Bitcoin Cash trades BCH against exactly one token', () => {
  const token = { category: 'ab'.repeat(32), ticker: 'X', decimals: 2 }
  assert.throws(() => quoteBchSwap(null, null, 1n), /BCH against one token/)
  assert.throws(() => quoteBchSwap(token, token, 1n), /BCH against one token/)
})

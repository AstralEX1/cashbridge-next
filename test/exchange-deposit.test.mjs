// Paying a Router order from an exchange: which chains take it, and the payment request the QR code carries.
// Run: npm run test:bridge
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exchangeChain, exchangePayoutBlocked, internalPayout, paymentRequest, watchExchangeDeposit } from '../src/lib/exchange-deposit.ts'

const DEPOSIT = '0x1f2E3d4C5b6A79881726354453627181920a0B0c'

test('exchange deposits only on chains 1Click takes plainly and this app reads back', () => {
  for (const chain of ['BASE', 'ETH', 'ARB', 'BSC', 'POL', 'SOL', 'TRON', 'BTC', 'LTC', 'DOGE']) assert.equal(exchangeChain(chain), true, chain)
  // BCH is the other side; XRP needs a memo 1Click does not map here; TON/Sui/Cardano deposits are not read back here.
  for (const chain of ['BCH', 'XRP', 'TON', 'SUI', 'ADA', 'GAIA', undefined]) assert.equal(exchangeChain(chain), false, String(chain))
})

test('an exchange payout is refused where the exchange needs a memo or tag the bridge cannot send', () => {
  for (const chain of ['XRP', 'GAIA', 'THOR']) assert.equal(exchangePayoutBlocked(chain), true, chain)
  for (const chain of ['ETH', 'BASE', 'SOL', 'TRON', 'BTC', 'LTC', 'DOGE', 'ZEC', undefined]) assert.equal(exchangePayoutBlocked(chain), false, String(chain))
})

test('native EVM coins are flagged as paid by a contract, tokens and other chains are not', () => {
  for (const asset of ['ETH.ETH', 'BASE.ETH', 'AVAX.AVAX', 'BSC.BNB']) assert.equal(internalPayout(asset), true, asset)
  for (const asset of ['ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', 'BTC.BTC', 'SOL.SOL', 'TRON.TRX'])
    assert.equal(internalPayout(asset), false, asset)
})

test('payment requests fill in coin, network and amount', () => {
  // EIP-681: token transfer with the amount in base units and the chain id.
  assert.equal(
    paymentRequest('BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', DEPOSIT, 5_000_000n, 6),
    `ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453/transfer?address=${DEPOSIT}&uint256=5000000`
  )
  assert.equal(paymentRequest('BSC.USDT-0X55D398326F99059FF775485246999027B3197955', DEPOSIT, 10n ** 18n, 18).endsWith('@56/transfer?address=' + DEPOSIT + '&uint256=1000000000000000000'), true)
  assert.equal(paymentRequest('ETH.ETH', DEPOSIT, 10n ** 16n, 18), `ethereum:${DEPOSIT}@1?value=10000000000000000`)
  // Solana Pay: decimal amount, the mint as spl-token, case kept.
  assert.equal(
    paymentRequest('SOL.USDC-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Dep1osit1111111111111111111111111111111111', 2_500_000n, 6),
    'solana:Dep1osit1111111111111111111111111111111111?amount=2.5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  )
  assert.equal(paymentRequest('SOL.SOL', 'Dep1osit', 1_000_000_000n, 9), 'solana:Dep1osit?amount=1')
  assert.equal(paymentRequest('BTC.BTC', 'bc1qdeposit', 150_000n, 8), 'bitcoin:bc1qdeposit?amount=0.0015')
  // No common request format: the bare address.
  assert.equal(paymentRequest('TRON.USDT-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TDeposit', 1_000_000n, 6), 'TDeposit')
})

test('the deposit counts once its own chain shows it paying the deposit address', async () => {
  const source = { chain: 'BASE', asset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' }
  const asked = []
  const chain = paid => async (chainName, hash, expect) => {
    asked.push([chainName, hash, expect.destination, expect.buyAsset])
    return paid[hash]
  }
  const hashes = (...list) => ({ originChainTxHashes: list.map(hash => ({ hash })) })
  assert.deepEqual(await watchExchangeDeposit(source, DEPOSIT, { status: 'PENDING_DEPOSIT' }, chain({})), { kind: 'waiting' })
  // 1Click saw it, the chain does not show it yet.
  assert.deepEqual(await watchExchangeDeposit(source, DEPOSIT, { status: 'KNOWN_DEPOSIT_TX', swapDetails: hashes('0xaa') }, chain({})), { kind: 'arriving' })
  assert.deepEqual(asked.at(-1), ['BASE', '0xaa', DEPOSIT, source.asset])
  assert.deepEqual(
    await watchExchangeDeposit(source, DEPOSIT, { status: 'PROCESSING', swapDetails: hashes('0xaa', '0xaa') }, chain({ '0xaa': { hash: '0xaa', amount: '4990000' } })),
    { kind: 'seen', hash: '0xaa', amount: 4_990_000n }
  )
  // Under the minimum: what the chain shows arrived, both withdrawals together.
  assert.deepEqual(
    await watchExchangeDeposit(source, DEPOSIT, { status: 'INCOMPLETE_DEPOSIT', swapDetails: hashes('0xaa', '0xbb') }, chain({ '0xaa': { hash: '0xaa', amount: '3000000' }, '0xbb': { hash: '0xbb', amount: '1000000' } })),
    { kind: 'short', received: 4_000_000n }
  )
  // A chain lookup that fails counts as not shown, never as paid.
  const failing = async () => { throw new Error('rpc down') }
  assert.deepEqual(await watchExchangeDeposit(source, DEPOSIT, { status: 'INCOMPLETE_DEPOSIT', swapDetails: hashes('0xaa') }, failing), { kind: 'short', received: 0n })
})

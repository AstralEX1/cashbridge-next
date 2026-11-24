// THORChain -> BCH -> PUSD bridge: fixture tests for the money-moving checks.
// Run: npm run test:bridge
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { binToHex, decodeTransaction, encodeCashAddress, encodeTransaction, hash160, hexToBin } from '@bitauth/libauth'
import { addressPaysScript, bchAddressProblem, bindingFromAddress, bindingFromPubkey, checkOutbound, decodeTx, isValidBinding, opReturnText, txidOf } from '../src/lib/bch.ts'
import { bestTrade, CauldronError, checkPoolCovenants, checkSigned, fitSale, poolLockingBytecode, reviewBuild, sourcesOf, tradeTransaction } from '../src/lib/cauldron.ts'
import { formatBaseUnits, inboundMatchesBinding, interpretMidgard, interpretTxStatus, minOutputFor, quoteLapsed, secondLegSellAmount, toBaseUnits } from '../src/lib/bridge.ts'
import { assertBridgeQuoteRequest, getQuotes, isBridgeRoute } from '../src/lib/api.ts'
import { BelowMinimumError, minimumFromProviderErrors, resolveQuoteError } from '../src/lib/errors.ts'
import { BridgeConfig } from '../src/config.ts'
import { Chain } from '@tcswap/core'
import { bridgeCompletionTransactions, bridgeOutcome } from '../src/lib/bridge-completion.ts'
import { cauldronLiquidityUrl, getCauldronApy, parseCauldronApy } from '../src/lib/cauldron-liquidity.ts'
import { inboundHash, otherKey, otherPubkey, OTHER_TOKEN, outboundTx, pubkey, PUSD, signBuild, swapBuild } from './fixtures/bridge-fixtures.mjs'

const binding = bindingFromPubkey(pubkey, 0)
const ownScript = hexToBin(binding.lockingBytecode)
const otherBinding = bindingFromPubkey(otherPubkey, 0)

test('completion history keeps every distinct delivery and swap in order, without toast state', () => {
  const source = `0x${'a'.repeat(64)}`
  const delivery = 'b'.repeat(64)
  const extra = 'c'.repeat(64)
  const swap = 'd'.repeat(64)
  const tx = {
    hash: source, assetFrom: { chain: Chain.Base }, assetTo: { chain: Chain.BitcoinCash },
    bridge: { stage: 'completed', received: [{ txid: delivery }, { txid: delivery.toUpperCase() }, { txid: extra }], secondLeg: { txid: swap } }
  }
  const history = bridgeCompletionTransactions(tx)
  assert.deepEqual(history.map(({ kind, chain, hash }) => ({ kind, chain, hash })), [
    { kind: 'bridgeFrom', chain: Chain.Base, hash: source },
    { kind: 'receiveOn', chain: Chain.BitcoinCash, hash: delivery },
    { kind: 'receiveOn', chain: Chain.BitcoinCash, hash: extra },
    { kind: 'swapOnCauldron', chain: Chain.BitcoinCash, hash: swap }
  ])
  assert.equal(new Set(history.map(tx => tx.key)).size, 4)
  tx.bridge.stage = 'kept_bch'
  assert.equal(bridgeCompletionTransactions(tx).length, 3, 'keeping BCH does not claim a token swap')
  tx.bridge.stage = 'second_leg_pending'
  assert.deepEqual(bridgeCompletionTransactions(tx), [], 'pending transactions get no success receipt')
  tx.bridge.stage = 'failed'
  assert.deepEqual(bridgeCompletionTransactions(tx), [])
})

test('completion history handles reverse, BCH-only, missing hashes and confirmed refunds', () => {
  const sale = 'a'.repeat(64), deposit = 'b'.repeat(64), payout = `0x${'c'.repeat(64)}`, refund = 'd'.repeat(64)
  const tx = {
    assetFrom: { chain: Chain.BitcoinCash }, assetTo: { chain: Chain.Base },
    bridge: { stage: 'completed', direction: 'reverse', reverse: { sale: { txid: sale }, deposit: { txid: deposit }, payout: { hash: payout } } }
  }
  assert.deepEqual(bridgeCompletionTransactions(tx).map(item => item.kind), ['swapOnCauldron', 'bridgeFrom', 'receiveOn'])
  tx.bridge.stage = 'kept_bch'
  assert.deepEqual(bridgeCompletionTransactions(tx).map(item => item.hash), [sale])
  delete tx.bridge.reverse.sale
  tx.bridge.stage = 'completed'
  assert.deepEqual(bridgeCompletionTransactions(tx).map(item => item.hash), [deposit, payout], 'native BCH has no Cauldron sale')
  tx.bridge.reverse.refund = { txid: refund }
  assert.equal(bridgeCompletionTransactions(tx).at(-1).kind, 'refundOn')
  tx.bridge = { stage: 'completed', received: [{ txid: '' }, {}], refunds: [{ txid: refund, pending: true }, { txid: deposit, pending: false }] }
  assert.deepEqual(bridgeCompletionTransactions(tx).map(item => item.hash), [deposit])
})

test('history shows the BCH kept or the refund instead of the planned payout', () => {
  const usdc = 'BASE.USDC-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const forward = { assetFrom: { identifier: usdc }, bridge: { stage: 'kept_bch', received: [{ value: '20000000' }, { value: '237100' }] } }
  assert.deepEqual(bridgeOutcome(forward), { asset: 'bch', amount: '0.202371' })
  forward.bridge = { stage: 'refunded', refunds: [{ asset: usdc.toUpperCase(), amount: '480000000', pending: false }, { asset: usdc, amount: '1', pending: true }] }
  assert.deepEqual(bridgeOutcome(forward), { asset: 'source', amount: '4.8' })
  forward.bridge = { stage: 'completed', received: [{ value: '20000000' }] }
  assert.equal(bridgeOutcome(forward), undefined, 'a delivered payout keeps the planned asset')

  const reverse = { assetFrom: { identifier: 'BCH.PUSD-x' }, bridge: { stage: 'kept_bch', direction: 'reverse', reverse: { sale: { bchOut: '1', outputs: [{ value: '20237100' }] } } } }
  assert.deepEqual(bridgeOutcome(reverse), { asset: 'bch', amount: '0.202371' })
  reverse.bridge = { stage: 'refunded', direction: 'reverse', reverse: { refund: { txid: 'a', amountSats: '20100000' } } }
  assert.deepEqual(bridgeOutcome(reverse), { asset: 'bch', amount: '0.201' })
  for (const bridge of [{ stage: 'second_leg_pending', direction: 'reverse', reverse: {} }, { stage: 'kept_bch', direction: 'reverse', reverse: { sale: { outputs: [{ value: 'bad' }] } } }, { stage: 'kept_bch' }])
    assert.equal(bridgeOutcome({ assetFrom: { identifier: usdc }, bridge }), undefined)
})

test('completion history preserves case-sensitive non-hex source transaction IDs', () => {
  const hash = '4EXnNpJZ9RLzJCpH9BvbdvABQaSMQ7RQbEVjGRxAwyCSTPXnCYdbmCfXbNfF'
  const tx = { hash, assetFrom: { chain: Chain.Solana }, bridge: { stage: 'completed' } }
  assert.equal(bridgeCompletionTransactions(tx)[0].hash, hash)
  tx.hash = 'not a transaction'
  assert.deepEqual(bridgeCompletionTransactions(tx), [])
})

test('LP links use the token category, and APY rejects missing or invalid pool data', () => {
  assert.equal(cauldronLiquidityUrl(PUSD), `https://app.cauldron.quest/add/${PUSD}`)
  assert.equal(cauldronLiquidityUrl(OTHER_TOKEN), `https://app.cauldron.quest/add/${OTHER_TOKEN}`)
  assert.throws(() => cauldronLiquidityUrl('../add'), /category/)
  assert.equal(parseCauldronApy({ apy: '8.597885945977747012808480970', pools: 63 }), 8.597885945977747)
  assert.equal(parseCauldronApy({ apy: '0', pools: 1 }), 0)
  for (const apy of ['', '  ', '0x10', '-1', 'NaN', 'Infinity', -1, Infinity, null, {}]) {
    assert.equal(parseCauldronApy({ apy, pools: 1 }), null)
  }
  for (const pools of [0, -1, '3', 1.5, undefined]) assert.equal(parseCauldronApy({ apy: '10', pools }), null)
  assert.equal(parseCauldronApy(null), null)
})

test('APY uses the public aggregate endpoint and fails without inventing a rate', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${BridgeConfig.cauldronIndexerUrl}/cauldron/pool/aggregated_apy?token=${PUSD}`)
    assert.ok(options.signal instanceof AbortSignal)
    return { ok: true, json: async () => ({ apy: '9.25', pools: 3 }) }
  })
  assert.equal(await getCauldronApy(PUSD), 9.25)
  await assert.rejects(getCauldronApy('../bad'), /category/)
  assert.equal(fetchMock.mock.callCount(), 1)
  fetchMock.mock.mockImplementation(async () => ({ ok: false }))
  await assert.rejects(getCauldronApy(PUSD), /Could not read/)
})

// --- Identity and addresses --------------------------------------------------------------------

test('PUSD identity is the verified category with 2 decimals', () => {
  assert.equal(BridgeConfig.pusd.category, PUSD)
  assert.equal(BridgeConfig.pusd.decimals, 2)
})

test('plain and token-aware addresses of the binding pay the same script', () => {
  assert.ok(binding.cashAddress.startsWith('bitcoincash:q'))
  assert.ok(binding.tokenAddress.startsWith('bitcoincash:z'))
  assert.ok(addressPaysScript(binding.cashAddress, binding.lockingBytecode))
  assert.ok(addressPaysScript(binding.tokenAddress, binding.lockingBytecode))
  assert.ok(addressPaysScript(binding.cashAddress.replace('bitcoincash:', ''), binding.lockingBytecode), 'THORNode may print it without prefix')
  assert.ok(addressPaysScript(binding.cashAddress.toUpperCase(), binding.lockingBytecode))
  assert.ok(!addressPaysScript(otherBinding.cashAddress, binding.lockingBytecode))
  assert.ok(!addressPaysScript('bchtest:' + binding.cashAddress.split(':')[1], binding.lockingBytecode))
})

test('a pasted BCH destination must be CashAddr, and token-aware when it receives a token', () => {
  const [prefix, plain] = binding.cashAddress.split(':')
  const token = binding.tokenAddress.split(':')[1]
  const scriptHash = hash160(ownScript)
  const p2sh = encodeCashAddress({ prefix, type: 'p2sh', payload: scriptHash }).address
  const p2shToken = encodeCashAddress({ prefix, type: 'p2shWithTokens', payload: scriptHash }).address
  assert.ok(p2sh.includes(':p') && p2shToken.includes(':r'))
  assert.equal(bchAddressProblem(binding.cashAddress, false), undefined)
  assert.equal(bchAddressProblem(`  ${plain}\n`, false), undefined, 'bare and padded')
  assert.equal(bchAddressProblem(binding.cashAddress.toUpperCase(), false), undefined)
  assert.equal(bchAddressProblem(binding.tokenAddress, false), undefined, 'a token-aware address also receives plain BCH')
  assert.equal(bchAddressProblem(p2sh, false), undefined)
  // PUSD goes only to a token-aware address.
  assert.equal(bchAddressProblem(binding.tokenAddress, true), undefined)
  assert.equal(bchAddressProblem(token, true), undefined)
  assert.equal(bchAddressProblem(p2shToken, true), undefined)
  assert.equal(bchAddressProblem(binding.cashAddress, true), 'notTokenAware')
  assert.equal(bchAddressProblem(plain, true), 'notTokenAware')
  assert.equal(bchAddressProblem(p2sh, true), 'notTokenAware')
  // Other chains, other networks and typos are refused on both routes.
  const foreign = [
    '',
    'bitcoincash:',
    '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', // EVM
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Solana
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', // Bitcoin bech32
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // legacy: Bitcoin and BCH look alike
    '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
    'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
    'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', // XRP
    'thor1x8q5mmwz3lhc9d2fpzcsw5rjv8uyw3nmpq2zqp',
    `bchtest:${plain}`,
    `ethereum:${plain}`,
    `${prefix}:${plain.slice(0, -1)}`, // truncated
    `${prefix}:${plain.slice(0, -1)}${plain.endsWith('q') ? 'p' : 'q'}`, // checksum typo
    `${prefix}:${plain.slice(0, 10)}${plain.slice(10).toUpperCase()}`, // mixed case
    `${prefix}:${plain} extra`
  ]
  for (const address of foreign) {
    assert.equal(bchAddressProblem(address, false), 'invalid', `plain: ${address}`)
    assert.equal(bchAddressProblem(address, true), 'invalid', `token: ${address}`)
  }
})

test('a restored binding is accepted only if it still derives from its key', () => {
  assert.ok(isValidBinding(binding))
  assert.ok(!isValidBinding({ ...binding, cashAddress: otherBinding.cashAddress }), 'swapped destination')
  assert.ok(!isValidBinding({ ...binding, lockingBytecode: otherBinding.lockingBytecode }))
  assert.ok(!isValidBinding({ ...binding, pubkey: 'zz' }))
  assert.ok(!isValidBinding(null))
})

test('a pasted address becomes a watch-only binding that pays the same script', () => {
  const pasted = bindingFromAddress(binding.tokenAddress)
  assert.equal(pasted.pubkey, '')
  assert.equal(pasted.cashAddress, binding.cashAddress)
  assert.equal(pasted.lockingBytecode, binding.lockingBytecode)
  assert.ok(isValidBinding(pasted))
  assert.ok(!isValidBinding({ ...pasted, lockingBytecode: otherBinding.lockingBytecode }), 'watch-only must still match its address')
  assert.equal(bindingFromAddress('bitcoincash:not-an-address'), undefined)
})

// --- Amounts -----------------------------------------------------------------------------------

test('decimal strings convert to base units exactly, or not at all', () => {
  assert.equal(toBaseUnits('1', 8), 100_000_000n)
  assert.equal(toBaseUnits('0.00012345', 8), 12_345n)
  assert.equal(toBaseUnits('12.30', 2), 1_230n)
  assert.throws(() => toBaseUnits('0.000000001', 8))
  assert.throws(() => toBaseUnits('-1', 8))
  assert.throws(() => toBaseUnits('1e8', 8))
  assert.equal(formatBaseUnits(123_456n, 2), '1234.56')
  assert.equal(formatBaseUnits('100000000', 8), '1')
})

test('second-leg reserve leaves room for fees and grows on retry', () => {
  const total = 1_000_000n
  assert.ok(secondLegSellAmount(total, 0) < total)
  assert.ok(secondLegSellAmount(total, 1) < secondLegSellAmount(total, 0))
  assert.equal(secondLegSellAmount(3_000n), 0n, 'too small to swap')
  assert.equal(minOutputFor(10_000n, 100), 9_900n)
})

test('a quote past its expiration is never signed', () => {
  const now = 1_900_000_000_000
  assert.equal(quoteLapsed({ expiration: '1900000001' }, now), false)
  assert.equal(quoteLapsed({ expiration: '1900000000' }, now), true)
  assert.equal(quoteLapsed({ expiration: '1899999000' }, now), true)
  assert.equal(quoteLapsed({}, now), false, 'a route without an expiry is judged by its own checks')
})

// --- First-leg restrictions (crafted URLs / state / quotes) -------------------------------------

test('only THORChain quotes to BCH.BCH are requested', () => {
  assert.doesNotThrow(() => assertBridgeQuoteRequest({ sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN'] }))
  assert.throws(() => assertBridgeQuoteRequest({ sellAsset: 'ETH.ETH', buyAsset: 'BTC.BTC', providers: ['THORCHAIN'] }))
  assert.throws(() => assertBridgeQuoteRequest({ sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['MAYACHAIN'] }))
  assert.throws(() => assertBridgeQuoteRequest({ sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN', 'HOUDINI'] }))
  assert.throws(() => assertBridgeQuoteRequest({ sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: [] }))
  assert.throws(() => assertBridgeQuoteRequest({ sellAsset: 'BCH.BCH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN'] }))
})

test('a returned route must still be THORChain to BCH paying the asked address', () => {
  const route = { sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN'], destinationAddress: binding.cashAddress }
  const request = { sellAsset: 'ETH.ETH', destinationAddress: binding.cashAddress }
  assert.ok(isBridgeRoute(route, request))
  assert.ok(isBridgeRoute({ ...route, providers: ['THORCHAIN_STREAMING'] }, request))
  assert.ok(!isBridgeRoute({ ...route, buyAsset: 'ETH.USDC-0XA0B8' }, request))
  assert.ok(!isBridgeRoute({ ...route, providers: ['MAYACHAIN'] }, request))
  assert.ok(!isBridgeRoute({ ...route, destinationAddress: otherBinding.cashAddress }, request))
  assert.ok(!isBridgeRoute({ ...route, sellAsset: 'BTC.BTC' }, request))
  // As the aggregator really answers: the asked `bitcoincash:` address comes back without its prefix.
  assert.ok(isBridgeRoute({ ...route, destinationAddress: binding.cashAddress.split(':')[1] }, request))
  assert.ok(!isBridgeRoute({ ...route, destinationAddress: otherBinding.cashAddress.split(':')[1] }, request))
  assert.ok(!isBridgeRoute({ ...route, destinationAddress: undefined }, request))
  // The memo is what THORChain acts on: an echoed address cannot cover a memo paying someone else.
  const short = binding.cashAddress.split(':')[1]
  assert.ok(isBridgeRoute({ ...route, memo: `=:c:${short}:0/1/0` }, request))
  assert.ok(isBridgeRoute({ ...route, memo: `=:BCH.BCH:${binding.cashAddress}:0` }, request))
  assert.ok(!isBridgeRoute({ ...route, memo: `=:c:${otherBinding.cashAddress.split(':')[1]}:0/1/0` }, request))
  assert.ok(!isBridgeRoute({ ...route, memo: `=:ETH.ETH:0xabc:0` }, request))
})

test('the reverse direction quotes BCH.BCH into one non-BCH asset and nothing else', () => {
  assert.doesNotThrow(() => assertBridgeQuoteRequest({ sellAsset: 'BCH.BCH', buyAsset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', providers: ['THORCHAIN'] }))
  assert.throws(() => assertBridgeQuoteRequest({ sellAsset: 'BCH.BCH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN'] }))
  assert.throws(() => assertBridgeQuoteRequest({ sellAsset: 'BCH.BCH', buyAsset: 'ETH.ETH', providers: ['MAYACHAIN'] }))
  assert.throws(() => assertBridgeQuoteRequest({ sellAsset: 'ETH.ETH', buyAsset: 'ETH.USDC-0XA0B8', providers: ['THORCHAIN'] }))
})

test('a reverse route must still pay the asked EVM address the asked asset', () => {
  const dest = '0x76ff6F88f58e083b88A80B1764ae7002e303D1A6'
  const route = { sellAsset: 'BCH.BCH', buyAsset: 'BASE.ETH', providers: ['THORCHAIN'], destinationAddress: dest }
  const request = { sellAsset: 'BCH.BCH', buyAsset: 'BASE.ETH', destinationAddress: dest }
  assert.ok(isBridgeRoute(route, request))
  assert.ok(isBridgeRoute({ ...route, destinationAddress: dest.toLowerCase() }, request))
  assert.ok(!isBridgeRoute({ ...route, buyAsset: 'BASE.USDC' }, request))
  assert.ok(!isBridgeRoute({ ...route, destinationAddress: '0x000000000000000000000000000000000000dEaD' }, request))
  assert.ok(!isBridgeRoute({ ...route, sellAsset: 'ETH.ETH' }, request))
})

// --- THORNode first-leg interpretation ---------------------------------------------------------

const done = { swap_status: { pending: false }, swap_finalised: { completed: true }, outbound_signed: { completed: true } }
const bchOut = (amount = '1000000', to = binding.cashAddress) => ({ id: 'CC'.repeat(32), chain: 'BCH', to_address: to, coins: [{ asset: 'BCH.BCH', amount }], memo: `OUT:${inboundHash}` })

test('a swap still streaming is pending', () => {
  const view = interpretTxStatus({ stages: { swap_status: { pending: true } } }, binding.lockingBytecode)
  assert.equal(view.kind, 'pending')
})

test('a planned outbound is never presented as received', () => {
  const view = interpretTxStatus(
    { planned_out_txs: [{ chain: 'BCH', to_address: binding.cashAddress, coin: { asset: 'BCH.BCH', amount: '1000000' }, refund: false }], stages: { swap_status: { pending: false } } },
    binding.lockingBytecode
  )
  assert.equal(view.kind, 'pending')
})

test('an executed outbound to the bound address is reported with its amount', () => {
  const view = interpretTxStatus({ out_txs: [bchOut()], planned_out_txs: [{ chain: 'BCH', to_address: binding.cashAddress, coin: { asset: 'BCH.BCH', amount: '1000000' }, refund: false }], stages: done }, binding.lockingBytecode)
  assert.equal(view.kind, 'outbound')
  assert.equal(view.result, 'swapped')
  assert.deepEqual(view.outbound, [{ txid: 'cc'.repeat(32), amountSats: '1000000' }])
})

test('an outbound to another address or of another asset is refused', () => {
  assert.equal(interpretTxStatus({ out_txs: [bchOut('1', otherBinding.cashAddress)], stages: done }, binding.lockingBytecode).kind, 'invalid')
  assert.equal(interpretTxStatus({ out_txs: [{ ...bchOut(), chain: 'BTC', coins: [{ asset: 'BTC.BTC', amount: '1' }] }], stages: done }, binding.lockingBytecode).kind, 'invalid')
})

test('full refund, pending refund and partial fill are told apart', () => {
  const refund = { id: 'DD'.repeat(32), chain: 'ETH', to_address: '0xabc', coins: [{ asset: 'ETH.ETH', amount: '100' }], memo: `REFUND:${inboundHash}` }
  const full = interpretTxStatus({ out_txs: [refund], planned_out_txs: [{ chain: 'ETH', to_address: '0xabc', coin: refund.coins[0], refund: true }], stages: done }, binding.lockingBytecode)
  assert.equal(full.kind, 'refunded')

  const pendingRefund = interpretTxStatus({ planned_out_txs: [{ chain: 'ETH', to_address: '0xabc', coin: refund.coins[0], refund: true }], stages: done }, binding.lockingBytecode)
  assert.equal(pendingRefund.kind, 'pending')
  assert.equal(pendingRefund.result, 'refund_pending')

  const partial = interpretTxStatus(
    {
      out_txs: [bchOut('500000'), refund],
      planned_out_txs: [
        { chain: 'BCH', to_address: binding.cashAddress, coin: { asset: 'BCH.BCH', amount: '500000' }, refund: false },
        { chain: 'ETH', to_address: '0xabc', coin: refund.coins[0], refund: true }
      ],
      stages: done
    },
    binding.lockingBytecode
  )
  assert.equal(partial.kind, 'outbound')
  assert.equal(partial.result, 'partial')
  assert.equal(partial.refunds.length, 1)
})

test('Midgard is used only to conclude refunds', () => {
  assert.equal(interpretMidgard([{ type: 'swap', status: 'success', in: [], out: [] }]), undefined)
  assert.equal(interpretMidgard([{ type: 'refund', status: 'success', in: [], out: [{ txID: 'x', address: 'a', coins: [{ asset: 'ETH.ETH', amount: '1' }] }] }]).kind, 'refunded')
  assert.equal(interpretMidgard([{ type: 'refund', status: 'pending', in: [], out: [] }]).kind, 'pending')
})

test('a hand-entered source hash must be a swap to BCH paying the bound address', () => {
  assert.ok(inboundMatchesBinding({ tx: { memo: `=:BCH.BCH:${binding.cashAddress}:0/1/0` } }, binding.lockingBytecode))
  assert.ok(inboundMatchesBinding({ tx: { memo: `=:c:${binding.cashAddress.split(':')[1]}:0/1/0:t:0` } }, binding.lockingBytecode))
  assert.ok(!inboundMatchesBinding({ tx: { memo: `=:BCH.BCH:${otherBinding.cashAddress}:0` } }, binding.lockingBytecode))
  assert.ok(!inboundMatchesBinding({ tx: { memo: `=:ETH.ETH:0xabc:0` } }, binding.lockingBytecode))
  assert.ok(!inboundMatchesBinding({ tx: { memo: `+:BCH.BCH:${binding.cashAddress}` } }, binding.lockingBytecode))
  for (const asset of ['BCH', 'C']) assert.ok(!inboundMatchesBinding({ tx: { memo: `=:${asset}:${binding.cashAddress}:0` } }, binding.lockingBytecode), `${asset} parses as a THOR-chain asset`)
})

// --- On-chain BCH receipt ----------------------------------------------------------------------

const outboundFixture = opts => {
  const hex = outboundTx({ to: ownScript, amount: 1_000_000n, ...opts })
  return { hex, tx: decodeTx(hex), txid: txidOf(hex) }
}

test('the outbound memo is read from its OP_RETURN', () => {
  const { tx } = outboundFixture()
  assert.equal(opReturnText(tx.outputs[2].lockingBytecode), `OUT:${inboundHash}`)
})

test('confirmed, unspent outputs of THORChain’s outbound are verified', () => {
  const raw = outboundFixture()
  const check = checkOutbound(raw, { inboundHash, lockingBytecode: binding.lockingBytecode, expectedSats: 1_000_000n }, { tip: 100, utxos: [{ txid: raw.txid, vout: 0, value: 1_000_000n, height: 100, hasToken: false }] })
  assert.equal(check.kind, 'ok')
  assert.equal(check.total, '1000000')
  assert.equal(check.confirmations, 1)
  assert.ok(check.outputs[0].unspent)
})

test('insufficient confirmations and spent outputs are reported, not unlocked', () => {
  const raw = outboundFixture()
  const unconfirmed = checkOutbound(raw, { inboundHash, lockingBytecode: binding.lockingBytecode, expectedSats: 1_000_000n }, { tip: 100, utxos: [{ txid: raw.txid, vout: 0, value: 1_000_000n, height: 0, hasToken: false }] })
  assert.equal(unconfirmed.confirmations, 0)
  const spent = checkOutbound(raw, { inboundHash, lockingBytecode: binding.lockingBytecode, expectedSats: 1_000_000n }, { tip: 100, utxos: [] })
  assert.equal(spent.outputs[0].unspent, false)
})

test('wrong memo, wrong recipient, token outputs and amount mismatch are refused', () => {
  const ctx = { inboundHash, lockingBytecode: binding.lockingBytecode, expectedSats: 1_000_000n }
  const none = { tip: 1, utxos: [] }
  assert.equal(checkOutbound(outboundFixture({ memo: 'OUT:' + 'F'.repeat(64) }), ctx, none).kind, 'invalid')
  assert.equal(checkOutbound(outboundFixture({ memo: `REFUND:${inboundHash}` }), ctx, none).kind, 'invalid')
  assert.equal(checkOutbound(outboundFixture({ to: hexToBin(otherBinding.lockingBytecode) }), ctx, none).kind, 'invalid')
  assert.equal(checkOutbound(outboundFixture({ token: { category: hexToBin(PUSD), amount: 1n } }), ctx, none).kind, 'invalid')
  assert.equal(checkOutbound(outboundFixture({ amount: 999_999n }), ctx, none).kind, 'invalid', 'planned amount is not received amount')
})

// --- Cauldron transaction review ---------------------------------------------------------------

const funding = [{ txid: 'cc'.repeat(32), vout: 0, value: '1000000' }]
const sellSats = 990_000n
const intent = { category: PUSD, side: 'buy', funding, lockingBytecode: binding.lockingBytecode, tokenAddress: binding.tokenAddress, cashAddress: binding.cashAddress, sell: sellSats, minOutput: 4_900n }
const build = (opts = {}) => swapBuild({ ownScript, funding, sellSats, pusdOut: 5_000n, ...opts })

test('a correct build is accepted and its money flows are computed from the transaction', () => {
  const reviewed = reviewBuild(build(), intent)
  assert.equal(reviewed.output, 5_000n)
  assert.equal(reviewed.routerFeeSats, 0n)
  assert.equal(reviewed.minerFeeSats, 600n)
  assert.deepEqual(reviewed.ownIndexes, [0])
  assert.equal(reviewed.debitSats, sellSats + 600n)
})

test('modified outputs and excessive fees are refused', () => {
  assert.throws(() => reviewBuild(build({ routerFee: 990n }), intent), /BCH leaves to an address/)
  assert.throws(() => reviewBuild(build({ minerFee: 5_000n }), intent), /miner fee is excessive/)
  assert.throws(() => reviewBuild(build({ minerFee: 10n }), intent), /too low/)
  assert.throws(
    () =>
      reviewBuild(
        build({
          mutate: tx => {
            // Redirect the BCH change to someone else.
            tx.outputs[2].lockingBytecode = hexToBin(otherBinding.lockingBytecode)
          }
        }),
        intent
      ),
    /BCH leaves to an address|More BCH/
  )
})

test('wrong category, NFTs, burns and low output are refused', () => {
  assert.throws(() => reviewBuild(build({ tokenCategory: OTHER_TOKEN }), intent), /different token category|burned/)
  assert.throws(() => reviewBuild(build({ pusdOut: 4_000n }), intent), /fewer tokens/)
  assert.throws(
    () =>
      reviewBuild(
        build({
          mutate: tx => {
            tx.outputs[0].token.amount -= 1n // pool keeps 1 less: burned
          }
        }),
        intent
      ),
    /burned/
  )
  assert.throws(
    () =>
      reviewBuild(
        build({
          mutate: tx => {
            tx.outputs[1].token.nft = { capability: 'none', commitment: new Uint8Array() }
          }
        }),
        intent
      ),
    /NFT|burned/
  )
})

test('unrelated wallet inputs, spent or altered funding and a wrong signing set are refused', () => {
  assert.throws(() => reviewBuild(build({ extraInputs: [{ txid: 'dd'.repeat(32), vout: 3, value: '50000' }] }), intent), /not approved/)
  assert.throws(() => reviewBuild(build(), { ...intent, funding: [{ ...funding[0], value: '1000001' }] }), /does not match/)
  assert.throws(() => reviewBuild(build(), { ...intent, funding: [...funding, { txid: 'ee'.repeat(32), vout: 0, value: '1' }] }), /Not every/)
  const b = build()
  assert.throws(() => reviewBuild({ ...b, inputs_to_sign: [0, 1] }, intent), /inputs to sign/)
  assert.throws(() => reviewBuild({ ...b, inputs_to_sign: [] }, intent), /inputs to sign/)
  assert.throws(() => reviewBuild({ ...b, source_outputs: b.source_outputs.slice(1) }, intent), /line up/)
})

// --- Signed transaction checks -----------------------------------------------------------------

const reviewedAndSigned = (key, mutateSigned) => {
  const reviewed = reviewBuild(build(), intent)
  const unsigned = decodeTransaction(hexToBin(reviewed.unsignedHex))
  let signed = signBuild(unsigned, sourcesOf(reviewed), reviewed.ownIndexes, key)
  if (mutateSigned) {
    const tx = decodeTransaction(hexToBin(signed))
    mutateSigned(tx)
    signed = binToHex(encodeTransaction(tx))
  }
  return { reviewed, signed }
}

test('a correctly signed transaction verifies and yields its txid', () => {
  const { reviewed, signed } = reviewedAndSigned()
  assert.equal(checkSigned(reviewed.unsignedHex, signed, reviewed.ownIndexes, sourcesOf(reviewed), binding.pubkey), txidOf(signed))
})

test('signatures by another key, changed outputs or changed pool inputs are refused', () => {
  const other = reviewedAndSigned(otherKey)
  assert.throws(() => checkSigned(other.reviewed.unsignedHex, other.signed, other.reviewed.ownIndexes, sourcesOf(other.reviewed), binding.pubkey), /different key/)

  const changedOutput = reviewedAndSigned(undefined, tx => {
    tx.outputs[2].valueSatoshis -= 1n
  })
  assert.throws(() => checkSigned(changedOutput.reviewed.unsignedHex, changedOutput.signed, changedOutput.reviewed.ownIndexes, sourcesOf(changedOutput.reviewed), binding.pubkey), /outputs/)

  const changedPool = reviewedAndSigned(undefined, tx => {
    tx.inputs[1].unlockingBytecode = Uint8Array.from([0x01, 0x52])
  })
  assert.throws(() => checkSigned(changedPool.reviewed.unsignedHex, changedPool.signed, changedPool.reviewed.ownIndexes, sourcesOf(changedPool.reviewed), binding.pubkey), /pool input/)

  const { reviewed } = reviewedAndSigned()
  assert.throws(() => checkSigned(reviewed.unsignedHex, reviewed.unsignedHex, reviewed.ownIndexes, sourcesOf(reviewed), binding.pubkey), /unsigned/)
  assert.throws(() => checkSigned(reviewed.unsignedHex, 'zz', reviewed.ownIndexes, sourcesOf(reviewed), binding.pubkey), /invalid transaction/)
})

test('a signature that does not commit to the whole transaction is refused', () => {
  const tampered = reviewedAndSigned(undefined, tx => {
    const u = tx.inputs[0].unlockingBytecode
    const sigLength = u[0]
    u[sigLength] = 0xc1 // SIGHASH_ALL | FORKID | ANYONECANPAY
  })
  assert.throws(
    () => checkSigned(tampered.reviewed.unsignedHex, tampered.signed, tampered.reviewed.ownIndexes, sourcesOf(tampered.reviewed), binding.pubkey),
    /whole transaction/
  )
})

test('the binding key hash is what the fixtures pay', () => {
  assert.equal(binToHex(hash160(pubkey)), binding.lockingBytecode.slice(6, 46))
})

test('a binding on the wallet’s DeFi path is accepted; an unknown path is not', () => {
  const defi = bindingFromPubkey(pubkey, 0, 'defi')
  assert.equal(defi.path, 'defi')
  assert.equal(defi.lockingBytecode, binding.lockingBytecode)
  assert.ok(isValidBinding(defi))
  assert.ok(!isValidBinding({ ...binding, path: 'change' }))
  assert.ok(!isValidBinding({ ...binding, path: '__proto__' }))
})

test('every pool input must accept the trade under its own covenant', () => {
  const reviewed = reviewBuild(build(), intent)
  // The stand-in pool (P2SH32 of OP_1) accepts the trade, unsigned as it is.
  checkPoolCovenants(reviewed)
  // A pool whose script fails (OP_RETURN) blocks the build before anything is signed.
  const refusing = {
    ...reviewed,
    sourceOutputs: reviewed.sourceOutputs.map((s, i) => (reviewed.ownIndexes.includes(i) ? s : { ...s, lockingBytecode: '6a' }))
  }
  assert.throws(() => checkPoolCovenants(refusing), /does not accept/)
})

// --- Local Cauldron trade (@cashlab/cauldron) --------------------------------------------------

test('a pool owner key hash is compiled once and different owners get different scripts', () => {
  const script = poolLockingBytecode(new Uint8Array(20).fill(1))
  assert.equal(poolLockingBytecode(new Uint8Array(20).fill(1)), script)
  assert.notDeepEqual(poolLockingBytecode(new Uint8Array(20).fill(2)), script)
})

// A Cauldron pool with the real PoolV0 covenant, near the live price of ~3,600 sats per PUSD unit.
const cauldronPool = (sats, tokens, txByte = 'dd') => {
  const withdrawPkh = new Uint8Array(20).fill(7)
  return {
    version: '0',
    parameters: { withdraw_pubkey_hash: withdrawPkh },
    outpoint: { txhash: hexToBin(txByte.repeat(32)), index: 1 },
    output: { locking_bytecode: poolLockingBytecode(withdrawPkh), token: { amount: tokens, token_id: PUSD }, amount: sats }
  }
}
const localFunding = [{ txid: 'ee'.repeat(32), vout: 0, value: '1010000' }]
const localTrade = () => {
  const trade = bestTrade([cauldronPool(108_000_000n, 30_000n)], 1_000_000n)
  const localIntent = {
    category: PUSD,
    side: 'buy',
    funding: localFunding,
    lockingBytecode: binding.lockingBytecode,
    tokenAddress: binding.tokenAddress,
    cashAddress: binding.cashAddress,
    sell: trade.summary.supply,
    minOutput: minOutputFor(trade.summary.demand)
  }
  return { trade, localIntent, build: tradeTransaction(trade, localIntent) }
}

test('a local trade passes the review, the real pool covenant and the signature checks', () => {
  const { trade, localIntent, build: local } = localTrade()
  assert.ok(trade.summary.supply > 0n && trade.summary.supply <= 1_000_000n)
  // ~1,000,000 sats at ~3,600 sats per unit, less the 0.3% pool fee and price impact.
  assert.ok(trade.summary.demand > 260n && trade.summary.demand < 280n, `got ${trade.summary.demand}`)
  const reviewed = reviewBuild(local, localIntent)
  assert.equal(reviewed.output, trade.summary.demand)
  assert.deepEqual(reviewed.ownIndexes, [1])
  assert.equal(reviewed.routerFeeSats, 0n)
  assert.equal(decodeTransaction(hexToBin(reviewed.unsignedHex)).inputs[1].unlockingBytecode.length, 0, 'the throwaway signature is removed')
  checkPoolCovenants(reviewed)
  const signed = signBuild(decodeTransaction(hexToBin(reviewed.unsignedHex)), sourcesOf(reviewed), reviewed.ownIndexes)
  assert.equal(checkSigned(reviewed.unsignedHex, signed, reviewed.ownIndexes, sourcesOf(reviewed), binding.pubkey), txidOf(signed))
})

test('the pool covenant refuses a trade that takes more PUSD than the pool pays', () => {
  const { localIntent, build: local } = localTrade()
  const tx = decodeTransaction(hexToBin(local.unsigned_tx_hex))
  // One more PUSD unit out of the pool and into the wallet: tokens are still conserved.
  tx.outputs[0].token.amount -= 1n
  tx.outputs.find(o => o.token && o !== tx.outputs[0]).token.amount += 1n
  const reviewed = reviewBuild({ ...local, unsigned_tx_hex: binToHex(encodeTransaction(tx)) }, localIntent)
  assert.throws(() => checkPoolCovenants(reviewed), /does not accept/)
})

test('a sale the funding cannot cover is reported as insufficient funds', () => {
  const { trade, localIntent } = localTrade()
  assert.throws(() => tradeTransaction(trade, { ...localIntent, funding: [{ ...localFunding[0], value: '500000' }] }), e => e.code === 'insufficient_funds')
})

// --- A sale fitted to its funding --------------------------------------------------------------

const short = () => new CauldronError('insufficient_funds', 'short')

test('fitSale takes the ceiling when it is funded and narrows to the largest funded sale otherwise', async () => {
  let calls = 0
  assert.equal(await fitSale(1_000n, async sell => (calls++, sell)), 1_000n)
  assert.equal(calls, 1)
  for (const limit of [999n, 1_000n, 1_337n, 5_000n, 50_000n, 123_456n]) {
    const ceiling = 1_000_000n
    const sold = await fitSale(ceiling, async sell => {
      if (sell > ceiling - limit) throw short()
      return sell
    })
    assert.ok(sold <= ceiling - limit && sold > ceiling - limit - 64n, `shortfall ${limit}: sold ${sold}`)
  }
})

test('fitSale fails like the first attempt when nothing can be funded and never swallows other errors', async () => {
  await assert.rejects(fitSale(10_000n, async () => { throw short() }), e => e.code === 'insufficient_funds')
  await assert.rejects(fitSale(10_000n, async sell => { if (sell === 10_000n) throw short(); throw new CauldronError('route_failed', 'pools') }), e => e.code === 'route_failed')
  await assert.rejects(fitSale(10_000n, async () => { throw new Error('network') }), /network/)
})

test('a purchase fitted to its funding sells all the funding can pay for and still passes every check', async () => {
  const pool = cauldronPool(108_000_000n, 30_000n)
  const fit = async (funding, payout) => {
    const total = funding.reduce((sum, f) => sum + BigInt(f.value), 0n)
    return fitSale(total, async sell => {
      const trade = bestTrade([pool], sell)
      const intent = {
        category: PUSD, side: 'buy', funding, lockingBytecode: binding.lockingBytecode, tokenAddress: binding.tokenAddress, cashAddress: binding.cashAddress,
        sell: trade.summary.supply, minOutput: minOutputFor(trade.summary.demand), ...(payout && { payout })
      }
      const build = tradeTransaction(trade, intent)
      const reviewed = reviewBuild(build, intent)
      checkPoolCovenants(reviewed)
      return { trade, reviewed, total }
    })
  }
  for (const payout of [undefined, { tokenScript: otherBinding.lockingBytecode, changeScript: otherBinding.lockingBytecode }]) {
    for (const funding of [[{ txid: 'ee'.repeat(32), vout: 0, value: '1010000' }], [{ txid: 'ee'.repeat(32), vout: 0, value: '600000' }, { txid: 'ef'.repeat(32), vout: 1, value: '410000' }], [{ txid: 'ee'.repeat(32), vout: 0, value: '25000' }]]) {
      const { trade, reviewed, total } = await fit(funding, payout)
      // Little is left over: the fee, the token's dust and at most one pool step (~3,700 sats a PUSD unit).
      assert.ok(total - trade.summary.supply < 6_000n, `left ${total - trade.summary.supply} of ${total}`)
      // That is more than the fixed reserve sold, and the wallet never spends beyond the funding.
      assert.ok(trade.summary.supply > secondLegSellAmount(total))
      assert.ok(reviewed.debitSats <= total)
    }
  }
})

// Selling the token back for BCH: the funding carries the tokens on the bound address, as a wallet holds them.
const localSale = (tokens = 300n) => {
  const trade = bestTrade([cauldronPool(108_000_000n, 30_000n)], tokens, PUSD, 'sell')
  const saleIntent = {
    category: PUSD,
    side: 'sell',
    funding: [{ txid: 'ef'.repeat(32), vout: 1, value: '1000', token: { category: PUSD, amount: '500' } }],
    lockingBytecode: binding.lockingBytecode,
    tokenAddress: binding.tokenAddress,
    cashAddress: binding.cashAddress,
    sell: trade.summary.supply,
    minOutput: minOutputFor(trade.summary.demand)
  }
  return { trade, saleIntent, build: tradeTransaction(trade, saleIntent) }
}

test('a local token sale pays BCH to the wallet, returns the unsold tokens and passes every check', () => {
  const { trade, saleIntent, build: local } = localSale()
  assert.equal(trade.summary.supply, 300n)
  // ~300 units at ~3,600 sats each, less the 0.3% pool fee and price impact.
  assert.ok(trade.summary.demand > 1_000_000n && trade.summary.demand < 1_090_000n, `got ${trade.summary.demand}`)
  const reviewed = reviewBuild(local, saleIntent)
  assert.equal(reviewed.side, 'sell')
  assert.equal(reviewed.tokensSold, 300n)
  assert.equal(reviewed.output, trade.summary.demand)
  assert.equal(reviewed.debitSats, 0n)
  assert.ok(reviewed.bchOutputs.length >= 1 && reviewed.bchOutputs.every(o => o.value > 0n))
  checkPoolCovenants(reviewed)
  const signed = signBuild(decodeTransaction(hexToBin(reviewed.unsignedHex)), sourcesOf(reviewed), reviewed.ownIndexes)
  assert.equal(checkSigned(reviewed.unsignedHex, signed, reviewed.ownIndexes, sourcesOf(reviewed), binding.pubkey), txidOf(signed))
})

test('a token sale is refused when it sells more than approved, pays too little BCH or spends unapproved tokens', () => {
  const { saleIntent, build: local } = localSale()
  assert.throws(() => reviewBuild(local, { ...saleIntent, sell: 299n }), /More tokens leave/)
  assert.throws(() => reviewBuild(local, { ...saleIntent, minOutput: 10_000_000n }), /less (BCH|than)/)
  assert.throws(() => reviewBuild(local, { ...saleIntent, funding: [{ ...saleIntent.funding[0], token: { category: PUSD, amount: '501' } }] }), /does not match/)
  assert.throws(() => reviewBuild(local, { ...saleIntent, side: 'buy' }), /does not match|BCH only/)
  assert.throws(() => tradeTransaction(localSale().trade, { ...saleIntent, funding: [{ ...saleIntent.funding[0], token: { category: PUSD, amount: '100' } }] }), e => e.code === 'insufficient_funds')
})

const MIN_SWAP_404 = { providerErrors: [{ provider: 'THORCHAIN', error: 'amount less than min swap amount (recommended_min_amount_in: 36045): invalid request', errorCode: 'unknownApiError' }] }

// Runs getQuotes against a stubbed proxy answer, recording what reached console.error.
const quoteWith = async (status, body) => {
  const fetchBefore = globalThis.fetch
  const errorBefore = console.error
  const logged = []
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, statusText: status === 404 ? 'Not Found' : 'Bad Gateway', headers: { 'content-type': 'application/json' } })
  console.error = (...args) => logged.push(args.join(' '))
  try {
    return { result: await getQuotes({ sellAsset: 'BASE.ETH', buyAsset: 'BCH.BCH', sellAmount: '0.0001', slippage: 3, providers: ['THORCHAIN'] }).catch(error => error), logged }
  } finally {
    globalThis.fetch = fetchBefore
    console.error = errorBefore
  }
}

test('the THORChain minimum is read from the provider error in asset units', () => {
  assert.equal(minimumFromProviderErrors(MIN_SWAP_404), '0.00036045')
  assert.equal(minimumFromProviderErrors({ providerErrors: [{ error: 'trading is halted' }] }), undefined)
  assert.equal(minimumFromProviderErrors(null), undefined)
})

test('a quote under the minimum is a quiet BelowMinimumError carrying the minimum', async () => {
  const { result, logged } = await quoteWith(404, MIN_SWAP_404)
  assert.ok(result instanceof BelowMinimumError)
  assert.equal(result.minimum, '0.00036045')
  assert.deepEqual(logged, [])
})

test('any other quote failure is still a logged USwapError the quote error resolver understands', async () => {
  const { result, logged } = await quoteWith(502, { providerErrors: [{ provider: 'THORCHAIN', error: 'pool not available' }] })
  assert.equal(result.name, 'USwapError')
  assert.equal(result.cause.status, 502)
  assert.equal(resolveQuoteError(result).message, 'pool not available')
  assert.equal(logged.length, 1)
})

test('the confirm summary for a PUSD destination: received PUSD, its USD value and an impact made of fees and pool impact', async () => {
  const { bridgeSummary, PUSD_LEG_SECONDS } = await import('../src/lib/bridge-summary.ts')
  // 0.001 ETH at $2,300 → 0.0073 BCH at $280; 0.0072 BCH sold to the pools for 2.00 PUSD (2.02 at spot).
  const summary = bridgeSummary({
    sent: 0.001,
    sentUsd: 2.3,
    bch: 0.0073,
    bchUsd: 280,
    thorFeeUsd: 0.2,
    sourceGasUsd: 0.01,
    thorSeconds: 600,
    pusd: { output: 2.0, spotOutput: 2.02, sell: 0.0072, tradeFee: 0.0000216, minerFee: 0.000002 }
  })
  const pusdUsd = (0.0072 * 280) / 2.02
  assert.equal(summary.received, 2.0)
  assert.ok(Math.abs(summary.receivedUsd - 2 * pusdUsd) < 1e-9)
  assert.equal(summary.seconds, 600 + PUSD_LEG_SECONDS)
  assert.ok(Math.abs(summary.gasUsd - (0.01 + 0.000002 * 280)) < 1e-9)
  assert.ok(summary.impactUsd < 0)
  // Every dollar lost (except gas) is the THORChain fee, the Cauldron fee, or pool impact.
  const parts = -0.2 - summary.cauldronFeeUsd + summary.poolImpactUsd
  assert.ok(Math.abs(parts - summary.impactUsd) < 1e-9 || summary.poolImpactUsd === 0)
  assert.ok(Math.abs(summary.impactPercent - (summary.impactUsd / 2.3) * 100) < 1e-9)
})

test('the confirm summary for plain BCH has no PUSD leg time, no Cauldron fee, and unknown prices stay unknown', async () => {
  const { bridgeSummary } = await import('../src/lib/bridge-summary.ts')
  const summary = bridgeSummary({ sent: 0.001, sentUsd: 2.3, bch: 0.0073, bchUsd: 280, thorFeeUsd: 0.2, thorSeconds: 600 })
  assert.equal(summary.received, 0.0073)
  assert.equal(summary.seconds, 600)
  assert.equal(summary.cauldronFeeUsd, undefined)
  assert.ok(Math.abs(summary.impactUsd - (0.0073 * 280 - 2.3)) < 1e-9)
  const unpriced = bridgeSummary({ sent: 0.001, bch: 0.0073, thorSeconds: 0 })
  assert.equal(unpriced.receivedUsd, undefined)
  assert.equal(unpriced.impactPercent, undefined)
  assert.equal(unpriced.seconds, undefined)
})

test('confirm figures are formatted as the design shows them', async () => {
  const { formatUsd, formatPercent, formatMinutes, formatAmount } = await import('../src/lib/bridge-summary.ts')
  assert.equal(formatUsd(2.314), '$2.31')
  assert.equal(formatUsd(-0.28), '−$0.28')
  assert.equal(formatUsd(0.004), '<$0.01')
  assert.equal(formatPercent(-12.13), '−12.1%')
  assert.equal(formatPercent(-0.44), '−0.44%')
  assert.equal(formatMinutes(590), 10)
  assert.equal(formatMinutes(10), 1)
  assert.equal(formatAmount(2040.123), '2,040.12')
  assert.equal(formatAmount(0.00729561234), '0.00729561')
})

test('the PUSD swap is broadcast through Fulcrum first and through Cauldron only when Fulcrum cannot be reached', async () => {
  const { broadcastBchTransaction, BroadcastRejected } = await import('../src/lib/cauldron.ts')
  const { RpcError } = await import('../src/lib/bch.ts')
  const txid = 'ab'.repeat(32)
  const calls = []
  const routes = (fulcrum, cauldron = async () => { calls.push('cauldron'); return txid }) => ({
    fulcrum: async hex => { calls.push('fulcrum'); return fulcrum(hex) },
    cauldron
  })

  // Accepted by Fulcrum: Cauldron is never asked.
  assert.equal(await broadcastBchTransaction('00', txid, routes(async () => txid)), txid)
  assert.deepEqual(calls.splice(0), ['fulcrum'])

  // Fulcrum unreachable: the same bytes go to Cauldron.
  assert.equal(await broadcastBchTransaction('00', txid, routes(async () => { throw new Error('Could not connect to bch.imaginary.cash') })), txid)
  assert.deepEqual(calls.splice(0), ['fulcrum', 'cauldron'])

  // Already known to the node: success, nothing else is tried.
  assert.equal(await broadcastBchTransaction('00', txid, routes(async () => { throw new RpcError('1', 'txn-already-known') })), txid)
  assert.deepEqual(calls.splice(0), ['fulcrum'])

  // Rejected by the node (e.g. a pool already spent): a rejection, not a retry elsewhere.
  await assert.rejects(broadcastBchTransaction('00', txid, routes(async () => { throw new RpcError('1', 'the transaction was rejected by network rules. missing-inputs') })), BroadcastRejected)
  assert.deepEqual(calls.splice(0), ['fulcrum'])
})

test('a backup rejection cannot rule out a broadcast whose Fulcrum answer was lost', async () => {
  const { broadcastBchTransaction, BroadcastRejected, BroadcastUnknown } = await import('../src/lib/cauldron.ts')
  const { RpcTimeoutError } = await import('../src/lib/bch.ts')
  const txid = 'ab'.repeat(32)
  await assert.rejects(broadcastBchTransaction('00', txid, {
    fulcrum: async () => { throw new RpcTimeoutError('Broadcast answer lost') },
    cauldron: async () => { throw new BroadcastRejected('Missing inputs') }
  }), BroadcastUnknown)
})

test('the chains decide the first leg: BCH seen at the bound address (0-conf) makes the PUSD swap ready', async () => {
  const { firstLegFromChain } = await import('../src/lib/bridge-tracking.ts')
  const op = { destinationAsset: 'PUSD', firstLeg: { result: 'pending' } }
  const outputs = [{ txid: 'ab'.repeat(32), vout: 0, value: '4873362', confirmations: 0, unspent: true }]

  // Only the source receipt so far: its depth is recorded, the stage stays.
  const pending = firstLegFromChain(op, { source: { confirmations: 3, failed: false }, outbound: { kind: 'not_found' } })
  assert.equal(pending.stage, undefined)
  assert.equal(pending.firstLeg.sourceConfirmations, 3)

  // The outbound in the mempool: ready at once, with the exact amount received.
  const arrived = firstLegFromChain(op, { source: { confirmations: 5, failed: false }, outbound: { kind: 'ok', outputs, total: '4873362', confirmations: 0 } })
  assert.equal(arrived.stage, 'bch_ready')
  assert.deepEqual(arrived.received, outputs)
  assert.equal(arrived.firstLeg.result, 'swapped')
  assert.ok(arrived.firstLeg.receivedAt > 0)

  // Plain BCH: arrival finishes the operation.
  assert.equal(firstLegFromChain({ ...op, destinationAsset: 'BCH' }, { outbound: { kind: 'ok', outputs, total: '4873362', confirmations: 0 } }).stage, 'kept_bch')

  // Already spent from the wallet before the swap: not offered for the PUSD swap.
  const spent = firstLegFromChain(op, { outbound: { kind: 'ok', outputs: [{ ...outputs[0], unspent: false, confirmations: 1 }], total: '4873362', confirmations: 1 } })
  assert.equal(spent.stage, 'bch_unconfirmed')
  assert.match(spent.error, /already been spent/)

  // A reverted source transaction ends the operation; nothing reached THORChain.
  assert.equal(firstLegFromChain(op, { source: { confirmations: 2, failed: true } }).stage, 'failed')
  // Nothing new: no update at all.
  assert.equal(firstLegFromChain({ ...op, firstLeg: { result: 'pending', sourceConfirmations: 3 } }, { source: { confirmations: 3, failed: false } }), undefined)
})

test('step times count down against the quote, then show the time elapsed', async () => {
  const { stepTime, formatStepTime } = await import('../src/lib/bridge-tracking.ts')
  const start = 1_000_000
  assert.deepEqual(formatStepTime(stepTime(start + 10_000, start, 150)), { key: 'minutes', value: 3 })
  assert.deepEqual(formatStepTime(stepTime(start + 100_000, start, 150)), { key: 'seconds', value: 50 })
  assert.deepEqual(formatStepTime(stepTime(start + 185_000, start, 150)), { key: 'elapsed', value: '3:05' })
  assert.deepEqual(formatStepTime(stepTime(start + 65_000, start, undefined)), { key: 'elapsed', value: '1:05' })
})

test('the first leg is timed without a BCH block wait, which the 0-conf bridge does not need', async () => {
  const { firstLegSeconds } = await import('../src/lib/bridge-summary.ts')
  // The aggregator's Base → BCH estimate: 24 s inbound, 6 s swap, 600 s outbound (a BCH block).
  assert.equal(firstLegSeconds({ inbound: 24, swap: 6, outbound: 600, total: 630 }), 24 + 6 + 90)
  // A real THORChain outbound delay beyond the block wait still counts.
  assert.equal(firstLegSeconds({ inbound: 24, swap: 6, outbound: 1800, total: 1830 }), 24 + 6 + 90 + 1200)
  assert.equal(firstLegSeconds({ total: 630 }), 630)
  assert.equal(firstLegSeconds(undefined), undefined)
})

// --- Reverse direction: THORChain deposit -------------------------------------------------------

test('a deposit memo must swap to the asked asset and pay the asked address within 80 bytes', async () => {
  const { checkDepositMemo } = await import('../src/lib/thorchain-deposit.ts')
  const want = { buyAsset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', destination: '0x76ff6F88f58e083b88A80B1764ae7002e303D1A6' }
  assert.doesNotThrow(() => checkDepositMemo('=:BASE.USDC:0x76ff6f88f58e083b88a80b1764ae7002e303d1a6:261106164', want))
  assert.doesNotThrow(() => checkDepositMemo('s:BASE.USDC:0x76ff6F88f58e083b88A80B1764ae7002e303D1A6', want))
  assert.throws(() => checkDepositMemo('=:BASE.ETH:0x76ff6F88f58e083b88A80B1764ae7002e303D1A6:1', want), /different asset/)
  assert.throws(() => checkDepositMemo('=:BASE.USDC:0x000000000000000000000000000000000000dEaD:1', want), /different address/)
  assert.throws(() => checkDepositMemo('+:BASE.USDC:0x76ff6F88f58e083b88A80B1764ae7002e303D1A6', want), /not a swap/)
  assert.throws(() => checkDepositMemo(`=:BASE.USDC:0x76ff6F88f58e083b88A80B1764ae7002e303D1A6:${'1'.repeat(40)}`, want), /longer/)
})

test('a deposit memo may not set a limit below the minimum shown', async () => {
  const { checkDepositMemo } = await import('../src/lib/thorchain-deposit.ts')
  const want = { buyAsset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', destination: '0x76ff6F88f58e083b88A80B1764ae7002e303D1A6', minOut: '2.61106164' }
  const memo = limit => `=:BASE.USDC:0x76ff6F88f58e083b88A80B1764ae7002e303D1A6:${limit}`
  assert.doesNotThrow(() => checkDepositMemo(memo('261106164'), want))
  assert.doesNotThrow(() => checkDepositMemo(memo('260000000/1/0'), want), 'within the shown figure’s rounding')
  assert.doesNotThrow(() => checkDepositMemo(memo('0/1/0'), want), 'no limit, as THORChain quotes a streaming swap')
  assert.throws(() => checkDepositMemo(memo('250000000'), want), /less than the minimum shown/)
  assert.throws(() => checkDepositMemo(memo('25e7/3/0'), want), /less than the minimum shown/)
  assert.doesNotThrow(() => checkDepositMemo(memo('250000000'), { ...want, minOut: undefined }))
})

test('a deposit pays only THORChain’s current, open BCH vault', async () => {
  const { checkInbound } = await import('../src/lib/thorchain-deposit.ts')
  const vault = otherBinding.cashAddress
  const inbounds = [
    { chain: 'BCH', address: vault.split(':')[1], halted: false, chain_trading_paused: false, gas_rate: '3' },
    { chain: 'BASE', address: '0x718f', router: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4', halted: false, chain_trading_paused: false }
  ]
  const ok = checkInbound(inbounds, vault, 'BASE')
  assert.equal(ok.vaultScript, otherBinding.lockingBytecode)
  assert.equal(ok.router, '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4')
  assert.equal(ok.feeRate, 3n)
  assert.throws(() => checkInbound(inbounds, binding.cashAddress, 'BASE'), /not THORChain/)
  assert.throws(() => checkInbound([{ ...inbounds[0], halted: true }, inbounds[1]], vault, 'BASE'), /paused/)
  assert.throws(() => checkInbound([inbounds[0], { ...inbounds[1], chain_trading_paused: true }], vault, 'BASE'), /paused/)
})

test('a deposit pays the vault first, carries the memo, returns change, signs and verifies', async () => {
  const { buildDeposit } = await import('../src/lib/thorchain-deposit.ts')
  const memo = '=:BASE.USDC:0x76ff6F88f58e083b88A80B1764ae7002e303D1A6:261106164'
  const funding = [{ txid: 'ab'.repeat(32), vout: 2, value: '1500000' }]
  const built = buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript: otherBinding.lockingBytecode, memo, amountSats: 1_000_000n, feeRate: 1n })
  const tx = decodeTransaction(hexToBin(built.unsignedHex))
  assert.equal(binToHex(tx.outputs[0].lockingBytecode), otherBinding.lockingBytecode)
  assert.equal(tx.outputs[0].valueSatoshis, 1_000_000n)
  assert.equal(opReturnText(tx.outputs[1].lockingBytecode), memo)
  assert.equal(binToHex(tx.outputs[2].lockingBytecode), binding.lockingBytecode)
  assert.equal(built.amountSats + built.minerFeeSats + built.changeSats, 1_500_000n)
  assert.ok(built.minerFeeSats > 200n && built.minerFeeSats < 500n, `fee ${built.minerFeeSats}`)
  const signed = signBuild(tx, sourcesOf(built), built.ownIndexes)
  assert.equal(checkSigned(built.unsignedHex, signed, built.ownIndexes, sourcesOf(built), binding.pubkey), txidOf(signed))

  const all = buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript: otherBinding.lockingBytecode, memo, payAll: true, feeRate: 1n })
  assert.equal(all.changeSats, 0n)
  assert.equal(decodeTransaction(hexToBin(all.unsignedHex)).outputs.length, 2)
  assert.equal(all.amountSats + all.minerFeeSats, 1_500_000n)
  assert.throws(() => buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript: otherBinding.lockingBytecode, memo, amountSats: 5_000n, feeRate: 1n }), /minimum/)
  assert.throws(() => buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript: otherBinding.lockingBytecode, memo, amountSats: 1_499_900n, feeRate: 1n }), /does not cover/)

  // A NEAR Intents deposit address takes a plain transfer: no memo output at all.
  const plain = buildDeposit({ funding, lockingBytecode: binding.lockingBytecode, vaultScript: otherBinding.lockingBytecode, amountSats: 1_000_000n, feeRate: 1n })
  const plainTx = decodeTransaction(hexToBin(plain.unsignedHex))
  assert.deepEqual(plainTx.outputs.map(o => binToHex(o.lockingBytecode)), [otherBinding.lockingBytecode, binding.lockingBytecode])
  assert.equal(plainTx.outputs[0].valueSatoshis, 1_000_000n)
  assert.ok(plain.minerFeeSats < built.minerFeeSats)
})

test('the payout is the router’s TransferOut to the destination with the deposit’s OUT memo', async () => {
  const { matchPayout, TRANSFER_FAILED_TOPIC, TRANSFER_OUT_TOPIC } = await import('../src/lib/thorchain-deposit.ts')
  const { AbiCoder } = await import('ethers')
  const destination = '0x76ff6F88f58e083b88A80B1764ae7002e303D1A6'
  const deposit = 'e3a1b0c2d4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a6b8'
  const router = '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4'
  const want = { destination, depositTxid: deposit, router, buyAsset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' }
  const log = (memo, to = destination) => ({
    address: router,
    topics: [TRANSFER_OUT_TOPIC, `0x${'0'.repeat(24)}718f6c9df785bc4e323086de024ca822efbe8ab9`, `0x${'0'.repeat(24)}${to.slice(2).toLowerCase()}`],
    data: AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'string'], ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 2_611_061n, memo]),
    transactionHash: '0xfeed',
    blockNumber: 1
  })
  assert.deepEqual(matchPayout([log(`OUT:${deposit.toUpperCase()}`)], want), {
    hash: '0xfeed',
    amount: '2611061',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  })
  assert.equal(matchPayout([log(`OUT:${'00'.repeat(32)}`)], want), undefined)
  assert.equal(matchPayout([log(`OUT:${deposit}`, '0x000000000000000000000000000000000000dEaD')], want), undefined)
  assert.equal(matchPayout([log(`REFUND:${deposit}`)], want), undefined)
  assert.equal(matchPayout([{ ...log(`OUT:${deposit}`), address: destination }], want), undefined, 'another contract can emit the same event')
  const native = { ...log(`OUT:${deposit}`), data: AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'string'], ['0x' + '00'.repeat(20), 1000n, `OUT:${deposit}`]) }
  assert.equal(matchPayout([native], want), undefined, 'receiving native currency is not receiving USDC')
  assert.equal(matchPayout([native], { ...want, buyAsset: 'BASE.ETH' }).amount, '1000')
  const bounced = { ...native, topics: [TRANSFER_FAILED_TOPIC, ...native.topics.slice(1)], data: AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'string'], ['0x' + '00'.repeat(20), 1000n, '']) }
  assert.equal(matchPayout([bounced, native], { ...want, buyAsset: 'BASE.ETH' }), undefined, 'ETH the recipient refused went back to the vault')
  const zero = { ...log(`OUT:${deposit}`), data: AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'string'], ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 0n, `OUT:${deposit}`]) }
  assert.equal(matchPayout([zero], want), undefined)
  assert.equal(matchPayout([{ ...log(`OUT:${deposit}`), data: '0x00' }], want), undefined)
})

test('a BCH refund of a deposit is recognised by its REFUND memo', () => {
  const raw = { hex: outboundTx({ to: ownScript, amount: 900_000n, memo: `REFUND:${inboundHash}` }) }
  raw.tx = decodeTx(raw.hex)
  const ctx = { inboundHash, lockingBytecode: binding.lockingBytecode, expectedSats: 900_000n }
  assert.equal(checkOutbound(raw, ctx, { tip: 1, utxos: [] }).kind, 'invalid', 'an OUT check does not accept a refund')
  assert.equal(checkOutbound(raw, { ...ctx, action: 'REFUND' }, { tip: 1, utxos: [] }).kind, 'ok')
})

// --- BCH wallet signing outcomes ----------------------------------------------------------------

test('a wallet request ends as declined, timed out, cancelled or undelivered, and is re-sent only if it never left', async () => {
  const { signInWallet, SignCancelled, SignDeclined, SignTimedOut, SignUndelivered } = await import('../src/lib/bch-signing.ts')
  const tx = { unsignedHex: '00', sourceOutputs: [], ownIndexes: [] }
  const manager = handler => {
    const calls = []
    return {
      calls,
      signTransaction: (request, { signal }) => {
        calls.push(request)
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          handler(calls.length, resolve, reject)
        })
      }
    }
  }
  const declined = manager((n, resolve, reject) => reject(new Error('User rejected')))
  await assert.rejects(signInWallet(declined, binding, tx, 'x'), SignDeclined)

  // AbortSignal.timeout does not keep Node's event loop alive on its own.
  const keepAlive = setInterval(() => {}, 1_000)
  const silent = manager(() => {})
  await assert.rejects(signInWallet(silent, binding, tx, 'x', { timeoutMs: 20 }), SignTimedOut).finally(() => clearInterval(keepAlive))

  const controller = new AbortController()
  const cancelled = signInWallet(manager(() => {}), binding, tx, 'x', { signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, SignCancelled)

  // A failed publish may still have reached the wallet: not sent twice.
  const lost = manager((n, resolve, reject) => reject(new Error('Failed to publish sign_transaction_request to all relays')))
  await assert.rejects(signInWallet(lost, binding, tx, 'x'), SignUndelivered)
  assert.equal(lost.calls.length, 1)

  // No relay connection at all: it never left, so it is sent once more.
  const offline = manager((n, resolve, reject) => reject(new Error('[wizardconnect/dapp] Not connected')))
  await assert.rejects(signInWallet(offline, binding, tx, 'x'), SignUndelivered)
  assert.equal(offline.calls.length, 2)
})

test('the payout time comes from THORNode’s confirmation countdown, not the quote', async () => {
  const { depositReadyAt } = await import('../src/lib/reverse-bridge.ts')
  const now = 1_000_000
  // As THORNode answered for a real deposit waiting for 4 BCH confirmations.
  const waiting = { stages: { inbound_observed: { completed: true }, inbound_confirmation_counted: { remaining_confirmation_seconds: 1614, completed: false }, swap_status: { pending: false } } }
  assert.equal(depositReadyAt(waiting, now), now + (1614 + 60) * 1000)
  assert.equal(depositReadyAt({ stages: { inbound_observed: { completed: false } } }, now), undefined)
  const delayed = { stages: { inbound_observed: { completed: true }, inbound_confirmation_counted: { completed: true }, outbound_delay: { remaining_delay_seconds: 30, completed: false } } }
  assert.equal(depositReadyAt(delayed, now), now + 90 * 1000)
})

test('price impact is the whole loss: slippage, or the value lost to fixed fees when larger', async () => {
  const { resolvePriceImpact } = await import('../src/lib/swap-helpers.ts')
  const { USwapNumber } = await import('@tcswap/core')
  const quote = (buy, slippageBps) => ({ sellAmount: '1', expectedBuyAmount: buy, meta: { slippageBps } })
  const usd = n => new USwapNumber(n)
  // 1 USDC in, $0.73 out: the outbound fee is 27%, the pool slippage only 0.19%.
  assert.equal(resolvePriceImpact(quote('0.73', 19), usd(1), usd(1)).toSignificant(4), '27')
  assert.equal(resolvePriceImpact(quote('0.999', 19), usd(1), usd(1)).toSignificant(4), '0.19')
  assert.equal(resolvePriceImpact(quote('0.73', 19)).toSignificant(4), '0.19', 'without rates only slippage is known')
  assert.equal(resolvePriceImpact(quote('0.9', undefined), usd(1), usd(1)).toSignificant(4), '10')
})

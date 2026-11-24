// The bridge's step tracking, step by step, against a fake Fulcrum server: what each saved stage moves to.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { binToHex, encodeTransaction, hexToBin } from '@bitauth/libauth'
import { bindingFromPubkey, txidOf } from '../src/lib/bch.ts'
import { pubkey } from './fixtures/bridge-fixtures.mjs'

const binding = bindingFromPubkey(pubkey, 0)
let syncBridge

// A transaction of its own id (seeded), paying the bound address.
const makeTx = seed =>
  binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin(seed.repeat(32)), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0) }],
      outputs: [{ lockingBytecode: hexToBin(binding.lockingBytecode), valueSatoshis: 1_000_000n }]
    })
  )
const delivery = makeTx('31')
const swap = makeTx('32')
const deposit = makeTx('33')
const foreign = makeTx('34')

// What the fake server knows: unspent outputs of the address, transactions by id with their depth, and the address history.
const server = { unspent: [], txs: {}, history: [] }
const reset = () => Object.assign(server, { unspent: [], txs: {}, history: [] })
const knows = (hex, confirmations = 0) => (server.txs[txidOf(hex)] = { hex, confirmations })

before(async () => {
  const answers = {
    'server.version': () => ['Fulcrum', '1.5'],
    'blockchain.headers.subscribe': () => ({ height: 100 }),
    'blockchain.scripthash.listunspent': () => server.unspent,
    'blockchain.scripthash.get_history': () => server.history.map(hex => ({ tx_hash: txidOf(hex), height: 0 })),
    'blockchain.transaction.get': ([hash, verbose]) => {
      const known = server.txs[hash]
      return known && (verbose ? { confirmations: known.confirmations } : known.hex)
    }
  }
  globalThis.WebSocket = class {
    static OPEN = 1
    readyState = 0
    constructor() {
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.()
      })
    }
    send(data) {
      const { id, method, params } = JSON.parse(data)
      const result = answers[method]?.(params)
      const reply = result === undefined ? { jsonrpc: '2.0', id, error: { code: 2, message: 'not found' } } : { jsonrpc: '2.0', id, result }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }))
    }
    close() {
      this.readyState = 3
      this.onclose?.()
    }
  }
  ;({ syncBridge } = await import('../src/lib/bridge-sync.ts'))
})

// One pass over the operation; returns the patch it made (undefined: no change).
const sync = async bridge => {
  let patch
  await syncBridge({ uid: 'u1', bridge }, (uid, fn) => (patch = { ...patch, ...fn(bridge) }), () => {})
  return patch
}
const out = (hex, extra = {}) => ({ txid: txidOf(hex), vout: 0, value: '1000000', confirmations: 0, unspent: false, ...extra })
const listed = (hex, height = 0) => ({ tx_hash: txidOf(hex), tx_pos: 0, value: 1_000_000, height })
const forward = (stage, extra = {}) => ({ direction: 'forward', stage, binding, destinationAsset: 'PUSD', firstLeg: { result: 'success' }, received: [out(delivery)], ...extra })

test('received BCH: listed unspent is ready; missing waits for a lagging server unless it is mined or was seen', async () => {
  reset()
  server.unspent = [listed(delivery, 100)]
  assert.equal((await sync(forward('bch_unconfirmed'))).stage, 'bch_ready')

  reset()
  knows(delivery, 0)
  assert.equal((await sync(forward('bch_unconfirmed'))).stage, 'bch_unconfirmed', 'in the mempool, not yet listed')

  reset()
  knows(delivery, 2)
  const mined = await sync(forward('bch_unconfirmed'))
  assert.equal(mined.stage, 'kept_bch', 'mined and no longer unspent: spent outside the app')
  assert.match(mined.error, /spent from your wallet outside this app/)

  reset()
  assert.equal((await sync(forward('bch_unconfirmed', { received: [out(delivery, { unspent: true })] }))).stage, 'kept_bch', 'seen unspent before')
  assert.equal((await sync(forward('bch_ready'))).stage, 'kept_bch', 'the swap was already offered')
})

test('received BCH for a native BCH transfer ends it, or goes back to the refund it was', async () => {
  reset()
  server.unspent = [listed(delivery, 100)]
  assert.equal((await sync(forward('bch_unconfirmed', { destinationAsset: 'BCH' }))).stage, 'kept_bch')
  assert.equal((await sync(forward('bch_unconfirmed', { destinationAsset: 'BCH', firstLeg: { result: 'refund_pending' } }))).stage, 'first_leg_pending')
})

test('token swap: done once the network holds it, or the address history shows it spent the BCH', async () => {
  const leg = { attempt: 'a1', txid: txidOf(swap) }
  reset()
  knows(swap, 0)
  const held = await sync(forward('second_leg_pending', { secondLeg: leg }))
  assert.equal(held.stage, 'completed')
  assert.equal(held.secondLeg.confirmations, 0)

  reset()
  server.history = [delivery, swap]
  assert.equal((await sync(forward('second_leg_pending', { secondLeg: leg }))).stage, 'completed', 'the server lags on the swap id')

  reset()
  server.history = [delivery, foreign]
  const lost = await sync(forward('second_leg_pending', { secondLeg: leg }))
  assert.equal(lost.stage, 'failed')

  reset()
  server.unspent = [listed(delivery)]
  assert.equal(await sync(forward('second_leg_pending', { secondLeg: leg })), undefined, 'BCH still there: keep waiting')
})

test('back from BCH: a seen deposit moves on; sale BCH spent elsewhere is kept, not lost', async () => {
  const reverse = (stage, extra = {}) => ({ direction: 'reverse', stage, binding, reverse: { buyAsset: 'ETH.ETH', ...extra } })
  reset()
  knows(deposit, 0)
  assert.equal((await sync(reverse('second_leg_signed', { deposit: { attempt: 'd1', txid: txidOf(deposit) } }))).stage, 'second_leg_pending')

  reset()
  assert.equal(await sync(reverse('second_leg_signed', { deposit: { attempt: 'd1', txid: txidOf(deposit) } })), undefined, 'not seen yet')

  const sold = reverse('bch_ready', { sale: { txid: txidOf(delivery), outputs: [out(delivery)] } })
  reset()
  server.unspent = [listed(delivery)]
  assert.equal(await sync(sold), undefined, 'the sale BCH is still there')

  reset()
  const kept = await sync(sold)
  assert.equal(kept.stage, 'kept_bch')

  reset()
  server.history = [deposit]
  assert.equal(await sync(reverse('bch_ready', { sale: sold.reverse.sale, priorDepositTxids: [txidOf(deposit)] })), undefined, 'spent by one of its own deposits')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { deriveHdPrivateNodeFromSeed, encodeHdPrivateKey, hexToBin } from '@bitauth/libauth'
import { OrderStore } from '../src/server/auto-bridge/store.ts'
import { WorkerWallet } from '../src/server/auto-bridge/wallet.ts'
import { processOrder } from '../src/server/auto-bridge/worker.ts'
import { createOrder, getOrder, attachSource } from '../src/server/auto-bridge/api.ts'
import { forwardOrder } from '../src/server/auto-bridge/proxy.ts'
import { bindingFromPubkey, decodeTx, txidOf } from '../src/lib/bch.ts'
import { sameSourceTransaction } from '../src/lib/source-transaction.ts'
import { pubkey, otherPubkey, outboundTx } from './fixtures/bridge-fixtures.mjs'

const recipient = bindingFromPubkey(pubkey, 0), refund = bindingFromPubkey(otherPubkey, 0)
const intent = { recipientAddress: recipient.tokenAddress, refundAddress: refund.cashAddress, expectedBchSats: '1000000' }
const limits = { maxOrderSats: 100000000n, maxPendingSats: 2000000n, maxOpenOrders: 100 }
const policy = { minConfirmations: 1, zeroConfMaxSats: 0n, maxWaitMs: 60000 }
const solana = 'AbCdEfGhJkMnPqRsTuVwXyZ123456789'.repeat(4).slice(0, 88)
const setup = (path = ':memory:', customLimits = limits) => {
  const signer = new WorkerWallet(encodeHdPrivateKey({ network: 'mainnet', node: deriveHdPrivateNodeFromSeed(randomBytes(32)) }).hdPrivateKey)
  const store = new OrderStore(path, signer.xpub, customLimits)
  const cap = randomBytes(32).toString('hex'), id = randomUUID()
  const order = store.create(id, cap, intent, '200', 100)
  return { signer, store, cap, id, order }
}
const noSigner = { signSwap() { assert.fail('Unexpected swap signing') }, signRefund() { assert.fail('Unexpected refund signing') } }
const receipt = (order, source) => {
  const hex = outboundTx({ to: hexToBin(order.binding.lockingBytecode), amount: 1000000n, memo: `OUT:${source}` })
  const txid = txidOf(hex)
  return { hex, txid, source, status: {
    tx: { id: source, memo: `=:BCH.BCH:${order.binding.cashAddress}:0` },
    stages: { swap_finalised: { completed: true }, swap_status: { pending: false } },
    out_txs: [{ id: txid, chain: 'BCH', to_address: order.binding.cashAddress, memo: `OUT:${source}`, coins: [{ asset: 'BCH.BCH', amount: '1000000' }] }],
    planned_out_txs: [{ chain: 'BCH', to_address: order.binding.cashAddress, coin: { asset: 'BCH.BCH', amount: '1000000' }, refund: false }]
  } }
}
const gateway = payments => ({
  history: async () => payments.map(p => p.txid), raw: async id => payments.find(p => p.txid === id)?.hex,
  tip: async () => 100,
  coin: async (id, vout) => vout === 0 && payments.some(p => p.txid === id) ? { output: decodeTx(payments.find(p => p.txid === id).hex).outputs[0], confirmations: 0 } : undefined,
  thorStatus: async id => payments.find(p => sameSourceTransaction(p.source, id))?.status,
  observe: async () => ({ seen: false, confirmations: 0 }), broadcast: async () => assert.fail('Unexpected network write')
})
const req = (body, cap, method = 'POST', ip = randomUUID()) => new NextRequest('https://bridge.example/api/auto-bridge/orders', {
  method, headers: { Authorization: `Bearer ${cap}`, 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': ip },
  ...(method === 'POST' && { body: JSON.stringify(body) })
})

test('closed-browser Solana and indexed Cosmos orders discover exact funding without a source callback', async () => {
  for (const source of [solana, 'AB'.repeat(32) + '-1']) {
    const env = setup()
    try {
      await processOrder(env.store, gateway([receipt(env.order, source)]), noSigner, env.order, policy)
      const order = env.store.get(env.id)
      assert.equal(order.state, 'awaiting_confirmations')
      assert.equal(order.funding[0].value, '1000000')
      assert.equal(env.store.exposure(), 1000000n)
    } finally { env.store.close() }
  }
})

test('an existing order paying a service deposit script retains custody without signing', async () => {
  const env = setup(':memory:', { ...limits, maxPendingSats: 100000000n })
  try {
    const order = env.store.create(randomUUID(), randomBytes(32).toString('hex'), {
      ...intent, recipientAddress: env.signer.binding(2).tokenAddress
    }, '200')
    env.store.create(randomUUID(), randomBytes(32).toString('hex'), intent, '200')
    await processOrder(env.store, gateway([receipt(order, 'AB'.repeat(32))]), noSigner, order, policy)
    assert.equal(env.store.get(order.id).state, 'manual_review')
    assert.equal(env.store.exposure(), 1000000n)
    assert.equal(env.store.attempts(order.id).length, 0)
  } finally { env.store.close() }
})

test('multiple inbounds remain quarantined and accounted after the admission reservation expires', async () => {
  const env = setup()
  try {
    await processOrder(env.store, gateway([receipt(env.order, 'AB'.repeat(32)), receipt(env.order, 'CD'.repeat(32))]), noSigner, env.order, policy)
    assert.equal(env.store.get(env.id).state, 'manual_review')
    assert.equal(env.store.exposure(), 2000000n)
    assert.equal(env.store.attempts(env.id).length, 0)
    assert.throws(() => env.store.create(randomUUID(), randomBytes(32).toString('hex'), intent, '200', 31 * 60000), error => error.status === 503)
  } finally { env.store.close() }
})

test('known signed payouts reconcile through native RPC when history is unavailable, with an exact fallback receipt', async () => {
  const env = setup()
  try {
    env.store.update(env.id, env.order.version, { funding: [{ txid: 'ef'.repeat(32), vout: 0, value: '1000000', confirmations: 1, unspent: true }], state: 'ready', receivedAt: 100 })
    const order = env.store.get(env.id), attempt = env.signer.signRefund(order)
    env.store.saveAttempt(order, attempt)
    let histories = 0
    await processOrder(env.store, { ...gateway([]), history: async () => { histories++; throw new Error('History unavailable') }, observe: async () => ({ seen: true, confirmations: 6 }) }, noSigner, env.store.get(env.id), policy)
    assert.equal(histories, 0)
    const view = env.store.public(env.id, env.cap)
    assert.equal(view.state, 'refunded')
    assert.equal(view.settlement.bchAmount, decodeTx(attempt.hex).outputs[0].valueSatoshis.toString())
    assert.notEqual(view.receivedSats, view.settlement.bchAmount)
    assert.equal(view.settlement.seen, true)
    assert.equal(view.settlement.confirmations, 6)
  } finally { env.store.close() }
})

test('late terminal deposits are observed and retained without signing a second payout', async () => {
  for (const state of ['completed', 'refunded', 'source_refunded', 'manual_review']) {
    const env = setup()
    try {
      env.store.update(env.id, env.order.version, { state })
      await processOrder(env.store, gateway([receipt(env.order, 'AB'.repeat(32))]), noSigner, env.store.get(env.id), policy)
      assert.equal(env.store.get(env.id).state, state)
      assert.equal(env.store.exposure(), 1000000n)
      assert.equal(env.store.public(env.id, env.cap).recoverySats, '1000000')
      assert.equal(env.store.attempts(env.id).length, 0)
    } finally { env.store.close() }
  }
})

test('funded work precedes bounded cold scans while old address records remain available', () => {
  const env = setup(':memory:', { ...limits, maxPendingSats: 100000000n })
  try {
    for (let i = 0; i < 8; i++) env.store.create(randomUUID(), randomBytes(32).toString('hex'), intent, '200', i)
    env.store.update(env.id, env.order.version, { funding: [{ txid: 'ef'.repeat(32), vout: 0, value: '1000000', confirmations: 1, unspent: true }] })
    const work = env.store.nextWork(2000000, 2)
    assert.equal(work[0].id, env.id)
    assert.equal(work.length, 3)
    assert.equal(env.store.active().length, 9)
    const next = env.store.nextWork(2000001, 2)
    assert.equal(next[0].id, env.id)
    assert.ok(next.slice(1).every(order => !work.slice(1).some(previous => previous.id === order.id)))
  } finally { env.store.close() }
})

test('restoring a stale database cannot allocate another address or sign, even with the same xpub', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cashbridge-stale-'))
  const path = join(directory, 'orders.sqlite'), snapshot = join(directory, 'old.sqlite')
  const env = setup(path)
  try {
    env.store.close(); copyFileSync(path, snapshot)
    let store = new OrderStore(path, env.signer.xpub, limits)
    store.create(randomUUID(), randomBytes(32).toString('hex'), intent, '200')
    store.close(); copyFileSync(snapshot, path)
    store = new OrderStore(path, env.signer.xpub, limits)
    assert.equal(store.recoveryRequired, true)
    assert.equal(store.public(env.id, env.cap).recoveryRequired, true)
    assert.throws(() => store.create(randomUUID(), randomBytes(32).toString('hex'), intent, '200'), error => error.status === 503)
    await assert.rejects(processOrder(store, gateway([]), noSigner, store.get(env.id), policy), error => error.status === 503)
    store.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('unpaid orders do not use up the Router\'s capacity, while one with a source payment does', () => {
  // The limit holds two orders' worth; the open one from setup is unpaid.
  const env = setup()
  try {
    const more = () => env.store.create(randomUUID(), randomBytes(32).toString('hex'), intent, '200', 200)
    more()
    const paid = more()
    env.store.update(paid.id, paid.version, { sourceHash: solana })
    more()
    const second = more()
    env.store.update(second.id, second.version, { sourceHash: 'AB'.repeat(32) })
    assert.throws(more, error => error.status === 503)
  } finally { env.store.close() }
})

test('closed admission preserves existing idempotent creates, status and source hints', async () => {
  const env = setup()
  const service = { store: env.store, quote: async () => ({ output: 1000n }), admit: () => false }
  try {
    assert.equal((await createOrder(req({ id: env.id, ...intent }, env.cap), service)).status, 200)
    assert.equal((await createOrder(req({ id: randomUUID(), ...intent }, env.cap), service)).status, 503)
    assert.equal((await getOrder(req(undefined, env.cap, 'GET'), env.id, service)).status, 200)
    assert.equal((await attachSource(req({ sourceHash: solana }, env.cap), env.id, service)).status, 200)
    assert.equal(env.store.get(env.id).sourceHash, solana)
    assert.equal((await attachSource(req({ sourceHash: solana.toUpperCase() }, env.cap), env.id, service)).status, 409)
  } finally { env.store.close() }
})

test('status polling does not exhaust the public write bucket', async () => {
  const old = process.env.AUTO_BRIDGE_SOCKET
  process.env.AUTO_BRIDGE_SOCKET = join(tmpdir(), `missing-${randomUUID()}.sock`)
  const cap = randomBytes(32).toString('hex'), ip = randomUUID(), id = randomUUID()
  try {
    for (let i = 0; i < 11; i++) assert.equal((await forwardOrder(req(undefined, cap, 'GET', ip), id)).status, 503)
    assert.equal((await forwardOrder(req({}, cap, 'POST', ip), id)).status, 503)
  } finally { if (old === undefined) delete process.env.AUTO_BRIDGE_SOCKET; else process.env.AUTO_BRIDGE_SOCKET = old }
})

test('a failed commit does not leave the guard ahead of the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cashbridge-guard-error-'))
  const path = join(directory, 'orders.sqlite')
  const env = setup(path)
  const guard = () => readFileSync(`${path}.guard`, 'utf8').trim()
  try {
    const before = guard()
    const exec = env.store.db.exec.bind(env.store.db)
    let failing = true
    env.store.db.exec = sql => {
      if (failing && sql === 'COMMIT') {
        failing = false
        throw new Error('disk full')
      }
      return exec(sql)
    }
    assert.throws(() => env.store.update(env.id, env.order.version, { state: 'streaming' }), /disk full/)
    assert.equal(env.store.recoveryRequired, false)
    assert.equal(guard(), before)
    assert.equal(env.store.get(env.id).state, 'awaiting_deposit')
    assert.equal(env.store.update(env.id, env.order.version, { state: 'streaming' }), true)
    assert.equal(env.store.recoveryRequired, false)
    assert.equal(guard(), String(Number(before) + 1))
  } finally {
    env.store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('polling bookkeeping leaves the guard alone while a state change advances it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cashbridge-guard-poll-'))
  const path = join(directory, 'orders.sqlite')
  const env = setup(path)
  const guard = () => readFileSync(`${path}.guard`, 'utf8').trim()
  try {
    const before = guard()
    assert.equal(env.store.nextWork(500).length, 1)
    assert.equal(env.store.get(env.id).lastCheckedAt, 500)
    assert.equal(guard(), before)
    env.store.update(env.id, env.store.get(env.id).version, { state: 'streaming' })
    assert.equal(guard(), String(Number(before) + 1))
    assert.equal(env.store.recoveryRequired, false)
  } finally {
    env.store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

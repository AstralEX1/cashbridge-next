import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { bindingFromPubkey } from '../src/lib/bch.ts'
import { pubkey, otherPubkey } from './fixtures/bridge-fixtures.mjs'
import { BridgeConfig } from '../src/config.ts'

const data = new Map()
globalThis.localStorage = {
  get length() { return data.size },
  key: index => [...data.keys()][index] ?? null,
  getItem: key => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value),
  removeItem: key => data.delete(key)
}
const { autoBridgeStore } = await import('../src/store/auto-bridge-store.ts')
const { startAutomaticSource, restoreAutomaticOrder, pollAutomaticOrders, createAutomaticOrder, orderRequest, RouterUnavailableError, OrderRequestError } = await import('../src/lib/auto-bridge-client.ts')
const { automaticCompletion, automaticTransactions } = await import('../src/lib/auto-bridge-summary.ts')
const { automaticEligible, nearPaysBeforeRefund } = await import('../src/lib/auto-bridge-contract.ts')

test('NEAR payout must finish before the contract refund window', () => {
  const maxWaitSeconds = 1800
  const refundAfter = 1_700_000_000
  assert.equal(nearPaysBeforeRefund({ maxWaitSeconds }, refundAfter * 1000 - 60_000), true)
  assert.equal(nearPaysBeforeRefund({ contract: { refundAfter }, maxWaitSeconds }, refundAfter * 1000 - maxWaitSeconds * 1000 - 1), true)
  assert.equal(nearPaysBeforeRefund({ contract: { refundAfter }, maxWaitSeconds }, refundAfter * 1000 - maxWaitSeconds * 1000), false)
  assert.equal(nearPaysBeforeRefund({ contract: { refundAfter }, maxWaitSeconds }, Number.NaN), false)
})

test('an unreachable, slow or failing worker reads as Cashbridge Router unavailable; a refused request keeps its message', async t => {
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex') }
  const answers = [
    () => { throw new TypeError('fetch failed') },
    () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') },
    () => Response.json({ error: 'Automatic bridge worker is unavailable' }, { status: 503 }),
    () => new Response('<html>An error occurred with your deployment</html>', { status: 504 }),
    () => new Response('not json', { status: 200 })
  ]
  let next = 0
  t.mock.method(globalThis, 'fetch', async () => answers[next++]())
  for (const answer of answers.slice(0, 4)) {
    await assert.rejects(orderRequest(reference, 'GET'), error => error instanceof RouterUnavailableError && error.message === 'Cashbridge Router is unavailable')
  }
  await assert.rejects(orderRequest(reference, 'GET'), error => !(error instanceof RouterUnavailableError))
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Too many order requests' }, { status: 429 }))
  await assert.rejects(orderRequest(reference, 'GET'), error => error instanceof OrderRequestError && error.status === 429 && error.message === 'Too many order requests')
})

test('terminal automatic orders refresh late custody and payout warnings on a bounded schedule', async t => {
  t.after(() => { autoBridgeStore.setState({ orders: [] }); data.clear() })
  const address = bindingFromPubkey(pubkey, 0).cashAddress
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), sourceAttempted: true }
  autoBridgeStore.setState({ orders: [reference] })
  let now = 1000, calls = 0
  t.mock.method(Date, 'now', () => now)
  let response = { id: reference.id, depositAddress: address, minPusd: '100', state: 'completed', recoverySats: '0' }
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(response) })
  const schedule = new Map()
  assert.equal(await pollAutomaticOrders(schedule, () => false), false)
  assert.equal(calls, 1)
  now += 299999
  await pollAutomaticOrders(schedule, () => false)
  assert.equal(calls, 1)
  now++
  response = { ...response, recoverySats: '12000', error: 'Final payout needs verification' }
  assert.equal(await pollAutomaticOrders(schedule, () => false), false)
  assert.equal(calls, 2)
  assert.equal(autoBridgeStore.getState().orders[0].order.recoverySats, '12000')
  assert.equal(autoBridgeStore.getState().orders[0].order.error, response.error)
  await pollAutomaticOrders(schedule, () => true)
  assert.equal(calls, 2)
  // Settled with nothing left at the contract: asked again for a day after its last change, then never.
  response = { ...response, recoverySats: '0', error: undefined, updatedAt: now }
  now += 300001
  await pollAutomaticOrders(schedule, () => false)
  assert.equal(calls, 3)
  now += 24 * 60 * 60_000
  await pollAutomaticOrders(schedule, () => false)
  assert.equal(calls, 3)
})

test('the page key leaves browser storage once its order is done with no BCH left at the contract, and stays gone', async t => {
  t.after(() => { autoBridgeStore.setState({ orders: [] }); data.clear() })
  const address = bindingFromPubkey(pubkey, 0).cashAddress
  const secret = randomBytes(32).toString('hex')
  const saved = id => JSON.parse(data.get(`cashbridge-auto-order-${id}`) ?? 'null')
  const run = async (state, recoverySats) => {
    const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), pageSecret: secret }
    autoBridgeStore.getState().save(reference)
    t.mock.method(globalThis, 'fetch', async () => Response.json({ id: reference.id, depositAddress: address, minPusd: '100', state, recoverySats }))
    await pollAutomaticOrders(new Map(), () => false)
    t.mock.restoreAll()
    return reference.id
  }
  for (const [state, recovery, kept] of [['completed', '0', false], ['refunded', undefined, false], ['completed', '12000', true], ['manual_review', '0', true], ['submitted', '0', true]]) {
    const id = await run(state, recovery)
    const label = `${state} with ${recovery ?? 'no'} sats left`
    assert.equal(autoBridgeStore.getState().orders.find(order => order.id === id).pageSecret, kept ? secret : '', label)
    assert.equal(saved(id).pageSecret, kept ? secret : '', label)
  }
  // An older tab that still holds the key cannot write it back.
  const id = autoBridgeStore.getState().orders.find(order => order.pageSecret === '').id
  autoBridgeStore.setState(state => ({ orders: state.orders.map(order => order.id === id ? { ...order, pageSecret: secret, estimatedSeconds: 60 } : order) }))
  assert.equal(saved(id).pageSecret, '')
  assert.equal(saved(id).estimatedSeconds, 60)
})

test('the poller leaves an order alone while its create request is in flight', async t => {
  t.after(() => { autoBridgeStore.setState({ orders: [] }); data.clear() })
  const address = bindingFromPubkey(pubkey, 0).cashAddress
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), intent: { recipientAddress: address, refundAddress: address, expectedBchSats: '1000', source: {} } }
  autoBridgeStore.setState({ orders: [reference] })
  const methods = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    methods.push(init.method)
    await gate
    return Response.json({ id: reference.id, depositAddress: address, minPusd: '100', state: 'awaiting_deposit', expectedBchSats: '1000', recipientAddress: address, refundAddress: address, apiVersion: 2 })
  })
  const creating = createAutomaticOrder(reference)
  await pollAutomaticOrders(new Map(), () => false)
  assert.deepEqual(methods, ['POST'], 'the poll must not GET or POST the order being created')
  release()
  await creating
})

test('source authorization is recorded before opening the wallet and a lost callback cannot trigger resubmission', async () => {
  const deposit = bindingFromPubkey(pubkey, 0).cashAddress
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), order: { depositAddress: deposit } }
  autoBridgeStore.getState().save(reference)
  const route = { sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN_STREAMING'], destinationAddress: deposit }
  let calls = 0
  const execute = async () => {
    calls++
    assert.equal(autoBridgeStore.getState().orders.find(order => order.id === reference.id).sourceAttempted, true)
    throw new Error('Wallet response lost after possible broadcast')
  }
  await assert.rejects(startAutomaticSource(reference, route, 'ETH.ETH', execute, async () => {}))
  await assert.rejects(startAutomaticSource(reference, route, 'ETH.ETH', execute, async () => {}))
  assert.equal(calls, 1)
})

test('lost creation response restores the same intent; a possibly sent source is never recreated on a missing server record', async () => {
  const address = bindingFromPubkey(pubkey, 0).cashAddress
  const intent = { recipientAddress: address, refundAddress: address, expectedBchSats: '1000000' }
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), intent }
  autoBridgeStore.getState().save(reference)
  const oldFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body })
    return options.method === 'GET' ? Response.json({ error: 'Order not found' }, { status: 404 }) :
      Response.json({ id: reference.id, ...intent, depositAddress: address, minPusd: '123' })
  }
  try {
    await restoreAutomaticOrder(reference)
    assert.deepEqual(calls.map(call => call.method), ['GET', 'POST'])
    assert.deepEqual(JSON.parse(calls[1].body), { id: reference.id, ...intent })
    calls.length = 0
    await assert.rejects(restoreAutomaticOrder({ ...reference, sourceAttempted: true }))
    assert.deepEqual(calls.map(call => call.method), ['GET'])
  } finally { globalThis.fetch = oldFetch }
})

test('a stale tab cannot erase source authorization or another tab order', async () => {
  const oldWindow = globalThis.window, navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  globalThis.window = {}
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_key, _options, fn) => fn({}) } } })
  const address = bindingFromPubkey(pubkey, 0).cashAddress
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), order: { depositAddress: address } }
  autoBridgeStore.getState().save(reference)
  const route = { sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN'], destinationAddress: address }
  let calls = 0
  try {
    await assert.rejects(startAutomaticSource(reference, route, 'ETH.ETH', async () => { calls++; throw new Error('Lost answer') }, async () => {}))
    // Model a second tab persisting an older in-memory history snapshot.
    autoBridgeStore.getState().patch(reference.id, { sourceAttempted: false })
    await assert.rejects(startAutomaticSource(reference, route, 'ETH.ETH', async () => { calls++; return 'ab'.repeat(32) }, async () => {}))
    assert.equal(calls, 1)
    const external = { id: randomUUID(), capability: randomBytes(32).toString('hex'), createdAt: Date.now() }
    data.set(`cashbridge-auto-order-${external.id}`, JSON.stringify(external))
    autoBridgeStore.getState().patch(reference.id, { sourceHash: 'cd'.repeat(32) })
    await autoBridgeStore.persist.rehydrate()
    assert.ok(autoBridgeStore.getState().orders.some(ref => ref.id === external.id))
    // Automatic transfers keep no drafts: one left by a closed page is dropped, a sent one stays.
    const stale = Date.now() - 31 * 60_000
    const leftover = { id: randomUUID(), capability: randomBytes(32).toString('hex'), createdAt: stale }
    const sent = { id: randomUUID(), capability: randomBytes(32).toString('hex'), createdAt: stale, sourceHash: 'ef'.repeat(32) }
    for (const ref of [leftover, sent]) data.set(`cashbridge-auto-order-${ref.id}`, JSON.stringify(ref))
    await autoBridgeStore.persist.rehydrate()
    assert.equal(data.has(`cashbridge-auto-order-${leftover.id}`), false)
    assert.ok(!autoBridgeStore.getState().orders.some(ref => ref.id === leftover.id))
    assert.ok(autoBridgeStore.getState().orders.some(ref => ref.id === sent.id))
    autoBridgeStore.getState().remove(external.id)
    assert.equal(data.has(`cashbridge-auto-order-${external.id}`), false)
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator
  }
})

test('source freshness is rechecked before authorization', async () => {
  const address = bindingFromPubkey(pubkey, 0).cashAddress
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), order: { depositAddress: address } }
  autoBridgeStore.getState().save(reference)
  const route = { sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN'], destinationAddress: address }
  let calls = 0
  await assert.rejects(startAutomaticSource(reference, route, 'ETH.ETH', async () => { calls++; return 'ab'.repeat(32) }, async () => {}, () => false))
  assert.equal(calls, 0)
  assert.equal(autoBridgeStore.getState().orders.find(ref => ref.id === reference.id).sourceAttempted, undefined)
})

test('a previously funded order cannot authorize another source payment', async () => {
  const address = bindingFromPubkey(pubkey, 0).cashAddress
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), order: { depositAddress: address, state: 'streaming', receivedSats: '1000' } }
  autoBridgeStore.getState().save(reference)
  const route = { sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN'], destinationAddress: address }
  let calls = 0
  await assert.rejects(startAutomaticSource(reference, route, 'ETH.ETH', async () => { calls++; return 'ab'.repeat(32) }, async () => {}))
  assert.equal(calls, 0)
})

test('a failed durable authorization write never opens the wallet', async () => {
  const oldWindow = globalThis.window, navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), setItem = localStorage.setItem
  globalThis.window = {}
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_key, _options, fn) => fn({}) } } })
  const address = bindingFromPubkey(pubkey, 0).cashAddress
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), order: { depositAddress: address } }
  autoBridgeStore.getState().save(reference)
  const route = { sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN'], destinationAddress: address }
  let calls = 0
  localStorage.setItem = (key, value) => { if (key.startsWith('cashbridge-auto-source-')) throw new Error('Storage full'); setItem(key, value) }
  try {
    await assert.rejects(startAutomaticSource(reference, route, 'ETH.ETH', async () => { calls++; return 'ab'.repeat(32) }, async () => {}))
    assert.equal(calls, 0)
  } finally {
    localStorage.setItem = setItem
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator
  }
})

test('receipt uses the observed exact output and fallback net of fee; reverse and plain BCH stay manual', () => {
  const order = { sourceHash: 'AB'.repeat(32) + '-2', source: { chain: 'GAIA' }, settlement: { kind: 'swap', seen: true, txid: 'cd'.repeat(32), pusdAmount: '1234', bchAmount: '12345' } }
  assert.equal(automaticCompletion({ ...order, settlement: { ...order.settlement, seen: false } }), undefined)
  assert.deepEqual(automaticCompletion(order), { amount: '12.34', ticker: 'PUSD', refund: false, change: '0.00012345' })
  assert.equal(automaticCompletion({ ...order, settlement: { ...order.settlement, kind: 'refund' } }).amount, '0.00012345')
  assert.equal(automaticTransactions(order).at(-1).hash, 'cd'.repeat(32))
  assert.deepEqual(automaticCompletion(order, { ticker: 'GOLD', decimals: 3 }).amount, '1.234')
  assert.equal(automaticEligible(false, 'pusd'), true)
  assert.equal(automaticEligible(false, 'another-token'), true, 'every Cauldron token goes through the Router')
  assert.equal(automaticEligible(true, 'pusd'), false)
  assert.equal(automaticEligible(false, undefined), false)
})

test('wrong order destination is refused and source callback failure does not erase a successful source hash', async () => {
  const deposit = bindingFromPubkey(pubkey, 0).cashAddress,
    another = bindingFromPubkey(otherPubkey, 0).cashAddress
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), order: { depositAddress: deposit } }
  autoBridgeStore.getState().save(reference)
  const route = { sellAsset: 'ETH.ETH', buyAsset: 'BCH.BCH', providers: ['THORCHAIN'], destinationAddress: another }
  let called = false
  await assert.rejects(
    startAutomaticSource(
      reference,
      route,
      'ETH.ETH',
      async () => {
        called = true
        return 'ab'.repeat(32)
      },
      async () => {}
    )
  )
  assert.equal(called, false)
  const hash = await startAutomaticSource(
    reference,
    { ...route, destinationAddress: deposit },
    'ETH.ETH',
    async () => 'ab'.repeat(32),
    async () => {
      throw new Error('Callback offline')
    }
  )
  assert.equal(hash, 'ab'.repeat(32))
  assert.equal(autoBridgeStore.getState().orders.find(order => order.id === reference.id).sourceHash, hash)
})

test('a contract order is accepted only when its deposit is the contract of the order terms', async () => {
  const { orderBinding } = await import('../src/lib/router-contract.ts')
  const recipient = bindingFromPubkey(pubkey, 0), refund = bindingFromPubkey(otherPubkey, 0)
  const intent = { recipientAddress: recipient.tokenAddress, refundAddress: refund.cashAddress, expectedBchSats: '1000000' }
  const contract = { routerKey: bindingFromPubkey(otherPubkey, 1).pubkey, refundAfter: Math.floor(Date.now() / 1000) + 3 * 60 * 60 }
  const terms = { ...contract, recipientScript: recipient.lockingBytecode, refundScript: refund.lockingBytecode, category: BridgeConfig.pusd.category, minPusd: '123' }
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), intent }
  const oldFetch = globalThis.fetch
  let depositAddress = orderBinding(terms, 0).cashAddress, category
  globalThis.fetch = async () => Response.json({ id: reference.id, ...intent, contract, depositAddress, minPusd: '123', ...(category && { category }) })
  try {
    assert.equal((await restoreAutomaticOrder(reference)).depositAddress, depositAddress)
    category = 'ab'.repeat(32)
    await assert.rejects(restoreAutomaticOrder(reference), /does not match/, 'a PUSD order answered with another token')
    category = undefined
    depositAddress = orderBinding({ ...terms, recipientScript: refund.lockingBytecode }, 0).cashAddress
    await assert.rejects(restoreAutomaticOrder(reference), /not its contract/)
    depositAddress = refund.cashAddress
    await assert.rejects(restoreAutomaticOrder(reference), /not its contract/)
  } finally { globalThis.fetch = oldFetch }
})

test('a version 2 order must name the page key it was asked for, and no order may hold a refund far off', async () => {
  const { orderBinding } = await import('../src/lib/router-contract.ts')
  const recipient = bindingFromPubkey(pubkey, 0), refund = bindingFromPubkey(otherPubkey, 0)
  const pageKey = recipient.pubkey
  const intent = { recipientAddress: recipient.tokenAddress, refundAddress: refund.cashAddress, expectedBchSats: '1000000', pageKey }
  let contract = { routerKey: bindingFromPubkey(otherPubkey, 1).pubkey, refundAfter: Math.floor(Date.now() / 1000) + 3 * 60 * 60, version: 2, pageKey }
  const address = c => orderBinding({ ...c, recipientScript: recipient.lockingBytecode, refundScript: refund.lockingBytecode, category: BridgeConfig.pusd.category, minPusd: '123', quotedSats: '1000000' }, 0).cashAddress
  const reference = { id: randomUUID(), capability: randomBytes(32).toString('hex'), intent }
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ id: reference.id, ...intent, contract, depositAddress: address(contract), minPusd: '123' })
  try {
    assert.equal((await restoreAutomaticOrder(reference)).contract.pageKey, pageKey)
    contract = { ...contract, pageKey: contract.routerKey }
    await assert.rejects(restoreAutomaticOrder(reference), /does not match/, 'the Router dropped the page key')
    contract = { ...contract, pageKey, version: 3 }
    await assert.rejects(restoreAutomaticOrder(reference), /invalid/)
    contract = { ...contract, version: 2, refundAfter: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 }
    await assert.rejects(restoreAutomaticOrder(reference), /invalid/, 'a refund a month away')
    // A Router that has no version 2 yet answers version 1: the order still works, settled by the Router alone.
    contract = { routerKey: contract.routerKey, refundAfter: Math.floor(Date.now() / 1000) + 3 * 60 * 60 }
    assert.equal((await restoreAutomaticOrder(reference)).contract.version, undefined)
  } finally { globalThis.fetch = oldFetch }
})

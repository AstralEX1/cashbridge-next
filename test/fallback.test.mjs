import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { fetchFirst, refused, rpcFirst } from '../src/lib/fallback.ts'

const hostOf = url => new URL(url).host

test('a failing, rate-limited or slow endpoint hands the request on, and is asked last afterwards', async t => {
  const asked = []
  t.mock.method(globalThis, 'fetch', async url => {
    asked.push(hostOf(url))
    if (hostOf(url) === 'a.example') return new Response('slow down', { status: 429 })
    if (hostOf(url) === 'b.example') throw new TypeError('fetch failed')
    return Response.json({ ok: true })
  })
  const bases = ['https://a.example', 'https://b.example', 'https://c.example']
  assert.deepEqual(await (await fetchFirst(bases, '/x')).json(), { ok: true })
  assert.deepEqual(asked, ['a.example', 'b.example', 'c.example'])
  asked.length = 0
  await fetchFirst(bases, '/x')
  assert.deepEqual(asked, ['c.example'], 'the endpoint that answered goes first while the others cool down')
})

test("an endpoint's own answer is final: a 404 is not a reason to ask another", async t => {
  const asked = []
  t.mock.method(globalThis, 'fetch', async url => {
    asked.push(hostOf(url))
    return new Response('not found', { status: 404 })
  })
  assert.equal((await fetchFirst(['https://d.example', 'https://e.example'], '/tx/1')).status, 404)
  assert.deepEqual(asked, ['d.example'])
})

test('a caller abort stops the rotation', async t => {
  const controller = new AbortController()
  controller.abort(new Error('user left'))
  t.mock.method(globalThis, 'fetch', async () => assert.fail('nothing is fetched after an abort'))
  await assert.rejects(fetchFirst(['https://f.example'], '', { signal: controller.signal }), /user left/)
})

test('plan and rate-limit errors move a JSON-RPC call on; a revert is the chain answering', async t => {
  assert.equal(refused({ error: { code: -32005, message: 'rate limit exceeded' } }), true)
  assert.equal(refused({ error: { code: 35, message: 'method is not available on free plan, please upgrade' } }), true)
  assert.equal(refused({ error: { code: 3, message: 'execution reverted: blocked' } }), false)
  assert.equal(refused({ result: '0x1' }), false)
  const asked = []
  t.mock.method(globalThis, 'fetch', async url => {
    asked.push(hostOf(url))
    return hostOf(url) === 'g.example'
      ? Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32029, message: 'Too Many Requests' } })
      : Response.json({ jsonrpc: '2.0', id: 1, result: '0x10' })
  })
  assert.deepEqual(await rpcFirst(['https://g.example', 'https://h.example'], { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), {
    jsonrpc: '2.0',
    id: 1,
    result: '0x10'
  })
  assert.deepEqual(asked, ['g.example', 'h.example'])
})

test('the EVM provider skips a node that serves another chain and rotates past a dead one', async t => {
  const { getProvider } = await import('../src/lib/evm-rpc.ts')
  const { EVM_RPC_URLS } = await import('../src/lib/endpoints.ts')
  const [wrong, dead, good] = EVM_RPC_URLS.BERA
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const { method } = JSON.parse(init.body)
    calls.push([url, method])
    if (url === dead) throw new TypeError('fetch failed')
    if (method === 'eth_chainId') return Response.json({ jsonrpc: '2.0', id: 1, result: url === wrong ? '0x1' : '0x138de' })
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0x2a' })
  })
  const provider = await getProvider('BERA')
  assert.equal(await provider.getBlockNumber(), 42)
  assert.ok(!calls.some(([url, method]) => url === wrong && method !== 'eth_chainId'), 'a node on another chain never serves a read')
  assert.ok(calls.some(([url, method]) => url === good && method === 'eth_blockNumber'))
})

test('an EVM node whose chain check got an error answer is checked again, not dropped for the visit', async t => {
  const { getProvider } = await import('../src/lib/evm-rpc.ts')
  let blip = true
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { method, id } = JSON.parse(init.body)
    if (method !== 'eth_chainId') return Response.json({ jsonrpc: '2.0', id, result: '0x2a' })
    return Response.json(blip ? { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'internal error' } } : { jsonrpc: '2.0', id: 1, result: '0xc4' })
  })
  const provider = await getProvider('XLAYER')
  await assert.rejects(provider.getBlockNumber())
  blip = false
  // ethers keeps a call's answer for 250 ms.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await provider.getBlockNumber(), 42)
})

test('the Solana proxy passes a refused call to the next node and returns its answer', async t => {
  const { POST } = await import('../src/app/api/solana/route.ts')
  const { SOLANA_RPC_URLS } = await import('../src/lib/endpoints.ts')
  const asked = []
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async url => {
    asked.push(url)
    if (url === SOLANA_RPC_URLS[0]) return Response.json({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too many requests for a specific RPC call' } }, { status: 429 })
    if (url === SOLANA_RPC_URLS[1]) return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Request blocked' } }, { status: 403 })
    return Response.json({ jsonrpc: '2.0', id: 1, result: { value: [] } })
  })
  const res = await POST(
    new NextRequest('http://localhost/api/solana', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [] }),
      headers: { 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '198.51.100.77' }
    })
  )
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 1, result: { value: [] } })
  assert.deepEqual(asked, SOLANA_RPC_URLS.slice(0, 3))
})

// A WebSocket double: `down` hosts refuse the connection, `drop` hosts hang up on a broadcast.
const fakeSockets = ({ down, drop, opened }) =>
  class {
    static OPEN = 1
    constructor(url) {
      this.host = hostOf(url)
      this.readyState = 0
      opened.push(this.host)
      setTimeout(() => {
        if (down.includes(this.host)) return this.onerror?.()
        this.readyState = 1
        this.onopen?.()
      })
    }
    send(text) {
      const { id, method } = JSON.parse(text)
      if (method === 'blockchain.transaction.broadcast' && drop.includes(this.host)) return setTimeout(() => this.close())
      const reply =
        method === 'server.version'
          ? { id, result: ['Fulcrum', '1.5.3'] }
          : method === 'blockchain.transaction.get'
            ? { id, error: { code: 2, message: 'No such mempool or blockchain transaction' } }
            : { id, result: this.host }
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }))
    }
    close() {
      this.readyState = 3
      this.onclose?.()
    }
  }

test('a BCH call moves to the next Fulcrum server when one is down or drops it, and keeps a server answer', async t => {
  const { BridgeConfig } = await import('../src/config.ts')
  const { broadcastTransaction, getRawTransaction } = await import('../src/lib/bch.ts')
  const [first, second, third] = BridgeConfig.electrumUrls.map(hostOf)
  const opened = []
  const original = globalThis.WebSocket
  globalThis.WebSocket = fakeSockets({ down: [first], drop: [second], opened })
  t.after(() => (globalThis.WebSocket = original))
  assert.equal(await broadcastTransaction('00'), third, 'the broadcast went through the third server')
  assert.deepEqual(opened, [first, second, third])
  opened.length = 0
  assert.equal(await getRawTransaction('ab'.repeat(32)), null, 'a server saying "not found" is an answer, not a failure')
  assert.deepEqual(opened, [third], 'the server that answered is asked first, and its answer stands')
})

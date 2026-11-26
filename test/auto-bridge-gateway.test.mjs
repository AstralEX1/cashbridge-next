import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BchGateway } from '../src/server/auto-bridge/gateway.ts'
import { loadConfig } from '../src/server/auto-bridge/config.ts'
import { BroadcastRejected, BroadcastUnknown } from '../src/lib/cauldron.ts'
import { txidOf } from '../src/lib/bch.ts'
import { FULCRUM_URLS } from '../src/lib/endpoints.ts'

test('an accepted RPC broadcast does not call or wait for the backup broadcaster', async t => {
  const previous = ['BCHN_RPC_CONFIG_FILE', 'BCHN_RPC_COOKIE_FILE', 'BCHN_RPC_URL'].map(name => [name, process.env[name]])
  delete process.env.BCHN_RPC_CONFIG_FILE
  delete process.env.BCHN_RPC_COOKIE_FILE
  process.env.BCHN_RPC_URL = 'http://127.0.0.1:8332'
  const attempt = { txid: '11'.repeat(32), hex: '00', kind: 'refund', pusdOut: '0', status: 'signed' }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++
    assert.equal(JSON.parse(options.body).method, 'sendrawtransaction')
    return Response.json({ result: attempt.txid })
  })
  try {
    await new BchGateway().broadcast(attempt)
    assert.equal(calls, 1)
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('an unsolicited NFT can be observed for custody without becoming a spendable native input', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ result: { value: 0.00000546, confirmations: 1,
    scriptPubKey: { hex: '51' }, tokenData: { category: 'ab'.repeat(32), amount: '0', nft: { capability: 'none', commitment: '' } } } })
  try {
    const coin = await new BchGateway().coin('cd'.repeat(32), 0)
    assert.equal(coin.output.valueSatoshis, 546n)
    assert.equal(coin.output.token.nft.capability, 'none')
  } finally { globalThis.fetch = originalFetch }
})

test('gateway retains uncertain primary acceptance even if its secondary broadcaster rejects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cashbridge-gateway-'))
  const credential = join(directory, 'rpc.credential')
  writeFileSync(credential, randomBytes(32).toString('hex'), { mode: 0o600 })
  const previousFile = process.env.BCHN_RPC_COOKIE_FILE,
    previousUrl = process.env.BCHN_RPC_URL,
    originalFetch = globalThis.fetch
  process.env.BCHN_RPC_COOKIE_FILE = credential
  process.env.BCHN_RPC_URL = 'http://127.0.0.1:8332'
  const attempt = { txid: '11'.repeat(32), hex: '00', kind: 'refund', pusdOut: '0', status: 'signed' }
  let primaryCode,
    sends = []
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    if (new URL(url).hostname === '127.0.0.1') {
      sends.push(body.params[0])
      if (primaryCode === undefined) throw new Error('synthetic lost response')
      return Response.json({ error: { code: primaryCode } }, { status: 500 })
    }
    sends.push(body.tx)
    return Response.json({ error: { code: 'REJECTED' } }, { status: 400 })
  }
  try {
    const gateway = new BchGateway()
    await assert.rejects(gateway.broadcast(attempt), BroadcastUnknown)
    assert.deepEqual(sends, [attempt.hex, attempt.hex])
    sends = []
    primaryCode = -28
    await assert.rejects(gateway.broadcast(attempt), BroadcastUnknown)
    assert.equal(sends.length, 2)
    sends = []
    primaryCode = -26
    await assert.rejects(gateway.broadcast(attempt), BroadcastRejected)
    assert.equal(sends.length, 1)
    primaryCode = -27
    await gateway.broadcast(attempt)
  } finally {
    globalThis.fetch = originalFetch
    if (previousFile === undefined) delete process.env.BCHN_RPC_COOKIE_FILE
    else process.env.BCHN_RPC_COOKIE_FILE = previousFile
    if (previousUrl === undefined) delete process.env.BCHN_RPC_URL
    else process.env.BCHN_RPC_URL = previousUrl
    rmSync(directory, { recursive: true, force: true })
  }
})

test('disabled or missing worker policy fails closed as service configuration errors', () => {
  const previous = ['AUTO_BRIDGE_ENABLED', 'AUTO_BRIDGE_MAX_ORDER_SATS', 'AUTO_BRIDGE_MAX_PENDING_SATS'].map(name => [name, process.env[name]])
  try {
    delete process.env.AUTO_BRIDGE_ENABLED
    assert.throws(loadConfig, error => error.status === 503)
    process.env.AUTO_BRIDGE_ENABLED = 'true'
    delete process.env.AUTO_BRIDGE_MAX_ORDER_SATS
    assert.throws(loadConfig, error => error.status === 503)
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('hosted RPC reads its private configuration without exposing credentials and rejects wrong-chain or unsafe configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cashbridge-rpc-'))
  const file = join(directory, 'rpc.json'),
    secret = randomBytes(32).toString('hex')
  const names = ['BCHN_RPC_CONFIG_FILE', 'BCHN_RPC_COOKIE_FILE', 'BCHN_RPC_URL']
  const previous = names.map(name => [name, process.env[name]])
  const originalFetch = globalThis.fetch
  writeFileSync(file, JSON.stringify({ url: 'https://rpc.example/private-endpoint', headers: { 'x-api-key': secret } }), { mode: 0o600 })
  process.env.BCHN_RPC_CONFIG_FILE = file
  // The private config takes precedence over legacy cookie configuration.
  process.env.BCHN_RPC_COOKIE_FILE = '/nonexistent/legacy-cookie'
  let chain = 'main',
    authorized = false
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'error')
    authorized = options.headers['x-api-key'] === secret
    if (JSON.parse(options.body).method === 'getrawtransaction') return Response.json({ result: indexProbe.hex })
    return Response.json({ result: { chain, initialblockdownload: false, blocks: 100, headers: 100 } })
  }
  try {
    const gateway = new BchGateway()
    await gateway.assertReady()
    assert.equal(authorized, true)
    chain = 'test'
    await assert.rejects(gateway.assertReady(), /mainnet/)
    chmodSync(file, 0o644)
    assert.throws(
      () => new BchGateway(),
      error => !error.message.includes(secret) && /configuration/.test(error.message)
    )
    chmodSync(file, 0o600)
    for (const config of [
      null,
      { url: 'http://rpc.example', headers: {} },
      { url: 'https://rpc.example', headers: { authorization: 123 } },
      { url: 'https://rpc.example', headers: {}, minIntervalMs: -1 }
    ]) {
      writeFileSync(file, JSON.stringify(config))
      assert.throws(() => new BchGateway(), /configuration/)
    }
  } finally {
    globalThis.fetch = originalFetch
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('hosted RPC failover preserves uncertain writes across backup rejections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cashbridge-rpc-failover-'))
  const file = join(directory, 'rpc.json'),
    originalFetch = globalThis.fetch,
    previous = process.env.BCHN_RPC_CONFIG_FILE
  writeFileSync(
    file,
    JSON.stringify({
      rpcs: [
        { url: 'https://first.example', headers: {} },
        { url: 'https://second.example', headers: {} }
      ]
    }),
    { mode: 0o600 }
  )
  process.env.BCHN_RPC_CONFIG_FILE = file
  let secondaryAccepts = false,
    upstreamReadError = false
  const attempt = { txid: '11'.repeat(32), hex: '00', kind: 'refund', pusdOut: '0', status: 'signed' }
  globalThis.fetch = async (url, options) => {
    const host = new URL(url).host,
      payload = JSON.parse(options.body)
    if (host === 'first.example') {
      if (upstreamReadError && payload.method === 'getblockcount') return Response.json({ error: { code: -16503 } })
      throw new Error('synthetic lost response')
    }
    if (host === 'second.example') {
      if (payload.method === 'getblockcount') return Response.json({ result: 100 })
      return secondaryAccepts ? Response.json({ result: attempt.txid }) : Response.json({ error: { code: -26 } })
    }
    return Response.json({ error: { code: 'REJECTED' } })
  }
  try {
    const gateway = new BchGateway()
    assert.equal(await gateway.tip(), 100)
    upstreamReadError = true
    assert.equal(await gateway.tip(), 100)
    await assert.rejects(gateway.broadcast(attempt), BroadcastUnknown)
    secondaryAccepts = true
    await gateway.broadcast(attempt)
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.BCHN_RPC_CONFIG_FILE
    else process.env.BCHN_RPC_CONFIG_FILE = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

test('concurrent RPC reads reserve separate request slots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cashbridge-rpc-pacing-'))
  const file = join(directory, 'rpc.json'),
    previous = process.env.BCHN_RPC_CONFIG_FILE,
    originalFetch = globalThis.fetch
  writeFileSync(file, JSON.stringify({ url: 'https://rpc.example', headers: {}, minIntervalMs: 40 }), { mode: 0o600 })
  process.env.BCHN_RPC_CONFIG_FILE = file
  const starts = []
  globalThis.fetch = async () => {
    starts.push(Date.now())
    return Response.json({ result: 100 })
  }
  try {
    const gateway = new BchGateway()
    assert.deepEqual(await Promise.all([gateway.tip(), gateway.tip(), gateway.tip()]), [100, 100, 100])
    assert.equal(starts.length, 3)
    assert.ok(starts[1] - starts[0] >= 30)
    assert.ok(starts[2] - starts[1] >= 30)
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.BCHN_RPC_CONFIG_FILE
    else process.env.BCHN_RPC_CONFIG_FILE = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

// Runs `body` against a gateway whose private config lists `hosts`; `answer(host, payload)` plays each node.
async function withNodes(hosts, answer, body) {
  const directory = mkdtempSync(join(tmpdir(), 'cashbridge-rpc-nodes-'))
  const file = join(directory, 'rpc.json'),
    previous = process.env.BCHN_RPC_CONFIG_FILE,
    originalFetch = globalThis.fetch,
    calls = []
  writeFileSync(file, JSON.stringify({ rpcs: hosts.map(host => ({ url: `https://${host}`, headers: {} })) }), { mode: 0o600 })
  process.env.BCHN_RPC_CONFIG_FILE = file
  globalThis.fetch = async (url, options) => {
    const host = new URL(url).host,
      payload = JSON.parse(options.body)
    calls.push(`${host} ${payload.method}`)
    return answer(host, payload)
  }
  try {
    await body(new BchGateway(), calls)
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.BCHN_RPC_CONFIG_FILE
    else process.env.BCHN_RPC_CONFIG_FILE = previous
    rmSync(directory, { recursive: true, force: true })
  }
}
const synced = { chain: 'main', initialblockdownload: false, blocks: 100, headers: 100 }

test('a node answering 200 with an empty or lagging result is skipped and then asked last', async () => {
  const empty = { result: null, error: null }
  await withNodes(['first.example', 'second.example'], (host, { method }) => Response.json(method === 'getrawtransaction' ? { result: indexProbe.hex } : host === 'first.example' ? empty : { result: synced }), async (gateway, calls) => {
    await gateway.assertReady()
    await gateway.assertReady()
    assert.deepEqual(calls.filter(call => call.endsWith('getblockchaininfo')), ['first.example getblockchaininfo', 'second.example getblockchaininfo', 'second.example getblockchaininfo'])
  })
  await withNodes(['first.example', 'second.example'], (host, { method }) => Response.json({ result: method === 'getrawtransaction' ? indexProbe.hex : host === 'first.example' ? { ...synced, blocks: 90 } : synced }), async gateway => {
    await gateway.assertReady()
  })
  await withNodes(['first.example', 'second.example'], () => Response.json(empty), async gateway => {
    await assert.rejects(gateway.assertReady())
  })
})

test('transaction answers are checked against the requested txid on every node', async () => {
  const id = txidOf('00')
  await withNodes(['first.example', 'second.example'], host => Response.json({ result: host === 'first.example' ? '01' : '00' }), async gateway => {
    assert.equal(await gateway.raw(id), '00')
  })
  await withNodes(['first.example', 'second.example'], host => Response.json({ result: { hex: host === 'first.example' ? '01' : '00', confirmations: 7 } }), async gateway => {
    assert.deepEqual(await gateway.observe(id), { seen: true, confirmations: 7 })
  })
  await withNodes(['first.example', 'second.example'], () => Response.json({ result: '01' }), async gateway => {
    await assert.rejects(gateway.raw(id), /hash mismatch/)
  })
})

test('a spent output is only reported when a second node agrees', async () => {
  const unspent = { value: 0.001, confirmations: 3, scriptPubKey: { hex: '51' } }
  const spentOn = (other) => host => (host === 'first.example' ? Response.json({ result: null }) : other())
  const coin = gateway => gateway.coin('ab'.repeat(32), 0)
  await withNodes(['first.example', 'second.example'], spentOn(() => Response.json({ result: null })), async gateway => {
    assert.equal(await coin(gateway), undefined)
  })
  await withNodes(['first.example', 'second.example'], spentOn(() => Response.json({ result: unspent })), async gateway => {
    await assert.rejects(coin(gateway), /disagree/)
  })
  // The other RPC is down: Fulcrum's UTXO set decides, and only an unreachable Fulcrum leaves it unconfirmed.
  const originalSocket = globalThis.WebSocket,
    previousFulcrum = process.env.AUTO_BRIDGE_FULCRUM_URL
  let fulcrum
  globalThis.WebSocket = class {
    static OPEN = 1
    readyState = 0
    constructor() {
      setTimeout(() => (fulcrum === 'down' ? this.onerror?.() : ((this.readyState = 1), this.onopen?.())), 0)
    }
    send(data) {
      const { id, method } = JSON.parse(data)
      assert.equal(method, 'blockchain.utxo.get_info')
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id, result: fulcrum }) }), 0)
    }
    close() {
      this.readyState = 3
      this.onclose?.()
    }
  }
  process.env.AUTO_BRIDGE_FULCRUM_URL = 'wss://fulcrum.example:50004'
  try {
    for (const [answer, expected] of [[null, undefined], [{ value: 100000 }, /disagree/], ['down', /could not be confirmed/]]) {
      fulcrum = answer
      await withNodes(['first.example', 'second.example'], spentOn(() => { throw new Error('down') }), async gateway => {
        if (expected) await assert.rejects(coin(gateway), expected)
        else assert.equal(await coin(gateway), undefined)
      })
    }
  } finally {
    globalThis.WebSocket = originalSocket
    if (previousFulcrum === undefined) delete process.env.AUTO_BRIDGE_FULCRUM_URL
    else process.env.AUTO_BRIDGE_FULCRUM_URL = previousFulcrum
  }
  await withNodes(['only.example'], () => Response.json({ result: null }), async gateway => {
    assert.equal(await coin(gateway), undefined)
  })
})

test('up to eight RPC endpoints are accepted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cashbridge-rpc-many-')),
    file = join(directory, 'rpc.json'),
    previous = process.env.BCHN_RPC_CONFIG_FILE
  process.env.BCHN_RPC_CONFIG_FILE = file
  try {
    const rpcs = count => Array.from({ length: count }, (_, i) => ({ url: `https://node${i}.example`, headers: {} }))
    writeFileSync(file, JSON.stringify({ rpcs: rpcs(8) }), { mode: 0o600 })
    new BchGateway()
    writeFileSync(file, JSON.stringify({ rpcs: rpcs(9) }), { mode: 0o600 })
    assert.throws(() => new BchGateway(), /configuration/)
  } finally {
    if (previous === undefined) delete process.env.BCHN_RPC_CONFIG_FILE
    else process.env.BCHN_RPC_CONFIG_FILE = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

// The first BCH (and Bitcoin) transfer, block 170: only an indexed node can return it.
const indexProbe = { id: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16', hex: '0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000' }

test('readiness refuses a synchronized node that cannot look up confirmed transactions, and probes an indexed one once', async () => {
  const answer = indexed => (_host, { method, params }) => {
    if (method === 'getblockchaininfo') return Response.json({ result: synced })
    assert.equal(params[0], indexProbe.id)
    return indexed ? Response.json({ result: indexProbe.hex }) : Response.json({ error: { code: -5 } }, { status: 500 })
  }
  await withNodes(['unindexed.example'], answer(false), async gateway => {
    await assert.rejects(gateway.assertReady(), /txindex/)
  })
  await withNodes(['first.example', 'unindexed.example'], (host, payload) => answer(host === 'first.example')(host, payload), async gateway => {
    await assert.rejects(gateway.assertReady(), /txindex/)
  })
  await withNodes(['indexed.example'], answer(true), async (gateway, calls) => {
    await gateway.assertReady()
    await gateway.assertReady()
    assert.deepEqual(calls, ['indexed.example getblockchaininfo', 'indexed.example getrawtransaction', 'indexed.example getblockchaininfo'])
  })
})

test('every node must prove its index even after failover, and failed probes are retried', async () => {
  for (const fail of [
    () => { throw new Error('unavailable') },
    () => Response.json({ result: null }),
    () => Response.json({ result: '00' }),
    () => Response.json({ error: { code: -28 } }),
    () => new Response('not JSON', { status: 502 })
  ]) {
    let recovered = false
    await withNodes(['first.example', 'second.example'], (host, { method }) => {
      if (method === 'getblockcount') {
        if (host === 'first.example') throw new Error('unavailable')
        return Response.json({ result: 100 })
      }
      if (method === 'getblockchaininfo') return Response.json({ result: synced })
      if (host === 'first.example' && !recovered) return fail()
      return Response.json({ result: indexProbe.hex })
    }, async (gateway, calls) => {
      assert.equal(await gateway.tip(), 100)
      await assert.rejects(gateway.assertReady())
      await assert.rejects(gateway.assertReady())
      recovered = true
      await gateway.assertReady()
      await gateway.assertReady()
      assert.equal(calls.filter(call => call === 'first.example getrawtransaction').length, 3)
      assert.equal(calls.filter(call => call === 'second.example getrawtransaction').length, 1)
    })
  }
})

test('Fulcrum servers: the configured ones first, then the public ones, without repeats', () => {
  const previous = process.env.AUTO_BRIDGE_FULCRUM_URL
  process.env.AUTO_BRIDGE_FULCRUM_URL = 'wss://bch.imaginary.cash:50004, ws://127.0.0.1:50003'
  try {
    assert.deepEqual(new BchGateway().fulcrums, ['wss://bch.imaginary.cash:50004', 'ws://127.0.0.1:50003', ...FULCRUM_URLS.filter(url => url !== 'wss://bch.imaginary.cash:50004')])
  } finally {
    if (previous === undefined) delete process.env.AUTO_BRIDGE_FULCRUM_URL
    else process.env.AUTO_BRIDGE_FULCRUM_URL = previous
  }
})

test('history asks the next Fulcrum server when one cannot be reached and keeps the failing one last for a minute', async () => {
  const names = ['BCHN_RPC_CONFIG_FILE', 'BCHN_RPC_COOKIE_FILE', 'BCHN_RPC_URL', 'AUTO_BRIDGE_FULCRUM_URL']
  const previous = names.map(name => [name, process.env[name]])
  const originalSocket = globalThis.WebSocket
  const opened = []
  class FakeSocket {
    static OPEN = 1
    readyState = 0
    constructor(url) {
      opened.push(new URL(url).hostname)
      setTimeout(() => {
        // Only the labelled-up host answers; others (including merged public Electrum URLs) stay down for this test.
        if (url.includes('up.example')) {
          this.readyState = 1
          this.onopen?.()
        } else this.onerror?.()
      }, 0)
    }
    send(data) {
      const { id } = JSON.parse(data)
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id, result: [{ tx_hash: 'AB'.repeat(32), height: 1 }] }) }), 0)
    }
    close() {
      this.readyState = 3
      this.onclose?.()
    }
  }
  delete process.env.BCHN_RPC_CONFIG_FILE
  delete process.env.BCHN_RPC_COOKIE_FILE
  process.env.BCHN_RPC_URL = 'http://127.0.0.1:8332'
  globalThis.WebSocket = FakeSocket
  try {
    process.env.AUTO_BRIDGE_FULCRUM_URL = ' wss://down.example:50004 , wss://up.example:443 ,'
    const gateway = new BchGateway()
    assert.deepEqual(await gateway.history('51'), ['ab'.repeat(32)])
    assert.deepEqual(opened.slice(0, 2), ['down.example', 'up.example'])
    opened.length = 0
    assert.deepEqual(await gateway.history('51'), ['ab'.repeat(32)])
    assert.deepEqual(opened, ['up.example'])
    process.env.AUTO_BRIDGE_FULCRUM_URL = 'wss://down.example:50004,wss://down2.example:443'
    await assert.rejects(new BchGateway().history('51'), /Could not connect/)
  } finally {
    globalThis.WebSocket = originalSocket
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

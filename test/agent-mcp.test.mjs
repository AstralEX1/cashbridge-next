// The MCP endpoint for AI agents, against stand-ins for the aggregator, THORNode and the Cashbridge Router: it never
// hands out a transaction that does not match its quote, and a Router order is checked against its contract.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Interface } from 'ethers'
import { NextRequest } from 'next/server.js'
import { pubkey, otherPubkey } from './fixtures/bridge-fixtures.mjs'
import { bindingFromPubkey } from '../src/lib/bch.ts'
import { orderBinding } from '../src/lib/router-contract.ts'
import { BridgeConfig } from '../src/config.ts'

const VAULT = '0x1111111111111111111111111111111111111111'
const ROUTER = '0x2222222222222222222222222222222222222222'
const SOURCE = '0x3333333333333333333333333333333333333333'
const USDC = 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913'
const shapeRates = []
const DEPOSIT = new Interface(['function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration)'])
const recipient = bindingFromPubkey(pubkey, 0)
const routerKey = bindingFromPubkey(otherPubkey, 1).pubkey

const quotes = []
const nearQuotes = []
const NEAR_DEPOSIT = '0x6666666666666666666666666666666666666666'
const NEAR_BCH_DEPOSIT = bindingFromPubkey(otherPubkey, 2).cashAddress
let nearBchDeposit = NEAR_BCH_DEPOSIT
let tamper = route => route
// The last ShapeShift quote asked for, which 1Click's status of its deposit address describes.
let shapeQuote
const SHAPE_DEPOSIT = '0x5555555555555555555555555555555555555555'
const aggregator = request => {
  quotes.push(request)
  const forward = request.buyAsset === 'BCH.BCH'
  const memo = request.destinationAddress ? `=:${request.buyAsset}:${request.destinationAddress}:0/1/0` : undefined
  const route = {
    providers: ['THORCHAIN'],
    sellAsset: request.sellAsset,
    buyAsset: request.buyAsset,
    sellAmount: request.sellAmount,
    expectedBuyAmount: forward ? '0.05' : '20',
    fees: [{ type: 'outbound', amount: '0.0001', asset: 'BCH.BCH', chain: 'BCH', protocol: 'THORCHAIN' }],
    estimatedTime: { total: 600 },
    expiration: '1900000000',
    ...(request.sourceAddress && { sourceAddress: request.sourceAddress }),
    ...(request.destinationAddress && { destinationAddress: request.destinationAddress.replace(/^bitcoincash:/, ''), memo, inboundAddress: VAULT })
  }
  return { routes: [tamper(route)] }
}

const realFetch = globalThis.fetch
const routerSeen = []
const ordersById = new Map()
let routerOrder = order => order
const router = createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    routerSeen.push({ method: req.method, url: req.url, headers: req.headers, body: body && JSON.parse(body) })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST' && req.url === '/orders') {
      const input = JSON.parse(body)
      const contract = { routerKey, refundAfter: Math.floor(Date.now() / 1000) + 3 * 60 * 60 }
      const terms = { ...contract, recipientScript: recipient.lockingBytecode, refundScript: recipient.lockingBytecode, category: input.category ?? BridgeConfig.pusd.category, minPusd: '123' }
      const order = { apiVersion: 2, ...input, contract, depositAddress: orderBinding(terms, 0).cashAddress, minPusd: '123', maxWaitSeconds: 1800, state: 'awaiting_deposit', receivedSats: '0', attempts: [] }
      const published = routerOrder(order)
      ordersById.set(published.id, published)
      res.statusCode = 201
      return res.end(JSON.stringify(published))
    }
    const id = req.url.split('/')[2]
    const existing = ordersById.get(id)
    const patch = body ? JSON.parse(body) : {}
    if (existing) {
      const updated = { ...existing, ...patch, ...(req.method === 'POST' && patch.sourceHash && { state: 'ready', receivedSats: existing.expectedBchSats }) }
      ordersById.set(id, updated)
      return res.end(JSON.stringify(updated))
    }
    res.end(JSON.stringify({ apiVersion: 2, id, recipientAddress: recipient.tokenAddress, refundAddress: recipient.tokenAddress, expectedBchSats: '5000000', depositAddress: recipient.cashAddress, minPusd: '123', state: 'ready', receivedSats: '5000000', attempts: [], ...patch }))
  })
})

let mcpPost, mcpGet
let nearSubmitStatus = 200
before(async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'mcp-router-')), 'worker.sock')
  await new Promise(resolve => router.listen(socket, resolve))
  process.env.AUTO_BRIDGE_SOCKET = socket
  process.env.THORCHAIN_API_KEY = 'agent-test-key'
  process.env.THORCHAIN_API_URL = 'https://aggregator.test/v1'
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === 'https://aggregator.test/v1/quote') {
      assert.equal(new Headers(init.headers).get('x-api-key'), 'agent-test-key')
      return Response.json(aggregator(JSON.parse(init.body)))
    }
    if (url === 'https://1click.chaindefuser.com/v0/tokens')
      return Response.json([
        { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 1, contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
        { assetId: 'nep141:bch.omft.near', decimals: 8, blockchain: 'bch', symbol: 'BCH', price: 400, contractAddress: null },
        { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH', price: 3000, contractAddress: null },
        { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 90000, contractAddress: null },
        { assetId: 'nep141:sui.omft.near', decimals: 9, blockchain: 'sui', symbol: 'SUI', price: 1.5, contractAddress: null }
      ])
    if (url.startsWith('https://1click.chaindefuser.com/v0/status?depositAddress=')) {
      const address = decodeURIComponent(url.split('=')[1])
      if (!shapeQuote || address !== SHAPE_DEPOSIT) return new Response('{}', { status: 404 })
      const fromBch = shapeQuote.sellAssetId.endsWith('slip44:145')
      const usdc = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
      return Response.json({
        status: 'PENDING_DEPOSIT',
        correlationId: 'c-ss',
        quoteResponse: {
          timestamp: '2030-01-01T00:00:00.000Z',
          signature: 'ed25519:ss',
          quoteRequest: {
            swapType: 'EXACT_INPUT',
            originAsset: fromBch ? 'nep141:bch.omft.near' : usdc,
            destinationAsset: fromBch ? usdc : 'nep141:bch.omft.near',
            amount: shapeQuote.sellAmountCryptoBaseUnit,
            recipient: shapeQuote.receiveAddress,
            refundTo: shapeQuote.sendAddress,
            deadline: new Date(Date.now() + 4 * 3600_000).toISOString()
          },
          quote: { depositAddress: SHAPE_DEPOSIT, amountIn: shapeQuote.sellAmountCryptoBaseUnit, amountOut: '7000000', minAmountOut: '6900000', deadline: new Date(Date.now() + 3 * 86400_000).toISOString() }
        }
      })
    }
    if (url === 'https://1click.chaindefuser.com/v0/quote') {
      const body = JSON.parse(init.body)
      nearQuotes.push(body)
      return Response.json({
        correlationId: 'c-1',
        timestamp: '2030-01-01T00:00:00.000Z',
        signature: 'ed25519:sig',
        quote: { ...(!body.dry && { depositAddress: body.originAsset === 'nep141:bch.omft.near' ? nearBchDeposit : NEAR_DEPOSIT }), amountIn: body.amount, amountInFormatted: '25', minAmountIn: body.amount, amountOut: '6000000', amountOutFormatted: '0.06', minAmountOut: '5900000', deadline: new Date(Date.parse(body.deadline) + 3 * 86400_000).toISOString(), timeEstimate: 40 }
      })
    }
    if (url.startsWith('https://gateway.liquify.com/chain/thorchain_api/thorchain/pool/')) {
      const asset = decodeURIComponent(url.split('/').pop())
      // THORChain has no pool for a NEAR-only coin, nor for RUNE itself.
      return asset.startsWith('SUI.') || asset === 'THOR.RUNE' ? new Response('{}', { status: 404 }) : Response.json({ asset, decimals: 6 })
    }
    if (url.endsWith('/thorchain/inbound_addresses'))
      return Response.json([{ chain: 'BASE', address: VAULT, router: ROUTER, halted: false }, { chain: 'BCH', address: recipient.cashAddress, halted: false }])
    if (url.startsWith('https://api.shapeshift.com/v1/swap/rates')) {
      shapeRates.push(new URL(url).searchParams)
      return Response.json({
        rates: [{ swapperName: 'TestSwapper', buyAmountCryptoBaseUnit: '7000000', sellAmountCryptoBaseUnit: '25000000', estimatedExecutionTimeMs: 120000, supportsExternalPayment: true }]
      })
    }
    if (url === 'https://api.shapeshift.com/v1/swap/quote') {
      const body = JSON.parse(init.body)
      shapeQuote = body
      return Response.json({
        quoteId: 'ss-quote-1',
        swapperName: 'TestSwapper',
        sellAmountCryptoBaseUnit: body.sellAmountCryptoBaseUnit,
        buyAmountAfterFeesCryptoBaseUnit: '7000000',
        depositAddress: SHAPE_DEPOSIT,
        expiresAt: Date.parse('2030-01-01T01:00:00.000Z'),
        steps: [{ estimatedExecutionTimeMs: 120000 }]
      })
    }
    if (url.startsWith('https://api.shapeshift.com/v1/swap/status'))
      return Response.json({ quoteId: 'ss-quote-1', status: 'pending' })
    if (url === 'https://1click.chaindefuser.com/v0/deposit/submit') return Response.json({}, { status: nearSubmitStatus })
    throw new Error(`Unexpected fetch ${url}`)
  }
  ;({ mcpPost, mcpGet } = await import('../src/server/agent/mcp.ts'))
})
after(() => {
  globalThis.fetch = realFetch
  router.close()
})

let client = 0
const post = async (message, ip = `198.51.100.${++client}`, headers = {}) => {
  const response = await mcpPost(new NextRequest('https://cashbridge.space/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers }, body: typeof message === 'string' ? message : JSON.stringify(message) }))
  return { status: response.status, body: response.status === 202 ? undefined : await response.json(), headers: response.headers }
}
const call = async (name, args) => {
  const { body } = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  return body.result
}

test('initialize negotiates a supported version and the tool list carries no handlers', async () => {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  assert.match(init.body.result.instructions, /never signs/)
  const unknown = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal(unknown.body.result.protocolVersion, '2025-11-25')
  const { body } = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  assert.deepEqual(body.result.tools.map(t => t.name), ['list_supported_assets', 'get_bridge_quote', 'prepare_bridge', 'report_source_transaction', 'get_bridge_status'])
  assert.ok(body.result.tools.every(t => t.inputSchema && !('run' in t)))
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  assert.equal((await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status, 400)
  assert.equal((await post('{not json')).body.error.code, -32700)
  assert.equal((await post({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).body.error.code, -32601)
  assert.equal((await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'sign_everything' } })).body.error.code, -32602)
})

test('Streamable HTTP rules: foreign Origin, unknown protocol version and a null id are refused', async () => {
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
  assert.equal((await post(ping, undefined, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await post(ping, undefined, { origin: 'https://cashbridge.space' })).status, 200)
  assert.equal((await post(ping, undefined, { 'mcp-protocol-version': '2025-06-18' })).status, 200)
  assert.equal((await post(ping, undefined, { 'mcp-protocol-version': '1999-01-01' })).status, 400)
  const init = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, undefined, { 'mcp-protocol-version': '2025-03-26' })
  assert.equal(init.body.result.protocolVersion, '2025-11-25', 'initialize still negotiates')
  assert.equal((await post({ jsonrpc: '2.0', id: null, method: 'ping' })).status, 400)
  assert.equal((await mcpGet(new NextRequest('https://cashbridge.space/mcp', { headers: { origin: 'https://evil.example' } }))).status, 403)
})

test('a NEAR deposit notice reports whether 1Click took it, and takes only a transaction hash', async t => {
  t.mock.method(console, 'warn', () => {})
  const args = { near_deposit_address: NEAR_DEPOSIT, source_tx: `0x${'ab'.repeat(32)}` }
  assert.equal((await call('report_source_transaction', args)).structuredContent.reported, true)
  nearSubmitStatus = 500
  t.after(() => (nearSubmitStatus = 200))
  const refused = (await call('report_source_transaction', args)).structuredContent
  assert.equal(refused.reported, false)
  assert.match(refused.note, /did not take/)
  assert.equal((await call('report_source_transaction', { ...args, source_tx: 'paid it, thanks' })).isError, true)
  const ton = (await call('report_source_transaction', { ...args, source_tx: 'q0z4g+M3n/VxX3nC2hq8xNfX0b3l8XvB1sJ8i2ZkQ1Y=' })).structuredContent
  assert.equal(ton.source_tx.length, 44, 'a base64 TON hash is a hash too')
})

test('GET serves the server card, and an SSE request is refused', async () => {
  const card = await mcpGet(new NextRequest('https://cashbridge.space/mcp'))
  assert.equal((await card.json()).transport.endpoint.endsWith('/mcp'), true)
  assert.equal((await mcpGet(new NextRequest('https://cashbridge.space/mcp', { headers: { accept: 'text/event-stream' } }))).status, 405)
})

test('a status or report call without an id names every id it accepts', async () => {
  const none = await call('get_bridge_status', {})
  assert.equal(none.isError, true)
  assert.equal(none.content[0].text, 'Give order_id + order_token, near_deposit_address, shapeshift_quote_id, or source_tx')
  assert.match((await call('get_bridge_status', { order_token: 'ab'.repeat(32) })).content[0].text, /"order_id" is required/)
  const report = await call('report_source_transaction', { source_tx: 'ab'.repeat(32) })
  assert.equal(report.isError, true)
  assert.match(report.content[0].text, /order_id \+ order_token, near_deposit_address, or shapeshift_quote_id/)
})

// The bare domain 308s to www, and a POST without -L stops at the redirect: every printed URL is the www one.
test('printed URLs use the www host, also when the site URL is set to the bare domain', async () => {
  const bare = /https:\/\/cashbridge\.space/
  const { MCP_URL, SKILL_INSTALL_COMMAND } = await import('../src/server/agent/kit.ts')
  const card = await (await mcpGet(new NextRequest('https://www.cashbridge.space/mcp'))).json()
  const { GET } = await import('../src/app/llms.txt/route.ts')
  const llms = await (await GET()).text()
  assert.equal(MCP_URL, 'https://www.cashbridge.space/mcp')
  assert.equal(card.transport.endpoint, MCP_URL)
  for (const printed of [SKILL_INSTALL_COMMAND, JSON.stringify(card), llms]) assert.doesNotMatch(printed, bare)
  const baseUrl = execFileSync(process.execPath, ['--no-warnings', '--import', './test/register-ts-alias.mjs', '--input-type=module', '-e', "process.stdout.write((await import('./src/config.ts')).AppConfig.baseUrl)"], { env: { ...process.env, NEXT_PUBLIC_SITE_URL: 'https://cashbridge.space' } }).toString()
  assert.equal(baseUrl, 'https://www.cashbridge.space')
})

test('each client gets 60 requests per window, then 429 with Retry-After', async () => {
  for (let i = 0; i < 60; i++) assert.equal((await post({ jsonrpc: '2.0', id: i, method: 'ping' }, '203.0.113.9')).status, 200)
  const limited = await post({ jsonrpc: '2.0', id: 61, method: 'ping' }, '203.0.113.9')
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.equal((await post({ jsonrpc: '2.0', id: 62, method: 'ping' }, '203.0.113.10')).status, 200, 'another client is not affected')
})

test('bad arguments come back as tool errors the agent can read', async () => {
  let result = await call('get_bridge_quote', { from_asset: 'BCH.BCH', to_asset: 'PUSD', amount: '1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /one side must be BCH\.BCH/i)
  result = await call('get_bridge_quote', { from_asset: USDC, to_asset: 'BCH.BCH', amount: '-3' })
  assert.match(result.content[0].text, /positive decimal/)
  result = await call('prepare_bridge', { from_asset: USDC, to_asset: 'PUSD', amount: '25', source_address: SOURCE, destination_address: recipient.cashAddress })
  assert.match(result.content[0].text, /token-aware/)
})

test('a forward transfer to BCH returns the approval and the verified router deposit', async () => {
  quotes.length = 0
  const result = await call('prepare_bridge', { from_asset: USDC, to_asset: 'BCH.BCH', amount: '25', source_address: SOURCE, destination_address: recipient.tokenAddress })
  assert.equal(result.isError, undefined, result.content[0].text)
  const data = result.structuredContent
  assert.equal(data.destination_address, recipient.cashAddress, 'a token-aware address is paid in its plain form')
  assert.equal(quotes[0].destinationAddress, recipient.cashAddress)
  assert.equal(quotes[0].refundAddress, SOURCE)
  assert.equal(data.deposit.inbound_address, VAULT)
  assert.equal(data.deposit.expires_at, new Date(1_900_000_000_000).toISOString())
  assert.deepEqual(data.transactions.map(t => [t.step, t.to.toLowerCase(), t.chain_id]), [['approve', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 8453], ['deposit', ROUTER, 8453]])
  assert.equal(quotes[0].dry, undefined, 'the aggregator is not asked to simulate a wallet that has not approved yet')
  const approve = new Interface(['function approve(address spender, uint256 amount)']).decodeFunctionData('approve', data.transactions[0].data)
  assert.equal(approve.spender, ROUTER)
  assert.equal(approve.amount, 25_000_000n)
  const deposit = DEPOSIT.decodeFunctionData('depositWithExpiry', data.transactions[1].data)
  assert.deepEqual([deposit.vault, deposit.asset.toLowerCase(), deposit.amount, deposit.memo, deposit.expiration], [VAULT, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 25_000_000n, data.deposit.memo, 1_900_000_000n])
  assert.equal(data.transactions[1].from, SOURCE)
  assert.equal(data.transactions[1].value, '0')
})

test('a quote that pays another vault, carries another memo or has expired gets no transaction', async () => {
  try {
    for (const [change, reason] of [
      [route => ({ ...route, inboundAddress: '0x4444444444444444444444444444444444444444' }), /not THORChain's current BASE vault/],
      [route => ({ ...route, memo: '=:BCH.BCH:qattacker' }), /no route/],
      [route => ({ ...route, expiration: '1000' }), /no valid expiry/]
    ]) {
      tamper = change
      const result = await call('prepare_bridge', { from_asset: USDC, to_asset: 'BCH.BCH', amount: '25', source_address: SOURCE, destination_address: recipient.cashAddress })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, reason)
    }
  } finally {
    tamper = route => route
  }
})

test('a CashToken goes through a Router order whose deposit is its contract', async () => {
  quotes.length = 0
  routerSeen.length = 0
  const result = await call('prepare_bridge', { from_asset: 'BASE.ETH', to_asset: 'PUSD', amount: '0.01', source_address: SOURCE, destination_address: recipient.tokenAddress })
  assert.equal(result.isError, undefined, result.content[0].text)
  const { order, deposit, transactions } = result.structuredContent
  assert.match(order.token, /^[a-f0-9]{64}$/)
  assert.equal(routerSeen[0].headers.authorization, `Bearer ${order.token}`)
  assert.equal(routerSeen[0].headers['cf-connecting-ip'], `198.51.100.${client}`)
  assert.deepEqual(routerSeen[0].body.source, { chain: 'BASE', asset: 'BASE.ETH', amount: '0.01', address: SOURCE })
  assert.equal(routerSeen[0].body.expectedBchSats, '5000000')
  assert.equal(order.minimum_output, '1.23 PUSD')
  assert.equal(quotes[1].destinationAddress, order.deposit_address, 'THORChain pays the order contract')
  assert.ok(deposit.memo.includes(order.deposit_address))
  assert.deepEqual(transactions.map(t => t.step), ['deposit'], 'native ETH needs no approval')

  routerOrder = o => ({ ...o, depositAddress: recipient.cashAddress })
  const forged = await call('prepare_bridge', { from_asset: 'BASE.ETH', to_asset: 'PUSD', amount: '0.01', source_address: SOURCE, destination_address: recipient.tokenAddress })
  assert.equal(forged.isError, true, 'a deposit that is not the contract of the terms is refused')
  assert.match(forged.content[0].text, /not its contract/)
  routerOrder = o => o

  routerSeen.length = 0
  const hash = 'ab'.repeat(32)
  const reported = await call('report_source_transaction', { order_id: order.id, order_token: order.token, source_tx: `0x${hash}` })
  assert.equal(reported.isError, undefined, reported.content[0].text)
  assert.deepEqual(routerSeen[0].body, { sourceHash: hash })
  const status = await call('get_bridge_status', { order_id: order.id, order_token: order.token })
  assert.equal(status.structuredContent.state, 'ready')
  assert.match(status.structuredContent.meaning, /buying the token/)
})

test('a coin THORChain has no pool for is still sized for ShapeShift: NEAR Intents decimals, and 8 for RUNE', async () => {
  shapeRates.length = 0
  const quote = await call('get_bridge_quote', { from_asset: 'SUI.SUI', to_asset: 'BCH.BCH', amount: '2' })
  assert.equal(quote.isError, undefined, quote.content[0].text)
  assert.ok(quote.structuredContent.routes.some(r => r.route === 'shapeshift'), JSON.stringify(quote.structuredContent))
  assert.equal(shapeRates.at(-1).get('sellAmountCryptoBaseUnit'), '2000000000')

  // RUNE has no pool, and NEAR Intents does not list it.
  const rune = await call('get_bridge_quote', { from_asset: 'THOR.RUNE', to_asset: 'BCH.BCH', amount: '3' })
  assert.ok(!JSON.stringify(rune).includes('did not give the decimals'), JSON.stringify(rune))
  assert.equal(shapeRates.at(-1).get('sellAmountCryptoBaseUnit'), '300000000')
})

test('plain BCH compares THORChain with NEAR Intents, and a NEAR deposit is a plain transfer', async () => {
  const quote = await call('get_bridge_quote', { from_asset: USDC, to_asset: 'BCH.BCH', amount: '25' })
  assert.equal(quote.isError, undefined, quote.content[0].text)
  assert.deepEqual(
    quote.structuredContent.routes.map(r => [r.route, r.expected_output]),
    [
      ['thorchain', '0.05'],
      ['near_intents', '0.06'],
      ['shapeshift', '0.07']
    ]
  )
  assert.equal(quote.structuredContent.best, 'shapeshift')

  nearQuotes.length = 0
  const result = await call('prepare_bridge', { from_asset: USDC, to_asset: 'BCH.BCH', amount: '25', source_address: SOURCE, destination_address: recipient.tokenAddress, route: 'near_intents' })
  assert.equal(result.isError, undefined, result.content[0].text)
  const data = result.structuredContent
  assert.equal(nearQuotes[0].dry, false)
  assert.equal(nearQuotes[0].recipient, recipient.cashAddress, '1Click is given the plain address')
  assert.equal(nearQuotes[0].refundTo, SOURCE)
  assert.equal(data.deposit.deposit_address, NEAR_DEPOSIT)
  const [transfer] = data.transactions
  assert.equal(transfer.to.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
  const args = new Interface(['function transfer(address to, uint256 amount)']).decodeFunctionData('transfer', transfer.data)
  assert.equal(args.to, NEAR_DEPOSIT)
  assert.equal(args.amount, 25_000_000n)
  assert.equal(data.near_quote.signature, 'ed25519:sig')

  nearQuotes.length = 0
  routerSeen.length = 0
  const token = await call('prepare_bridge', { from_asset: USDC, to_asset: 'PUSD', amount: '25', source_address: SOURCE, destination_address: recipient.tokenAddress, route: 'near_intents' })
  assert.equal(token.isError, undefined, token.content[0].text)
  assert.match(token.structuredContent.route, /NEAR Intents/)
  assert.equal(token.structuredContent.order.near_deposit_address, NEAR_DEPOSIT)
  assert.equal(nearQuotes.at(-1).recipient, token.structuredContent.order.deposit_address)
  assert.ok(routerSeen.some(r => r.body?.nearDepositAddress === NEAR_DEPOSIT))
})

test('selling plain BCH compares both routes too, and a NEAR deposit out of BCH is checked before it is handed out', async () => {
  const quote = await call('get_bridge_quote', { from_asset: 'BCH.BCH', to_asset: USDC, amount: '0.1' })
  assert.equal(quote.isError, undefined, quote.content[0].text)
  assert.deepEqual(
    quote.structuredContent.routes.map(r => [r.route, r.expected_output]),
    [
      ['thorchain', '20'],
      ['near_intents', '6'],
      ['shapeshift', '7']
    ]
  )
  assert.equal(quote.structuredContent.best, 'thorchain')

  nearQuotes.length = 0
  const args = { from_asset: 'BCH.BCH', to_asset: USDC, amount: '0.1', source_address: recipient.tokenAddress, destination_address: SOURCE, route: 'near_intents' }
  const result = await call('prepare_bridge', args)
  assert.equal(result.isError, undefined, result.content[0].text)
  const data = result.structuredContent
  assert.equal(nearQuotes[0].refundTo, recipient.cashAddress, 'refunds go to the plain sending address')
  assert.equal(nearQuotes[0].recipient, SOURCE)
  assert.equal(data.deposit.deposit_address, NEAR_BCH_DEPOSIT)
  assert.equal(data.deposit.amount_base_units, '10000000')
  assert.equal(data.transactions, undefined)

  nearBchDeposit = NEAR_DEPOSIT
  try {
    const bad = await call('prepare_bridge', args)
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /nothing was sent/)
  } finally {
    nearBchDeposit = NEAR_BCH_DEPOSIT
  }
})

test('ShapeShift prepares a plain deposit-address transfer', async () => {
  const result = await call('prepare_bridge', {
    from_asset: USDC,
    to_asset: 'BCH.BCH',
    amount: '25',
    source_address: SOURCE,
    destination_address: recipient.cashAddress,
    route: 'shapeshift'
  })
  assert.equal(result.isError, undefined, result.content[0].text)
  const data = result.structuredContent
  assert.equal(data.route, 'ShapeShift')
  assert.equal(data.deposit.deposit_address, '0x5555555555555555555555555555555555555555')
  assert.equal(data.shapeshift.quote_id, 'ss-quote-1')
  assert.equal(data.transactions[0].step, 'transfer')
  const status = await call('get_bridge_status', { shapeshift_quote_id: 'ss-quote-1' })
  assert.equal(status.structuredContent.status, 'pending')
  // ShapeShift takes no source notice: the call is accepted but says nothing was reported.
  const report = await call('report_source_transaction', { shapeshift_quote_id: 'ss-quote-1', source_tx: `0x${'ab'.repeat(32)}` })
  assert.equal(report.isError, undefined, report.content[0].text)
  assert.equal(report.structuredContent.reported, false)
  assert.match(report.structuredContent.note, /needs no report/)
})

test('a token name with an extra dash still pays the token contract, never the gas coin', async () => {
  const result = await call('prepare_bridge', {
    from_asset: 'BASE.USDC-X-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913',
    to_asset: 'BCH.BCH',
    amount: '25',
    source_address: SOURCE,
    destination_address: recipient.cashAddress,
    route: 'shapeshift'
  })
  assert.equal(result.isError, undefined, result.content[0].text)
  const [transfer] = result.structuredContent.transactions
  assert.equal(transfer.to.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
  assert.equal(transfer.value, '0')
  const sent = new Interface(['function transfer(address to, uint256 amount)']).decodeFunctionData('transfer', transfer.data)
  assert.deepEqual([sent.to, sent.amount], [SHAPE_DEPOSIT, 25_000_000n])
})

test('an Any-network free pair quotes all three routes, and NEAR prepares a plain deposit there', async () => {
  const quote = await call('get_bridge_quote', { from_asset: 'ETH.ETH', to_asset: 'BTC.BTC', amount: '1' })
  assert.equal(quote.isError, undefined, quote.content[0].text)
  assert.equal(quote.structuredContent.mode, 'any_network')
  assert.deepEqual(quote.structuredContent.routes.map(r => r.route), ['thorchain', 'near_intents', 'shapeshift'])

  nearQuotes.length = 0
  const btc = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
  const result = await call('prepare_bridge', { from_asset: 'ETH.ETH', to_asset: 'BTC.BTC', amount: '1', source_address: SOURCE, destination_address: btc, route: 'near_intents' })
  assert.equal(result.isError, undefined, result.content[0].text)
  const data = result.structuredContent
  assert.equal(data.mode, 'any_network')
  assert.equal(nearQuotes[0].originAsset, 'nep141:eth.omft.near')
  assert.equal(nearQuotes[0].destinationAsset, 'nep141:btc.omft.near')
  assert.equal(nearQuotes[0].recipient, btc)
  assert.equal(nearQuotes[0].refundTo, SOURCE)
  assert.deepEqual(data.transactions.map(t => [t.step, t.to, t.value]), [['transfer', NEAR_DEPOSIT, nearQuotes[0].amount]])
})

test('a CashToken purchase can ride ShapeShift: its NEAR Intents deposit pays the Router order', async () => {
  routerSeen.length = 0
  const result = await call('prepare_bridge', { from_asset: USDC, to_asset: 'PUSD', amount: '25', source_address: SOURCE, destination_address: recipient.tokenAddress, route: 'shapeshift' })
  assert.equal(result.isError, undefined, result.content[0].text)
  const data = result.structuredContent
  assert.match(data.route, /ShapeShift/)
  assert.equal(shapeQuote.receiveAddress, data.order.deposit_address, 'ShapeShift pays the order contract')
  assert.equal(shapeQuote.sendAddress, SOURCE)
  assert.equal(data.deposit.deposit_address, SHAPE_DEPOSIT)
  assert.equal(data.shapeshift.quote_id, 'ss-quote-1')
  assert.deepEqual(routerSeen.at(-1).body, { nearDepositAddress: SHAPE_DEPOSIT, shapeshiftQuoteId: 'ss-quote-1' })
  assert.equal(data.order.shapeshift_quote_id, 'ss-quote-1')

  const forged = shapeQuote
  try {
    // 1Click now says the address pays someone else: the order gets no deposit and nothing is handed out.
    routerSeen.length = 0
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const response = await original(input, init)
      if (String(input).endsWith('/v1/swap/quote')) shapeQuote = { ...shapeQuote, receiveAddress: recipient.cashAddress }
      return response
    }
    try {
      const bad = await call('prepare_bridge', { from_asset: USDC, to_asset: 'PUSD', amount: '25', source_address: SOURCE, destination_address: recipient.tokenAddress, route: 'shapeshift' })
      assert.equal(bad.isError, true)
      assert.match(bad.content[0].text, /does not match/)
      assert.ok(!routerSeen.some(r => r.body?.nearDepositAddress))
    } finally {
      globalThis.fetch = original
    }
  } finally {
    shapeQuote = forged
  }
})

test('the agent prompt and skill name every tool, and the skill index digest covers the served SKILL.md', async () => {
  const { AGENT_PROMPT, SKILL_INDEX, SKILL_MD, SKILL_PATH } = await import('../src/server/agent/kit.ts')
  const { TOOLS } = await import('../src/server/agent/tools.ts')
  for (const tool of TOOLS) assert.ok(AGENT_PROMPT.includes(`- ${tool.name}(`), tool.name)
  const [entry] = SKILL_INDEX.skills
  const [, frontmatter] = SKILL_MD.match(/^---\n([\s\S]*?)\n---\n/)
  const fields = Object.fromEntries(frontmatter.split('\n').map(line => line.split(/: (.*)/s).slice(0, 2)))
  assert.deepEqual(fields, { name: entry.name, description: entry.description })
  assert.ok(!entry.description.includes(': ') && entry.description.length <= 1024, 'a plain YAML scalar that skill installers parse')
  // The route lives where the index points, and the bytes it serves are the ones the digest covers.
  const { GET } = await import(`../src/app${SKILL_PATH}/route.ts`)
  const served = Buffer.from(await (await GET()).arrayBuffer())
  assert.equal(entry.url, SKILL_PATH)
  assert.equal(entry.digest, `sha256:${createHash('sha256').update(served).digest('hex')}`)
})

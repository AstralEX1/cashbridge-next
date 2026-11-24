// The 1Click proxy: partner JWT stays server-side, only allowlisted paths get through.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { NextRequest } from 'next/server.js'

const JWT = 'partner-jwt-do-not-ship-9c2e'
const seen = []
const upstreamStatuses = []
const upstream = createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body })
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-echo-auth', String(req.headers.authorization ?? ''))
    res.statusCode = upstreamStatuses.shift() ?? 200
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
})

let route
before(async () => {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  process.env.NEAR_INTENTS_JWT = JWT
  process.env.NEAR_INTENTS_URL = `http://127.0.0.1:${upstream.address().port}`
  route = await import('../src/app/api/near-intents/[...path]/route.ts')
})
after(() => upstream.close())

const call = (method, path, { query = '', body, headers = {} } = {}) => {
  const req = new NextRequest(`http://localhost:3000/api/near-intents/${path.join('/')}${query}`, {
    method,
    body,
    headers: { 'sec-fetch-site': 'same-origin', host: 'localhost:3000', ...headers }
  })
  return route[method](req, { params: Promise.resolve({ path }) })
}

test('an allowed quote reaches upstream with the partner JWT; the response carries no JWT', async () => {
  seen.length = 0
  const res = await call('POST', ['v0', 'quote'], {
    body: JSON.stringify({ dry: true, swapType: 'EXACT_INPUT' }),
    headers: { authorization: 'Bearer browser-supplied', cookie: 'a=b' }
  })
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, '/quote')
  assert.equal(seen[0].headers.authorization, `Bearer ${JWT}`, 'the server JWT, not the browser one')
  assert.equal(seen[0].headers.cookie, undefined)
  const text = await res.text()
  assert.ok(!text.includes(JWT))
  assert.equal(res.headers.get('x-echo-auth'), null)
  for (const [, v] of res.headers) assert.ok(!v.includes(JWT))
})

test('a quote that adds a partner fee or another referral is refused before it reaches 1Click', async () => {
  seen.length = 0
  for (const extra of [{ appFees: [{ recipient: 'someone.near', fee: 100 }] }, { referral: 'someone-else' }]) {
    const res = await call('POST', ['v0', 'quote'], { body: JSON.stringify({ dry: true, swapType: 'EXACT_INPUT', ...extra }) })
    assert.equal(res.status, 400)
  }
  assert.equal(seen.length, 0)
  assert.equal((await call('POST', ['v0', 'quote'], { body: JSON.stringify({ dry: true, referral: 'cashbridge' }) })).status, 200)
})

test('tokens and status are forwarded; deposit/submit is POST only', async () => {
  seen.length = 0
  assert.equal((await call('GET', ['v0', 'tokens'])).status, 200)
  assert.equal(seen[0].url, '/tokens')
  assert.equal((await call('GET', ['v0', 'status'], { query: '?depositAddress=bitcoincash:qtest' })).status, 200)
  assert.equal(seen[1].url, '/status?depositAddress=bitcoincash%3Aqtest')
  assert.equal((await call('POST', ['v0', 'deposit', 'submit'], { body: JSON.stringify({ depositAddress: 'a', txHash: 'b' }) })).status, 200)
  assert.equal(seen[2].url, '/deposit/submit')
  assert.equal((await call('GET', ['v0', 'deposit', 'submit'])).status, 404)
})

test('a quote retries one transient gateway response before returning it', async () => {
  seen.length = 0
  upstreamStatuses.push(502, 200)
  const res = await call('POST', ['v0', 'quote'], { body: JSON.stringify({ dry: true }) })
  assert.equal(res.status, 200)
  assert.equal(seen.length, 2)
  upstreamStatuses.push(502, 200)
  assert.equal((await call('GET', ['v0', 'tokens'])).status, 200, 'the token list is read-only too')
  assert.equal(seen.length, 4)
  upstreamStatuses.push(502)
  assert.equal((await call('GET', ['v0', 'status'], { query: '?depositAddress=a' })).status, 502, 'status is not retried')
  assert.equal(seen.length, 5)
})

test('unknown paths, traversal and wrong versions are refused without contacting upstream', async () => {
  seen.length = 0
  for (const path of [['v0', 'admin'], ['v0', '..', 'v1', 'quote'], ['v0', 'quote%2F..%2Fadmin'], ['v1', 'quote'], ['v0'], ['v0', 'https:', '', 'evil.example']]) {
    assert.equal((await call('GET', path)).status, 404, path.join('/'))
    assert.equal((await call('POST', path, { body: '{}' })).status, 404, path.join('/'))
  }
  assert.equal((await call('GET', ['v0', 'quote'])).status, 404, 'quote is POST only')
  assert.equal((await route.DELETE(new NextRequest('http://localhost:3000/api/near-intents/v0/quote', { method: 'DELETE' }))).status, 405)
  assert.equal(seen.length, 0)
})

test('cross-origin, oversized and non-JSON requests are refused', async () => {
  seen.length = 0
  assert.equal((await call('POST', ['v0', 'quote'], { body: '{}', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await call('POST', ['v0', 'quote'], { body: 'not json' })).status, 400)
  assert.equal((await call('POST', ['v0', 'quote'], { body: JSON.stringify({ x: 'a'.repeat(20_000) }) })).status, 413)
  assert.equal(seen.length, 0)
})

test('without a JWT the proxy still forwards keyless', async () => {
  delete process.env.NEAR_INTENTS_JWT
  seen.length = 0
  const res = await call('POST', ['v0', 'quote'], { body: '{}' })
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers.authorization, undefined)
  process.env.NEAR_INTENTS_JWT = JWT
})

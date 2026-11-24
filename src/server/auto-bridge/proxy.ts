import { request } from 'node:http'
import { request as secureRequest } from 'node:https'
import { NextRequest, NextResponse } from 'next/server'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { isSameOrigin } from '@/lib/same-origin'
import { isFeedOrder, type FeedOrder } from '@/lib/auto-bridge-contract'

// Under the browser's 15 s request timeout, so the page gets this answer rather than giving up first.
const UPSTREAM_DEADLINE_MS = 12000

// The public process has socket access, not access to the signer or its SQLite database.
export async function forwardOrder(req: NextRequest, id?: string) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
  const failure = (status: number, error: string) => NextResponse.json({ error }, { status, headers })
  if (id && !/^[a-f0-9-]{36}$/.test(id)) return failure(400, 'Invalid order identifier')
  if (req.method === 'POST' && !isSameOrigin(req)) return failure(403, 'Same-origin request required')
  if (!/^Bearer [a-f0-9]{64}$/.test(req.headers.get('authorization') ?? '')) return failure(401, 'Order authorization required')
  const ip = clientIp(req)
  if (rateLimit(req, req.method === 'POST' ? 'automatic-proxy-write' : 'automatic-proxy-read', req.method === 'POST' ? 10 : 600) !== null)
    return failure(429, 'Too many order requests')
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = req.body?.getReader()
    if (reader)
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > 4096) {
          await reader.cancel()
          return failure(413, 'Request body too large')
        }
        chunks.push(next.value)
      }
    const body = Buffer.concat(chunks)
    const upstreamHeaders: Record<string, string> = {
      authorization: req.headers.get('authorization')!,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin'
    }
    if (ip) upstreamHeaders['cf-connecting-ip'] = ip
    const response = await callWorker(req.method, `/orders${id ? `/${id}` : ''}`, upstreamHeaders, body)
    if (!response) return failure(503, 'Automatic bridge transport is not configured')
    return new NextResponse(response.body.toString('utf8'), { status: response.status, headers })
  } catch {
    return failure(503, 'Cashbridge Router is unavailable')
  }
}

// One request to the worker, for the order proxy, the scanner feed and the agent endpoint: over HTTPS to
// AUTO_BRIDGE_UPSTREAM with the service token, or over its local socket.
// Undefined when the transport is misconfigured.
export async function callWorker(method: string, path: string, headers: Record<string, string>, body?: Buffer) {
  const upstream = process.env.AUTO_BRIDGE_UPSTREAM ? new URL(process.env.AUTO_BRIDGE_UPSTREAM) : undefined
  if (upstream && (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash)) return undefined
  const serviceToken = process.env.AUTO_BRIDGE_SERVICE_TOKEN
  if ((upstream && !serviceToken) || (serviceToken && !/^[A-Za-z0-9_-]{32,128}$/.test(serviceToken))) return undefined
  const upstreamHeaders = { ...headers, ...(serviceToken ? { 'x-cashbridge-service-auth': serviceToken } : {}) }
  // The query rides outside the pathname, which would percent-encode its `?`.
  const queryAt = path.indexOf('?')
  const search = queryAt < 0 ? '' : path.slice(queryAt)
  if (upstream) {
    upstream.pathname = upstream.pathname.replace(/\/$/, '') + (queryAt < 0 ? path : path.slice(0, queryAt))
  }
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const options = {
      ...(upstream
        ? { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, path: upstream.pathname + search }
        : {
            socketPath: process.env.AUTO_BRIDGE_SOCKET ?? '/run/cashbridge/worker.sock',
            path
          }),
      method,
      headers: upstreamHeaders,
      // A hard deadline, not an idle timeout: a worker that trickles or never answers still ends in a JSON 503.
      signal: AbortSignal.timeout(UPSTREAM_DEADLINE_MS)
    }
    const call = (upstream ? secureRequest : request)(options, incoming => {
      const result: Buffer[] = []
      let length = 0
      incoming.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 65536) call.destroy(new Error('Order response exceeded limit'))
        else result.push(chunk)
      })
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 503, body: Buffer.concat(result) }))
      incoming.on('error', reject)
    })
    call.on('error', reject)
    call.end(body)
  })
}

// The Router's newest orders for the public scanner, or with `address` that wallet's orders; undefined when the
// worker cannot be read, predates the feed, or (for an address) did not apply the filter. `ip` is the asking client's,
// so the Router's read limit counts each visitor apart.
export async function readOrderFeed(address: string | undefined, ip: string): Promise<FeedOrder[] | undefined> {
  try {
    const response = await callWorker('GET', address ? `/orders?address=${encodeURIComponent(address)}` : '/orders', { 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': ip })
    if (response?.status !== 200) return undefined
    const body = JSON.parse(response.body.toString('utf8'))
    if (address && body?.address !== address) return undefined
    const orders: unknown = body?.orders
    return Array.isArray(orders) ? orders.filter(isFeedOrder) : undefined
  } catch {
    return undefined
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { apiError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { isSameOrigin } from '@/lib/same-origin'
import { readRequestBody } from '@/lib/request-body'

// The allowlisting proxy behind /api/thorchain and /api/near-intents: each route names its
// upstream, the calls it forwards and the credential it adds; the checks are the same.
const UPSTREAM_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 16 * 1024
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504])

type Endpoint = { method: 'GET' | 'POST'; path: RegExp; query?: string[] }

export type UpstreamProxy = {
  version: string // the first path segment, mirroring the upstream's versioned base
  endpoints: Endpoint[]
  retriedGet: string // a read-only GET path that, like POST quote, gets one retry on a gateway failure
  rateLimitScope: string
  crossOriginHint: string
  notFound: [message: string, hint: string]
  unreachable: [message: string, hint: string]
  upstreamBase: () => string
  // The headers to send upstream, or the error to answer when the server is not set up.
  headers: (req: NextRequest) => Record<string, string> | Response
  // A refusal for a parsed JSON body, if any.
  checkBody?: (path: string, body: unknown) => Response | undefined
}

function resolve(proxy: UpstreamProxy, method: string, fullPath: string[], search: URLSearchParams) {
  const [version, ...path] = fullPath
  if (version !== proxy.version) return null

  // Next decodes catch-all segments, so an encoded slash or dot-segment would walk out of
  // the allowlisted path once fetch normalises the URL.
  if (path.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) return null

  const joined = path.join('/')
  const endpoint = proxy.endpoints.find(e => e.method === method && e.path.test(joined))
  if (!endpoint) return null

  const query = new URLSearchParams()
  for (const [key, value] of search) {
    if (!endpoint.query?.includes(key) || query.has(key) || value.length > 256) return null
    query.set(key, value)
  }

  return { path: path.map(encodeURIComponent).join('/'), query: query.toString() }
}

export async function forwardUpstream(proxy: UpstreamProxy, req: NextRequest, path: string[], method: 'GET' | 'POST') {
  if (!isSameOrigin(req)) {
    return apiError(403, 'forbidden', 'Cross-origin requests are not allowed', proxy.crossOriginHint)
  }

  const retryAfter = rateLimit(req, proxy.rateLimitScope, 600)
  if (retryAfter !== null) {
    return apiError(429, 'rate_limited', 'Too many requests', `Retry after ${retryAfter} seconds (see the Retry-After header).`, {
      'Retry-After': String(retryAfter)
    })
  }

  const target = resolve(proxy, method, path, req.nextUrl.searchParams)
  if (!target) return apiError(404, 'not_found', ...proxy.notFound)

  const headers = proxy.headers(req)
  if (headers instanceof Response) return headers

  let body: string | undefined
  if (method === 'POST') {
    const payload = await readRequestBody(req, MAX_BODY_BYTES)
    if (typeof payload !== 'string') return payload
    body = payload
    if (body) {
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        return apiError(400, 'bad_request', 'Body must be JSON', 'Send a JSON request body.')
      }
      const refused = proxy.checkBody?.(target.path, parsed)
      if (refused) return refused
      headers['Content-Type'] = 'application/json'
    }
  }

  const upstreamBase = proxy.upstreamBase().replace(/\/$/, '')
  const url = `${upstreamBase}/${target.path}${target.query ? `?${target.query}` : ''}`

  const fetchUpstream = () => fetch(url, {
    method,
    headers,
    body,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  })

  let upstream = await fetchUpstream().catch(() => null)

  // Quotes and the read-only GET are safe to repeat, so retry one explicit gateway failure before the
  // client logs it as an error. A timed-out or unreachable upstream is not retried, keeping the request within its current bound.
  const readOnly = (method === 'POST' && target.path === 'quote') || (method === 'GET' && target.path === proxy.retriedGet)
  if (readOnly && upstream && RETRYABLE_UPSTREAM_STATUSES.has(upstream.status)) {
    const firstResponse = upstream
    const retry = await fetchUpstream().catch(() => null)
    if (retry) {
      await firstResponse.body?.cancel().catch(() => {})
      upstream = retry
    }
  }

  if (!upstream) return apiError(502, 'upstream_unreachable', ...proxy.unreachable)

  // Only the body and status go back: no upstream headers, which could echo request details.
  const payload = await upstream.text()
  return new NextResponse(payload, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type')?.startsWith('application/json') ? 'application/json' : 'text/plain',
      'Cache-Control': 'no-store'
    }
  })
}

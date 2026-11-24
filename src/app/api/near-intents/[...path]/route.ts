import { NextRequest, NextResponse } from 'next/server'
import { apiError, methodNotAllowed } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { isSameOrigin } from '@/lib/same-origin'
import { readRequestBody } from '@/lib/request-body'
import { REFERRAL } from '@/lib/near-intents'

// Server-side proxy for NEAR Intents' 1Click API. The partner JWT (NEAR_INTENTS_JWT) stays on the
// server; the browser talks to /api/near-intents/v0/* and this route adds Authorization when set.
// Without a JWT, requests stay keyless (1Click adds 25 bps on quotes). Only the swap-flow calls
// are forwarded.
const DEFAULT_UPSTREAM = 'https://1click.chaindefuser.com/v0'

const UPSTREAM_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 16 * 1024
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504])

type Endpoint = { method: 'GET' | 'POST'; path: RegExp; query?: string[] }

const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: /^tokens$/ },
  { method: 'GET', path: /^status$/, query: ['depositAddress'] },
  { method: 'POST', path: /^quote$/ },
  { method: 'POST', path: /^deposit\/submit$/ }
]

function resolve(method: string, fullPath: string[], search: URLSearchParams) {
  const [version, ...path] = fullPath
  if (version !== 'v0') return null

  if (path.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) return null

  const joined = path.join('/')
  const endpoint = ENDPOINTS.find(e => e.method === method && e.path.test(joined))
  if (!endpoint) return null

  const query = new URLSearchParams()
  for (const [key, value] of search) {
    if (!endpoint.query?.includes(key) || query.has(key) || value.length > 256) return null
    query.set(key, value)
  }

  return { path: path.map(encodeURIComponent).join('/'), query: query.toString() }
}

async function forward(req: NextRequest, path: string[], method: 'GET' | 'POST') {
  if (!isSameOrigin(req)) {
    return apiError(403, 'forbidden', 'Cross-origin requests are not allowed', 'This proxy only serves this site. Use 1click.chaindefuser.com with your own partner JWT.')
  }

  const retryAfter = rateLimit(req, 'near-intents', 600)
  if (retryAfter !== null) {
    return apiError(429, 'rate_limited', 'Too many requests', `Retry after ${retryAfter} seconds (see the Retry-After header).`, {
      'Retry-After': String(retryAfter)
    })
  }

  const target = resolve(method, path, req.nextUrl.searchParams)
  if (!target) return apiError(404, 'not_found', 'Unsupported 1Click path', 'This proxy only forwards tokens, status, quote and deposit/submit.')

  let body: string | undefined
  if (method === 'POST') {
    const payload = await readRequestBody(req, MAX_BODY_BYTES)
    if (typeof payload !== 'string') return payload
    body = payload
    if (body) {
      let parsed: { appFees?: unknown; referral?: unknown } | null
      try {
        parsed = JSON.parse(body)
      } catch {
        return apiError(400, 'bad_request', 'Body must be JSON', 'Send a JSON request body.')
      }
      // The partner JWT pays for this site's quotes only: no fee for someone else, no other referral.
      if (target.path === 'quote' && parsed && typeof parsed === 'object' && (parsed.appFees !== undefined || (parsed.referral ?? REFERRAL) !== REFERRAL))
        return apiError(400, 'bad_request', 'Unsupported quote fields', `This proxy quotes for this site only: no appFees, and referral "${REFERRAL}" or none.`)
    }
  }

  const headers: Record<string, string> = {}
  const jwt = process.env.NEAR_INTENTS_JWT?.trim()
  if (jwt) headers.Authorization = `Bearer ${jwt}`
  if (body) headers['Content-Type'] = 'application/json'

  const upstreamBase = (process.env.NEAR_INTENTS_URL || process.env.NEXT_PUBLIC_NEAR_INTENTS_URL || DEFAULT_UPSTREAM).replace(/\/$/, '')
  const url = `${upstreamBase}/${target.path}${target.query ? `?${target.query}` : ''}`

  const fetchUpstream = () =>
    fetch(url, {
      method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    })

  let upstream = await fetchUpstream().catch(() => null)

  const readOnly = (method === 'POST' && target.path === 'quote') || (method === 'GET' && target.path === 'tokens')
  if (readOnly && upstream && RETRYABLE_UPSTREAM_STATUSES.has(upstream.status)) {
    const firstResponse = upstream
    const retry = await fetchUpstream().catch(() => null)
    if (retry) {
      await firstResponse.body?.cancel().catch(() => {})
      upstream = retry
    }
  }

  if (!upstream) {
    return apiError(502, 'upstream_unreachable', 'NEAR Intents is unreachable', 'The 1Click API did not respond. Retry in a moment.')
  }

  const payload = await upstream.text()
  return new NextResponse(payload, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type')?.startsWith('application/json') ? 'application/json' : 'text/plain',
      'Cache-Control': 'no-store'
    }
  })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await params).path, 'GET')
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await params).path, 'POST')
}

export const PUT = methodNotAllowed(['GET', 'POST'])
export const PATCH = methodNotAllowed(['GET', 'POST'])
export const DELETE = methodNotAllowed(['GET', 'POST'])

import { NextRequest } from 'next/server'
import { apiError, methodNotAllowed } from '@/lib/api-error'
import { forwardUpstream, type UpstreamProxy } from '@/lib/upstream-proxy'
import { REFERRAL } from '@/lib/near-intents'

// Server-side proxy for NEAR Intents' 1Click API. The partner JWT (NEAR_INTENTS_JWT) stays on the
// server; the browser talks to /api/near-intents/v0/* and this route adds Authorization when set.
// Without a JWT, requests stay keyless (1Click adds 25 bps on quotes). Only the swap-flow calls
// are forwarded.
const DEFAULT_UPSTREAM = 'https://1click.chaindefuser.com/v0'

const proxy: UpstreamProxy = {
  version: 'v0',
  endpoints: [
    { method: 'GET', path: /^tokens$/ },
    { method: 'GET', path: /^status$/, query: ['depositAddress'] },
    { method: 'POST', path: /^quote$/ },
    { method: 'POST', path: /^deposit\/submit$/ }
  ],
  retriedGet: 'tokens',
  rateLimitScope: 'near-intents',
  crossOriginHint: 'This proxy only serves this site. Use 1click.chaindefuser.com with your own partner JWT.',
  notFound: ['Unsupported 1Click path', 'This proxy only forwards tokens, status, quote and deposit/submit.'],
  unreachable: ['NEAR Intents is unreachable', 'The 1Click API did not respond. Retry in a moment.'],
  upstreamBase: () => process.env.NEAR_INTENTS_URL || process.env.NEXT_PUBLIC_NEAR_INTENTS_URL || DEFAULT_UPSTREAM,
  headers: () => {
    const headers: Record<string, string> = {}
    const jwt = process.env.NEAR_INTENTS_JWT?.trim()
    if (jwt) headers.Authorization = `Bearer ${jwt}`
    return headers
  },
  // The partner JWT pays for this site's quotes only: no fee for someone else, no other referral.
  checkBody: (path, body) => {
    const quote = body as { appFees?: unknown; referral?: unknown } | null
    if (path === 'quote' && quote && typeof quote === 'object' && (quote.appFees !== undefined || (quote.referral ?? REFERRAL) !== REFERRAL))
      return apiError(400, 'bad_request', 'Unsupported quote fields', `This proxy quotes for this site only: no appFees, and referral "${REFERRAL}" or none.`)
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forwardUpstream(proxy, req, (await params).path, 'GET')
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forwardUpstream(proxy, req, (await params).path, 'POST')
}

export const PUT = methodNotAllowed(['GET', 'POST'])
export const PATCH = methodNotAllowed(['GET', 'POST'])
export const DELETE = methodNotAllowed(['GET', 'POST'])

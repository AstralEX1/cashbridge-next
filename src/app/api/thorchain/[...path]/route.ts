import { NextRequest } from 'next/server'
import { apiError, methodNotAllowed } from '@/lib/api-error'
import { forwardUpstream, type UpstreamProxy } from '@/lib/upstream-proxy'

// Server-side proxy for the hosted THORChain aggregator (api.thorchain.org/v1), so the
// x-api-key stays on the server instead of shipping in the client bundle. The SDK and
// src/lib/api.ts point their aggregator base URL here (see aggregatorApiUrl) and send no
// key of their own; this route adds THORCHAIN_API_KEY. Only the calls the swap flow makes
// are forwarded - it is not a general proxy for the aggregator.
const DEFAULT_UPSTREAM = 'https://api.thorchain.org/v1'

// Headers the browser may pass through. Nothing that could carry a credential.
const FORWARDED_HEADERS = ['x-referral-code']

const proxy: UpstreamProxy = {
  // Served at /api/thorchain/v1/*, mirroring the upstream's versioned base.
  version: 'v1',
  endpoints: [
    { method: 'GET', path: /^providers$/ },
    { method: 'GET', path: /^tokens$/, query: ['provider'] },
    { method: 'GET', path: /^balance$/, query: ['chain', 'address', 'identifier'] },
    { method: 'POST', path: /^quote$/ },
    { method: 'POST', path: /^track$/ },
    // The referral click-through ping (src/lib/referral.ts); carries no body.
    { method: 'POST', path: /^referral\/[a-z0-9_-]{1,64}\/visit$/i }
  ],
  retriedGet: 'balance',
  rateLimitScope: 'thorchain-aggregator',
  crossOriginHint: 'This proxy only serves this site. Use api.thorchain.org with your own API key.',
  notFound: ['Unsupported aggregator path', 'This proxy only forwards the providers, tokens, balance, quote and track calls.'],
  unreachable: ['THORChain aggregator is unreachable', 'The upstream API did not respond. Retry in a moment.'],
  upstreamBase: () => process.env.THORCHAIN_API_URL || DEFAULT_UPSTREAM,
  headers: req => {
    const apiKey = process.env.THORCHAIN_API_KEY
    if (!apiKey) return apiError(500, 'server_misconfigured', 'Server misconfiguration', 'THORCHAIN_API_KEY is not set on the server.')
    const headers: Record<string, string> = { 'x-api-key': apiKey }
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers.get(name)
      if (value && /^[a-z0-9_-]{1,64}$/i.test(value)) headers[name] = value
    }
    return headers
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

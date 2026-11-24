import { NextRequest, NextResponse } from 'next/server'
import { isScanAddress } from '@/lib/auto-bridge-contract'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { readOrderFeed } from '@/server/auto-bridge/proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 20

// The Cashbridge Router's newest orders for the scanner page, or with `?address=` the orders tied to that wallet.
// `orders: null` means the Router could not be read (or cannot search by address yet); the page still lists the
// verified runs and its other sources. The CDN keeps an answer briefly, so page views do not reach the Router.
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')?.trim()
  if (address !== undefined) {
    if (!isScanAddress(address)) return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
    if (rateLimit(req, 'scanner-address', 60) !== null) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }
  const orders = (await readOrderFeed(address, clientIp(req))) ?? null
  return NextResponse.json(
    { orders },
    { headers: { 'Cache-Control': orders ? 'public, s-maxage=30, stale-while-revalidate=120' : 'public, s-maxage=10' } }
  )
}

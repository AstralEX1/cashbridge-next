import { NextResponse } from 'next/server'
import { BridgeConfig } from '@/config'
import { getNearQuote, getNearTokens, nearSlippageBps } from '@/lib/near-intents'
import { findNearUnquotable, type NearUnquotable } from '@/lib/near-quotable'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const HOUR_MS = 60 * 60_000
// One probe of every NEAR token per instance an hour, whatever the URL asks: the CDN shares it, and a cache-busting
// query cannot turn this route into a stream of quotes.
let last: { at: number; result: Promise<NearUnquotable> } | undefined

export async function GET() {
  if (!BridgeConfig.nearIntents) return NextResponse.json({ forward: [], reverse: [] })
  if (!last || Date.now() - last.at > HOUR_MS) {
    const result = getNearTokens().then(tokens =>
      findNearUnquotable(
        tokens,
        (sellAsset, buyAsset, sellAmount) => getNearQuote({ sellAsset, buyAsset, sellAmount, dry: true, slippageBps: nearSlippageBps(1) }, AbortSignal.timeout(8_000)),
        Date.now() + 45_000
      )
    )
    last = { at: Date.now(), result }
    result.catch(() => (last = undefined))
  }
  const result = await last.result.catch(() => undefined)
  // A list that could not be built hides nothing, and is not kept by the CDN.
  if (!result) return NextResponse.json({ forward: [], reverse: [] }, { headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json(result, { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' } })
}

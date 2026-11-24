import type { QuoteResponseRoute } from '@tcswap/helpers/api'
import { USwapNumber } from '@tcswap/core'
import { isBridgeRoute } from '@/lib/api'
import { withLock } from '@/lib/bridge-first-leg'
import { isUserRejection } from '@/lib/errors'
import { sourceTransactionId } from '@/lib/source-transaction'
import { checkOrder } from '@/lib/auto-bridge-order'
import { pageCanSettle, pageKeySpent, pageMayReturn, returnFromPage, settleFromPage } from '@/lib/page-settle'
import { autoBridgeStore, type SavedAutoOrder } from '@/store/auto-bridge-store'
import { isTerminal, type PublicOrder } from '@/lib/auto-bridge-contract'

export class OrderRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
// The worker gave no usable answer: unreachable, too slow, a 5xx or a platform error page. The screens
// show this as "Cashbridge Router is unavailable" with Try again, whatever the server happened to say.
export class RouterUnavailableError extends Error {
  constructor() { super('Cashbridge Router is unavailable') }
}
// Creating an order is one quote and one database write; a worker that needs longer is not healthy.
// The Vercel proxy gives up first (12 s), so a stuck worker ends here with a JSON answer, not a spinner.
const REQUEST_TIMEOUT_MS = 15000
const attemptKey = (id: string) => `cashbridge-auto-source-${id}`
const attemptRecorded = (reference: SavedAutoOrder) => reference.sourceAttempted ||
  (typeof window !== 'undefined' && localStorage.getItem(attemptKey(reference.id)) === 'attempted')
export const assertAutomaticSaved = (reference: SavedAutoOrder, attempted = false) => {
  if (typeof window === 'undefined') return
  try {
    const saved = JSON.parse(localStorage.getItem(`cashbridge-auto-order-${reference.id}`) ?? 'null') as SavedAutoOrder | null
    if (saved?.capability === reference.capability && (!attempted || localStorage.getItem(attemptKey(reference.id)) === 'attempted')) return
  } catch { /* A payment must not start without a durable local reference. */ }
  throw new Error('Allow browser storage before starting an automatic transfer')
}
export async function orderRequest(reference: SavedAutoOrder, method: 'GET' | 'POST', body?: unknown): Promise<PublicOrder> {
  const path = method === 'POST' && body && typeof body === 'object' && 'id' in body ? '' : `/${reference.id}`
  let response: Response
  try {
    response = await fetch(`/api/auto-bridge/orders${path}`, {
      method,
      headers: { Authorization: `Bearer ${reference.capability}`, ...(method === 'POST' && { 'Content-Type': 'application/json' }) },
      ...(method === 'POST' && { body: JSON.stringify(body) }), cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch { throw new RouterUnavailableError() }
  const result = await response.json().catch(() => undefined)
  if (response.status >= 500) throw new RouterUnavailableError()
  if (!response.ok) throw new OrderRequestError(response.status, typeof result?.error === 'string' ? result.error : 'Automatic bridge request failed')
  return checkOrder(result as PublicOrder | undefined, reference.id, reference.intent)
}

const creating = new Set<string>()
// The poller restores every saved order that has no server record yet, so while the create is in
// flight it leaves that order alone; otherwise both would POST it (same id, so harmless, but twice).
export async function createAutomaticOrder(reference: SavedAutoOrder): Promise<PublicOrder> {
  creating.add(reference.id)
  try { return await orderRequest(reference, 'POST', { id: reference.id, ...reference.intent }) }
  finally { creating.delete(reference.id) }
}

export async function restoreAutomaticOrder(reference: SavedAutoOrder): Promise<PublicOrder> {
  let order: PublicOrder
  try { order = await orderRequest(reference, 'GET') }
  catch (error) {
    if (!(error instanceof OrderRequestError) || error.status !== 404 || !reference.intent || attemptRecorded(reference)) throw error
    order = await orderRequest(reference, 'POST', { id: reference.id, ...reference.intent })
  }
  autoBridgeStore.getState().patch(reference.id, { order })
  return order
}

// One tab at a time settles an order from the page; a failure waits for the next poll, and the Router stays the fallback.
const settleOnce = (reference: SavedAutoOrder, order: PublicOrder) =>
  withLock(`cashbridge-page-settle-${reference.id}`, () => settleFromPage(order, reference.pageSecret!)).catch(error =>
    console.warn('The page could not settle the order yet; the Cashbridge Router will:', error instanceof Error ? error.message : error))
// BCH left at the contract goes back to the customer from the page too, so a stopped Router cannot strand it.
const returnOnce = (reference: SavedAutoOrder, order: PublicOrder) =>
  withLock(`cashbridge-page-settle-${reference.id}`, () => returnFromPage(order, reference.pageSecret)).catch(error =>
    console.warn('The page could not send the BCH back yet:', error instanceof Error ? error.message : error))

export type OrderPollSchedule = Map<string, { at: number; attempted: boolean; failed: boolean }>
// A finished order with nothing left at its contract, a day after its last change: nothing more can happen to it.
const SETTLED_KEEP_POLLING_MS = 24 * 60 * 60_000

export async function pollAutomaticOrders(nextPoll: OrderPollSchedule, stopped: () => boolean) {
  let failed = false
  for (const reference of autoBridgeStore.getState().orders) {
    if (stopped()) break
    if (creating.has(reference.id)) continue
    if (reference.order && pageKeySpent(reference.order) && Date.now() - reference.order.updatedAt > SETTLED_KEEP_POLLING_MS) continue
    const deferred = nextPoll.get(reference.id)
    if (deferred && deferred.at > Date.now() && deferred.attempted === !!reference.sourceAttempted) {
      failed ||= deferred.failed
      continue
    }
    let order = reference.order
    try {
      order = await restoreAutomaticOrder(reference)
      // A key that can sign nothing more is not kept in the browser ('' stays erased; see the order storage).
      if (reference.pageSecret && pageKeySpent(order)) autoBridgeStore.getState().patch(reference.id, { pageSecret: '' })
      const delay = isTerminal(order.state) ? 300000 : reference.sourceAttempted ? 5000 : 60000
      nextPoll.set(reference.id, { at: Date.now() + delay, attempted: !!reference.sourceAttempted, failed: false })
    } catch {
      failed = true
      // The page still settles from the order it last saw while the Router is unreachable.
      nextPoll.set(reference.id, { at: Date.now() + (pageCanSettle(order, reference.pageSecret) ? 5000 : 60000), attempted: !!reference.sourceAttempted, failed: true })
    }
    if (reference.sourceAttempted && pageCanSettle(order, reference.pageSecret)) await settleOnce(reference, order)
    if (reference.sourceAttempted && pageMayReturn(order, reference.pageSecret)) await returnOnce(reference, order)
  }
  return failed
}

export async function startAutomaticSource(
  reference: SavedAutoOrder,
  route: QuoteResponseRoute,
  sellAsset: string,
  execute: () => Promise<string>,
  hint: (hash: string) => Promise<unknown>,
  stillCurrent: () => boolean = () => true
) {
  if (typeof window !== 'undefined' && !navigator.locks) throw new Error('Please use an updated browser to start an automatic transfer safely')
  const hash = await withLock(`cashbridge-auto-source-${reference.id}`, async () => {
    if (typeof window !== 'undefined') await autoBridgeStore.persist?.rehydrate()
    const saved = autoBridgeStore.getState().orders.find(order => order.id === reference.id)
    const order = saved?.order
    if (!saved || attemptRecorded(saved) || !order || !isBridgeRoute(route, { sellAsset, destinationAddress: order.depositAddress }))
      throw new Error('Prepare a new executable quote for this order')
    if ((order.state && order.state !== 'awaiting_deposit') || order.sourceHash || order.inboundHash || BigInt(order.receivedSats ?? '0') > 0n || order.payoutTxid)
      throw new Error('This order already has a payment; check its status instead of sending again')
    const source = saved.intent?.source
    if (source && (source.asset !== sellAsset || !new USwapNumber(route.sellAmount).eqValue(source.amount)))
      throw new Error('The prepared transfer has changed')
    if (!stillCurrent()) throw new Error('The prepared transfer has changed')
    // A separate per-order marker cannot be erased by an older tab persisting its history.
    if (typeof window !== 'undefined') localStorage.setItem(attemptKey(reference.id), 'attempted')
    autoBridgeStore.getState().patch(reference.id, { sourceAttempted: true })
    assertAutomaticSaved(reference, true)
    try {
      const result = await execute()
      const id = sourceTransactionId(result)
      if (!id) throw new Error('The wallet response is unclear; do not send again while the transfer is checked')
      autoBridgeStore.getState().patch(reference.id, { sourceHash: id })
      await hint(id).catch(() => undefined)
      return id
    } catch (error) {
      if (isUserRejection(error)) {
        if (typeof window !== 'undefined') localStorage.removeItem(attemptKey(reference.id))
        autoBridgeStore.getState().patch(reference.id, { sourceAttempted: false })
      }
      throw error
    }
  })
  if (!hash) throw new Error('This transfer is being confirmed in another window')
  return hash
}

// Paying from an exchange: no wallet is opened, so showing the deposit address is the attempt. From here on the order is
// kept and watched like one the wallet sent, and is never created again under a fresh quote.
export async function startExchangeDeposit(reference: SavedAutoOrder) {
  if (typeof window !== 'undefined' && !navigator.locks) throw new Error('Please use an updated browser to start an automatic transfer safely')
  const started = await withLock(`cashbridge-auto-source-${reference.id}`, async () => {
    const order = autoBridgeStore.getState().orders.find(item => item.id === reference.id)?.order
    if (!order?.nearDepositAddress || order.state !== 'awaiting_deposit') throw new Error('Prepare a new deposit address for this order')
    if (typeof window !== 'undefined') localStorage.setItem(attemptKey(reference.id), 'attempted')
    autoBridgeStore.getState().patch(reference.id, { sourceAttempted: true })
    assertAutomaticSaved(reference, true)
    return true
  })
  if (!started) throw new Error('This transfer is being confirmed in another window')
}

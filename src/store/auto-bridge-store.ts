import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import type { OrderIntent, PublicOrder } from '@/lib/auto-bridge-contract'
import type { CauldronToken } from '@/lib/cauldron-tokens'

export interface SavedAutoOrder {
  id: string
  capability: string
  createdAt?: number
  intent?: OrderIntent
  // The token being bought, for display; the order itself has only its category.
  token?: CauldronToken
  sourceAttempted?: boolean
  sourceHash?: string
  order?: PublicOrder
  estimatedSeconds?: number
  // The secret of the one-use key the order's contract accepts from this page (src/lib/page-settle.ts); '' once the
  // order no longer needs it.
  pageSecret?: string
  // Paid from an exchange to the NEAR Intents deposit address (src/lib/exchange-deposit.ts): the quoted deposit in the
  // source asset's base units, the least 1Click swaps, and when its window closes (ms).
  exchange?: { decimals: number; amountIn: string; minAmountIn: string; deadline: number }
}
interface AutoBridgeStore {
  orders: SavedAutoOrder[]
  save: (reference: SavedAutoOrder) => void
  patch: (id: string, patch: Partial<Omit<SavedAutoOrder, 'id' | 'capability' | 'intent'>>) => void
  // Forgets an order the user never sent anything to.
  remove: (id: string) => void
}
const ORDER_PREFIX = 'cashbridge-auto-order-'
const SOURCE_PREFIX = 'cashbridge-auto-source-'
// Long enough for another tab's open Confirm; any older draft is left over from a closed page.
const DRAFT_TTL_MS = 30 * 60_000
// The source wallet was never opened for it (a declined request clears the mark) and no chain has paid it.
export const isAutomaticDraft = (ref: SavedAutoOrder) =>
  !ref.sourceAttempted && !ref.sourceHash && !ref.order?.sourceHash && !ref.order?.inboundHash && BigInt(ref.order?.receivedSats || '0') === 0n
// An exchange deposit address still inside its window and not paid yet: listed under the form so its QR code can be
// opened again. One nobody paid drops off the list when the window closes.
export const exchangeOpen = (ref: SavedAutoOrder, now = Date.now()) =>
  !!ref.exchange && now < ref.exchange.deadline && (!ref.order || ref.order.state === 'awaiting_deposit' || ref.order.state === 'streaming')
// An exchange deposit address nobody paid, a day after its window closed: a payment would have shown by now on any visit.
const EXCHANGE_KEEP_MS = 24 * 60 * 60_000
export const exchangeLapsed = (ref: SavedAutoOrder, now = Date.now()) =>
  !!ref.exchange && now > ref.exchange.deadline + EXCHANGE_KEEP_MS && (!ref.order || ref.order.state === 'awaiting_deposit') &&
  !ref.sourceHash && !ref.order?.sourceHash && BigInt(ref.order?.receivedSats || '0') === 0n
const forgetOrder = (id: string) => {
  localStorage.removeItem(ORDER_PREFIX + id)
  localStorage.removeItem(SOURCE_PREFIX + id)
}
// Per-order records keep a stale tab's history write from deleting another tab's order.
// Read the original B array as well, so existing browser references migrate without a reset.
const orderStorage = (): StateStorage => {
  const previous = new Map<string, string>()
  const prefix = ORDER_PREFIX
  return {
    getItem(name) {
      const legacy = JSON.parse(localStorage.getItem(name) ?? '{}')
      const orders = new Map<string, SavedAutoOrder>((legacy.state?.orders ?? []).map((ref: SavedAutoOrder) => [ref.id, ref]))
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(prefix)) {
          const ref = JSON.parse(localStorage.getItem(key)!) as SavedAutoOrder
          orders.set(ref.id, ref)
        }
      }
      for (const ref of orders.values()) {
        if (localStorage.getItem(SOURCE_PREFIX + ref.id) === 'attempted') ref.sourceAttempted = true
        // Automatic transfers keep no drafts: one the user never sent is dropped.
        if ((isAutomaticDraft(ref) && ref.createdAt !== undefined && Date.now() - ref.createdAt > DRAFT_TTL_MS) || exchangeLapsed(ref)) {
          forgetOrder(ref.id)
          orders.delete(ref.id)
          continue
        }
        previous.set(ref.id, JSON.stringify(ref))
        if (!localStorage.getItem(prefix + ref.id)) localStorage.setItem(prefix + ref.id, JSON.stringify(ref))
      }
      return JSON.stringify({ state: { orders: [...orders.values()] }, version: 0 })
    },
    setItem(_name, value) {
      const refs = JSON.parse(value).state.orders as SavedAutoOrder[]
      for (const ref of refs) {
        const serialized = JSON.stringify(ref)
        if (previous.get(ref.id) === serialized) continue
        const old = JSON.parse(localStorage.getItem(prefix + ref.id) ?? 'null') as SavedAutoOrder | null
        // An erased page key stays erased, whatever an older tab still holds in memory.
        const merged = old ? { ...old, ...ref, intent: old.intent ?? ref.intent,
          order: old.order && (!ref.order || old.order.updatedAt > ref.order.updatedAt) ? old.order : ref.order,
          ...(old.pageSecret === '' && { pageSecret: '' }) } : ref
        localStorage.setItem(prefix + ref.id, JSON.stringify(merged))
        previous.set(ref.id, serialized)
      }
    },
    removeItem(name) { localStorage.removeItem(name) }
  }
}
export const autoBridgeStore = create<AutoBridgeStore>()(
  persist(
    set => ({
      orders: [],
      save: reference => set(state => ({ orders: state.orders.some(order => order.id === reference.id) ? state.orders : [...state.orders, reference] })),
      patch: (id, patch) => set(state => ({ orders: state.orders.map(order => order.id === id ? { ...order, ...patch } : order) })),
      remove: id => {
        if (typeof localStorage !== 'undefined') forgetOrder(id)
        set(state => ({ orders: state.orders.filter(order => order.id !== id) }))
      }
    }),
    { name: 'cashbridge-auto-orders', storage: createJSONStorage(orderStorage), partialize: state => ({ orders: state.orders }) }
  )
)

interface AutomaticPreference {
  mode: 'manual' | 'automatic'
  recipient: string
  // The last refund address typed per source chain for an exchange deposit.
  refunds: Record<string, string>
  setMode: (mode: 'manual' | 'automatic') => void
  setRecipient: (recipient: string) => void
  setRefund: (chain: string, address: string) => void
}
// Every transfer the order contract can take goes through it; Manual is the user's own pick, kept from version 1 on.
export const automaticPreference = create<AutomaticPreference>()(persist(
  set => ({
    mode: 'automatic',
    recipient: '',
    refunds: {},
    setMode: mode => set({ mode }),
    setRecipient: recipient => set({ recipient }),
    setRefund: (chain, address) => set(state => ({ refunds: { ...state.refunds, [chain]: address } }))
  }),
  {
    name: 'cashbridge-execution',
    version: 1,
    partialize: state => ({ mode: state.mode, recipient: state.recipient, refunds: state.refunds }),
    migrate: saved => ({ recipient: (saved as { recipient?: string } | undefined)?.recipient ?? '', mode: 'automatic' as const, refunds: {} })
  }
))

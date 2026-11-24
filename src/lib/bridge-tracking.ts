import type { ReceiptCheck } from '@/lib/bch'
import { BridgeConfig } from '@/config'
import type { BridgeOperation } from '@/store/transaction-store'

// Progress from the chains themselves: the source transaction's receipt on its own chain and the
// BCH arriving at the bound address (Fulcrum). THORChain's status endpoints only fill gaps (refunds,
// timing) and never hold a stage back.

export interface SourceReceipt {
  // Blocks since the source transaction was mined (0 while it is not yet in a block).
  confirmations: number
  // The transaction was mined but reverted: nothing reached THORChain.
  failed: boolean
}

// The first-leg update the chain observations call for, or undefined when nothing changed.
export const firstLegFromChain = (
  op: Pick<BridgeOperation, 'destinationAsset' | 'firstLeg'>,
  { source, outbound }: { source?: SourceReceipt; outbound?: ReceiptCheck }
): Partial<BridgeOperation> | undefined => {
  const firstLeg = source ? { ...op.firstLeg, sourceConfirmations: source.confirmations } : op.firstLeg
  if (source?.failed) return { stage: 'failed', firstLeg, error: 'The source transaction failed on its chain; nothing was sent to THORChain' }

  if (outbound?.kind === 'ok') {
    const native = op.destinationAsset === 'BCH'
    const outputs = outbound.outputs
    const confirmed = outputs.every(o => o.confirmations >= BridgeConfig.minConfirmations)
    const spendable = native || outputs.every(o => o.unspent)
    return {
      stage: confirmed && spendable ? (native ? 'kept_bch' : 'bch_ready') : 'bch_unconfirmed',
      received: outputs,
      firstLeg: { ...firstLeg, result: 'swapped', receivedAt: op.firstLeg.receivedAt ?? Date.now() },
      // An output already gone stays unconfirmed here; the received-BCH check decides whether it was spent.
      error: undefined
    }
  }

  return source && source.confirmations !== op.firstLeg.sourceConfirmations ? { firstLeg } : undefined
}

// The live time line of a step: time left against its estimate, then time elapsed once past it.
export const stepTime = (nowMs: number, startMs: number, estimateSeconds?: number) => {
  const elapsed = Math.max(0, Math.floor((nowMs - startMs) / 1000))
  if (estimateSeconds && estimateSeconds > elapsed) return { kind: 'remaining' as const, seconds: estimateSeconds - elapsed, elapsed }
  return { kind: 'elapsed' as const, seconds: elapsed, elapsed }
}

// "≈ 3 min", "≈ 40 s", or "1:05" elapsed.
export const formatStepTime = (time: ReturnType<typeof stepTime>) => {
  if (time.kind === 'remaining') return time.seconds >= 90 ? { key: 'minutes' as const, value: Math.ceil(time.seconds / 60) } : { key: 'seconds' as const, value: time.seconds }
  const m = Math.floor(time.seconds / 60)
  const s = String(time.seconds % 60).padStart(2, '0')
  return { key: 'elapsed' as const, value: `${m}:${s}` }
}

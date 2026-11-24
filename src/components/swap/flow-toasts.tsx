'use client'

import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { toast as sonner } from 'sonner'
import { Chain } from '@tcswap/core'
import { explorerTxUrl } from '@/lib/explorer'
import { shortBridgeAddress } from '@/components/swap/bridge-wallet-badge'
import { TxToastCard } from '@/components/tx-toast'
import { toast } from '@/lib/toast'

// How long a dismissed toast plays its exit before it leaves the list.
const LEAVE_MS = 220
// Phone width: the toasts sit in the page under the actions (see `.bridge-flow-toasts`) instead of over them.
const COMPACT = '(max-width: 520px)'

export interface FlowToast {
  id: string
  title: string
  // Explorer hash when this toast is a chain transaction; omitted for in-app status toasts.
  hash?: string
  chain?: Chain
  time?: string
  // The token the ring turns around.
  icon?: ReactNode
  // Still waiting for the chain: the ring turns until the transaction is through.
  pending?: boolean
  // Status line under the title when there is no hash yet.
  description?: ReactNode
  actionLabel?: string
  onAction?: () => void
}

const useCompact = () =>
  useSyncExternalStore(
    notify => {
      const query = window.matchMedia(COMPACT)
      query.addEventListener('change', notify)
      return () => query.removeEventListener('change', notify)
    },
    () => window.matchMedia(COMPACT).matches,
    () => false
  )

// The transactions of a running bridge as toasts. Wide screens put them in the site's toast stack; a phone lists them.
// `persist`: keep sonner toasts when this owner unmounts (another owner on the bridge tab keeps updating them).
export const FlowToasts = ({ toasts, onDismiss, persist }: { toasts: FlowToast[]; onDismiss: (id: string) => void; persist?: boolean }) =>
  useCompact() ? <FlowToastList toasts={toasts} onDismiss={onDismiss} /> : <FlowToastStack toasts={toasts} onDismiss={onDismiss} persist={persist} />

const FlowToastStack = ({ toasts, onDismiss, persist }: { toasts: FlowToast[]; onDismiss: (id: string) => void; persist?: boolean }) => {
  const t = useTranslations('bridge.progress')
  const shown = useRef(new Set<string>())
  const latest = useRef({ toasts, onDismiss, t })
  latest.current = { toasts, onDismiss, t }
  // The cards only change with these fields, and the owner builds a new array on every render.
  const signature = toasts
    .map(item => [item.id, item.pending ? 'pending' : 'done', item.title, item.hash ?? '', String(item.description ?? '')].join('|'))
    .join('\n')

  useEffect(() => {
    const { toasts: items, t: translate } = latest.current
    const next = new Set(items.map(item => item.id))
    const gone = [...shown.current].filter(id => !next.has(id))
    shown.current = next
    gone.forEach(id => sonner.dismiss(id))
    for (const item of items) {
      const explorer = item.hash && item.chain ? explorerTxUrl({ chain: item.chain, txHash: item.hash }) : undefined
      const options = {
        id: item.id,
        icon: item.icon,
        description:
          item.description ??
          (item.hash ? (
            <>
              {translate(item.pending ? 'toastPending' : 'toastDone')} · <span title={item.hash}>{shortBridgeAddress(item.hash)}</span>
            </>
          ) : undefined),
        actionLabel: item.actionLabel ?? (explorer ? translate('viewExplorer') : undefined),
        actionHref: explorer,
        onAction: item.onAction,
        dismissLabel: translate('dismiss'),
        duration: Infinity,
        // Only a person's close reaches the owner; the dismissals above came from the owner already.
        onDismiss: () => {
          if (shown.current.delete(item.id)) latest.current.onDismiss(item.id)
        }
      }
      if (item.pending) toast.loading(item.title, options)
      else toast.success(item.title, options)
    }
  }, [signature])

  // Leaving the screen takes its toasts along unless `persist` (a sibling on the bridge tab still owns them).
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (persist) return
      window.setTimeout(() => {
        if (mounted.current) return
        const owned = [...shown.current]
        shown.current.clear()
        owned.forEach(id => sonner.dismiss(id))
      })
    }
  }, [persist])

  return null
}

const FlowToastList = ({ toasts, onDismiss }: { toasts: FlowToast[]; onDismiss: (id: string) => void }) => {
  const t = useTranslations('bridge.progress')
  const [leaving, setLeaving] = useState<string[]>([])
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach(timer => window.clearTimeout(timer)), [])

  if (toasts.length === 0) return null
  return (
    <ol className="bridge-flow-toasts" aria-label={t('transactions')}>
      {toasts.map(item => {
        const explorer = item.hash && item.chain ? explorerTxUrl({ chain: item.chain, txHash: item.hash }) : undefined
        return (
          <li key={item.id}>
            <TxToastCard
              status={item.pending ? 'loading' : 'success'}
              title={item.title}
              description={
                item.description ??
                (item.hash ? (
                  <>
                    {t(item.pending ? 'toastPending' : 'toastDone')} · <span title={item.hash}>{shortBridgeAddress(item.hash)}</span>
                  </>
                ) : undefined)
              }
              icon={item.icon}
              actionLabel={item.actionLabel ?? (explorer ? t('viewExplorer') : undefined)}
              actionHref={explorer}
              onAction={item.onAction}
              dismissLabel={t('dismiss')}
              leaving={leaving.includes(item.id)}
              onDismiss={() => {
                setLeaving(list => [...list, item.id])
                timers.current.push(window.setTimeout(() => onDismiss(item.id), LEAVE_MS))
              }}
            />
          </li>
        )
      })}
    </ol>
  )
}

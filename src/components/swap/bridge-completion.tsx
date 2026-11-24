'use client'

import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { explorerTxUrl } from '@/lib/explorer'
import { Check, ExternalLink, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { chainLabel } from '@/components/connect-wallet/config'
import { GenericButton } from '@/components/generic-button'
import { AppConfig } from '@/config'
import type { CompletionTransaction } from '@/lib/bridge-completion'
import { cauldronLiquidityUrl, getCauldronApy } from '@/lib/cauldron-liquidity'

export interface BridgeCompletionProps {
  received: { amount: string; ticker: string; icon: ReactNode }
  transactions: CompletionTransaction[]
  liquidityCategory?: string
  onClose: () => void
  notice?: ReactNode
  additionalReceived?: { amount: string; ticker: string; icon?: ReactNode }[]
}

const CauldronEarn = ({ category }: { category: string }) => {
  const t = useTranslations('bridge.completion')
  const { data: apy, isPending } = useQuery({
    queryKey: ['cauldron-apy', category],
    queryFn: () => getCauldronApy(category),
    staleTime: 5 * 60_000,
    retry: false
  })
  return (
    <a className="bridge-complete-earn" href={cauldronLiquidityUrl(category)} target="_blank" rel="noopener noreferrer" title={t('apySource')}>
      {/* The APY reads as pending while it loads; only a failed or empty answer falls back. */}
      {typeof apy === 'number'
        ? t('earn', { apy: apy.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })
        : isPending
          ? t('earn', { apy: '…' })
          : t('provideLiquidity')}
      <ExternalLink size={15} aria-hidden="true" />
    </a>
  )
}

export const BridgeCompletion = ({ received, transactions, liquidityCategory, onClose, notice, additionalReceived }: BridgeCompletionProps) => {
  const t = useTranslations('bridge.completion')
  const tProgress = useTranslations('bridge.progress')
  const amount = `${received.amount} ${received.ticker}`
  return (
    <div className="bridge-flow">
      <div className="bridge-flow-main bridge-complete-main">
        <div className="bridge-complete-brand">{AppConfig.appName}</div>
        <div className="bridge-flow-card bridge-complete-card">
          <button className="bridge-complete-close" type="button" onClick={onClose} aria-label={tProgress('close')}>
            <X size={20} aria-hidden="true" />
          </button>
          <section className="bridge-complete-received" aria-label={t('received')}>
            <div className="bridge-complete-label">{t('received')}</div>
            <div className="bridge-complete-amount">
              <span className="bridge-complete-icon">{received.icon}</span>
              <strong title={amount}>{amount}</strong>
            </div>
            {additionalReceived?.map(value => (
              <p className="bridge-complete-extra" key={value.ticker}>
                {value.icon}+ {value.amount} {value.ticker}
              </p>
            ))}
            {notice && <div className="bridge-flow-message" role="status">{notice}</div>}
            {liquidityCategory && <CauldronEarn category={liquidityCategory} />}
          </section>
          <section className="bridge-complete-history" aria-label={t('history')}>
            <h2>{t('history')}</h2>
            {transactions.length ? (
              <ol>
                {transactions.map(tx => (
                  <li key={tx.key}>
                    <a href={explorerTxUrl({ chain: tx.chain, txHash: tx.hash })} target="_blank" rel="noopener noreferrer" title={tx.hash}>
                      <span className="bridge-complete-check"><Check size={16} strokeWidth={2.5} aria-hidden="true" /></span>
                      <span className="bridge-complete-step">{t(tx.kind, { chain: chainLabel(tx.chain) })}</span>
                      <ExternalLink size={18} aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ol>
            ) : <p>{t('historyUnavailable')}</p>}
          </section>
          <GenericButton className="bridge-flow-primary is-active w-full" onClick={onClose}>
            {tProgress('newTransfer')}
          </GenericButton>
        </div>
      </div>
    </div>
  )
}

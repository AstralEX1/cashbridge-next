'use client'

import { useState } from 'react'
import { Chain } from '@tcswap/core'
import { BchMark, TokenMark } from '@/components/swap/bridge-marks'
import { PUSD_TOKEN } from '@/lib/cauldron-tokens'
import type { FlowToast } from '@/components/swap/flow-toasts'
import { BridgeFlow, CauldronQuoteBlock, type FlowStage } from '@/components/swap/pusd-swap'
import { ExchangeDepositCard } from '@/components/swap/exchange-deposit-card'
import type { PublicOrder } from '@/lib/auto-bridge-contract'

// `exchange`: an order paid from an exchange, waiting for the withdrawal (a masked example deposit address).
const EXCHANGE_ORDER = {
  id: 'preview',
  state: 'awaiting_deposit',
  receivedSats: '0',
  nearDepositAddress: '0x0000000000000000000000000000000000c0ffee',
  source: { chain: 'BASE', asset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', amount: '5', address: '0x76ff6F88f58e083b88A80B1764ae7002e303D1A6' }
} as unknown as PublicOrder

// Development only (`?bridgeFlowPreview=<stage>` on the swap page): the progress screen's stages
// from fixed example figures, to look at them without an operation in flight. The real screen reads
// the operation's own figures.
const ETH_ICON = (
  <span className="bridge-flow-icon">
    <img src="/networks/eth.svg" width={30} height={30} alt="" />
  </span>
)

const PREVIEW_TX = 'https://thorchain.net/'

export const BridgeFlowPreview = ({ stage = 'bridging' }: { stage?: string }) => {
  const [dismissed, setDismissed] = useState<string[]>([])
  // `reverse-<stage>` previews the reverse direction (PUSD -> BCH -> ETH, or BCH -> ETH for `plain`).
  const [now] = useState(() => Date.now())
  const exchange = stage === 'exchange'
  const reverse = stage.startsWith('reverse-')
  const name = reverse ? stage.slice('reverse-'.length) : stage
  const nativeBch = name === 'done-bch'
  const flow = nativeBch ? 'done' : (['bridging', 'ready', 'plain', 'swapping', 'done', 'ended'] as FlowStage[]).includes(name as FlowStage) ? (name as FlowStage) : 'bridging'
  const pusd = !nativeBch && flow !== 'plain'
  const received = flow !== 'bridging' && flow !== 'plain'
  const toasts: FlowToast[] = [
    ...(pusd && (flow === 'swapping' || flow === 'done')
      ? [{ id: 'swap', title: flow === 'done' ? 'PUSD received · in mempool' : 'PUSD swap sent', hash: 'e3a1c9d7b5f2a8e6c4d2b0f8e6a4c2d0b8f6e4d2c0a8b6f4e2d0c8a6b4f2e0d8', chain: Chain.BitcoinCash, icon: <TokenMark token={PUSD_TOKEN} size={30} />, pending: flow === 'swapping' }]
      : []),
    ...(received ? [{ id: 'receive', title: 'BCH received', hash: 'b7d0e2c4f1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f541c8', chain: Chain.BitcoinCash, icon: <BchMark size={30} /> }] : []),
    { id: 'send', title: received ? 'Send Tx confirmed' : 'Send Tx submitted', hash: '0x5e1c7d2b9a8f6e4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a2918070a9f2', chain: Chain.Base, time: '19:11', icon: ETH_ICON, pending: !received }
  ].filter(t => !exchange && !dismissed.includes(t.id))

  return (
    <div className="bridge-flow-layer" role="dialog" aria-label="Bridge progress preview">
      <BridgeFlow
        stage={flow}
        title="Preview"
        sourceChain={Chain.Base}
        sourceAddress={exchange ? undefined : "0x76ff6F88f58e083b88A80B1764ae7002e303D1A6"}
        bchAddress="bitcoincash:qp4qeeh8m6zd8r2yq7h0j3k5x9w2v4u6t8s0rm8w9z"
        reverse={reverse}
        sent={
          reverse
            ? pusd
              ? { amount: '2.04', ticker: 'PUSD', usd: '$2.03', icon: <TokenMark token={PUSD_TOKEN} size={30} /> }
              : { amount: '0.0073', ticker: 'BCH', usd: '$2.05', icon: <BchMark size={30} /> }
            : exchange
              ? { amount: '5', ticker: 'USDC', usd: '$5.00', icon: <span className="bridge-flow-icon"><img src="/networks/base.svg" width={30} height={30} alt="" /></span> }
              : { amount: '0.000546306', ticker: 'ETH', usd: '$1.29', icon: ETH_ICON }
        }
        bch={
          reverse && !pusd
            ? { amount: '≈ 0.00088', ticker: 'ETH', usd: '$2.02', icon: ETH_ICON }
            : { amount: received ? '0.0072956' : '≈ 0.0073', ticker: 'BCH', usd: '$2.05', icon: <BchMark size={30} /> }
        }
        final={
          pusd
            ? reverse
              ? { amount: '≈ 0.00088', ticker: 'ETH', usd: '$2.02', icon: ETH_ICON }
              : { amount: '≈ 2.04', ticker: 'PUSD', usd: '$2.03', icon: <TokenMark token={PUSD_TOKEN} size={30} /> }
            : undefined
        }
        firstBar={received ? { fill: 1, done: true, href: PREVIEW_TX } : exchange ? { fill: 0 } : { fill: 0.6, eta: '≈ 2 min', live: true, href: PREVIEW_TX }}
        secondBar={pusd ? (flow === 'swapping' ? { fill: 0.6, live: true, eta: '≈ 40 s' } : flow === 'done' ? { fill: 1, done: true } : { fill: 0, eta: '≈ 1 min' }) : undefined}
        completion={flow === 'done' ? {
          received: reverse
            ? { amount: '0.00088', ticker: 'ETH', icon: <img src="/networks/eth.svg" width={48} height={48} alt="" /> }
            : nativeBch
              ? { amount: '0.0072956', ticker: 'BCH', icon: <BchMark size={48} /> }
              : { amount: '1.01', ticker: 'PUSD', icon: <TokenMark token={PUSD_TOKEN} size={48} /> },
          transactions: reverse ? [
            { key: 'sale', kind: 'swapOnCauldron', chain: Chain.BitcoinCash, hash: '1'.repeat(64) },
            { key: 'deposit', kind: 'bridgeFrom', chain: Chain.BitcoinCash, hash: '2'.repeat(64) },
            { key: 'payout', kind: 'receiveOn', chain: Chain.Base, hash: `0x${'3'.repeat(64)}` }
          ] : [
            { key: 'send', kind: 'bridgeFrom', chain: Chain.Base, hash: `0x${'1'.repeat(64)}` },
            { key: 'receive', kind: 'receiveOn', chain: Chain.BitcoinCash, hash: '2'.repeat(64) },
            ...(!nativeBch ? [{ key: 'swap', kind: 'swapOnCauldron' as const, chain: Chain.BitcoinCash, hash: '3'.repeat(64) }] : [])
          ],
          liquidityCategory: reverse ? undefined : PUSD_TOKEN.category
        } : undefined}
        details={
          exchange ? (
            <ExchangeDepositCard
              reference={{ id: 'preview', capability: '', exchange: { decimals: 6, amountIn: '5000000', minAmountIn: '4950000', deadline: now + 2 * 60 * 60_000 } }}
              order={EXCHANGE_ORDER}
              now={now}
            />
          ) : flow === 'ready' ? (
            <CauldronQuoteBlock
              quote={{
                ticker: 'PUSD',
                bchPerToken: 0.0035565,
                tokenUsd: 0.997,
                lpFeePercent: 0.3,
                lpFeeUsd: 0.006,
                networkFeeBch: 0.0000031,
                networkFeeUsd: 0.0009,
                priceImpactPercent: 0.44,
                minimum: '2.02 PUSD'
              }}
            />
          ) : undefined
        }
        actions={
          flow === 'ready' ? (
            <>
              <button type="button" className="bridge-flow-primary is-active">
                Swap BCH → PUSD (2/2)
              </button>
              <button type="button" className="bridge-flow-link">
                Keep BCH instead
              </button>
            </>
          ) : flow === 'bridging' || flow === 'plain' ? (
            <button type="button" className="bridge-flow-primary" disabled>
              <svg className="bridge-flow-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="#3a4f59" />
                <path d="M12 3a9 9 0 019 9" stroke="#0ac18e" />
              </svg>
              {exchange ? 'Waiting for your deposit' : flow === 'plain' ? `Bridging to ${reverse ? 'ETH' : 'BCH'}…` : 'Swap BCH → PUSD (2/2)'}
            </button>
          ) : undefined
        }
        toasts={toasts}
        onDismissToast={id => setDismissed(list => [...list, id])}
        onClose={() => {}}
        onBridgeAnother={flow === 'plain' ? () => {} : undefined}
      />
    </div>
  )
}

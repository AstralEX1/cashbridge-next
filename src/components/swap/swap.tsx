'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { ArrowDownUp } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { AssetValue } from '@tcswap/core'
import { BridgeConfig } from '@/config'
import { Asset } from '@/components/swap/asset'
import { SwapButton } from '@/components/swap/swap-button'
import { ReverseSwapButton } from '@/components/swap/reverse-bridge'
import { BchInputFrom, ReverseInputTo } from '@/components/swap/reverse-inputs'
import { BchSwapButton, BchSwapInputTo } from '@/components/swap/bch-swap'
import { BackgroundBridges, BchWalletStatus, BridgeOperationPanel } from '@/components/swap/pusd-swap'
import { SwapHaltBanner } from '@/components/swap/swap-halt-banner'
import { SwapInputFrom } from '@/components/swap/swap-input-from'
import { SwapInputTo } from '@/components/swap/swap-input-to'
import { SwapSettings } from '@/components/swap/swap-settings'
import { RefreshButton } from '@/components/swap/refresh-button'
import { RouterHint, RouterSelector } from '@/components/swap/automatic-bridge-controls'
import { RouteCompare } from '@/components/swap/route-compare'
import { AutomaticOrders } from '@/components/swap/auto-bridge-progress'
import { useAutomaticBridge } from '@/hooks/use-automatic-bridge'
import { isAssetInMode, useAssets } from '@/hooks/use-assets'
import { useResolveSource } from '@/hooks/use-resolve-source'
import { useSetAssetFrom, useSetAssetTo } from '@/hooks/use-swap'
import { useTradingHalt } from '@/hooks/use-trading-halt'
import { urlBuyAsset, useUrlParams } from '@/hooks/use-url-params'
import { useIsPrivateSend } from '@/store/limit-swap-store'
import { isNetworkAsset, isReverseTargetAsset, useSwapStore } from '@/store/swap-store'
import { getActiveBridge } from '@/store/transaction-store'
import { useActiveBridge } from '@/hooks/use-bridges'
import './bridge.css'

// Development-only preview of the progress screen (`?bridgeFlowPreview=<stage>`); the condition is
// constant at build time, so production bundles drop the import.
const BridgeFlowPreview =
  process.env.NODE_ENV !== 'production'
    ? dynamic(() => import('@/components/swap/bridge-flow-preview').then(m => m.BridgeFlowPreview), { ssr: false })
    : () => null

const DEFAULT_SELL = 'BTC.BTC'
const DEFAULT_BUY = BridgeConfig.buyAsset
// The first payout asset offered in the reverse direction, when the forward source cannot be paid out to.
const DEFAULT_REVERSE_TARGETS = ['BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', 'BASE.ETH', 'ETH.ETH']

export const Swap = () => {
  const tBridge = useTranslations('bridge.form')
  const tOnBch = useTranslations('bridge.onBch')
  const { automatic } = useAutomaticBridge()
  const [picker, setPicker] = useState<'from' | 'to'>()
  const activeBridge = useActiveBridge()
  const [progressId, setProgressId] = useState<string>()
  const progressReadyId = activeBridge && activeBridge.bridge.stage !== 'first_leg_signing' ? activeBridge.uid : undefined
  useEffect(() => {
    if (progressReadyId) setProgressId(progressReadyId)
  }, [progressReadyId])
  const setAssetFrom = useSetAssetFrom()
  const setAssetTo = useSetAssetTo()
  const isPrivateSend = useIsPrivateSend()
  const pairKey = useSwapStore(state => `${state.assetFrom?.identifier}|${state.assetTo?.identifier}`)
  const reverse = useSwapStore(state => state.reverse)
  const openNetworks = useSwapStore(state => state.openNetworks)
  // Back from BCH into a Bitcoin Cash asset: a Cauldron swap that never leaves Bitcoin Cash.
  const onBch = useSwapStore(state => !state.openNetworks && state.reverse && state.localTo !== undefined)
  const toggleDirection = useSwapStore(state => state.swapAssets)
  const assetFrom = useSwapStore(state => state.assetFrom)
  const { assets } = useAssets()
  const { isHalted, chains: haltedChains } = useTradingHalt()
  const searchParams = useSearchParams()
  const flowPreview = process.env.NODE_ENV !== 'production' ? searchParams.get('bridgeFlowPreview') : null

  const isPrivateTab = useUrlParams()
  useResolveSource()

  useEffect(() => {
    AssetValue.loadStaticAssets()
  }, [])

  // Each tab has its own asset list (the native protocols' or Houdini's). Switching tabs keeps a
  // selection both list and replaces one only the other does, so the form never quotes an asset
  // the current provider does not know. Leaving a private send restores the URL's buy asset.
  useEffect(() => {
    if (!assets?.length || openNetworks) return

    // Read the pair from the store, not the render closure: on a first visit useUrlParams sets
    // the pair from the URL in this same commit, and the closure still holds the empty pair.
    const { assetFrom, assetTo } = useSwapStore.getState()

    const inMode = (asset?: Asset) => !!asset && isAssetInMode(asset, isPrivateTab)
    // Defaults before "any asset", so a fallback clashing with `other` doesn't land on the list's first entry.
    const replacement = (fallback: string, other?: Asset) => {
      const usable = (a: Asset) => inMode(a) && a.identifier !== other?.identifier
      for (const id of [fallback, DEFAULT_BUY, DEFAULT_SELL]) {
        const match = assets.find(a => a.identifier === id && usable(a))
        if (match) return match
      }
      return assets.find(usable)
    }

    const nextFrom = inMode(assetFrom) ? assetFrom : replacement(DEFAULT_SELL, isPrivateSend ? undefined : assetTo)
    const keepTo = inMode(assetTo) && assetTo?.identifier !== nextFrom?.identifier
    const nextTo = isPrivateSend ? nextFrom : keepTo ? assetTo : replacement(urlBuyAsset(assets)?.identifier ?? DEFAULT_BUY, nextFrom)

    if (nextFrom && nextFrom !== assetFrom) setAssetFrom(nextFrom)
    if (nextTo && nextTo !== assetTo) setAssetTo(nextTo)
    // Also reruns on pair changes: a saved same-asset pair rehydrates after the first run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNetworks, isPrivateTab, isPrivateSend, assets, pairKey])

  // The reverse direction pays out only where the payout can be checked: any other source gives way.
  useEffect(() => {
    if (openNetworks || !reverse || !assets?.length || isReverseTargetAsset(assetFrom)) return
    const target = DEFAULT_REVERSE_TARGETS.map(id => assets.find(a => a.identifier.toUpperCase() === id && isReverseTargetAsset(a))).find(Boolean)
    if (target) setAssetFrom(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNetworks, reverse, assets, assetFrom])

  // Open-networks pairs need two distinct listed assets; seed a common destination when empty.
  useEffect(() => {
    if (!openNetworks || !assets?.length) return
    const { assetFrom: from, assetTo: to } = useSwapStore.getState()
    const listed = assets.filter(isNetworkAsset)
    const nextFrom = listed.find(a => a.identifier === from?.identifier) ?? listed.find(a => a.identifier === DEFAULT_SELL) ?? listed[0]
    const nextTo = listed.find(a => a.identifier === to?.identifier && a.identifier !== nextFrom?.identifier) ??
      listed.find(a => a.identifier === 'ETH.ETH' && a.identifier !== nextFrom?.identifier) ??
      listed.find(a => a.identifier !== nextFrom?.identifier)
    if (nextFrom !== from || nextTo !== to) useSwapStore.setState({ assetFrom: nextFrom, assetTo: nextTo })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNetworks, assets, pairKey])

  return (
    <div className="bridge-widget mx-auto w-full max-w-[514px]">
      <div className="bridge-heading">
        <h1>{onBch ? tOnBch('heading') : tBridge(openNetworks ? 'headingOpen' : reverse ? 'headingReverse' : 'heading')}</h1>
      </div>
      {/* One row: Manual/Router (not for a swap on Bitcoin Cash, which neither bridges), then refresh/settings. Any network lives in the BCH asset picker. */}
      <div className="bridge-tools mb-3 flex flex-nowrap items-center gap-2 overflow-x-auto">
        {!onBch && <RouterSelector />}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <RefreshButton />
          <SwapSettings />
        </div>
      </div>
      <RouterHint />

      {/* Forward: THORChain or NEAR Intents swap to native BCH, then a separately signed Cauldron swap to the token.
            Reverse: a Cauldron sale of the token for BCH, then a BCH deposit to THORChain or NEAR Intents. No limit,
            private or memoless entry points. Open networks: any listed pair, Manual only. */}
      <div className="bridge-card">
        {openNetworks || !reverse ? (
          <SwapInputFrom selecting={picker === 'from'} onSelectOpenChange={open => setPicker(open ? 'from' : undefined)} />
        ) : (
          <BchInputFrom selecting={picker === 'from'} onSelectOpenChange={open => setPicker(open ? 'from' : undefined)} />
        )}
        <div className="bridge-divider">
          <span aria-hidden="true" />
          <button
            type="button"
            className="bridge-direction"
            aria-label={tBridge('switchDirection')}
            title={tBridge('switchDirection')}
            disabled={!!picker}
            onClick={() => toggleDirection()}
          >
            <ArrowDownUp size={21} aria-hidden="true" />
          </button>
          <span aria-hidden="true" />
        </div>
        {openNetworks || !reverse ? (
          <SwapInputTo selecting={picker === 'to'} onSelectOpenChange={open => setPicker(open ? 'to' : undefined)} />
        ) : onBch ? (
          <BchSwapInputTo selecting={picker === 'to'} onSelectOpenChange={open => setPicker(open ? 'to' : undefined)} />
        ) : (
          <ReverseInputTo selecting={picker === 'to'} onSelectOpenChange={open => setPicker(open ? 'to' : undefined)} />
        )}
      </div>
      {!onBch && <RouteCompare />}
      {onBch ? (
        <BchSwapButton />
      ) : !openNetworks && reverse ? (
        <ReverseSwapButton onShowBridge={() => setProgressId(getActiveBridge()?.uid)} />
      ) : (
        <SwapButton instantSwapSupported={openNetworks} instantSwapAvailable={openNetworks} onShowBridge={() => setProgressId(getActiveBridge()?.uid)} />
      )}
      {!openNetworks && (!automatic || reverse) && <BchWalletStatus />}

      <BridgeOperationPanel uid={progressId} onClose={() => setProgressId(undefined)} />
      <BackgroundBridges onOpen={setProgressId} openUid={progressId} />
      <AutomaticOrders />
      {flowPreview && <BridgeFlowPreview stage={flowPreview} />}

      {isHalted && !isPrivateTab && (
        <div className="pt-2">
          <SwapHaltBanner chains={haltedChains} />
        </div>
      )}
    </div>
  )
}

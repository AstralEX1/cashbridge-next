'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { Asset } from '@/components/swap/asset'
import { BridgeConfig } from '@/config'
import { useAssets } from '@/hooks/use-assets'
import { readTokenSlug, searchCauldronTokens, tokenSlug } from '@/lib/cauldron-tokens'
import { FIRST_VISIT_AMOUNT, isNetworkAsset, isReverseTargetAsset, useSwapStore } from '@/store/swap-store'

const DEFAULT_SELL = 'BTC.BTC'
// The bridge buys native BCH whatever the URL names (see BridgeConfig).
const DEFAULT_BUY = BridgeConfig.buyAsset
const SELL = 'sell-'
const BUY = '-buy-'

const isNativeAsset = (asset: Asset) => asset.chain === asset.ticker && !asset.isSecuredAsset && !asset.isTradeAsset

// URL slug: bare ticker for gas assets, identifier without the contract-address suffix otherwise
const toSlug = (asset: Asset) => {
  if (isNativeAsset(asset)) return asset.ticker
  const { address, identifier } = asset
  if (!address) return identifier
  const suffix = `-${address.toLowerCase()}`
  return identifier.toLowerCase().endsWith(suffix) ? identifier.slice(0, identifier.length - suffix.length) : identifier
}

function parsePath(pathname: string): { sell: string | null; buy: string | null } {
  if (!pathname.startsWith(`/${SELL}`)) return { sell: null, buy: null }
  const rest = pathname.slice(1 + SELL.length)
  const idx = rest.indexOf(BUY)
  if (idx === -1) return { sell: null, buy: null }
  return {
    sell: decodeURIComponent(rest.slice(0, idx)),
    buy: decodeURIComponent(rest.slice(idx + BUY.length))
  }
}

function resolveAsset(assets: Asset[], token: string | null, fallback: string): Asset | undefined {
  if (token) {
    const lower = token.toLowerCase()
    const exact = assets.find(a => a.identifier.toLowerCase() === lower)
    if (exact) return exact
    const slugMatch = assets.find(a => toSlug(a).toLowerCase() === lower)
    if (slugMatch) return slugMatch
  }
  return assets.find(a => a.identifier === fallback)
}

const readPair = (pathname: string, params: Pick<URLSearchParams, 'get'>) =>
  pathname.startsWith('/widget') ? { sell: params.get('from'), buy: params.get('to') } : parsePath(pathname)

// The buy asset the address bar names.
export const urlBuyAsset = (assets: Asset[]) => resolveAsset(assets, DEFAULT_BUY, DEFAULT_BUY)

export const useUrlParams = () => {
  const initialized = useRef(false)
  const skipNextSync = useRef(true)
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const isWidget = pathname.startsWith('/widget')
  const { assets } = useAssets()
  const { assetFrom, assetTo, bchToken, reverse, openNetworks, hasHydrated, setAssetFrom, setAssetTo } = useSwapStore()
  const isPrivateUrl = searchParams.get('private') === 'true'

  // Init store from URL (once)
  useEffect(() => {
    if (initialized.current) return
    if (!assets?.length || !hasHydrated) return

    // The address bar's source wins; without one a returning visitor gets the source saved from the last
    // visit, and a first visit (nothing saved) gets BTC with a sample amount.
    // The BCH side (native BCH or a Cauldron token) on the buy side links a transfer to BCH, on the sell
    // side a transfer back from it; the other side names the other chain's asset.
    const { sell, buy } = readPair(pathname, searchParams)
    const { assetTo: savedTo, setOpenNetworks } = useSwapStore.getState()
    const networkMode = searchParams.get('networks') === 'true' || (!sell && !buy && openNetworks)
    if (networkMode !== openNetworks) setOpenNetworks(networkMode)
    if (networkMode) {
      const listed = assets.filter(isNetworkAsset)
      const savedFrom = useSwapStore.getState().assetFrom
      const from = resolveAsset(listed, sell, savedFrom?.identifier ?? DEFAULT_SELL) ?? listed[0]
      const to = resolveAsset(listed, buy, savedTo?.identifier ?? 'ETH.ETH')
      const nextTo = to?.identifier !== from?.identifier ? to : listed.find(asset => asset.identifier !== from?.identifier)
      useSwapStore.setState({ assetFrom: from, assetTo: nextTo, reverse: false, bchToken: null })
      initialized.current = true
      return
    }
    const toBch = readTokenSlug(buy)
    const fromBch = toBch ? undefined : readTokenSlug(sell)
    const { assetFrom: savedFrom, amountFrom, setAmountFrom, setBchToken } = useSwapStore.getState()
    const saved = assets.find(a => a.identifier === savedFrom?.identifier)
    const sellAsset = resolveAsset(assets, fromBch ? buy : sell, saved?.identifier ?? DEFAULT_SELL)
    const bchSide = fromBch && isReverseTargetAsset(sellAsset) ? fromBch : toBch
    if (bchSide) {
      useSwapStore.setState({ reverse: bchSide === fromBch })
      if ('token' in bchSide) setBchToken(bchSide.token)
      else {
        // A token outside the pinned list is looked up by its category id; a pick made meanwhile wins.
        const before = useSwapStore.getState().bchToken
        searchCauldronTokens(bchSide.category)
          .then(found => {
            const token = found.find(t => t.category === bchSide.category)
            if (token && useSwapStore.getState().bchToken === before) setBchToken(token)
          })
          .catch(() => {})
      }
    }
    if (!saved && !useSwapStore.getState().reverse && sellAsset?.identifier === DEFAULT_SELL && !amountFrom) setAmountFrom(FIRST_VISIT_AMOUNT)
    // A crafted `-buy-` segment cannot pick another destination asset.
    const buyAsset = resolveAsset(assets, DEFAULT_BUY, DEFAULT_BUY)

    if (sellAsset) setAssetFrom(sellAsset)
    if (buyAsset && buyAsset.identifier !== sellAsset?.identifier) setAssetTo(buyAsset)

    initialized.current = true
  }, [assets, hasHydrated, pathname, searchParams, isWidget, openNetworks, setAssetFrom, setAssetTo])

  // Sync URL on user-driven asset changes (skip the first sync after init so `/` stays clean,
  // unless the URL carries a stale `private` flag)
  useEffect(() => {
    if (isWidget) return
    if (!initialized.current || !assetFrom || !assetTo) return
    const skip = skipNextSync.current
    skipNextSync.current = false
    if (skip && !isPrivateUrl) return
    // A same-asset pair is never a valid link, so the address keeps the last real pair.
    if (assetFrom.identifier === assetTo.identifier) return
    const [sell, buy] = openNetworks
      ? [encodeURIComponent(assetFrom.identifier), encodeURIComponent(assetTo.identifier)]
      : reverse ? [tokenSlug(bchToken), toSlug(assetFrom)] : [toSlug(assetFrom), tokenSlug(bchToken)]
    const newPath = `/${SELL}${sell}${BUY}${buy}`
    const params = new URLSearchParams(window.location.search)
    params.delete('private')
    if (openNetworks) params.set('networks', 'true')
    else params.delete('networks')
    const search = params.toString()
    const newUrl = search ? `${newPath}?${search}` : newPath
    if (window.location.pathname + window.location.search !== newUrl) {
      window.history.replaceState(window.history.state, '', newUrl)
    }
  }, [assetFrom, assetTo, bchToken, reverse, openNetworks, isPrivateUrl, isWidget])
}

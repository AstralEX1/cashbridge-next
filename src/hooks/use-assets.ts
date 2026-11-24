import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Chain, getChainConfig, isSecuredAssetIdentifier, ProviderName } from '@tcswap/helpers'
import { USwapApi } from '@tcswap/helpers/api'
import { Asset } from '@/components/swap/asset'
import { AppConfig, BridgeConfig } from '@/config'
import { getMidgardPools } from '@/lib/api'
import { getNearTokens, mergeNearAssets } from '@/lib/near-intents'
import { thorchainTokenLogo } from '@/lib/token-logos'
import type { NearUnquotable } from '@/lib/near-quotable'
import { isNetworkAsset, useSwapStore } from '@/store/swap-store'

// Chains a private (Houdini) swap may start or end on. Houdini lists more, but an asset is only
// offered where this app can validate the address it pays out to and show the chain - so every
// entry has a validator in the SDK and an icon under public/networks.
export const PRIVATE_SWAP_CHAINS: Chain[] = [
  Chain.Arbitrum,
  Chain.Aurora,
  Chain.Avalanche,
  Chain.Base,
  Chain.Berachain,
  Chain.BinanceSmartChain,
  Chain.Bitcoin,
  Chain.BitcoinCash,
  Chain.Cardano,
  Chain.Cosmos,
  Chain.Dash,
  Chain.Dogecoin,
  Chain.Ethereum,
  Chain.Gnosis,
  Chain.Litecoin,
  Chain.Monad,
  Chain.Near,
  Chain.Optimism,
  Chain.Polygon,
  Chain.Ripple,
  Chain.Solana,
  Chain.Sui,
  Chain.THORChain,
  Chain.Ton,
  Chain.Tron,
  Chain.XLayer,
  Chain.Zcash
]

// The providers whose listing makes an asset selectable: the native protocols (plus NEAR Intents
// when enabled). NEAR-only rows stay visible whenever Intents is on so Manual and the Router
// share one picker; they are not gated on the live quote path.
export const isAssetInMode = (asset: Asset): boolean => {
  const providers = asset.providers ?? []
  if (providers.some(p => AppConfig.providers.includes(p))) return true
  return BridgeConfig.nearIntents && providers.includes(ProviderName.NEAR)
}

// True when the asset is listed only by NEAR Intents (no THORChain/Maya stamp). Quotes must not ask
// the aggregator for a THORChain deposit for these — Midgard has no vault for them.
export const isNearOnlyAsset = (asset?: Asset) => {
  const providers = asset?.providers ?? []
  return providers.includes(ProviderName.NEAR) && !providers.some(p => p === ProviderName.THORCHAIN || p === ProviderName.THORCHAIN_STREAMING || AppConfig.providers.includes(p))
}

export const useAssets = (): { assets?: Asset[]; isLoading: boolean } => {
  const { data, isLoading } = useQuery({
    queryKey: ['assets'],
    queryFn: async () => {
      // The bridge lists THORChain's assets only; the private provider's list is never fetched.
      const providers: ProviderName[] = [...AppConfig.providers]
      // THORChain lists tokens whose pool is staged or suspended, and it quotes none of them; unreadable pools hide nothing.
      const pools = getMidgardPools().catch(() => undefined)
      // The private provider's list is a separate product: if it is down or not yet synced the
      // SWAP tab must not go with it.
      const lists = await Promise.all(
        providers.map(provider =>
          USwapApi.getTokenList(provider).catch(error => {
            if (provider !== AppConfig.privateProvider) throw error
            console.warn(`Token list for ${provider} unavailable`, error)
            return { tokens: [] }
          })
        )
      )
      const entries = lists.flatMap((l, i) =>
        l.tokens.map(token => ({
          token,
          provider: providers[i]
        }))
      )

      const assets = new Map<string, Asset>()
      const closed = new Set((await pools)?.filter(pool => pool.status && pool.status !== 'available').map(pool => pool.asset.toUpperCase()))

      for (const { token, provider } of entries) {
        if (!token.chain || !getChainConfig(token.chain).chain) {
          continue
        }

        if (token.chain === Chain.Radix || token.chain === Chain.Kujira) {
          continue
        }

        if (provider === AppConfig.privateProvider && !PRIVATE_SWAP_CHAINS.includes(token.chain)) {
          continue
        }

        const isSecured = isSecuredAssetIdentifier(token.identifier)
        const isTrade = !isSecured && token.identifier.includes('~')

        // Secured and trade assets live in THORChain accounts rather than on their own chains;
        // the bridge is qualified for L1 sources only.
        if (isSecured || isTrade) continue
        if (closed.has(token.identifier.toUpperCase())) continue

        // The token list API returns TRON identifiers with the address segment uppercased
        // (e.g. TRON.USDT-TR7NHQJEKQ...), but Tron base58 addresses are case-sensitive and
        // tronWeb rejects them as invalid. Rebuild the identifier from the canonical address.
        const identifier = token.chain === Chain.Tron && token.address ? `${token.chain}.${token.ticker}-${token.address}` : token.identifier

        const key = `${token.chain}-${token.identifier}`.toLowerCase()
        const providers = assets.get(key)?.providers ?? []
        if (!providers.includes(provider)) providers.push(provider)

        const asset: Asset = {
          address: token.address,
          chain: token.chain,
          chainId: token.chainId,
          coingeckoId: token.coingeckoId,
          decimals: token.decimals,
          identifier,
          isSecuredAsset: isSecured || undefined,
          isTradeAsset: isTrade || undefined,
          logoURI: thorchainTokenLogo(token.identifier, token.logoURI),
          name: token.name,
          providers,
          shortCode: token.shortCode,
          ticker: token.ticker
        }

        assets.set(key, asset)
      }

      // Merge 1Click tokens on chains Cashbridge already maps. Overlap keeps THOR metadata and
      // adds NEAR to providers; NEAR-only rows fill the gap Midgard never listed. A catalog failure
      // leaves the THOR list as-is.
      if (BridgeConfig.nearIntents) {
        const nearList = await getNearTokens().catch(error => {
          console.warn('NEAR Intents token list unavailable', error)
          return []
        })
        mergeNearAssets(assets, nearList)
      }

      return Array.from(assets.values())
    },
    refetchOnMount: false,
    refetchOnWindowFocus: false
  })

  return {
    assets: data,
    isLoading
  }
}

// The assets selectable in the current mode (see isAssetInMode). On the bridge, a NEAR-only row NEAR Intents quotes no
// route for in this direction is left out; until that list arrives, or when it fails, every row shows.
export const useModeAssets = (): { assets?: Asset[]; isLoading: boolean } => {
  const { assets, isLoading } = useAssets()
  const openNetworks = useSwapStore(state => state.openNetworks)
  const reverse = useSwapStore(state => state.reverse)
  const { data: unquotable } = useQuery({
    queryKey: ['near-unquotable'],
    queryFn: (): Promise<NearUnquotable> => fetch('/api/near-intents/quotable').then(res => res.json()),
    enabled: BridgeConfig.nearIntents,
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false
  })
  const hidden = openNetworks ? undefined : unquotable?.[reverse ? 'reverse' : 'forward']

  const modeAssets = useMemo(
    () =>
      assets?.filter(asset =>
        openNetworks ? isNetworkAsset(asset) : isAssetInMode(asset) && !(hidden?.includes(asset.identifier) && isNearOnlyAsset(asset))
      ),
    [assets, openNetworks, hidden]
  )

  return { assets: modeAssets, isLoading }
}

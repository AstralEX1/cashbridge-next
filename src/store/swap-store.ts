import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Asset } from '@/components/swap/asset'
import { BridgeConfig } from '@/config'
import { type CauldronToken, isCauldronToken, PUSD_TOKEN, sameToken } from '@/lib/cauldron-tokens'
import { isPayoutChain } from '@/lib/payout-chains'
import { automaticPreference } from '@/store/auto-bridge-store'

// A first visit opens on BTC with this sample amount, so there is a quote to look at; no other visit gets one.
export const FIRST_VISIT_AMOUNT = '0.00156'

// The THORChain leg always trades native BCH against one other asset: BCH is never on both sides,
// and nothing else is bought or sold through THORChain on the BCH side.
export const isBridgeBuyAsset = (asset?: Pick<Asset, 'identifier'>) => asset?.identifier.toUpperCase() === BridgeConfig.buyAsset
export const isBridgeSellAsset = (asset?: Asset) => !!asset && !isBridgeBuyAsset(asset) && asset.chain !== 'BCH'
export const isNetworkAsset = (asset?: Asset) => !!asset && !!asset.providers?.some(provider => BridgeConfig.providers.includes(provider))

export const INITIAL_SLIPPAGE = 1
export const INITIAL_CUSTOM_INTERVAL = 0
export const INITIAL_CUSTOM_QUANTITY = 0

// The reverse bridge pays out only where its arrival can be checked on that chain's own node.
export const isReverseTargetAsset = (asset?: Asset) => isBridgeSellAsset(asset) && isPayoutChain(asset!.chain)

// Which bridge carries the first leg: the better quote ('auto'), or the one the user picked.
export type RouteChoice = 'auto' | 'thorchain' | 'near' | 'shapeshift'

// The same Bitcoin Cash asset: native BCH (null) or one Cauldron token.
const sameBchAsset = (a: CauldronToken | null, b: CauldronToken | null) => (a === null ? b === null : sameToken(a, b))

interface SwapState {
  routeChoice: RouteChoice
  setRouteChoice: (choice: RouteChoice) => void
  // When true, both sides pick any listed asset (not only BCH / CashTokens). Router is unavailable.
  openNetworks: boolean
  setOpenNetworks: (open: boolean) => void
  // The BCH side of the bridge: native BCH (null) or a Cauldron token, bought or sold through Cauldron.
  bchToken: CauldronToken | null
  setBchToken: (token: CauldronToken | null) => void
  // Back from BCH, a Bitcoin Cash asset picked on the other side: the swap never leaves Bitcoin Cash, one Cauldron trade
  // from `bchToken` into this (native BCH when null). Undefined: the other chain's `assetFrom` is paid out.
  localTo?: CauldronToken | null
  setLocalTo: (token?: CauldronToken | null) => void
  // false: other chain -> THORChain -> BCH (-> token). true: (token ->) BCH -> THORChain -> EVM chain.
  // `assetFrom` is the other chain's asset in both directions; `amountFrom` is always what is sent.
  // Ignored while openNetworks is on (the pair itself is the direction).
  reverse: boolean
  setReverse: (reverse: boolean) => void
  assetFrom?: Asset
  assetTo?: Asset
  amountFrom: string
  slippage?: number
  customInterval: number
  customQuantity: number
  feeWarning: string
  hasHydrated: boolean

  setSlippage: (limit?: number) => void
  setCustomInterval: (interval: number) => void
  setCustomQuantity: (quantity: number) => void
  setAmountFrom: (amount: string) => void
  setAssetFrom: (asset: Asset) => void
  setAssetTo: (asset: Asset) => void
  swapAssets: (amount?: string) => void
  setHasHydrated: (state: boolean) => void
}

export const useSwapStore = create<SwapState>()(
  persist(
    (set, get) => ({
      routeChoice: 'auto',
      setRouteChoice: routeChoice => set({ routeChoice }),
      openNetworks: false,
      setOpenNetworks: openNetworks => {
        if (openNetworks) {
          // Free pairs use Manual execution; the Router only settles the BCH / CashToken path.
          automaticPreference.getState().setMode('manual')
          set({ openNetworks: true, reverse: false, bchToken: null, localTo: undefined, amountFrom: '' })
          return
        }
        const { assetFrom, assetTo } = get()
        set({
          openNetworks: false,
          reverse: false,
          bchToken: PUSD_TOKEN,
          localTo: undefined,
          assetFrom: isBridgeSellAsset(assetFrom) ? assetFrom : undefined,
          assetTo: isBridgeBuyAsset(assetTo) ? assetTo : undefined,
          amountFrom: ''
        })
      },
      bchToken: PUSD_TOKEN,
      setBchToken: token => {
        if (token !== null && !isCauldronToken(token)) return
        const { bchToken, localTo } = get()
        if (localTo === undefined) return set({ bchToken: token })
        // Picking what the swap buys as what it sells turns the pair around; a token for a token buys BCH instead.
        if (sameBchAsset(token, localTo)) return set({ bchToken: token, localTo: bchToken })
        set({ bchToken: token, ...(token !== null && localTo !== null && { localTo: null }) })
      },
      localTo: undefined,
      setLocalTo: token => {
        if (token === undefined) return set({ localTo: undefined })
        if (token !== null && !isCauldronToken(token)) return
        // One Cauldron trade: BCH on exactly one side.
        if ((token === null) !== (get().bchToken === null)) set({ localTo: token })
      },
      reverse: false,
      setReverse: reverse => set({ reverse, localTo: undefined, amountFrom: '' }),
      slippage: INITIAL_SLIPPAGE,
      customInterval: INITIAL_CUSTOM_INTERVAL,
      customQuantity: INITIAL_CUSTOM_QUANTITY,
      amountFrom: '',
      feeWarning: '500',
      hasHydrated: false,

      setSlippage: slippage => set({ slippage: slippage }),
      setCustomInterval: customInterval => set({ customInterval }),
      setCustomQuantity: customQuantity => set({ customQuantity }),
      setAmountFrom: fromAmount => set({ amountFrom: fromAmount }),

      setAssetFrom: asset => {
        const { openNetworks, assetTo } = get()
        if (openNetworks) {
          if (!isNetworkAsset(asset)) return
          if (asset.identifier === assetTo?.identifier) return
          set({ assetFrom: asset })
          return
        }
        if (!isBridgeSellAsset(asset)) return
        set({ assetFrom: asset, assetTo: isBridgeBuyAsset(assetTo) ? assetTo : undefined })
      },

      setAssetTo: asset => {
        const { openNetworks, assetFrom } = get()
        if (openNetworks) {
          if (!isNetworkAsset(asset)) return
          if (asset.identifier === assetFrom?.identifier) return
          set({ assetTo: asset })
          return
        }
        if (!isBridgeBuyAsset(asset)) return
        set({ assetTo: asset })
      },

      // Bridge mode flips reverse; open-networks mode swaps the asset pair.
      swapAssets: () =>
        set(state =>
          state.openNetworks
            ? { assetFrom: state.assetTo, assetTo: state.assetFrom, amountFrom: '' }
            : state.reverse && state.localTo !== undefined
              ? { bchToken: state.localTo, localTo: state.bchToken, amountFrom: '' }
              : { reverse: !state.reverse, amountFrom: '' }
        ),

      setHasHydrated: (state: boolean) => set({ hasHydrated: state })
    }),
    {
      name: 'tc-swap-store',
      version: 6,
      // Versions before 4 could hold any pair; a restored pair is rechecked against the bridge rules.
      migrate: (persisted, version) => (version === 5 || version === 4 ? persisted : {}) as never,
      merge: (persisted, current) => {
        const state = { ...current, ...(persisted as Partial<SwapState>) }
        if (typeof state.openNetworks !== 'boolean') state.openNetworks = false
        if (state.openNetworks) {
          state.reverse = false
          state.bchToken = null
          if (!isNetworkAsset(state.assetFrom)) state.assetFrom = undefined
          if (!isNetworkAsset(state.assetTo)) state.assetTo = undefined
          if (state.assetFrom?.identifier === state.assetTo?.identifier) state.assetTo = undefined
        } else {
          if (!isBridgeSellAsset(state.assetFrom)) state.assetFrom = undefined
          if (!isBridgeBuyAsset(state.assetTo)) state.assetTo = undefined
        }
        // Before version 5 the BCH side was a 'BCH' | 'PUSD' choice.
        const legacy = (persisted as { destinationAsset?: unknown } | undefined)?.destinationAsset
        if (legacy === 'BCH') state.bchToken = null
        else if (state.bchToken !== null && !isCauldronToken(state.bchToken)) state.bchToken = PUSD_TOKEN
        if (typeof state.reverse !== 'boolean') state.reverse = false
        return state
      },
      onRehydrateStorage: () => state => {
        state?.setHasHydrated(true)
      },
      partialize: state => ({
        openNetworks: state.openNetworks,
        bchToken: state.bchToken,
        reverse: state.reverse,
        slippage: state.slippage,
        feeWarning: state.feeWarning,
        assetFrom: state.assetFrom,
        assetTo: state.assetTo
      })
    }
  )
)

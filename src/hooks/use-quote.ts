import { RefetchOptions, useQuery } from '@tanstack/react-query'
import { Chain, USwapNumber, WalletOption } from '@tcswap/core'
import { ProviderName, USwapError } from '@tcswap/helpers'
import { QuoteResponseRoute } from '@tcswap/helpers/api'
import { AppConfig, BridgeConfig } from '@/config'
import { isNearOnlyAsset } from '@/hooks/use-assets'
import { useAssetFrom, useAssetTo, useCustomInterval, useCustomQuantity, useSlippage, useSwap } from '@/hooks/use-swap'
import { getNetworkQuotes, getQuotes, QuoteTimeoutError } from '@/lib/api'
import { BelowMinimumError, isTradingHaltedError, resolveQuoteError } from '@/lib/errors'
import { isHoudiniProvider } from '@/lib/swap-helpers'
import { useTokenSale } from '@/hooks/use-token-sale'
import { useSwapStore } from '@/store/swap-store'
import { useAutomaticBridge } from '@/hooks/use-automatic-bridge'
import { getNearQuote, nearSlippageBps, type NearRoute } from '@/lib/near-intents'
import { formatBaseUnits, secondLegSellAmount, toBaseUnits } from '@/lib/bridge'
import { shapeShiftSaleSats } from '@/lib/router-contract'
import { getShapeShiftQuote, type ShapeShiftRoute } from '@/lib/shapeshift'
import { useSourceGas } from '@/hooks/use-source-gas'
import { useConnectedAccount } from '@/hooks/use-wallets'
import type { SourceGas } from '@/lib/source-gas'

// The routes' quotes for the same transfer; any may be missing. ShapeShift is quoted on open-network pairs only.
export interface BridgeRoutes {
  thorchain?: QuoteResponseRoute
  near?: NearRoute
  shapeshift?: ShapeShiftRoute
  // THORChain refused the quote because it has paused trading on a chain of the pair.
  thorchainHalted?: boolean
}

export type RouteKey = 'thorchain' | 'near' | 'shapeshift'

type UseQuote = {
  isLoading: boolean
  refetch: (options?: RefetchOptions) => void
  // The route the transfer takes: the user's pick when it quotes, else the better one.
  quote?: QuoteResponseRoute
  routes?: BridgeRoutes
  best?: RouteKey
  // Each route's deposit gas on the paying chain (EVM), in USD and in the bought asset; `best` is net of it.
  gas: Partial<Record<RouteKey, SourceGas>>
  // True when NEAR Intents or ShapeShift is quoted beside THORChain for this mode (drives the route compare UI).
  nearAllowed: boolean
  shapeshiftAllowed: boolean
  error: Error | null
  // Set when the amount is under THORChain's minimum swap, in the sell asset's units.
  minimum?: string
}

const LEDGER_MEMO_TRIMMED: Chain[] = [Chain.Litecoin, Chain.Dogecoin, Chain.BitcoinCash, Chain.Dash, Chain.Zcash]

export const useQuote = (): UseQuote => {
  const { valueFrom } = useSwap()
  const slippage = useSlippage()
  const assetFrom = useAssetFrom()
  const assetTo = useAssetTo()
  const customInterval = useCustomInterval()
  const customQuantity = useCustomQuantity()
  // Right after a mode switch the pair can lag a render behind (Swap fixes it in an effect); don't quote a same-asset pair.
  const sameAsset = !!assetFrom && assetFrom.identifier === assetTo?.identifier

  // The reverse bridge sells BCH into `assetFrom` (the other chain's asset). From a token, the BCH
  // quoted is what the Cauldron sale of the typed amount is expected to leave for THORChain.
  const reverse = useSwapStore(state => state.reverse)
  const openNetworks = useSwapStore(state => state.openNetworks)
  const bchToken = useSwapStore(state => state.bchToken)
  // A swap that stays on Bitcoin Cash is priced on Cauldron alone (useBchSwap).
  const onBch = useSwapStore(state => state.reverse && state.localTo !== undefined)
  const sale = useTokenSale(!openNetworks && reverse ? bchToken : null, valueFrom.toSignificant())
  const sellAsset = openNetworks ? assetFrom?.identifier : reverse ? BridgeConfig.buyAsset : assetFrom?.identifier
  // Bridge forward settles native BCH (CashToken afterwards on Cauldron). Open networks quotes the selected
  // pair. NEAR Intents only settles BCH.BCH on one side.
  const buyAsset = openNetworks ? assetTo?.identifier : reverse ? assetFrom?.identifier : BridgeConfig.buyAsset
  const sellAmount =
    !openNetworks && reverse && bchToken ? sale.bridgeAmount : valueFrom.eqValue(0) ? undefined : valueFrom.toSignificant()
  const { automatic } = useAutomaticBridge()
  // A Router sale through ShapeShift deposits an exact amount under its floor; the rest comes back as BCH.
  const exactSale = !openNetworks && reverse && bchToken && automatic && sale.quote ? shapeShiftSaleSats(sale.quote.output) : undefined
  const shapeshiftAmount = exactSale === undefined ? sellAmount : exactSale > 0n ? formatBaseUnits(exactSale, 8) : undefined
  // NEAR Intents and ShapeShift carry manual transfers both ways and free pairs, and the Cashbridge Router's transfers
  // when it takes them (forward: a NEAR Intents deposit address it follows; back: a sale that pays one).
  const routerTakes = (forward: boolean) => (reverse ? BridgeConfig.routerSaleRoutes : forward)
  const nearAllowed = BridgeConfig.nearIntents && (openNetworks || !automatic || routerTakes(BridgeConfig.routerNear))
  const shapeshiftAllowed = BridgeConfig.shapeshift && (openNetworks || !automatic || routerTakes(BridgeConfig.routerShapeShift))
  // ShapeShift wants both sides' decimals; on the bridge form one side is native BCH.
  const shapeshiftDecimals = openNetworks
    ? assetFrom && assetTo && { sellDecimals: assetFrom.decimals, buyDecimals: assetTo.decimals }
    : assetFrom && (reverse ? { sellDecimals: 8, buyDecimals: assetFrom.decimals } : { sellDecimals: assetFrom.decimals, buyDecimals: 8 })
  // On the bridge form `assetFrom` is the non-BCH side; NEAR-only rows must never ask THORChain for a deposit.
  const nearOnly = !openNetworks && isNearOnlyAsset(assetFrom)
  const sellChain = sellAsset?.split('.')[0] as Chain | undefined
  const sender = useConnectedAccount(sellChain, true)
  // Ledger's SDK connector cuts the last memo field, the trade limit, off a deposit on a UTXO chain other than Bitcoin
  // (wallet-hardware ledger `reduceMemo`): THORChain would swap it with no minimum out. NEAR Intents and ShapeShift take no memo.
  const noThorchain = nearOnly || (!!sender && sender.provider === WalletOption.LEDGER && LEDGER_MEMO_TRIMMED.includes(sender.network))
  const choice = useSwapStore(state => state.routeChoice)

  const queryKey = [
    'quote',
    reverse,
    openNetworks,
    sellAmount,
    assetFrom?.identifier,
    buyAsset,
    assetFrom?.chain,
    assetTo?.chain,
    slippage,
    customInterval,
    customQuantity,
    nearAllowed,
    shapeshiftAllowed,
    shapeshiftAmount,
    noThorchain
  ]

  const {
    data: routes,
    refetch,
    isLoading,
    isRefetching,
    isPlaceholderData,
    error
  } = useQuery({
    queryKey: queryKey,
    queryFn: async ({ signal }): Promise<BridgeRoutes | undefined> => {
      if (!sellAmount) return
      if (!sellAsset || !buyAsset) return

      // THORChain on the aggregator's own streaming policy, and NEAR Intents' 1Click beside it. Either one
      // quoting is enough; with neither, THORChain's error (a minimum, a halt) is the one shown.
      // NEAR-only assets skip THOR entirely so they cannot land on an unsupported vault deposit.
      // NEAR always asks for BCH.BCH on the BCH side (CashTokens are a separate Cauldron leg).
      const near = nearAllowed
        ? getNearQuote(
            {
              sellAsset,
              // Open networks and reverse quote the selected buy asset; bridge forward always buys native BCH first.
              buyAsset: openNetworks || reverse ? buyAsset : BridgeConfig.buyAsset,
              sellAmount,
              dry: true,
              slippageBps: nearSlippageBps(slippage)
            },
            signal
          ).catch(error => {
            // Pair switches and under-min amounts regularly 4xx; only unexpected failures are logged.
            const status = error && typeof error === 'object' && 'status' in error ? Number((error as { status: unknown }).status) : 0
            if (!(status >= 400 && status < 500) && !signal?.aborted) console.warn('NEAR Intents quote failed', error)
            return undefined
          })
        : undefined
      const shapeshift =
        shapeshiftAllowed && shapeshiftDecimals && shapeshiftAmount
          ? getShapeShiftQuote(
              { sellAsset, buyAsset: openNetworks || reverse ? buyAsset : BridgeConfig.buyAsset, sellAmount: shapeshiftAmount, ...shapeshiftDecimals, slippage },
              signal
            ).catch(error => {
              if (!signal?.aborted) console.warn('ShapeShift quote failed', error)
              return undefined
            })
          : undefined
      const thorchain = noThorchain
        ? Promise.resolve(undefined)
        : (openNetworks ? getNetworkQuotes : getQuotes)(
            {
              buyAsset,
              sellAsset,
              sellAmount,
              slippage: slippage ?? 99,
              providers: AppConfig.providers
            },
            createAbortController(signal)
          ).then(quotes => {
            if (quotes.length === 0) throw new Error(reverse ? 'No THORChain route from BCH for this amount' : 'No THORChain route to BCH for this amount')

            if (AppConfig.id === 'thorchain') {
              const thorchainQuote =
                quotes.find(q => q.providers[0] === ProviderName.THORCHAIN_STREAMING) || quotes.find(q => q.providers[0] === ProviderName.THORCHAIN)

              if (thorchainQuote) {
                return thorchainQuote
              }
            }

            return quotes.reduce((best, current) =>
              new USwapNumber(current.expectedBuyAmount).gt(new USwapNumber(best.expectedBuyAmount)) ? current : best
            )
          })
      const [thor, nearRoute, shapeRoute] = await Promise.allSettled([thorchain, near, shapeshift])
      const result = {
        thorchain: thor.status === 'fulfilled' ? thor.value : undefined,
        near: nearRoute.status === 'fulfilled' ? nearRoute.value : undefined,
        // ShapeShift's rates carry no minimum: forward, BCH too little to fund the token sale is no route.
        shapeshift:
          shapeRoute.status === 'fulfilled' && (openNetworks || reverse || fundsTokenSale(shapeRoute.value))
            ? timedLikeNear(shapeRoute.value, nearRoute.status === 'fulfilled' ? nearRoute.value : undefined)
            : undefined,
        ...(thor.status === 'rejected' && isTradingHaltedError(resolveQuoteError(thor.reason).message ?? '') && { thorchainHalted: true })
      }
      if (!result.thorchain && !result.near && !result.shapeshift) throw thor.status === 'rejected' ? thor.reason : new Error('No route for this amount')
      return result
    },
    placeholderData: previous => {
      const sample = previous?.thorchain ?? previous?.near ?? previous?.shapeshift
      return sample && isQuoteFor(sample, sellAsset, buyAsset) && !isHoudiniProvider(sample.providers[0]) ? previous : undefined
    },
    enabled: !!(sellAmount && sellAsset && buyAsset && (reverse || !sameAsset)) && !(onBch && !openNetworks),
    // A THORChain timeout is transient: asked again a few seconds later, quietly.
    retry: (count, error) => error instanceof QuoteTimeoutError && count < 2,
    retryDelay: 3_000,
    refetchOnMount: false
  })

  const newError = error instanceof USwapError ? resolveQuoteError(error) : error

  const saleError = reverse && bchToken ? sale.error : null
  const gas = useSourceGas(routes && { thorchain: routes.thorchain, near: routes.near, shapeshift: routes.shapeshift })
  // NEAR-only legs must never deposit into THORChain; NEAR Intents and ShapeShift (over 1Click) are ranked as usual.
  const usable = nearOnly && routes ? { ...routes, thorchain: undefined } : routes
  const best = bestRoute(usable, gas)
  const quote = usable && (choice === 'auto' ? best && usable[best] : (usable[choice] ?? usable.thorchain ?? usable.near ?? usable.shapeshift))
  // First paint only: keep last routes/quote on screen through refetches and Cauldron sale reloads.
  const waiting = isLoading && !isPlaceholderData && !routes
  const saleLoading = reverse && !!bchToken && sale.isLoading
  return {
    isLoading: waiting || isRefetching || saleLoading,
    refetch,
    quote: error || waiting ? undefined : quote,
    routes: error ? undefined : routes,
    best,
    gas: error ? {} : gas,
    nearAllowed,
    shapeshiftAllowed,
    error: saleError ?? newError,
    minimum: error instanceof BelowMinimumError ? error.minimum : undefined
  }
}

// ShapeShift's NEAR Intents rates carry a flat time; the same 1Click swap's own estimate is the NEAR route's.
export const timedLikeNear = <T extends ShapeShiftRoute>(shape: T | undefined, near?: { estimatedTime?: QuoteResponseRoute['estimatedTime'] }) =>
  shape && near?.estimatedTime && shape.shapeshift.swapper === 'NEAR Intents' ? { ...shape, estimatedTime: near.estimatedTime } : shape

// Whether a forward first leg's BCH leaves anything to sell for the token after the second leg's reserve.
export const fundsTokenSale = (route?: { expectedBuyAmount: string }) => !route || secondLegSellAmount(toBaseUnits(route.expectedBuyAmount, 8)) > 0n

// The route paying most of the bought asset net of its deposit's gas (`gas`, in the bought asset); THORChain, then NEAR,
// win a tie. Gas counts only when every quoted route has a figure, so a missing price never decides on its own.
export const bestRoute = (routes?: BridgeRoutes, gas: Partial<Record<RouteKey, Pick<SourceGas, 'buy'>>> = {}): RouteKey | undefined => {
  const quoted = (['thorchain', 'near', 'shapeshift'] as const).filter(key => routes?.[key])
  const priced = quoted.every(key => gas[key])
  const net = (key: RouteKey) => Number(routes![key]!.expectedBuyAmount) - (priced ? gas[key]!.buy : 0)
  let best: RouteKey | undefined
  for (const key of quoted) if (!best || net(key) > net(best)) best = key
  return best
}

export const isQuoteFor = (quote: QuoteResponseRoute, sellAsset?: string, buyAsset?: string) =>
  quote.sellAsset.toLowerCase() === sellAsset?.toLowerCase() && quote.buyAsset.toLowerCase() === buyAsset?.toLowerCase()

function createAbortController(signal: AbortSignal) {
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort()
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  return controller
}

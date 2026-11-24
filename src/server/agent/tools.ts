import { randomBytes, randomUUID } from 'node:crypto'
import { USwapNumber, getChainConfig } from '@tcswap/core'
import { EVMChains, ProviderName, type Chain } from '@tcswap/helpers'
import type { QuoteRequest, QuoteResponseRoute } from '@tcswap/helpers/api'
import { Interface, ZeroAddress, getAddress, isAddress } from 'ethers'
import { AppConfig, BridgeConfig } from '@/config'
import { getInboundAddresses, getMidgardPools, getNetworkQuotes, getQuotes, getTxStatus, isBridgeRoute, type TxStatusResponse } from '@/lib/api'
import { nearPaysBeforeRefund, type OrderIntent, type OrderState, type PublicOrder, type SaleIntent, type SaleRoute } from '@/lib/auto-bridge-contract'
import { checkNewOrder, checkOrder } from '@/lib/auto-bridge-order'
import { addressToLockingBytecode, bchAddressProblem, bindingFromAddress, listWalletCoins } from '@/lib/bch'
import { formatBaseUnits, minOutputFor, secondLegSellAmount, toBaseUnits } from '@/lib/bridge'
import { quoteToken } from '@/lib/cauldron'
import { FEATURED_TOKENS, fetchCauldronTokens, readTokenSlug, searchCauldronTokens, type CauldronToken } from '@/lib/cauldron-tokens'
import { isDollarStable } from '@/lib/dollar-stable'
import { resolveQuoteError } from '@/lib/errors'
import { FORWARD_DEADLINE_MS, findNearToken, getNearQuote, getNearStatus, getNearTokens, interpretNearStatus, isNearChain, nearExplorerUrl, nearSlippageBps, submitNearDeposit, type NearRoute, type NearQuoteRequest } from '@/lib/near-intents'
import { REFUND_AFTER_SECONDS, REFUND_FEE_CAP, SALE_FLOOR_TOLERANCE_BPS, shapeShiftSaleSats } from '@/lib/router-contract'
import { buildTokenSend, routedDeposit } from '@/lib/router-sale-legs'
import { getShapeShiftBridgeRoute, getShapeShiftQuote, getShapeShiftStatus, interpretShapeShiftStatus, shapeShiftAssetId, type ShapeShiftRoute } from '@/lib/shapeshift'
import { sourceTransactionId } from '@/lib/source-transaction'
import { DEPOSIT_FEE_RESERVE, checkDepositMemo, checkInbound, type InboundAddress } from '@/lib/thorchain-deposit'
import { callWorker } from '@/server/auto-bridge/proxy'

// The tools the Cash Bridge MCP endpoint offers to AI agents. None of them holds a key or signs: quotes are read-only,
// and prepare_bridge hands back the unsigned transaction or deposit instructions for the user's own wallet to sign.

// What a failing tool tells the agent; it reads the message and can correct its call.
export class ToolError extends Error {}

export interface ToolContext {
  ip: string
  // Charges `cost` against the caller's write quota; false once it is spent.
  allowWrite: () => boolean
}

type Args = Record<string, unknown>
type Tool = {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: Record<string, boolean | string>
  run: (args: Args, context: ToolContext) => Promise<unknown>
}

const QUOTE_TIMEOUT_MS = 20_000
const BCH_SIDE_HINT =
  'For the BCH bridge, one side must be BCH.BCH or a Cauldron token (PUSD, MUSD, a ticker from list_supported_assets, or a 64-hex category id) and the other a THORChain asset such as BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913. For Any-network free pairs, both sides are THORChain assets (ETH.ETH to BTC.BTC).'
const ROUTE_HINT = '"route" must be thorchain, near_intents or shapeshift'

const text = (args: Args, key: string, required = true) => {
  const value = args[key]
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolError(`"${key}" is required`)
    return undefined
  }
  if (typeof value !== 'string' || value.length > 256) throw new ToolError(`"${key}" must be a string`)
  return value.trim()
}

const decimalAmount = (args: Args) => {
  const amount = text(args, 'amount')!
  if (!/^\d+(?:\.\d+)?$/.test(amount) || !/[1-9]/.test(amount)) throw new ToolError('"amount" must be a positive decimal string such as "25" or "0.015"')
  return amount
}

// The aggregator's own slippage, in percent, as the page sends it (1% by default).
const slippage = (args: Args) => {
  const value = args.slippage_percent ?? 1
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0.1 || parsed > 5) throw new ToolError('"slippage_percent" must be between 0.1 and 5')
  return parsed
}

// --- Assets ---------------------------------------------------------------------------------------

type BchSide = { token?: CauldronToken }

// BCH.BCH, a pinned ticker or a category id; undefined for anything else (an asset on the other side).
const bchSide = async (asset: string): Promise<BchSide | undefined> => {
  const slug = readTokenSlug(asset)
  if (!slug) return undefined
  if ('token' in slug) return { token: slug.token ?? undefined }
  const token = (await searchCauldronTokens(slug.category)).find(t => t.category === slug.category)
  if (!token) throw new ToolError(`Cauldron lists no liquid token with category ${slug.category}`)
  return { token }
}

const tokenInfo = (token: CauldronToken) => ({ asset: token.ticker, category: token.category, name: token.name, decimals: token.decimals })

type BridgePair = { kind: 'bridge'; reverse: boolean; external: string; side: BchSide }
type NetworkPair = { kind: 'network'; sellAsset: string; buyAsset: string }
type Pair = BridgePair | NetworkPair

const thorAsset = (asset: string) => {
  if (!/^[A-Z0-9]+\.[A-Z0-9]/i.test(asset)) throw new ToolError(`"${asset}" is not a THORChain asset. ${BCH_SIDE_HINT}`)
  return asset
}

const pair = async (args: Args): Promise<Pair> => {
  const from = text(args, 'from_asset')!
  const to = text(args, 'to_asset')!
  if (from.toUpperCase() === to.toUpperCase()) throw new ToolError('"from_asset" and "to_asset" must differ')
  const [fromBch, toBch] = await Promise.all([bchSide(from), bchSide(to)])
  if (fromBch && toBch) throw new ToolError(BCH_SIDE_HINT)
  if (!fromBch && !toBch) {
    return { kind: 'network', sellAsset: thorAsset(from), buyAsset: thorAsset(to) }
  }
  if (!fromBch) thorAsset(from)
  if (!toBch) thorAsset(to)
  return toBch ? { kind: 'bridge', reverse: false, external: from, side: toBch } : { kind: 'bridge', reverse: true, external: to, side: fromBch! }
}

const routeChoice = (args: Args, allowed: string[]) => {
  const via = text(args, 'route', false) ?? (allowed.includes('thorchain') ? 'thorchain' : allowed[0])
  if (!via || !allowed.includes(via)) throw new ToolError(ROUTE_HINT)
  return via
}

// --- THORChain leg --------------------------------------------------------------------------------

// Any-network pairs pass getNetworkQuotes; the BCH bridge quotes with getQuotes.
const thorchainRoute = async (request: Omit<QuoteRequest, 'providers'>, quotes: typeof getQuotes = getQuotes) => {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), QUOTE_TIMEOUT_MS)
  try {
    const routes = await quotes({ ...request, providers: AppConfig.providers }, abort)
    // As on the page: the streaming swap when THORChain offers it, the plain one otherwise.
    const route = routes.find(r => r.providers[0] === ProviderName.THORCHAIN_STREAMING) ?? routes.find(r => r.providers[0] === ProviderName.THORCHAIN)
    if (!route) throw new ToolError('THORChain has no route for this pair and amount right now')
    return route
  } catch (error) {
    if (error instanceof ToolError) throw error
    throw new ToolError(resolveQuoteError(error).message)
  } finally {
    clearTimeout(timer)
  }
}

const legOf = (route: QuoteResponseRoute) => ({
  provider: 'THORChain',
  sell: `${route.sellAmount} ${route.sellAsset}`,
  buy: `${route.expectedBuyAmount} ${route.buyAsset}`,
  fees: route.fees.map(f => ({ type: f.type, amount: f.amount, asset: f.asset })),
  estimated_seconds: route.estimatedTime?.total,
  warnings: route.warnings?.map(w => w.display)
})

const tokenQuote = async (category: string, side: 'buy' | 'sell', amount: bigint) => {
  try {
    return await quoteToken({ category, side, amount })
  } catch (error) {
    throw new ToolError(`Cauldron: ${error instanceof Error ? error.message : 'no quote'}`)
  }
}

// --- NEAR Intents leg (plain BCH, either direction) ------------------------------------------------

const nearAvailable = (asset: string) => BridgeConfig.nearIntents && isNearChain(asset.split('.')[0])

const nearQuote = async (request: NearQuoteRequest & { sourceAddress?: string }) => {
  try {
    return await getNearQuote(request, AbortSignal.timeout(QUOTE_TIMEOUT_MS))
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : 'NEAR Intents gave no quote')
  }
}

const unit = (asset: string) => (asset === BridgeConfig.buyAsset ? 'BCH' : asset)

const nearLeg = (route: NearRoute) => ({
  provider: 'NEAR Intents',
  sell: `${route.sellAmount} ${unit(route.sellAsset)}`,
  buy: `${route.expectedBuyAmount} ${unit(route.buyAsset)}`,
  minimum: `${route.expectedBuyAmountMaxSlippage} ${unit(route.buyAsset)}`,
  estimated_seconds: route.estimatedTime?.total
})

const THORNODE_URL = 'https://gateway.liquify.com/chain/thorchain_api'

// A token's own decimals, as THORChain's pool records them.
const poolDecimals = async (asset: string) => {
  const pool = await fetch(`${THORNODE_URL}/thorchain/pool/${encodeURIComponent(asset)}`, { signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) })
    .then(res => (res.ok ? res.json() : undefined))
    .catch(() => undefined)
  if (!Number.isInteger(pool?.decimals)) throw new ToolError(`THORChain did not give the decimals of ${asset}; try again shortly`)
  return pool.decimals as number
}

// --- ShapeShift leg (deposit-address swaps; Any-network free pairs, and plain BCH when mapped) ------

const shapeShiftAvailable = (sellAsset: string, buyAsset: string) =>
  BridgeConfig.shapeshift && !!shapeShiftAssetId(sellAsset) && !!shapeShiftAssetId(buyAsset)

const assetDecimals = async (asset: string) => {
  if (asset === BridgeConfig.buyAsset || asset.toUpperCase().startsWith('BCH.')) return 8
  const chain = asset.split('.')[0].toUpperCase()
  const contract = asset.split('-')[1]
  // RUNE has no pool of its own; like the UTXO coins it counts 8 decimals.
  if (!contract && ['BTC', 'LTC', 'DOGE', 'BCH', 'DASH', 'ZEC', 'THOR'].includes(chain)) return 8
  if (!contract && (EVMChains as readonly string[]).includes(chain)) return 18
  // THORChain has no pool for a NEAR-only token (ARB.USDC, SUI.SUI, TON.TON); NEAR Intents lists its decimals.
  return poolDecimals(asset).catch(async error => {
    const decimals = BridgeConfig.nearIntents ? findNearToken(await getNearTokens().catch(() => []), asset)?.decimals : undefined
    if (decimals === undefined) throw error
    return decimals
  })
}

const shapeShiftQuote = async (
  sellAsset: string,
  buyAsset: string,
  sellAmount: string,
  percent: number,
  addresses?: { source: string; destination: string }
) => {
  if (!shapeShiftAvailable(sellAsset, buyAsset)) return undefined
  try {
    const [sellDecimals, buyDecimals] = await Promise.all([assetDecimals(sellAsset), assetDecimals(buyAsset)])
    return await getShapeShiftQuote(
      {
        sellAsset,
        buyAsset,
        sellAmount,
        sellDecimals,
        buyDecimals,
        slippage: percent,
        ...(addresses && { sourceAddress: addresses.source, destinationAddress: addresses.destination })
      },
      AbortSignal.timeout(QUOTE_TIMEOUT_MS)
    )
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : 'ShapeShift gave no quote')
  }
}

const shapeLeg = (route: ShapeShiftRoute) => ({
  provider: `ShapeShift (${route.shapeshift.swapper})`,
  sell: `${route.sellAmount} ${route.sellAsset}`,
  buy: `${route.expectedBuyAmount} ${route.buyAsset}`,
  minimum: `${route.expectedBuyAmountMaxSlippage} ${route.buyAsset}`,
  estimated_seconds: route.estimatedTime?.total
})

type ComparedRoute = { route: string; expected_output: string; minimum_output?: string; estimated_seconds?: number; legs: unknown[] }

const compareRoutes = (parts: Array<{ status: PromiseSettledResult<unknown>; built?: ComparedRoute; reasonName: string }>) => {
  const routes = parts.flatMap(p => (p.built ? [p.built] : []))
  const unavailable = parts.flatMap(p =>
    p.status.status === 'rejected' ? [{ route: p.reasonName, reason: p.status.reason instanceof Error ? p.status.reason.message : 'no quote' }] : []
  )
  if (!routes.length) {
    const first = parts.find(p => p.status.status === 'rejected')
    throw first && first.status.status === 'rejected' ? first.status.reason : new ToolError('No route for this pair and amount right now')
  }
  const best = routes.reduce((a, b) => (Number(b.expected_output) > Number(a.expected_output) ? b : a))
  return {
    best: best.route,
    expected_output: best.expected_output,
    routes,
    unavailable,
    cash_bridge_fee: '0',
    next_step:
      'Show the routes to the user. If they agree, call prepare_bridge with the same assets and amount, the sending address as source_address (their BCH address when BCH or a CashToken is sold), the receiving address as destination_address, and route set to the one they chose (best by default).'
  }
}

// The THORChain, NEAR Intents and ShapeShift quotes for one pair side by side; `first` is a leg all of them start with.
const compareQuotes = (
  thor: PromiseSettledResult<QuoteResponseRoute>,
  near: PromiseSettledResult<NearRoute | undefined>,
  shape: PromiseSettledResult<ShapeShiftRoute | undefined>,
  first: unknown[] = []
) =>
  compareRoutes([
    {
      status: thor,
      reasonName: 'thorchain',
      built:
        thor.status === 'fulfilled'
          ? { route: 'thorchain', expected_output: thor.value.expectedBuyAmount, estimated_seconds: thor.value.estimatedTime?.total, legs: [...first, legOf(thor.value)] }
          : undefined
    },
    {
      status: near,
      reasonName: 'near_intents',
      built:
        near.status === 'fulfilled' && near.value
          ? {
              route: 'near_intents',
              expected_output: near.value.expectedBuyAmount,
              minimum_output: near.value.expectedBuyAmountMaxSlippage,
              estimated_seconds: near.value.estimatedTime?.total,
              legs: [...first, nearLeg(near.value)]
            }
          : undefined
    },
    {
      status: shape,
      reasonName: 'shapeshift',
      built:
        shape.status === 'fulfilled' && shape.value
          ? {
              route: 'shapeshift',
              expected_output: shape.value.expectedBuyAmount,
              minimum_output: shape.value.expectedBuyAmountMaxSlippage,
              estimated_seconds: shape.value.estimatedTime?.total,
              legs: [...first, shapeLeg(shape.value)]
            }
          : undefined
    }
  ])

const tokenBuyFromBch = async (token: CauldronToken, bchAmount: string) => {
  const sale = await tokenQuote(token.category, 'buy', secondLegSellAmount(toBaseUnits(bchAmount, 8)))
  const output = formatBaseUnits(sale.output, token.decimals)
  return {
    output,
    minimum: formatBaseUnits(minOutputFor(sale.output), token.decimals),
    leg: {
      provider: 'Cauldron, through the Cashbridge Router',
      sell: `${formatBaseUnits(sale.sell, 8)} BCH`,
      buy: `${output} ${token.ticker}`,
      pool_fee_sats: sale.tradeFeeSats.toString()
    }
  }
}

// --- list_supported_assets -----------------------------------------------------------------------

const listSupportedAssets = async (args: Args) => {
  const search = text(args, 'search', false)?.toLowerCase()
  const [pools, tokens] = await Promise.all([
    getMidgardPools().catch(() => undefined),
    (search ? searchCauldronTokens(search) : fetchCauldronTokens()).catch(() => (search ? [] : [...FEATURED_TOKENS]))
  ])
  const external = (pools ?? [])
    .filter(p => ((p as { status?: string }).status ?? 'available').toLowerCase() === 'available' && !p.asset.toUpperCase().startsWith('BCH.'))
    .filter(p => !search || p.asset.toLowerCase().includes(search))
    .map(p => ({ asset: p.asset, price_usd: (isDollarStable(p.asset) ? 1 : Number(p.assetPriceUSD)).toPrecision(6) }))
  return {
    bch_side: [
      ...(!search || 'bch bitcoin cash'.includes(search) ? [{ asset: BridgeConfig.buyAsset, name: 'Bitcoin Cash', decimals: 8, route: 'THORChain to or from your BCH address' }] : []),
      ...tokens.map(t => ({ ...tokenInfo(t), route: 'Cauldron, through the Cashbridge Router' }))
    ],
    other_side: external,
    other_side_error: pools ? undefined : 'THORChain pool list is unavailable right now',
    directions: {
      to_bch: 'Any other_side asset to BCH.BCH or to a bch_side token.',
      from_bch: 'BCH.BCH or a bch_side token to any other_side asset. Token sales prepare through the Cashbridge Router when it admits them.',
      near_intents:
        'Between BCH.BCH and assets on ADA, ARB, AVAX, BASE, BERA, BSC, BTC, DASH, DOGE, ETH, GNO, LTC, MONAD, NEAR, OP, POL, SOL, SUI, TON, TRON, XLAYER and ZEC, both ways, NEAR Intents is quoted too; name them the same way (CHAIN.SYMBOL-CONTRACT). Free pairs between two of these chains are quoted on NEAR Intents too. CashToken purchases and sales can use NEAR when the Router admits them.',
      shapeshift:
        'Any-network free pairs (two other_side assets) quote ShapeShift beside THORChain when ShapeShift maps both. Plain BCH pairs, and the BCH leg of CashToken purchases and sales through the Router, are quoted the same way when the asset maps.',
      free_pairs: 'Two THORChain assets with no BCH side (for example ETH.ETH to BTC.BTC) use Any-network Manual: THORChain, NEAR Intents and ShapeShift.'
    }
  }
}

// --- get_bridge_quote ----------------------------------------------------------------------------

const getBridgeQuote = async (args: Args) => {
  const amount = decimalAmount(args)
  const matched = await pair(args)
  const percent = slippage(args)

  if (matched.kind === 'network') {
    const { sellAsset, buyAsset } = matched
    const [thor, near, shape] = await Promise.allSettled([
      thorchainRoute({ sellAsset, buyAsset, sellAmount: amount, slippage: percent }, getNetworkQuotes),
      nearAvailable(sellAsset) && nearAvailable(buyAsset)
        ? nearQuote({ sellAsset, buyAsset, sellAmount: amount, dry: true, slippageBps: nearSlippageBps(percent) })
        : Promise.resolve(undefined),
      shapeShiftAvailable(sellAsset, buyAsset) ? shapeShiftQuote(sellAsset, buyAsset, amount, percent) : Promise.resolve(undefined)
    ])
    return {
      from: { asset: sellAsset, amount },
      to: { asset: buyAsset },
      mode: 'any_network',
      ...compareQuotes(thor, near, shape)
    }
  }

  const { reverse, external, side } = matched
  const token = side.token
  if (!token) {
    // Plain BCH, either way: THORChain, NEAR Intents and ShapeShift when mapped.
    const [sellAsset, buyAsset] = reverse ? [BridgeConfig.buyAsset, external] : [external, BridgeConfig.buyAsset]
    const [thor, near, shape] = await Promise.allSettled([
      thorchainRoute({ sellAsset, buyAsset, sellAmount: amount, slippage: percent }),
      nearAvailable(external) ? nearQuote({ sellAsset, buyAsset, sellAmount: amount, dry: true, slippageBps: nearSlippageBps(percent) }) : Promise.resolve(undefined),
      shapeShiftAvailable(sellAsset, buyAsset) ? shapeShiftQuote(sellAsset, buyAsset, amount, percent) : Promise.resolve(undefined)
    ])
    return {
      from: { asset: sellAsset, amount },
      to: reverse ? { asset: external } : { asset: BridgeConfig.buyAsset, decimals: 8 },
      ...compareQuotes(thor, near, shape)
    }
  }

  if (!reverse) {
    // CashToken purchase: THORChain (and NEAR or ShapeShift when the Router admits them), then Cauldron through the Router.
    const shapeOk = BridgeConfig.routerShapeShift && shapeShiftAvailable(external, BridgeConfig.buyAsset)
    const [thor, near, shape] = await Promise.allSettled([
      thorchainRoute({ sellAsset: external, buyAsset: BridgeConfig.buyAsset, sellAmount: amount, slippage: percent }),
      BridgeConfig.routerNear && nearAvailable(external)
        ? nearQuote({ sellAsset: external, buyAsset: BridgeConfig.buyAsset, sellAmount: amount, dry: true, slippageBps: nearSlippageBps(percent) })
        : Promise.resolve(undefined),
      shapeOk ? shapeShiftQuote(external, BridgeConfig.buyAsset, amount, percent) : Promise.resolve(undefined)
    ])
    const parts: Array<{ status: PromiseSettledResult<unknown>; built?: ComparedRoute; reasonName: string }> = []
    if (thor.status === 'fulfilled') {
      const second = await tokenBuyFromBch(token, thor.value.expectedBuyAmount)
      parts.push({
        status: thor,
        reasonName: 'thorchain',
        built: {
          route: 'thorchain',
          expected_output: second.output,
          minimum_output: second.minimum,
          estimated_seconds: thor.value.estimatedTime?.total,
          legs: [legOf(thor.value), second.leg]
        }
      })
    } else parts.push({ status: thor, reasonName: 'thorchain' })
    if (near.status === 'fulfilled' && near.value) {
      const second = await tokenBuyFromBch(token, near.value.expectedBuyAmount)
      parts.push({
        status: near,
        reasonName: 'near_intents',
        built: {
          route: 'near_intents',
          expected_output: second.output,
          minimum_output: second.minimum,
          estimated_seconds: near.value.estimatedTime?.total,
          legs: [nearLeg(near.value), second.leg]
        }
      })
    } else if (BridgeConfig.routerNear && nearAvailable(external)) parts.push({ status: near, reasonName: 'near_intents' })
    if (shape.status === 'fulfilled' && shape.value) {
      const second = await tokenBuyFromBch(token, shape.value.expectedBuyAmount)
      parts.push({
        status: shape,
        reasonName: 'shapeshift',
        built: {
          route: 'shapeshift',
          expected_output: second.output,
          minimum_output: second.minimum,
          estimated_seconds: shape.value.estimatedTime?.total,
          legs: [shapeLeg(shape.value), second.leg]
        }
      })
    } else if (shapeOk) parts.push({ status: shape, reasonName: 'shapeshift' })
    return {
      from: { asset: external, amount },
      to: tokenInfo(token),
      ...compareRoutes(parts),
      note: 'The Router fixes its own CashToken minimum from a fresh pool quote when prepare_bridge opens the order.'
    }
  }

  // Token sale: Cauldron, then THORChain (Router sale when admitted), or NEAR Intents / ShapeShift when the Router
  // admits routed sales. NEAR's FLEX_INPUT converts the whole sale the Router deposits, so it is quoted like THORChain on
  // the whole sale less the fee cap, as the form does; ShapeShift on the exact amount it takes (the rest comes back as BCH).
  const sale = await tokenQuote(token.category, 'sell', toBaseUnits(amount, token.decimals))
  if (sale.output <= DEPOSIT_FEE_RESERVE) throw new ToolError('This amount sells for too little BCH to bridge')
  const routed = BridgeConfig.routerSales && BridgeConfig.routerSaleRoutes
  const [thor, near, shape] = await Promise.allSettled([
    thorchainRoute({ sellAsset: BridgeConfig.buyAsset, buyAsset: external, sellAmount: formatBaseUnits(sale.output - DEPOSIT_FEE_RESERVE, 8), slippage: percent }),
    routed && nearAvailable(external)
      ? nearQuote({ sellAsset: BridgeConfig.buyAsset, buyAsset: external, sellAmount: formatBaseUnits(sale.output - REFUND_FEE_CAP, 8), dry: true, slippageBps: nearSlippageBps(percent) })
      : Promise.resolve(undefined),
    routed && shapeShiftSaleSats(sale.output) > 0n && shapeShiftAvailable(BridgeConfig.buyAsset, external)
      ? shapeShiftQuote(BridgeConfig.buyAsset, external, formatBaseUnits(shapeShiftSaleSats(sale.output), 8), percent)
      : Promise.resolve(undefined)
  ])
  const first = {
    provider: BridgeConfig.routerSales ? 'Cauldron, through the Cashbridge Router sale' : 'Cauldron',
    sell: `${formatBaseUnits(sale.sell, token.decimals)} ${token.ticker}`,
    buy: `${formatBaseUnits(sale.output, 8)} BCH`,
    pool_fee_sats: sale.tradeFeeSats.toString()
  }
  return {
    from: { ...tokenInfo(token), amount },
    to: { asset: external },
    ...compareQuotes(thor, near, shape, [first]),
    ...(routed && { note: 'On shapeshift the Router deposits an exact amount and sends the rest of the sale back to source_address as BCH.' }),
    ...(!BridgeConfig.routerSales && { next_step: `Selling ${token.ticker} back through the Router is not admitted right now; send the user to ${AppConfig.baseUrl}/bridge.` })
  }
}

// --- prepare_bridge --------------------------------------------------------------------------------

const DEPOSIT_ABI = new Interface(['function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration)'])
const APPROVE_ABI = new Interface(['function approve(address spender, uint256 amount)'])

const inboundList = async () => {
  const inbounds = (await getInboundAddresses().catch(() => undefined)) as InboundAddress[] | undefined
  if (!inbounds?.length) throw new ToolError('THORChain did not list its inbound addresses; try again shortly')
  return inbounds
}

// The source chain's vault a forward deposit pays, open for trading.
const freshInbound = (inbounds: InboundAddress[], chain: string, vault: string) => {
  const inbound = inbounds.find(i => i.chain === chain)
  if (!inbound) throw new ToolError(`THORChain has no ${chain} inbound address right now`)
  if (inbound.halted || inbound.chain_trading_paused || inbound.global_trading_paused) throw new ToolError(`THORChain has paused ${chain} trading`)
  if (inbound.address.toLowerCase() !== vault.toLowerCase()) throw new ToolError(`The quoted vault is not THORChain's current ${chain} vault; ask for a new quote`)
  return inbound
}


// An EVM token's contract, read after the last dash as NEAR Intents and ShapeShift read it (`BASE.USDC-0X8335…`);
// undefined for the gas coin. A contract part that is no address is refused, never paid as the gas coin.
const evmTokenOf = (asset: string) => {
  const dash = asset.lastIndexOf('-')
  if (dash < 0) return undefined
  const contract = asset.slice(dash + 1).toLowerCase()
  if (!isAddress(contract)) throw new ToolError(`${asset} names no valid token contract`)
  return getAddress(contract)
}

// The EVM deposit, built here from THORNode's current router and vault and the quoted memo and expiry. The
// aggregator's ready-made transaction is simulated against the wallet, so it fails before the token is approved.
const evmTransactions = async (route: QuoteResponseRoute, chain: string, inbound: InboundAddress) => {
  if (!inbound.router) throw new ToolError(`THORChain has no ${chain} router right now`)
  const expiry = Number(route.expiration)
  if (!Number.isSafeInteger(expiry) || expiry * 1000 <= Date.now()) throw new ToolError('THORChain gave this quote no valid expiry; ask for a new one')
  const asset = evmTokenOf(route.sellAsset) ?? ZeroAddress
  // Every EVM gas asset THORChain carries has 18 decimals.
  const decimals = asset === ZeroAddress ? 18 : await poolDecimals(route.sellAsset)
  let amount: bigint
  try {
    amount = toBaseUnits(route.sellAmount, decimals)
  } catch {
    throw new ToolError(`"amount" has more decimals than ${route.sellAsset} takes (${decimals})`)
  }
  const router = getAddress(inbound.router)
  const from = route.sourceAddress
  const chainId = Number(getChainConfig(chain as Chain).chainId)
  const data = DEPOSIT_ABI.encodeFunctionData('depositWithExpiry', [inbound.address, asset, amount, route.memo, expiry])
  const deposit = { step: 'deposit', to: router, from, data, value: asset === ZeroAddress ? amount.toString() : '0', chain_id: chainId }
  if (asset === ZeroAddress) return [deposit]
  return [
    {
      step: 'approve',
      description: `Let the THORChain router take ${route.sellAmount} of the token. Skip it when the allowance already covers this amount.`,
      to: asset,
      from,
      data: APPROVE_ABI.encodeFunctionData('approve', [router, amount]),
      value: '0',
      chain_id: chainId
    },
    deposit
  ]
}

const HOW_TO_SEND: Record<string, string> = {
  UTXO: 'Send exactly the amount to inbound_address in one transaction that also has an OP_RETURN output carrying the memo. Send from source_address: THORChain refunds to the first input.',
  COSMOS: 'Send exactly the amount to inbound_address with the memo in the transaction memo field.',
  OTHER: 'Send exactly the amount to inbound_address with the memo, the way THORChain documents deposits for this chain.'
}

// Forward routes reach here with their memo already checked to pay the BCH destination (getQuotes keeps only those).
const depositOf = async (route: QuoteResponseRoute, destination: string, reverse: boolean) => {
  const chain = route.sellAsset.split('.')[0].toUpperCase()
  if (!route.memo || !route.inboundAddress) throw new ToolError('THORChain gave no deposit address for this quote; ask for a new one')
  const inbounds = await inboundList()
  let inbound: InboundAddress
  if (reverse) {
    try {
      checkDepositMemo(route.memo, { buyAsset: route.buyAsset, destination, minOut: route.expectedBuyAmountMaxSlippage })
      checkInbound(inbounds, route.inboundAddress, route.buyAsset.split('.')[0].toUpperCase())
    } catch (error) {
      throw new ToolError(`${error instanceof Error ? error.message : 'The deposit does not match its quote'}; ask for a new quote`)
    }
    inbound = inbounds.find(i => i.chain === 'BCH')!
  } else inbound = freshInbound(inbounds, chain, route.inboundAddress)
  const evm = (EVMChains as readonly string[]).includes(chain)
  const kind = evm ? 'EVM' : ['BTC', 'LTC', 'DOGE', 'BCH', 'DASH', 'ZEC'].includes(chain) ? 'UTXO' : chain === 'GAIA' ? 'COSMOS' : 'OTHER'
  return {
    deposit: {
      chain,
      asset: route.sellAsset,
      amount: route.sellAmount,
      inbound_address: route.inboundAddress,
      memo: route.memo,
      ...(inbound.router && { router: inbound.router }),
      expires_at: /^\d{9,11}$/.test(route.expiration ?? '') ? new Date(Number(route.expiration) * 1000).toISOString() : route.expiration,
      how_to_send: evm ? 'Sign and send the transactions below in order from source_address.' : HOW_TO_SEND[kind]
    },
    ...(evm && { transactions: await evmTransactions(route, chain, inbound) })
  }
}

const SAFETY = 'Show the user the amounts, the destination and the deposit before they sign. Never ask for a seed phrase or private key. Do not reuse this deposit after expires_at: prepare a new one.'

const plainBchAddress = (address: string, field = 'destination_address') => {
  if (bchAddressProblem(address, false)) throw new ToolError(`"${field}" must be a mainnet Bitcoin Cash address (bitcoincash:q… or z…)`)
  return bindingFromAddress(address)!.cashAddress
}

const routerCall = async (method: 'GET' | 'POST', path: string, capability: string, ip: string, body?: unknown) => {
  let response: { status: number; body: Buffer } | undefined
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${capability}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
    if (ip) headers['cf-connecting-ip'] = ip
    response = await callWorker(method, path, headers, body === undefined ? undefined : Buffer.from(JSON.stringify(body)))
  } catch {
    response = undefined
  }
  const result = (() => {
    try {
      return JSON.parse(response?.body.toString('utf8') ?? '')
    } catch {
      return undefined
    }
  })()
  if (!response || response.status >= 500) throw new ToolError(typeof result?.error === 'string' && response ? `Cashbridge Router: ${result.error}` : 'Cashbridge Router is unavailable right now; bridge to BCH.BCH instead, or try again later')
  if (response.status >= 400) throw new ToolError(`Cashbridge Router: ${typeof result?.error === 'string' ? result.error : `request failed (${response.status})`}`)
  return result as PublicOrder | undefined
}

const verified = (order: PublicOrder | undefined, id: string, intent?: OrderIntent) => {
  try {
    return checkOrder(order, id, intent)
  } catch (error) {
    throw new ToolError(`Cashbridge Router: ${error instanceof Error ? error.message : 'invalid order'}; nothing was sent, do not pay this order`)
  }
}

const orderBrief = (order: PublicOrder, capability: string, token: CauldronToken) => ({
  id: order.id,
  // The order's only key: whoever has it can read the order. Keep it with the transfer; it is not shown again.
  token: capability,
  deposit_address: order.depositAddress,
  contract: !!order.contract,
  recipient: order.recipientAddress,
  refund_address: order.refundAddress,
  minimum_output: `${formatBaseUnits(order.minPusd, token.decimals)} ${token.ticker}`,
  max_wait_seconds: order.maxWaitSeconds,
  ...(order.nearDepositAddress && { near_deposit_address: order.nearDepositAddress }),
  ...(order.shapeshiftQuoteId && { shapeshift_quote_id: order.shapeshiftQuoteId }),
  ...(order.sale && {
    sale: {
      category: order.sale.category,
      token_amount: order.sale.tokenAmount,
      buy_asset: order.sale.buyAsset,
      destination: order.sale.destination,
      ...(order.sale.route && { route: order.sale.route }),
      ...(order.sale.depositSats && { deposit_sats: order.sale.depositSats })
    }
  })
})

const prepareBridge = async (args: Args, context: ToolContext) => {
  const amount = decimalAmount(args)
  const matched = await pair(args)
  const percent = slippage(args)
  const source = text(args, 'source_address')!
  const destination = text(args, 'destination_address')!

  if (matched.kind === 'network') {
    const via = routeChoice(args, ['thorchain', 'near_intents', 'shapeshift'])
    const { sellAsset, buyAsset } = matched
    const sourceChain = sellAsset.split('.')[0].toUpperCase()
    if ((EVMChains as readonly string[]).includes(sourceChain) && !isAddress(source))
      throw new ToolError(`"source_address" must be the ${sourceChain} address that sends the funds`)
    if (via === 'shapeshift') return prepareShapeShift(sellAsset, buyAsset, amount, source, destination, percent)
    if (via === 'near_intents') return { ...(await prepareNear(sellAsset, buyAsset, amount, source, destination, percent)), mode: 'any_network' }
    const route = await thorchainRoute({
      sellAsset,
      buyAsset,
      sellAmount: amount,
      slippage: percent,
      sourceAddress: source,
      destinationAddress: destination,
      refundAddress: source
    }, getNetworkQuotes)
    try {
      checkDepositMemo(route.memo!, { buyAsset, destination, minOut: route.expectedBuyAmountMaxSlippage })
    } catch (error) {
      throw new ToolError(`${error instanceof Error ? error.message : 'The deposit does not match its quote'}; ask for a new quote`)
    }
    return {
      route: 'THORChain',
      mode: 'any_network',
      ...(await depositOf(route, destination, false)),
      expected_output: `${route.expectedBuyAmount} ${buyAsset}`,
      destination_address: destination,
      refund_address: source,
      track: 'After sending, call get_bridge_status with source_tx set to the transaction hash.',
      safety: SAFETY
    }
  }

  const { reverse, external, side } = matched
  const via = routeChoice(args, ['thorchain', 'near_intents', 'shapeshift'])

  if (reverse) {
    if (side.token) {
      const saleRoute: SaleRoute | undefined = via === 'near_intents' ? 'near' : via === 'shapeshift' ? 'shapeshift' : undefined
      if (saleRoute && !BridgeConfig.routerSaleRoutes) throw new ToolError('CashToken sales use the Cashbridge Router on THORChain right now; set route to thorchain')
      return prepareRouterSale(side.token, amount, source, destination, external, percent, context, saleRoute)
    }
    const from = plainBchAddress(source, 'source_address')
    if (via === 'near_intents') return prepareNear(BridgeConfig.buyAsset, external, amount, from, destination, percent)
    if (via === 'shapeshift') return prepareShapeShift(BridgeConfig.buyAsset, external, amount, from, destination, percent)
    const route = await thorchainRoute({
      sellAsset: BridgeConfig.buyAsset,
      buyAsset: external,
      sellAmount: amount,
      slippage: percent,
      sourceAddress: from,
      destinationAddress: destination,
      refundAddress: from
    })
    return {
      route: 'THORChain',
      ...(await depositOf(route, destination, true)),
      expected_output: `${route.expectedBuyAmount} ${route.buyAsset}`,
      destination_address: destination,
      refund_address: from,
      track: 'After sending, call get_bridge_status with source_tx set to the transaction id.',
      safety: SAFETY
    }
  }

  const sourceChain = external.split('.')[0].toUpperCase()
  if ((EVMChains as readonly string[]).includes(sourceChain) && !isAddress(source))
    throw new ToolError(`"source_address" must be the ${sourceChain} address that sends the funds`)
  const executable = (to: string) =>
    thorchainRoute({
      sellAsset: external,
      buyAsset: BridgeConfig.buyAsset,
      sellAmount: amount,
      slippage: percent,
      sourceAddress: source,
      destinationAddress: to,
      refundAddress: source
    })

  if (!side.token) {
    const to = plainBchAddress(destination)
    if (via === 'near_intents') return prepareNear(external, BridgeConfig.buyAsset, amount, source, to, percent)
    if (via === 'shapeshift') return prepareShapeShift(external, BridgeConfig.buyAsset, amount, source, to, percent)
    const route = await executable(to)
    return {
      route: 'THORChain',
      ...(await depositOf(route, to, false)),
      expected_output: `${route.expectedBuyAmount} BCH`,
      destination_address: to,
      refund_address: source,
      track: 'After sending, call get_bridge_status with source_tx set to the transaction hash.',
      safety: SAFETY
    }
  }

  // CashToken purchase through the Cashbridge Router: THORChain or NEAR pays BCH into the order contract.
  const token = side.token
  const problem = bchAddressProblem(destination, true)
  if (problem)
    throw new ToolError(
      problem === 'notTokenAware'
        ? '"destination_address" must be a token-aware BCH address (bitcoincash:z…) to receive CashTokens'
        : '"destination_address" must be a mainnet Bitcoin Cash address'
    )
  if (via === 'shapeshift' && !BridgeConfig.routerShapeShift) throw new ToolError('ShapeShift is not enabled for Cashbridge Router orders; use route thorchain')
  if (via === 'shapeshift' && !shapeShiftAvailable(external, BridgeConfig.buyAsset)) throw new ToolError('ShapeShift does not map this asset here; use route thorchain')
  if (!context.allowWrite()) throw new ToolError('Too many orders from this client; wait a few minutes')

  const expected =
    via === 'near_intents'
      ? await nearQuote({
          sellAsset: external,
          buyAsset: BridgeConfig.buyAsset,
          sellAmount: amount,
          dry: true,
          slippageBps: nearSlippageBps(percent)
        })
      : via === 'shapeshift'
        ? await shapeShiftQuote(external, BridgeConfig.buyAsset, amount, percent)
        : await thorchainRoute({ sellAsset: external, buyAsset: BridgeConfig.buyAsset, sellAmount: amount, slippage: percent })
  if (!expected) throw new ToolError(`${via === 'shapeshift' ? 'ShapeShift' : 'NEAR Intents'} has no quote for this pair and amount right now`)

  const intent: OrderIntent = {
    recipientAddress: destination,
    refundAddress: destination,
    source: { chain: sourceChain, asset: external, amount, address: source },
    expectedBchSats: toBaseUnits(expected.expectedBuyAmount, 8).toString()
  }
  if (token.category !== BridgeConfig.pusd.category) intent.category = token.category
  const id = randomUUID()
  const capability = randomBytes(32).toString('hex')
  let order = verified(await routerCall('POST', '/orders', capability, context.ip, { id, ...intent }), id, intent)
  if (order.apiVersion !== 2 || order.recoveryRequired) throw new ToolError('Cashbridge Router is being updated; try again later')
  // The contract is required here too; the minimum is shown to the user, who checks it before paying.
  try {
    checkNewOrder(order)
  } catch (error) {
    throw new ToolError(`${error instanceof Error ? error.message : 'Invalid order'}; nothing was sent, do not pay this order`)
  }

  if (via === 'near_intents') {
    if (!BridgeConfig.routerNear) throw new ToolError('NEAR Intents is not enabled for Cashbridge Router orders; use route thorchain')
    const now = Date.now()
    const near = await nearQuote({
      sellAsset: external,
      buyAsset: BridgeConfig.buyAsset,
      sellAmount: amount,
      sourceAddress: source,
      recipient: order.depositAddress,
      refundTo: source,
      dry: false,
      slippageBps: nearSlippageBps(percent),
      now
    })
    if (!near?.near.quote.depositAddress) throw new ToolError('NEAR Intents gave no deposit for this Router order; use route thorchain')
    if (!isBridgeRoute(near, { sellAsset: external, destinationAddress: order.depositAddress }))
      throw new ToolError('NEAR Intents quoted a deposit that does not pay this order; nothing was sent, ask for a new quote')
    // 1Click's `quote.deadline` is when the deposit address goes inactive (days later); the swap refunds at the one we asked for.
    if (!nearPaysBeforeRefund(order, now + FORWARD_DEADLINE_MS))
      throw new ToolError('NEAR Intents payout may arrive after this order can expire; use route thorchain or ask for a new quote')
    const depositAddress = near.near.quote.depositAddress
    try {
      order = verified(await routerCall('POST', `/orders/${id}`, capability, context.ip, { nearDepositAddress: depositAddress }), id, intent)
    } catch (error) {
      if (error instanceof ToolError && /not available through the Cashbridge Router/i.test(error.message))
        throw new ToolError('Cashbridge Router is not admitting NEAR orders right now; use route thorchain')
      throw error
    }
    if (order.nearDepositAddress !== depositAddress) throw new ToolError('Cashbridge Router did not keep the NEAR deposit address; nothing was sent')
    const prepared = await prepareNear(external, BridgeConfig.buyAsset, amount, source, order.depositAddress, percent, near)
    return {
      ...prepared,
      route: 'NEAR Intents, then Cauldron through the Cashbridge Router',
      order: orderBrief(order, capability, token),
      expected_bch: `${near.expectedBuyAmount} BCH`,
      track: 'After sending, call report_source_transaction with the order id, token and transaction hash, then poll get_bridge_status.',
      safety: `${SAFETY} If the Router cannot buy at least minimum_output in time, it sends the BCH to refund_address.`
    }
  }

  if (via === 'shapeshift') {
    // ShapeShift's BCH quotes are one-use NEAR Intents addresses; 1Click confirms this one pays the order's contract.
    const now = Date.now()
    const shape = await getShapeShiftBridgeRoute({
      sellAsset: external,
      buyAsset: BridgeConfig.buyAsset,
      sellAmount: amount,
      sellDecimals: await assetDecimals(external),
      buyDecimals: 8,
      slippage: percent,
      sourceAddress: source,
      destinationAddress: order.depositAddress
    }).catch(error => {
      throw new ToolError(error instanceof Error ? error.message : 'ShapeShift gave no quote')
    })
    const leg = shape?.shapeshift.near
    if (!shape || !leg?.shapeshiftQuoteId) throw new ToolError('ShapeShift gave no NEAR Intents deposit for this Router order; use route thorchain')
    if (!new USwapNumber(shape.sellAmount).eqValue(amount)) throw new ToolError('ShapeShift quoted a different amount; nothing was sent, ask for a new quote')
    if (!nearPaysBeforeRefund(order, now + FORWARD_DEADLINE_MS))
      throw new ToolError('ShapeShift payout may arrive after this order can expire; use route thorchain or ask for a new quote')
    try {
      order = verified(
        await routerCall('POST', `/orders/${id}`, capability, context.ip, { nearDepositAddress: leg.depositAddress, shapeshiftQuoteId: leg.shapeshiftQuoteId }),
        id,
        intent
      )
    } catch (error) {
      if (error instanceof ToolError && /not available through the Cashbridge Router/i.test(error.message))
        throw new ToolError('Cashbridge Router is not admitting ShapeShift orders right now; use route thorchain')
      throw error
    }
    if (order.nearDepositAddress !== leg.depositAddress) throw new ToolError('Cashbridge Router did not keep the ShapeShift deposit address; nothing was sent')
    const units = BigInt(leg.amountIn)
    const transactions = plainTransferTxs(external, source, leg.depositAddress, units)
    return {
      route: 'ShapeShift (NEAR Intents), then Cauldron through the Cashbridge Router',
      deposit: {
        chain: sourceChain,
        asset: external,
        amount: shape.sellAmount,
        amount_base_units: units.toString(),
        deposit_address: leg.depositAddress,
        expires_at: shape.shapeshift.expiresAt ? new Date(shape.shapeshift.expiresAt).toISOString() : shape.expiration,
        how_to_send:
          'Send exactly the amount to deposit_address in a plain transfer from source_address: no memo, no OP_RETURN and no approval. The address is for this one transfer only.'
      },
      ...(transactions && { transactions }),
      order: orderBrief(order, capability, token),
      expected_bch: `${shape.expectedBuyAmount} BCH`,
      shapeshift: { quote_id: leg.shapeshiftQuoteId, swapper: shape.shapeshift.swapper },
      explorer: nearExplorerUrl(leg.depositAddress),
      track: 'After sending, call report_source_transaction with the order id, token and transaction hash, then poll get_bridge_status.',
      safety: `${SAFETY} If the Router cannot buy at least minimum_output in time, it sends the BCH to refund_address.`
    }
  }

  const route = await executable(order.depositAddress)
  if (!new USwapNumber(route.sellAmount).eqValue(amount)) throw new ToolError('THORChain quoted a different amount; ask for a new quote')
  return {
    route: 'THORChain, then Cauldron through the Cashbridge Router',
    ...(await depositOf(route, order.depositAddress, false)),
    order: orderBrief(order, capability, token),
    expected_bch: `${route.expectedBuyAmount} BCH`,
    track: 'After sending, call report_source_transaction with the order id, token and transaction hash, then poll get_bridge_status.',
    safety: `${SAFETY} If the Router cannot buy at least minimum_output in time, it sends the BCH to refund_address.`
  }
}

const TRANSFER_ABI = new Interface(['function transfer(address to, uint256 amount)'])

const plainTransferTxs = (sellAsset: string, source: string, deposit: string, units: bigint) => {
  const chain = sellAsset.split('.')[0].toUpperCase()
  const evm = (EVMChains as readonly string[]).includes(chain)
  if (!evm) return undefined
  const token = evmTokenOf(sellAsset)
  const chainId = Number(getChainConfig(chain as Chain).chainId)
  return [
    token
      ? { step: 'transfer', to: token, from: source, data: TRANSFER_ABI.encodeFunctionData('transfer', [deposit, units]), value: '0', chain_id: chainId }
      : { step: 'transfer', to: deposit, from: source, data: '0x', value: units.toString(), chain_id: chainId }
  ]
}

// NEAR Intents, to or from plain BCH (or paying a Router order address): a one-use deposit address paid by a plain transfer.
const prepareNear = async (
  sellAsset: string,
  buyAsset: string,
  amount: string,
  source: string,
  to: string,
  percent: number,
  existing?: NearRoute
) => {
  const external = [sellAsset, buyAsset].find(asset => asset !== BridgeConfig.buyAsset && !nearAvailable(asset)) ?? (sellAsset === BridgeConfig.buyAsset ? buyAsset : sellAsset)
  if (!nearAvailable(external)) throw new ToolError(`NEAR Intents does not carry ${external.split('.')[0]} here; use route thorchain`)
  const route =
    existing ??
    (await nearQuote({
      sellAsset,
      buyAsset,
      sellAmount: amount,
      sourceAddress: source,
      recipient: to,
      refundTo: source,
      dry: false,
      slippageBps: nearSlippageBps(percent)
    }))
  if (!route?.near.quote.depositAddress) throw new ToolError(`NEAR Intents does not list ${external}; use route thorchain`)
  const deposit = route.near.quote.depositAddress
  const chain = sellAsset.split('.')[0].toUpperCase()
  if (chain === 'BCH' && (bchAddressProblem(deposit, false) || !new USwapNumber(route.sellAmount).eqValue(amount)))
    throw new ToolError('NEAR Intents quoted a deposit that does not match this transfer; nothing was sent, ask for a new quote')
  const units = BigInt(route.near.quote.amountIn)
  const transactions = plainTransferTxs(sellAsset, source, deposit, units)
  return {
    route: 'NEAR Intents',
    deposit: {
      chain,
      asset: sellAsset,
      amount: route.sellAmount,
      amount_base_units: units.toString(),
      deposit_address: deposit,
      expires_at: route.near.quoteRequest?.deadline ?? route.near.quote.deadline,
      how_to_send:
        'Send exactly the amount to deposit_address in a plain transfer from source_address: no memo, no OP_RETURN and no approval. The address is for this one transfer only.'
    },
    ...(transactions && { transactions }),
    expected_output: `${route.expectedBuyAmount} ${unit(buyAsset)}`,
    minimum_output: `${route.expectedBuyAmountMaxSlippage} ${unit(buyAsset)}`,
    destination_address: to,
    refund_address: source,
    near_quote: { correlation_id: route.near.correlationId, signature: route.near.signature, quoted_at: route.near.timestamp },
    explorer: nearExplorerUrl(deposit),
    track: 'After sending, call report_source_transaction with near_deposit_address and the transaction hash, then poll get_bridge_status with near_deposit_address.',
    safety: SAFETY
  }
}

const prepareShapeShift = async (sellAsset: string, buyAsset: string, amount: string, source: string, destination: string, percent: number) => {
  if (!shapeShiftAvailable(sellAsset, buyAsset)) throw new ToolError('ShapeShift does not map this pair here; use route thorchain or near_intents')
  const route = await shapeShiftQuote(sellAsset, buyAsset, amount, percent, { source, destination })
  if (!route?.shapeshift.depositAddress || !route.shapeshift.quoteId)
    throw new ToolError('ShapeShift gave no deposit address for this pair; use another route')
  if (!new USwapNumber(route.sellAmount).eqValue(amount))
    throw new ToolError('ShapeShift quoted a different amount; nothing was sent, ask for a new quote')
  const deposit = route.shapeshift.depositAddress
  const units = toBaseUnits(amount, await assetDecimals(sellAsset))
  const chain = sellAsset.split('.')[0].toUpperCase()
  const transactions = plainTransferTxs(sellAsset, source, deposit, units)
  return {
    route: 'ShapeShift',
    deposit: {
      chain,
      asset: sellAsset,
      amount: route.sellAmount,
      amount_base_units: units.toString(),
      deposit_address: deposit,
      expires_at: route.shapeshift.expiresAt ? new Date(route.shapeshift.expiresAt).toISOString() : route.expiration,
      how_to_send:
        'Send exactly the amount to deposit_address in a plain transfer from source_address: no memo, no OP_RETURN and no approval. The address is for this one transfer only.'
    },
    ...(transactions && { transactions }),
    expected_output: `${route.expectedBuyAmount} ${buyAsset}`,
    minimum_output: `${route.expectedBuyAmountMaxSlippage} ${buyAsset}`,
    destination_address: destination,
    refund_address: source,
    shapeshift: { quote_id: route.shapeshift.quoteId, swapper: route.shapeshift.swapper },
    track: 'After sending, call get_bridge_status with shapeshift_quote_id. Optionally report_source_transaction with shapeshift_quote_id and source_tx once the wallet confirms.',
    safety: SAFETY
  }
}

// CashToken sale through the Router: the user sends tokens to the sale contract; the Router sells and deposits to
// THORChain, or (`saleRoute`) to a NEAR Intents or ShapeShift address the Router checks at 1Click.
const prepareRouterSale = async (
  token: CauldronToken,
  amount: string,
  source: string,
  destination: string,
  buyAsset: string,
  percent: number,
  context: ToolContext,
  saleRoute?: SaleRoute
) => {
  if (!BridgeConfig.routerSales) throw new ToolError(`Selling ${token.ticker} back through the Router is not admitted right now; send the user to ${AppConfig.baseUrl}/bridge`)
  const problem = bchAddressProblem(source, true)
  if (problem)
    throw new ToolError(
      problem === 'notTokenAware'
        ? '"source_address" must be a token-aware BCH address (bitcoincash:z…) that holds the CashTokens'
        : '"source_address" must be a mainnet Bitcoin Cash address'
    )
  const binding = bindingFromAddress(source)
  if (!binding) throw new ToolError('"source_address" must be a mainnet Bitcoin Cash address')
  if (!context.allowWrite()) throw new ToolError('Too many orders from this client; wait a few minutes')

  const units = toBaseUnits(amount, token.decimals)
  const sale = await tokenQuote(token.category, 'sell', units)
  if (sale.output <= DEPOSIT_FEE_RESERVE) throw new ToolError('This amount sells for too little BCH to bridge')
  const leg = saleRoute ? await routedSaleLeg(saleRoute, sale.output, binding.cashAddress, buyAsset, destination, percent) : await thorchainSaleLeg(sale.output, binding.cashAddress, buyAsset, destination, percent)
  const saleIntent: SaleIntent = {
    category: token.category,
    tokenAmount: sale.sell.toString(),
    buyAsset,
    destination,
    ...leg.sale
  }
  const intent: OrderIntent = {
    recipientAddress: binding.tokenAddress,
    refundAddress: binding.tokenAddress,
    expectedBchSats: sale.output.toString(),
    sale: saleIntent
  }
  const id = randomUUID()
  const capability = randomBytes(32).toString('hex')
  const order = verified(await routerCall('POST', '/orders', capability, context.ip, { id, ...intent }), id, intent)
  if (order.apiVersion !== 2 || order.recoveryRequired) throw new ToolError('Cashbridge Router is being updated; try again later')
  if (!order.contract || order.contract.refundAfter > Date.now() / 1000 + REFUND_AFTER_SECONDS + 600)
    throw new ToolError('The Cashbridge Router order returns the tokens later than it should; nothing was sent')
  const minSats = BigInt(order.minPusd)
  if (minSats < minOutputFor(sale.output, SALE_FLOOR_TOLERANCE_BPS))
    throw new ToolError('The Cashbridge Router offered a lower minimum than this quote; nothing was sent')
  const toScript = addressToLockingBytecode(order.depositAddress)
  if (!toScript) throw new ToolError('The Cashbridge Router order has no deposit address')

  let send: ReturnType<typeof buildTokenSend> | undefined
  try {
    const { utxos } = await listWalletCoins(binding.lockingBytecode)
    send = buildTokenSend(utxos, binding, token, sale.sell, toScript)
  } catch (error) {
    // UTXOs may be unavailable from this host; the agent can still instruct a manual token send.
    send = undefined
    if (!(error instanceof Error)) throw error
  }

  return {
    route: `Cashbridge Router sale, then ${leg.name}`,
    deposit: {
      chain: 'BCH',
      asset: token.ticker,
      category: token.category,
      amount: formatBaseUnits(sale.sell, token.decimals),
      amount_base_units: sale.sell.toString(),
      deposit_address: order.depositAddress,
      how_to_send: send
        ? 'Sign and broadcast the unsigned BCH transaction below from source_address. It sends the CashTokens to the sale contract.'
        : `From source_address, send exactly ${formatBaseUnits(sale.sell, token.decimals)} ${token.ticker} (category ${token.category}) to deposit_address in one CashToken output. Keep enough plain BCH for the network fee.`
    },
    ...(send && {
      transactions: [
        {
          step: 'token_send',
          chain: 'BCH',
          unsigned_hex: send.unsignedHex,
          fee_sats: send.feeSats.toString(),
          source_outputs: send.sourceOutputs,
          own_indexes: send.ownIndexes
        }
      ]
    }),
    order: orderBrief(order, capability, token),
    expected_bch: `${formatBaseUnits(sale.output, 8)} BCH`,
    expected_output: `${leg.expectedOut} ${buyAsset}`,
    destination_address: destination,
    refund_address: binding.tokenAddress,
    ...(leg.near && { near_deposit_address: leg.near.depositAddress, explorer: nearExplorerUrl(leg.near.depositAddress) }),
    ...(leg.near?.shapeshiftQuoteId && { shapeshift: { quote_id: leg.near.shapeshiftQuoteId } }),
    ...(saleRoute === 'shapeshift' && { change: 'The Router deposits an exact amount; the rest of the sale comes back to the BCH address as plain BCH.' }),
    track: 'After sending, call report_source_transaction with the order id, token and BCH transaction hash, then poll get_bridge_status.',
    safety: `${SAFETY} If the Router cannot sell for at least the order minimum in time, it returns the tokens to refund_address.`
  }
}

const thorchainSaleLeg = async (bchOut: bigint, refund: string, buyAsset: string, destination: string, percent: number) => {
  const route = await thorchainRoute({
    sellAsset: BridgeConfig.buyAsset,
    buyAsset,
    sellAmount: formatBaseUnits(bchOut - DEPOSIT_FEE_RESERVE, 8),
    slippage: percent,
    sourceAddress: refund,
    destinationAddress: destination,
    refundAddress: refund
  })
  if (!route.memo || !route.inboundAddress) throw new ToolError('THORChain gave no deposit for this sale; ask for a new quote')
  if (!isBridgeRoute(route, { sellAsset: BridgeConfig.buyAsset, buyAsset, destinationAddress: destination }))
    throw new ToolError('THORChain quoted a deposit that does not match this sale; nothing was sent')
  try {
    checkDepositMemo(route.memo, { buyAsset, destination, minOut: route.expectedBuyAmountMaxSlippage })
  } catch (error) {
    throw new ToolError(`${error instanceof Error ? error.message : 'The deposit does not match its quote'}; ask for a new quote`)
  }
  const inbounds = await inboundList()
  checkInbound(inbounds, route.inboundAddress, buyAsset.split('.')[0].toUpperCase())
  return { name: 'THORChain', sale: { memo: route.memo, vaultAddress: route.inboundAddress }, expectedOut: route.expectedBuyAmount, near: undefined }
}

const routedSaleLeg = async (route: SaleRoute, bchOut: bigint, refund: string, buyAsset: string, destination: string, percent: number) => {
  const binding = bindingFromAddress(refund)!
  const leg = await routedDeposit({
    route,
    bchOut,
    binding,
    buyAsset,
    buyDecimals: route === 'shapeshift' ? await assetDecimals(buyAsset) : undefined,
    destination,
    slippage: percent
  }).catch(error => {
    throw new ToolError(`${error instanceof Error ? error.message : 'No quote'}; use route thorchain or ask again`)
  })
  return { name: route === 'near' ? 'NEAR Intents' : 'ShapeShift (NEAR Intents)', ...leg }
}

// --- Status ----------------------------------------------------------------------------------------

const ORDER_STATES: Record<OrderState, string> = {
  awaiting_deposit: 'Waiting for the source deposit (THORChain, NEAR Intents or ShapeShift into the order, or CashTokens into a sale contract).',
  streaming: 'The bridge (THORChain, NEAR Intents or ShapeShift) is still swapping.',
  awaiting_confirmations: 'The BCH arrived; waiting for the confirmations the order needs.',
  ready: 'Funds arrived; the Router is buying the token or depositing the sale.',
  retrying: 'The Router is retrying settlement.',
  broadcasting: 'The Router is sending the payout.',
  submitted: 'Done: the payout is in the BCH mempool. Nothing waits for confirmations.',
  completed: 'Done: the order settled.',
  refunded: 'Funds were returned to the refund address.',
  source_refunded: 'The first leg refunded the source transaction.',
  manual_review: 'Held for the operator to review. Do not send again.'
}

const orderCredentials = (args: Args) => {
  const id = text(args, 'order_id')!
  const capability = text(args, 'order_token')!
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ToolError('"order_id" is not an order id')
  if (!/^[a-f0-9]{64}$/.test(capability)) throw new ToolError('"order_token" is not an order token')
  return { id, capability }
}

const orderSummary = (order: PublicOrder) => ({
  order_id: order.id,
  state: order.state,
  meaning: ORDER_STATES[order.state] ?? order.state,
  deposit_address: order.depositAddress,
  recipient: order.recipientAddress,
  refund_address: order.refundAddress,
  received_sats: order.receivedSats,
  source_tx: order.sourceHash,
  thorchain_inbound: order.inboundHash,
  near_deposit_address: order.nearDepositAddress,
  ...(order.shapeshiftQuoteId && { shapeshift_quote_id: order.shapeshiftQuoteId }),
  sale: order.sale,
  payout_txid: order.payoutTxid ?? order.settlement?.txid,
  settlement: order.settlement,
  source_refunds: order.sourceRefunds,
  deadline: order.deadline ? new Date(order.deadline).toISOString() : undefined,
  error: order.error
})

const sourceStatus = (hash: string, status: TxStatusResponse) => {
  const outs = (status.out_txs ?? []).map(o => ({ chain: o.chain, to: o.to_address, txid: o.id, coins: o.coins, refund: !!o.memo?.toUpperCase().startsWith('REFUND') }))
  const stages = status.stages ?? {}
  const planned = status.planned_out_txs ?? []
  const done = outs.length > 0 && outs.length >= planned.length && !stages.swap_status?.pending
  return {
    source_tx: hash,
    state: !stages.inbound_observed?.completed ? 'not_seen' : done ? (outs.every(o => o.refund) ? 'refunded' : 'completed') : 'pending',
    memo: status.tx?.memo,
    stages,
    outbound: outs,
    planned_outbound: planned,
    note: 'THORChain reports this state; check the payout transaction on its own chain before treating the transfer as done.'
  }
}

const STATUS_IDS = 'Give order_id + order_token, near_deposit_address, shapeshift_quote_id, or source_tx'

const getBridgeStatus = async (args: Args, context: ToolContext) => {
  if (args.order_id !== undefined || args.order_token !== undefined) {
    const { id, capability } = orderCredentials(args)
    return orderSummary(verified(await routerCall('GET', `/orders/${id}`, capability, context.ip), id))
  }
  const shapeId = text(args, 'shapeshift_quote_id', false)
  if (shapeId) {
    const status = await getShapeShiftStatus(shapeId).catch(() => undefined)
    if (!status) throw new ToolError('ShapeShift did not answer for this quote id; try again shortly')
    return {
      shapeshift_quote_id: shapeId,
      status: status.status,
      ...interpretShapeShiftStatus(status),
      source_tx: status.txHash,
      buy_tx: status.buyTxHash,
      explorer: status.swapperTxLink,
      note: 'ShapeShift reports this state; check the payout transaction on its own chain before treating the transfer as done.'
    }
  }
  const near = text(args, 'near_deposit_address', false)
  if (near) {
    const status = await getNearStatus(near).catch(() => undefined)
    if (!status) throw new ToolError('NEAR Intents did not answer for this deposit address; try again shortly')
    return {
      near_deposit_address: near,
      status: status.status,
      ...interpretNearStatus(status),
      explorer: nearExplorerUrl(near),
      note: 'NEAR Intents reports this state; check the payout on the destination chain before treating the transfer as done.'
    }
  }
  const raw = text(args, 'source_tx', false)
  if (!raw) throw new ToolError(STATUS_IDS)
  const hash = sourceTransactionId(raw)
  if (!hash) throw new ToolError('"source_tx" is not a transaction hash')
  const status = await getTxStatus(hash).catch(() => undefined)
  if (!status) throw new ToolError('THORChain did not answer; try again shortly')
  return sourceStatus(hash, status)
}

const reportSourceTransaction = async (args: Args, context: ToolContext) => {
  const near = text(args, 'near_deposit_address', false)
  const shapeId = text(args, 'shapeshift_quote_id', false)
  const raw = text(args, 'source_tx')!
  if (near) {
    // A chain transaction id: hex (0x or not), base58 (Solana, NEAR), base64 (TON) or similar, never free text.
    if (!/^[0-9A-Za-z+/=_-]{32,128}$/.test(raw.replace(/^0x/i, ''))) throw new ToolError('"source_tx" is not a transaction hash')
    if (!context.allowWrite()) throw new ToolError('Too many updates from this client; wait a few minutes')
    const reported = await submitNearDeposit(near, raw)
    return {
      near_deposit_address: near,
      source_tx: raw,
      reported,
      ...(!reported && { note: 'NEAR Intents did not take the notice; the swap still starts once the deposit confirms. Poll get_bridge_status.' })
    }
  }
  if (shapeId) {
    if (!context.allowWrite()) throw new ToolError('Too many updates from this client; wait a few minutes')
    const status = await getShapeShiftStatus(shapeId).catch(() => undefined)
    if (!status) throw new ToolError('ShapeShift did not answer for this quote id; try again shortly')
    return {
      shapeshift_quote_id: shapeId,
      source_tx: raw,
      status: status.status,
      ...interpretShapeShiftStatus(status),
      reported: true,
      note: 'ShapeShift tracks externally paid quotes by quote id; keep polling get_bridge_status with shapeshift_quote_id.'
    }
  }
  if (args.order_id === undefined && args.order_token === undefined)
    throw new ToolError('Give order_id + order_token, near_deposit_address, or shapeshift_quote_id with source_tx')
  const { id, capability } = orderCredentials(args)
  const hash = sourceTransactionId(raw)
  if (!hash) throw new ToolError('"source_tx" is not a transaction hash')
  if (!context.allowWrite()) throw new ToolError('Too many order updates from this client; wait a few minutes')
  return orderSummary(verified(await routerCall('POST', `/orders/${id}`, capability, context.ip, { sourceHash: hash }), id))
}

// --- Definitions -----------------------------------------------------------------------------------

const assetProps = {
  from_asset: {
    type: 'string',
    description:
      'What the user sells: a THORChain asset (BASE.USDC-0X8335…, ETH.ETH, BTC.BTC), BCH.BCH, a Cauldron token (PUSD, MUSD), or for Any-network free pairs another THORChain asset.'
  },
  to_asset: {
    type: 'string',
    description:
      'What the user receives: BCH.BCH, a Cauldron token (PUSD, MUSD or a category id), a THORChain asset back from BCH, or for Any-network free pairs another THORChain asset.'
  },
  amount: { type: 'string', description: 'Amount of from_asset as a decimal string, e.g. "25" or "0.015".' },
  slippage_percent: { type: 'number', description: 'Slippage tolerance in percent (0.1 to 5, default 1).' }
}

export const TOOLS: Tool[] = [
  {
    name: 'list_supported_assets',
    title: 'List supported assets',
    description:
      'Lists what Cash Bridge can bridge: the BCH side (BCH.BCH and Cauldron CashTokens such as PUSD) and the assets on other chains. Any-network free pairs use two other_side assets.',
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Optional filter, e.g. "usdc", "base" or "pusd".' } } },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    run: listSupportedAssets
  },
  {
    name: 'get_bridge_quote',
    title: 'Quote a bridge transfer',
    description:
      'Quotes a transfer: THORChain, NEAR Intents and ShapeShift compared where available, for plain BCH, CashToken purchases and sales through the Cashbridge Router (when it admits them), and Any-network free pairs. Indicative only; nothing is reserved.',
    inputSchema: { type: 'object', properties: assetProps, required: ['from_asset', 'to_asset', 'amount'] },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    run: getBridgeQuote
  },
  {
    name: 'prepare_bridge',
    title: 'Prepare a bridge deposit',
    description:
      "Prepares a transfer for the user's own wallet to sign: THORChain vault+memo, NEAR Intents or ShapeShift deposit address, Cashbridge Router purchase (THORChain, NEAR Intents or ShapeShift first leg), or Router sale of a CashToken (paid out through any of the three). Never signs or sends anything.",
    inputSchema: {
      type: 'object',
      properties: {
        ...assetProps,
        source_address: {
          type: 'string',
          description: 'The address that sends the funds (token-aware BCH bitcoincash:z… when selling a CashToken); refunds go to it.'
        },
        destination_address: {
          type: 'string',
          description: 'Where the user receives: token-aware BCH for CashTokens, a plain BCH address, or the payout address on another chain.'
        },
        route: {
          type: 'string',
          enum: ['thorchain', 'near_intents', 'shapeshift'],
          description:
            'Which route to use, as get_bridge_quote compared them (default thorchain). CashToken purchases and sales use the Cashbridge Router on any of the three when it admits them.'
        }
      },
      required: ['from_asset', 'to_asset', 'amount', 'source_address', 'destination_address']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: prepareBridge
  },
  {
    name: 'report_source_transaction',
    title: 'Report the source transaction',
    description:
      'Tells the Cashbridge Router (order_id and order_token), NEAR Intents (near_deposit_address) or ShapeShift (shapeshift_quote_id) which transaction paid the deposit, so it is matched sooner.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The order id from prepare_bridge.' },
        order_token: { type: 'string', description: 'The order token from prepare_bridge.' },
        near_deposit_address: { type: 'string', description: 'The NEAR Intents deposit address from prepare_bridge.' },
        shapeshift_quote_id: { type: 'string', description: 'The ShapeShift quote id from prepare_bridge.' },
        source_tx: { type: 'string', description: 'The hash of the transaction the user sent.' }
      },
      required: ['source_tx']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: reportSourceTransaction
  },
  {
    name: 'get_bridge_status',
    title: 'Check a transfer',
    description:
      'Shows where a transfer is: a Cashbridge Router order, a NEAR Intents deposit, a ShapeShift quote id, or a THORChain swap by its source transaction hash. Give one: order_id + order_token, near_deposit_address, shapeshift_quote_id, or source_tx.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Cashbridge Router order id, with order_token.' },
        order_token: { type: 'string', description: 'The order token from prepare_bridge.' },
        near_deposit_address: { type: 'string', description: 'The NEAR Intents deposit address from prepare_bridge.' },
        shapeshift_quote_id: { type: 'string', description: 'The ShapeShift quote id from prepare_bridge.' },
        source_tx: { type: 'string', description: 'Source transaction hash, for a transfer without a Router order.' }
      }
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    run: getBridgeStatus
  }
]

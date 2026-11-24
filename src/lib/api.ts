import axios from 'axios'
import { AssetValue, Chain, EVMChains, getChainConfig } from '@tcswap/core'
import { ProviderName, USwapError } from '@tcswap/helpers'
import { BalanceResponse, QuoteRequest, QuoteResponse, QuoteResponseRoute, USwapApi } from '@tcswap/helpers/api'
import { normalizeThorBankDenom, thorchainPayoutsHalted } from '@/lib/swap-helpers'
import { referralHeaders } from '@/lib/referral'
import { aggregatorApiUrl, BridgeConfig } from '@/config'
import { addressToLockingBytecode } from '@/lib/bch'
import { swapMemoPays } from '@/lib/bridge'
import { isNearRoute } from '@/lib/near-intents'
import { isShapeShiftRoute } from '@/lib/shapeshift'
import { BelowMinimumError, minimumFromProviderErrors } from '@/lib/errors'
import { sourceTransactionId } from '@/lib/source-transaction'

// Through our own proxy, which adds the aggregator API key on the server (src/app/api/thorchain).
const uSwap = axios.create()
uSwap.interceptors.request.use(config => ({ ...config, baseURL: aggregatorApiUrl() }))

const DEXSCREENER_MIN_LIQUIDITY_USD = 10_000

export const getDexScreenerTokens = async (
  tokenAddresses: string[],
  chainId: 'solana' | 'ethereum' | 'near' = 'solana'
): Promise<Record<string, { price?: number; logo?: string }>> => {
  if (tokenAddresses.length === 0) return {}
  // The endpoint takes "up to 30 addresses" per call (DexScreener API reference).
  if (tokenAddresses.length > 30) {
    const chunks = Array.from({ length: Math.ceil(tokenAddresses.length / 30) }, (_, i) => tokenAddresses.slice(i * 30, i * 30 + 30))
    return Object.assign({}, ...(await Promise.all(chunks.map(chunk => getDexScreenerTokens(chunk, chainId)))))
  }
  const addresses = tokenAddresses.join(',')
  try {
    const res = await axios.get(`https://api.dexscreener.com/tokens/v1/${chainId}/${addresses}`)
    const result: Record<string, { price?: number; logo?: string }> = {}
    const liquidity: Record<string, { total: number; best: number }> = {}
    for (const pair of res.data || []) {
      const addr = pair?.baseToken?.address
      if (!addr) continue
      const key = chainId === 'solana' ? addr : addr.toLowerCase()
      const existing = result[key] ?? {}
      const pairLiquidity = Number(pair?.liquidity?.usd) || 0
      const seen = liquidity[key] ?? { total: 0, best: -1 }
      seen.total += pairLiquidity
      // Price from the deepest pool: spam tokens often have a shallow pair quoting a made-up price.
      if (pair?.priceUsd != null && pairLiquidity > seen.best) {
        existing.price = parseFloat(pair.priceUsd)
        seen.best = pairLiquidity
      }
      liquidity[key] = seen
      if (!existing.logo && pair?.info?.imageUrl) {
        existing.logo = pair.info.imageUrl
      }
      result[key] = existing
    }
    // Airdropped spam tokens sit in near-empty pools; a price from one is not a real price.
    for (const key of Object.keys(result)) {
      if (liquidity[key].total < DEXSCREENER_MIN_LIQUIDITY_USD) delete result[key].price
    }
    return result
  } catch {
    return {}
  }
}

// A stalled provider would otherwise hold a tracking poll open forever; a timeout fails into the next attempt.
const timeout = 15_000
const thornode = axios.create({ baseURL: 'https://gateway.liquify.com/chain/thorchain_api', timeout })
const midgard = axios.create({ baseURL: 'https://gateway.liquify.com/chain/thorchain_midgard', timeout })
const mayaMidgard = axios.create({ baseURL: 'https://midgard.mayachain.info', timeout })
const mayanode = axios.create({ baseURL: 'https://mayanode.mayachain.info', timeout })

export const getMidgardPools = async (): Promise<{ asset: string; assetPriceUSD: string; status?: string }[]> => {
  return midgard.get('/v2/pools').then(res => res.data)
}

export const getMidgardRunePrice = async (): Promise<number> => {
  return midgard.get('/v2/stats').then(res => parseFloat(res.data.runePriceUSD))
}

export const getMayaMidgardPools = async (): Promise<{ asset: string; assetPriceUSD: string }[]> => {
  return mayaMidgard.get('/v2/pools').then(res => res.data)
}

export const getMayaMidgardCacaoPrice = async (): Promise<number> => {
  return mayaMidgard.get('/v2/stats').then(res => parseFloat(res.data.cacaoPriceUSD))
}

export const getThorBankBalances = async (address: string): Promise<AssetValue[]> => {
  try {
    const res = await thornode.get(`/cosmos/bank/v1beta1/balances/${address}`)
    const balances: { denom: string; amount: string }[] = res.data?.balances || []
    const out: AssetValue[] = []
    for (const { denom, amount } of balances) {
      if (!denom || denom.includes('IBC/')) continue
      const asset = normalizeThorBankDenom(denom)
      if (!asset) continue
      try {
        out.push(AssetValue.from({ asset, fromBaseDecimal: 8, value: amount }))
      } catch {
        // skip unparseable denoms
      }
    }
    return out
  } catch {
    return []
  }
}

export const getAssetBalance = async (chain: Chain, address: string, identifier: string) => {
  return uSwap
    .get(`/balance?chain=${chain}&address=${address}&identifier=${identifier}`)
    .then(res => res.data)
    .then((data: BalanceResponse) => {
      const { baseDecimal } = getChainConfig(chain)
      return data.map(({ identifier, value, decimal }) => {
        return new AssetValue({ decimal: decimal || baseDecimal, identifier, value })
      })
    })
}

export class BridgeRouteError extends Error {}

// Every aggregator quote goes through here, so this is where the bridge's THORChain leg is enforced:
// THORChain only, with native BCH.BCH on exactly one side (bought in the forward direction, sold in
// the reverse one), with the aggregator's own streaming policy (no interval, quantity or
// destination-memo overrides).
export const isReverseBridgeRequest = (json: Pick<QuoteRequest, 'sellAsset'>) => json.sellAsset?.toUpperCase() === BridgeConfig.buyAsset

export const assertBridgeQuoteRequest = (json: Pick<QuoteRequest, 'buyAsset' | 'sellAsset' | 'providers'>) => {
  const [bchSide, otherSide] = isReverseBridgeRequest(json) ? [json.sellAsset, json.buyAsset] : [json.buyAsset, json.sellAsset]
  if (bchSide?.toUpperCase() !== BridgeConfig.buyAsset) throw new BridgeRouteError(`Only ${BridgeConfig.buyAsset} can be bought`)
  if (!otherSide || otherSide.toUpperCase().startsWith('BCH.')) throw new BridgeRouteError('BCH cannot be on both sides of the bridge')
  if (!json.providers?.length || json.providers.some(p => p !== ProviderName.THORCHAIN)) throw new BridgeRouteError('Only the THORChain provider is supported')
}

// A returned route is only usable if it is still the bridge's: THORChain (or a NEAR Intents route this app built
// itself, see near-intents.ts, or a ShapeShift one whose 1Click swap was checked), trading exactly the asked
// pair and (for an executable quote) paying the destination that was asked for.
export const isBridgeRoute = (route: QuoteResponseRoute, request: Pick<QuoteRequest, 'sellAsset' | 'destinationAddress'> & { buyAsset?: string }) => {
  const reverse = isReverseBridgeRequest(request)
  const buyAsset = reverse ? request.buyAsset : BridgeConfig.buyAsset
  return (
    !!buyAsset &&
    route.buyAsset?.toUpperCase() === buyAsset.toUpperCase() &&
    route.sellAsset?.toUpperCase() === request.sellAsset.toUpperCase() &&
    route.providers?.length === 1 &&
    (BridgeConfig.providers.includes(route.providers[0]) || isNearRoute(route) || (isShapeShiftRoute(route) && !!route.shapeshift.near)) &&
    (!request.destinationAddress ||
      (reverse
        ? route.destinationAddress?.toLowerCase() === request.destinationAddress.toLowerCase()
        : sameBchScript(route.destinationAddress, request.destinationAddress) &&
          // The memo, not the echoed address, is what THORChain pays: it must name the same BCH script.
          (!route.memo || swapMemoPays(route.memo, addressToLockingBytecode(request.destinationAddress) ?? ''))))
  )
}

// The aggregator echoes a BCH destination without its `bitcoincash:` prefix, so the two are compared by the
// script they pay, never as strings: a string match drops every route quoted to the bound wallet.
const sameBchScript = (a: string | undefined, b: string) => {
  const script = a ? addressToLockingBytecode(a) : undefined
  return !!script && script === addressToLockingBytecode(b)
}

// The SDK's request client logs every non-OK answer as a USwapError before throwing it, so an amount
// under the minimum (an expected 404) would read as an error. Post the quote ourselves: that case
// becomes a quiet BelowMinimumError; any other failure is the same USwapError the SDK raises.
// THORChain answering the aggregator too slowly: the only provider timed out, a transient state.
const providerTimedOut = (status: number, body: unknown) => {
  const errors = (body as { providerErrors?: { errorCode?: string }[] } | null)?.providerErrors
  return status === 404 && !!errors?.length && errors.every(e => e.errorCode === 'requestTimeOut')
}

export class QuoteTimeoutError extends Error {}

// The page asks through our proxy, which adds the key; the server (the agent endpoint) asks the aggregator itself.
const quoteEndpoint = (): [string, Record<string, string>] =>
  typeof window === 'undefined' && process.env.THORCHAIN_API_KEY
    ? [`${(process.env.THORCHAIN_API_URL || 'https://api.thorchain.org/v1').replace(/\/$/, '')}/quote`, { 'x-api-key': process.env.THORCHAIN_API_KEY }]
    : [`${aggregatorApiUrl()}/quote`, referralHeaders()]

const postQuote = async (request: QuoteRequest, abortController?: AbortController, attempt = 0): Promise<QuoteResponse> => {
  const [url, headers] = quoteEndpoint()
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    // A redirect would carry the server's key to another host.
    redirect: 'error',
    signal: abortController?.signal
  })
  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const minimum = response.status === 404 ? minimumFromProviderErrors(body) : undefined
    if (minimum) throw new BelowMinimumError(minimum)
    // Asked once more, then reported quietly like the minimum: it is not an error of this app.
    if (providerTimedOut(response.status, body)) {
      if (attempt === 0 && !abortController?.signal.aborted) return postQuote(request, abortController, 1)
      throw new QuoteTimeoutError('THORChain did not answer in time')
    }

    const errorData = { status: response.status, statusText: response.statusText }
    throw new USwapError({ errorKey: 'helpers_invalid_response', info: errorData }, { ...errorData, ...(body && { errorData: body }) })
  }
  if (body?.error) throw new USwapError('api_v2_server_error', { message: body.error })

  return body
}

// THORChain still quotes during a signing or outbound halt, while it holds every payout and refund on the chain, so a
// quote is refused then. Read with fetch beside the quote; a mimir that fails or does not answer within 10 s blocks nothing.
const quoteWhilePayoutsRun = async (request: QuoteRequest, abortController?: AbortController) => {
  const [quote, held] = await Promise.all([
    postQuote(request, abortController),
    fetch('https://gateway.liquify.com/chain/thorchain_api/thorchain/mimir', { signal: AbortSignal.timeout(10_000) })
      .then(res => (res.ok ? res.json() : undefined))
      .then(mimir => !!mimir && thorchainPayoutsHalted(mimir, [request.sellAsset, request.buyAsset]))
      .catch(() => false)
  ])
  if (held) throw new Error('THORChain is holding payouts on this network right now')
  return quote
}

export const getQuotes = async (json: QuoteRequest, abortController?: AbortController) => {
  assertBridgeQuoteRequest(json)
  const { sellAsset, sellAmount, sourceAddress, destinationAddress, refundAddress, slippage, dry } = json
  const buyAsset = isReverseBridgeRequest(json) ? json.buyAsset : BridgeConfig.buyAsset
  const request: QuoteRequest = {
    buyAsset,
    sellAsset,
    sellAmount,
    slippage,
    providers: [ProviderName.THORCHAIN],
    ...(sourceAddress && { sourceAddress }),
    ...(destinationAddress && { destinationAddress }),
    ...(refundAddress && { refundAddress }),
    ...(dry !== undefined && { dry })
  }

  return quoteWhilePayoutsRun(request, abortController).then(res =>
    res.routes
      .map(route => ({ ...route, sellAsset: requestCase(route.sellAsset, sellAsset), buyAsset: requestCase(route.buyAsset, buyAsset) }))
      .filter(route => isBridgeRoute(route, request))
  )
}

// THORChain's free-pair quotes (NEAR Intents and ShapeShift ones come from getNetworkRoutes); the BCH bridge keeps its stricter guard above.
type NetworkQuoteRequest = QuoteRequest & { buyAssetShortCode?: string }

export const isNetworkRoute = (route: QuoteResponseRoute, request: NetworkQuoteRequest) => {
  if (
    route.sellAsset !== request.sellAsset || route.buyAsset !== request.buyAsset ||
    route.providers?.length !== 1 || !BridgeConfig.providers.includes(route.providers[0])
  ) return false
  if (!request.destinationAddress) return true
  const chain = request.buyAsset.split('.')[0] as Chain
  const sameAddress = (address?: string) => {
    if (!address) return false
    if (chain === Chain.BitcoinCash) return sameBchScript(address, request.destinationAddress!)
    return EVMChains.includes(chain as never)
      ? address.toLowerCase() === request.destinationAddress!.toLowerCase()
      : address === request.destinationAddress
  }
  const [operation, memoAsset, ...memo] = (route.memo ?? '').split(':')
  const memoAddress = memo[0] === 'bitcoincash' ? `${memo[0]}:${memo[1]}` : memo[0]
  const assets = [request.buyAsset, request.buyAssetShortCode].filter(Boolean).map(asset => asset!.toUpperCase())
  return sameAddress(route.destinationAddress) && ['=', 'swap', 's'].includes(operation.toLowerCase()) &&
    assets.includes(memoAsset?.toUpperCase()) && sameAddress(memoAddress)
}

export const getNetworkQuotes = async (json: NetworkQuoteRequest, abortController?: AbortController) => {
  if (!json.sellAsset || !json.buyAsset || json.sellAsset === json.buyAsset ||
    !json.providers?.length || json.providers.some(provider => !BridgeConfig.providers.some(allowed => allowed === provider))) {
    throw new BridgeRouteError('Free pairs require two different assets and THORChain')
  }
  const { sellAsset, buyAsset, sellAmount, slippage, sourceAddress, destinationAddress, refundAddress, dry } = json
  const request: QuoteRequest = {
    sellAsset, buyAsset, sellAmount, slippage, providers: [ProviderName.THORCHAIN],
    ...(sourceAddress && { sourceAddress }),
    ...(destinationAddress && { destinationAddress }),
    ...(refundAddress && { refundAddress }),
    ...(dry !== undefined && { dry })
  }
  const response = await quoteWhilePayoutsRun(request, abortController)
  return response.routes
    .map(route => ({ ...route, sellAsset: requestCase(route.sellAsset, sellAsset), buyAsset: requestCase(route.buyAsset, buyAsset) }))
    .filter(route => isNetworkRoute(route, { ...request, buyAssetShortCode: json.buyAssetShortCode }))
}

// The aggregator upper-cases the asset identifiers it echoes back, which breaks case-sensitive base58 contracts: the
// SDK builds the transfer from `route.sellAsset`, and TronWeb rejects `TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T` as an
// invalid contract (toolbox_tron_transaction_creation_failed). Hand back the identifier as we asked for it.
function requestCase(returned: string, requested: string) {
  return returned && requested && returned.toUpperCase() === requested.toUpperCase() ? requested : returned
}

export const getTrack = async (data: Record<string, any>) => {
  return uSwap.post('/track', data).then(res => res.data)
}

export const getMimir = async (): Promise<Record<string, number>> => {
  return thornode.get('/thorchain/mimir').then(res => res.data)
}

export const getMayaMimir = async (): Promise<Record<string, number>> => {
  return mayanode.get('/mayachain/mimir').then(res => res.data)
}

export const getInboundAddresses = () => {
  return USwapApi.thornode.getInboundAddresses()
}

// The locking scripts of THORChain's BCH vault, the only signer of its payouts and refunds. Kept a few minutes: the
// vault changes only at a churn.
// shortcut: the active vault only; a payment from a retiring one during a churn waits for THORNode's report instead.
let bchVaults: { at: number; scripts: Promise<string[]> } | undefined
export const thorchainBchVaultScripts = () => {
  if (!bchVaults || Date.now() - bchVaults.at > 5 * 60_000) {
    const scripts = getInboundAddresses().then(list =>
      (list as unknown as { chain: string; address: string }[])
        .filter(inbound => inbound.chain === 'BCH')
        .map(inbound => addressToLockingBytecode(inbound.address))
        .filter((script): script is string => !!script)
    )
    bchVaults = { at: Date.now(), scripts }
    scripts.catch(() => (bchVaults = undefined))
  }
  return bchVaults.scripts
}

export interface TxStatusResponse {
  tx?: { id?: string; chain?: string; from_address?: string; to_address?: string; coins?: { asset: string; amount: string }[]; memo?: string }
  out_txs?: { id: string; chain: string; to_address?: string; coins: { asset: string; amount: string }[]; memo?: string }[]
  planned_out_txs?: { chain: string; to_address: string; coin: { asset: string; amount: string }; refund: boolean }[]
  stages?: {
    inbound_observed?: { completed?: boolean }
    inbound_confirmation_counted?: { remaining_confirmation_seconds?: number; completed?: boolean }
    inbound_finalised?: { completed?: boolean }
    swap_status?: { pending?: boolean; streaming?: { interval: number; quantity: number; count: number } }
    swap_finalised?: { completed?: boolean }
    outbound_delay?: { remaining_delay_seconds?: number; completed?: boolean }
    outbound_signed?: { completed?: boolean }
  }
}

export interface MidgardAction {
  status: string
  type: string
  in: { txID: string; address: string; coins: { asset: string; amount: string }[] }[]
  out: { txID: string; address: string; coins: { asset: string; amount: string }[] }[]
}

// Midgard's view of a swap, used to reconcile when THORNode is unreachable or silent.
export const getMidgardActions = async (txid: string): Promise<MidgardAction[]> => {
  return midgard.get('/v2/actions', { params: { txid: thorTxId(txid) } }).then(res => res.data?.actions ?? [])
}

// THORNode indexes inbounds by the bare hash. A wallet hands back the `0x`-prefixed form, and
// asking for that answers 200 with an empty, never-observed body rather than a 404 - so the
// transaction silently looks like it never arrived. Every /thorchain/tx/* route needs this.
export const thorTxId = (hash: string) => sourceTransactionId(hash) ?? hash.trim()

// An order's refund is published as an outbound of the *order's* inbound hash, so a cancelled
// order is watched through the hash it was placed with, not the hash that cancelled it.
export const getTxStatus = async (hash: string): Promise<TxStatusResponse> => {
  return thornode.get(`/thorchain/tx/status/${encodeURIComponent(thorTxId(hash))}`).then(res => res.data ?? {})
}


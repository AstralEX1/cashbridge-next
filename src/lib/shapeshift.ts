import { ProviderName } from '@tcswap/helpers'
import type { QuoteResponseRoute } from '@tcswap/helpers/api'
import { addressToLockingBytecode } from '@/lib/bch'
import { formatBaseUnits, toBaseUnits } from '@/lib/bridge'
import { baseUnits, getNearStatus, getNearTokens, NEAR_BCH, nearSlippageBps, nearTokenFor, PLACEHOLDERS } from '@/lib/near-intents'
import { sameAddress } from '@/lib/payout-chains'
import type { NearLeg } from '@/store/transaction-store'

// ShapeShift's public swap API (api.shapeshift.com, OpenAPI at /docs): the third route beside THORChain and NEAR
// Intents. Rates list every swapper; we keep those that can be paid by a plain transfer to a deposit address
// (`supportsExternalPayment`), the same wallet send NEAR Intents uses. Keyless; CORS is open. An optional partner
// code attributes swaps. Assets are CAIP-19.

export const SHAPESHIFT_URL = (process.env.NEXT_PUBLIC_SHAPESHIFT_URL || 'https://api.shapeshift.com').replace(/\/$/, '')

// ShapeShift is not in the SDK's provider list; routes carry this name through the rest of the app.
export const SHAPESHIFT_PROVIDER = 'SHAPESHIFT' as ProviderName

// THORChain-style chain prefix to its CAIP-2 chain, the coin's SLIP-44 number and its ticker. A contract-less
// identifier counts only when it is that ticker (so `THOR.TCY` is not read as RUNE).
// CAIP-2 values from ShapeShift `GET /v1/chains` (https://api.shapeshift.com/docs).
const CHAINS: Record<string, { caip: string; coin: number; native: string }> = {
  ARB: { caip: 'eip155:42161', coin: 60, native: 'ETH' },
  AVAX: { caip: 'eip155:43114', coin: 60, native: 'AVAX' },
  BASE: { caip: 'eip155:8453', coin: 60, native: 'ETH' },
  BCH: { caip: 'bip122:000000000000000000651ef99cb9fcbe', coin: 145, native: 'BCH' },
  BSC: { caip: 'eip155:56', coin: 60, native: 'BNB' },
  BTC: { caip: 'bip122:000000000019d6689c085ae165831e93', coin: 0, native: 'BTC' },
  DOGE: { caip: 'bip122:00000000001a91e3dace36e2be3bf030', coin: 3, native: 'DOGE' },
  ETH: { caip: 'eip155:1', coin: 60, native: 'ETH' },
  GAIA: { caip: 'cosmos:cosmoshub-4', coin: 118, native: 'ATOM' },
  GNO: { caip: 'eip155:100', coin: 60, native: 'XDAI' },
  LTC: { caip: 'bip122:12a765e31ffd4059bada1e25190f6e98', coin: 2, native: 'LTC' },
  MAYA: { caip: 'cosmos:mayachain-mainnet-v1', coin: 931, native: 'CACAO' },
  MEGAETH: { caip: 'eip155:4326', coin: 60, native: 'ETH' },
  MONAD: { caip: 'eip155:143', coin: 60, native: 'MON' },
  NEAR: { caip: 'near:mainnet', coin: 397, native: 'NEAR' },
  OP: { caip: 'eip155:10', coin: 60, native: 'ETH' },
  POL: { caip: 'eip155:137', coin: 60, native: 'POL' },
  SOL: { caip: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', coin: 501, native: 'SOL' },
  SUI: { caip: 'sui:35834a8a', coin: 784, native: 'SUI' },
  THOR: { caip: 'cosmos:thorchain-1', coin: 931, native: 'RUNE' },
  TON: { caip: 'ton:mainnet', coin: 607, native: 'TON' },
  TRON: { caip: 'tron:0x2b6653dc', coin: 195, native: 'TRX' },
  ZEC: { caip: 'bip122:00040fe8ec8471911baa1db1266ea15d', coin: 133, native: 'ZEC' }
}

// Prefixes with a `public/networks/{prefix.toLowerCase()}.svg` mark (MegaETH → megaeth.svg).
export const shapeShiftMappedPrefixes = (): string[] => Object.keys(CHAINS)

// THORChain upper-cases every contract, which base58 cannot survive. The stables the bridge lists are restored by
// hand; any other Solana/TRON token is left unmapped rather than guessed. EVM contracts are lower-cased in CAIP-19.
const BASE58_TOKENS: Record<string, { namespace: string; contracts: string[] }> = {
  SOL: { namespace: 'token', contracts: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'] },
  TRON: { namespace: 'trc20', contracts: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'] }
}
const EVM_PREFIXES = ['ARB', 'AVAX', 'BASE', 'BSC', 'ETH', 'GNO', 'MEGAETH', 'MONAD', 'OP', 'POL']

// CAIP-19 id for a THORChain-style identifier (`ETH.ETH`, `BASE.USDC-0X8335…`, `SOL.USDC-EPjF…`); undefined when
// ShapeShift does not carry the chain or the token cannot be named exactly.
export const shapeShiftAssetId = (identifier?: string): string | undefined => {
  const dot = identifier?.indexOf('.') ?? -1
  if (!identifier || dot < 0) return undefined
  const prefix = identifier.slice(0, dot).toUpperCase()
  const chain = CHAINS[prefix]
  if (!chain) return undefined
  const rest = identifier.slice(dot + 1)
  const dash = rest.lastIndexOf('-')
  if (dash < 0) return rest.toUpperCase() === chain.native ? `${chain.caip}/slip44:${chain.coin}` : undefined
  const contract = rest.slice(dash + 1)
  if (EVM_PREFIXES.includes(prefix)) return /^0X[0-9A-F]{40}$/i.test(contract) ? `${chain.caip}/erc20:${contract.toLowerCase()}` : undefined
  const base58 = BASE58_TOKENS[prefix]
  const exact = base58?.contracts.find(known => known.toUpperCase() === contract.toUpperCase())
  return base58 && exact ? `${chain.caip}/${base58.namespace}:${exact}` : undefined
}

export interface ShapeShiftRateRequest {
  sellAsset: string
  buyAsset: string
  // Decimal, in the sell asset's units.
  sellAmount: string
  sellDecimals: number
  buyDecimals: number
  // Percent, as the form holds it.
  slippage?: number
}

export interface ShapeShiftQuoteRequest extends ShapeShiftRateRequest {
  sourceAddress: string
  destinationAddress: string
}

interface RawRate {
  swapperName: string
  buyAmountCryptoBaseUnit: string
  sellAmountCryptoBaseUnit: string
  estimatedExecutionTimeMs?: number
  supportsExternalPayment?: boolean
  error?: unknown
}

export interface ShapeShiftQuoteResponse {
  quoteId: string
  swapperName: string
  sellAmountCryptoBaseUnit: string
  buyAmountAfterFeesCryptoBaseUnit: string
  depositAddress?: string
  expiresAt: number
  steps?: { estimatedExecutionTimeMs?: number }[]
}

// What a route keeps of ShapeShift's answer: enough to pay, track and explain it.
export interface ShapeShiftLeg {
  swapper: string
  quoteId?: string
  depositAddress?: string
  // Epoch ms.
  expiresAt?: number
  // A BCH leg: the NEAR Intents swap behind the deposit address, checked against 1Click (shapeShiftNearLeg).
  near?: NearLeg
}

export type ShapeShiftRoute = QuoteResponseRoute & { shapeshift: ShapeShiftLeg }
export const isShapeShiftRoute = (route?: QuoteResponseRoute): route is ShapeShiftRoute => route?.providers?.[0] === SHAPESHIFT_PROVIDER && 'shapeshift' in route

class ShapeShiftError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

const request = async <T,>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<T> => {
  const partner = process.env.NEXT_PUBLIC_SHAPESHIFT_PARTNER_CODE
  const response = await fetch(`${SHAPESHIFT_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers: { ...(init?.body !== undefined && { 'Content-Type': 'application/json' }), ...(partner && { 'X-Partner-Code': partner }) },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init?.signal ?? AbortSignal.timeout(20_000),
    cache: 'no-store'
  })
  const json = await response.json().catch(() => null)
  if (!response.ok) throw new ShapeShiftError(`ShapeShift: ${(json as { error?: string } | null)?.error ?? `HTTP ${response.status}`}`, response.status)
  return json as T
}

// Decimal fraction as ShapeShift takes it ("0.01" = 1%).
const slippageDecimal = (slippage?: number) => (nearSlippageBps(slippage) / 10_000).toString()

const ids = (req: ShapeShiftRateRequest) => {
  const sellAssetId = shapeShiftAssetId(req.sellAsset)
  const buyAssetId = shapeShiftAssetId(req.buyAsset)
  if (!sellAssetId || !buyAssetId || sellAssetId === buyAssetId) return undefined
  return { sellAssetId, buyAssetId }
}

// Swappers that quoted, can be paid by a deposit-address transfer, and pay something; best payout first.
export const depositRates = (rates: unknown): RawRate[] =>
  (Array.isArray(rates) ? (rates as RawRate[]) : [])
    .filter(rate => {
      try {
        return !rate.error && rate.supportsExternalPayment === true && BigInt(rate.buyAmountCryptoBaseUnit) > 0n
      } catch {
        return false
      }
    })
    .sort((a, b) => (BigInt(b.buyAmountCryptoBaseUnit) > BigInt(a.buyAmountCryptoBaseUnit) ? 1 : -1))

export const getShapeShiftRates = async (req: ShapeShiftRateRequest, signal?: AbortSignal): Promise<RawRate[]> => {
  const pair = ids(req)
  if (!pair) return []
  const query = new URLSearchParams({ ...pair, sellAmountCryptoBaseUnit: baseUnits(req.sellAmount, req.sellDecimals).toString(), slippageTolerancePercentageDecimal: slippageDecimal(req.slippage) })
  const { rates } = await request<{ rates: RawRate[] }>(`/v1/swap/rates?${query}`, { signal })
  return depositRates(rates)
}

// A bridge route from ShapeShift's answer. The executable one (a quote) names its deposit address and expiry.
export const shapeShiftRoute = (
  req: ShapeShiftRateRequest & { sourceAddress?: string; destinationAddress?: string },
  answer: { swapper: string; sell: string; buy: string; seconds?: number; quoteId?: string; depositAddress?: string; expiresAt?: number }
): ShapeShiftRoute => {
  const buy = BigInt(answer.buy)
  const min = (buy * BigInt(10_000 - nearSlippageBps(req.slippage))) / 10_000n
  return {
    providers: [SHAPESHIFT_PROVIDER],
    sellAsset: req.sellAsset,
    sellAmount: formatBaseUnits(answer.sell, req.sellDecimals),
    buyAsset: req.buyAsset,
    expectedBuyAmount: formatBaseUnits(buy, req.buyDecimals),
    expectedBuyAmountMaxSlippage: formatBaseUnits(min, req.buyDecimals),
    ...(req.destinationAddress && { destinationAddress: req.destinationAddress }),
    ...(req.sourceAddress && { sourceAddress: req.sourceAddress, refundAddress: req.sourceAddress }),
    ...(answer.depositAddress && { inboundAddress: answer.depositAddress, targetAddress: answer.depositAddress }),
    ...(answer.expiresAt && { expiration: String(Math.floor(answer.expiresAt / 1000)) }),
    estimatedTime: { total: answer.seconds ?? 0 },
    fees: [],
    meta: {} as QuoteResponseRoute['meta'],
    shapeshift: { swapper: answer.swapper, quoteId: answer.quoteId, depositAddress: answer.depositAddress, expiresAt: answer.expiresAt }
  } as ShapeShiftRoute
}

const MAX_SWAPPERS_TRIED = 3
// The least time a NEAR leg's refund deadline may leave to sign and send.
const MIN_DEADLINE_MS = 10 * 60_000

// A valid address on the asset's chain for a dry quote (1Click's placeholders); undefined where none is kept.
const dryAddress = (identifier: string) => {
  const prefix = identifier.split('.')[0].toUpperCase()
  return PLACEHOLDERS[EVM_PREFIXES.includes(prefix) ? 'evm' : prefix.toLowerCase()]
}

// An executable quote from the best swapper that really hands back a deposit address (the rate's flag is advisory),
// trying the next on a refusal. Dry (no addresses): the same quote for placeholder addresses, its deposit address
// dropped, because a rate leaves out fees the quote takes (0.01 BCH → Solana USDC was rated 1.96 but quoted 1.78
// after 1Click's withdrawal fee) and routes are compared on what is really paid out.
export const getShapeShiftQuote = async (req: ShapeShiftRateRequest & Partial<Pick<ShapeShiftQuoteRequest, 'sourceAddress' | 'destinationAddress'>>, signal?: AbortSignal): Promise<ShapeShiftRoute | undefined> => {
  const pair = ids(req)
  if (!pair) return undefined
  const candidates = await getShapeShiftRates(req, signal)
  const seconds = (ms?: number) => (ms ? Math.round(ms / 1000) : undefined)
  const dry = !req.sourceAddress || !req.destinationAddress
  const sendAddress = dry ? dryAddress(req.sellAsset) : req.sourceAddress
  const receiveAddress = dry ? dryAddress(req.buyAsset) : req.destinationAddress
  if (!sendAddress || !receiveAddress) {
    // shortcut: a chain with no placeholder (Cosmos, MAYA, THOR) is ranked by its rate, which may leave fees out.
    const best = candidates[0]
    return best && shapeShiftRoute(req, { swapper: best.swapperName, sell: best.sellAmountCryptoBaseUnit, buy: best.buyAmountCryptoBaseUnit, seconds: seconds(best.estimatedExecutionTimeMs) })
  }
  const sell = baseUnits(req.sellAmount, req.sellDecimals).toString()
  let failure: unknown
  for (const candidate of candidates.slice(0, MAX_SWAPPERS_TRIED)) {
    try {
      const quote = await request<ShapeShiftQuoteResponse>('/v1/swap/quote', {
        method: 'POST',
        signal,
        body: {
          ...pair,
          sellAmountCryptoBaseUnit: sell,
          receiveAddress,
          sendAddress,
          swapperName: candidate.swapperName,
          slippageTolerancePercentageDecimal: slippageDecimal(req.slippage)
        }
      })
      if (!quote.depositAddress || quote.sellAmountCryptoBaseUnit !== sell) continue
      const answer = {
        swapper: quote.swapperName,
        sell: quote.sellAmountCryptoBaseUnit,
        buy: quote.buyAmountAfterFeesCryptoBaseUnit,
        seconds: seconds(quote.steps?.reduce((sum, step) => sum + (step.estimatedExecutionTimeMs ?? 0), 0))
      }
      return shapeShiftRoute(req, dry ? answer : { ...answer, quoteId: quote.quoteId, depositAddress: quote.depositAddress, expiresAt: quote.expiresAt })
    } catch (error) {
      failure = error
    }
  }
  if (failure) throw failure
  return undefined
}

// ShapeShift moves native BCH only through NEAR Intents, so a BCH quote's deposit address is a 1Click one. Its 1Click
// status carries the signed quote, and the leg is checked there rather than trusted from ShapeShift: the payout goes
// to `recipient`, a refund to `refundTo`, for exactly the quoted amount between the route's two assets. The result is
// tracked like any NEAR Intents leg, and timed by 1Click's estimate (ShapeShift reports a flat one for these swaps).
export const shapeShiftNearLeg = async (route: ShapeShiftRoute, expect: { recipient: string; refundTo: string }): Promise<{ leg: NearLeg; seconds?: number }> => {
  const depositAddress = route.shapeshift.depositAddress
  if (!depositAddress) throw new Error('ShapeShift returned no deposit address')
  const [status, tokens] = await Promise.all([
    getNearStatus(depositAddress).catch(() => {
      throw new Error('ShapeShift’s deposit address is not a NEAR Intents one the bridge can follow')
    }),
    getNearTokens()
  ])
  const request = status.quoteResponse?.quoteRequest
  const quote = status.quoteResponse?.quote
  // ShapeShift may pick another 1Click row for the same token than this site would; the contract must match.
  const origin = nearTokenFor(tokens, request?.originAsset, route.sellAsset)
  const destination = nearTokenFor(tokens, request?.destinationAsset, route.buyAsset)
  const same = (address: string | undefined, wanted: string) =>
    !!address && (addressToLockingBytecode(wanted) ? addressToLockingBytecode(address) === addressToLockingBytecode(wanted) : sameAddress(address, wanted))
  const ok =
    status.status === 'PENDING_DEPOSIT' &&
    !!request &&
    !!quote?.amountIn &&
    !!quote.amountOut &&
    !!quote.minAmountOut &&
    !!status.correlationId &&
    !!status.quoteResponse?.signature &&
    !!status.quoteResponse.timestamp &&
    quote.depositAddress === depositAddress &&
    request.swapType === 'EXACT_INPUT' &&
    !!origin &&
    !!destination &&
    (request.originAsset === NEAR_BCH || request.destinationAsset === NEAR_BCH) &&
    same(request.recipient, expect.recipient) &&
    same(request.refundTo, expect.refundTo) &&
    quote.amountIn === toBaseUnits(route.sellAmount, origin.decimals).toString()
  if (!ok) throw new Error('ShapeShift’s quote does not match this transfer')
  // The user still has to sign and send; a deposit after the deadline is refunded.
  if (!(Date.parse(request!.deadline ?? '') - Date.now() >= MIN_DEADLINE_MS)) throw new Error('ShapeShift’s quote runs out too soon to send')
  const leg: NearLeg = {
    depositAddress,
    correlationId: status.correlationId!,
    signature: status.quoteResponse!.signature!,
    quotedAt: status.quoteResponse!.timestamp!,
    // The swap refunds at the requested deadline; `quote.deadline` is only when the address goes inactive (days later).
    deadline: request!.deadline ?? quote!.deadline,
    amountIn: quote!.amountIn!,
    amountOut: quote!.amountOut!,
    minAmountOut: quote!.minAmountOut!,
    shapeshiftQuoteId: route.shapeshift.quoteId
  }
  return { leg, seconds: quote!.timeEstimate && quote!.timeEstimate > 0 ? quote!.timeEstimate : undefined }
}

// An executable ShapeShift quote for a BCH leg, with its 1Click swap checked: paying `destinationAddress` and refunding
// `sourceAddress`, the wallet that sends.
export const getShapeShiftBridgeRoute = async (
  req: ShapeShiftRateRequest & { sourceAddress: string; destinationAddress: string },
  signal?: AbortSignal
): Promise<ShapeShiftRoute | undefined> => {
  const route = await getShapeShiftQuote(req, signal)
  if (!route) return undefined
  const { leg, seconds } = await shapeShiftNearLeg(route, { recipient: req.destinationAddress, refundTo: req.sourceAddress })
  // "At least" is what 1Click's signed quote enforces when that is below ShapeShift's figure.
  const shown = toBaseUnits(route.expectedBuyAmountMaxSlippage!, req.buyDecimals)
  const enforced = BigInt(leg.minAmountOut)
  return {
    ...route,
    ...(enforced < shown && { expectedBuyAmountMaxSlippage: formatBaseUnits(enforced, req.buyDecimals) }),
    ...(seconds && { estimatedTime: { total: seconds } }),
    shapeshift: { ...route.shapeshift, near: leg }
  }
}

export type ShapeShiftSwapStatus = 'pending' | 'submitted' | 'confirmed' | 'failed'

export interface ShapeShiftStatusResponse {
  quoteId: string
  status: ShapeShiftSwapStatus
  txHash?: string
  buyTxHash?: string
  buyAmountAfterFeesCryptoBaseUnit?: string
  swapperTxLink?: string
}

// An externally paid quote needs no hash: tracking starts from the quote id alone.
export const getShapeShiftStatus = (quoteId: string, signal?: AbortSignal) =>
  request<ShapeShiftStatusResponse>(`/v1/swap/status?quoteId=${encodeURIComponent(quoteId)}`, { signal })

export type ShapeShiftView = { kind: 'pending' } | { kind: 'paid'; txid: string } | { kind: 'failed' }

// The payout hash is only a pointer: the caller checks it on the destination chain.
export const interpretShapeShiftStatus = (status: ShapeShiftStatusResponse): ShapeShiftView => {
  if (status.status === 'failed') return { kind: 'failed' }
  if (status.status === 'confirmed' && status.buyTxHash) return { kind: 'paid', txid: status.buyTxHash }
  return { kind: 'pending' }
}

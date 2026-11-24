import { ProviderName } from '@tcswap/helpers'
import { BridgeConfig } from '@/config'
import { getInboundAddresses, getQuotes, isBridgeRoute } from '@/lib/api'
import { createAutomaticOrder } from '@/lib/auto-bridge-client'
import type { OrderIntent, SaleRoute } from '@/lib/auto-bridge-contract'
import { addressToLockingBytecode, listWalletCoins, type BchBinding } from '@/lib/bch'
import type { Signable } from '@/lib/bch-signing'
import { formatBaseUnits, minOutputFor } from '@/lib/bridge'
import { quoteToken } from '@/lib/cauldron'
import type { CauldronToken } from '@/lib/cauldron-tokens'
import { checkDepositMemo, checkInbound, DEPOSIT_FEE_RESERVE, DepositError, type InboundAddress } from '@/lib/thorchain-deposit'
import { blockHeight, destinationChainOf } from '@/lib/payout-chains'
import type { SavedAutoOrder } from '@/store/auto-bridge-store'
import { REFUND_AFTER_SECONDS, SALE_FLOOR_TOLERANCE_BPS } from '@/lib/router-contract'
import { buildTokenSend, routedDeposit, type DepositLeg } from '@/lib/router-sale-legs'
import type { NearLeg } from '@/store/transaction-store'

export { buildTokenSend, routedDeposit, SALE_COIN_SATS } from '@/lib/router-sale-legs'

// A transfer back from BCH through the Cashbridge Router: the BCH wallet signs one transaction that sends the tokens to
// the order's sale contract (src/lib/router-contract.ts), which lets the Router only sell them and deposit the BCH to
// the bridge's deposit address with this order's memo, or send them back.

export interface PreparedRouterSale {
  reference: SavedAutoOrder
  send: Signable & { feeSats: bigint }
  // The tokens sent, as the pools can take them.
  sellTokens: bigint
  // The quoted BCH from the sale, the Router's floor for it, and what THORChain is quoted to pay.
  bchOut: bigint
  minSats: bigint
  expectedOut: string
  // The destination chain's THORChain router and the block to look for the payout from.
  payoutRouter?: string
  startBlock?: number
  // A NEAR Intents or ShapeShift sale: the 1Click swap the Router's deposit pays, followed like a manual one.
  near?: NearLeg
}

// Quotes the sale and the bridge's deposit, opens the Router order and checks its contract, then builds the send.
// `route` picks the bridge the Router pays: THORChain's vault (absent), a NEAR Intents address that takes the whole
// sale ('near'), or a ShapeShift one that takes an exact amount ('shapeshift', the rest comes back as BCH).
export const prepareRouterSale = async ({
  token,
  units,
  binding,
  buyAsset,
  shortCode,
  buyDecimals,
  destination,
  slippage,
  route
}: {
  token: CauldronToken
  units: bigint
  binding: BchBinding
  buyAsset: string
  shortCode?: string
  buyDecimals?: number
  destination: string
  slippage: number
  route?: SaleRoute
}): Promise<PreparedRouterSale> => {
  const sale = await quoteToken({ category: token.category, side: 'sell', amount: units })
  const chain = destinationChainOf(buyAsset)
  const leg = route ? await routedDeposit({ route, bchOut: sale.output, binding, buyAsset, buyDecimals, destination, slippage }) : await thorchainDeposit({ bchOut: sale.output, binding, buyAsset, shortCode, destination, slippage })

  const intent: OrderIntent = {
    recipientAddress: binding.tokenAddress,
    refundAddress: binding.tokenAddress,
    expectedBchSats: sale.output.toString(),
    sale: { category: token.category, tokenAmount: sale.sell.toString(), buyAsset, destination, ...leg.sale }
  }
  const reference: SavedAutoOrder = { id: crypto.randomUUID(), capability: (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', ''), createdAt: Date.now(), intent, token }
  // The order request checks the echoed terms and that the deposit is the sale contract of exactly these terms.
  const order = await createAutomaticOrder(reference)
  // The contract's own return path must open on time, so the tokens are never held longer than the Router promises.
  if (!order.contract || order.contract.refundAfter > Date.now() / 1000 + REFUND_AFTER_SECONDS + 600) throw new DepositError('The Cashbridge Router order returns the tokens later than it should')
  const minSats = BigInt(order.minPusd)
  if (minSats < minOutputFor(sale.output, SALE_FLOOR_TOLERANCE_BPS)) throw new DepositError('The Cashbridge Router offered a lower minimum than this quote')
  const to = addressToLockingBytecode(order.depositAddress)
  if (!to) throw new DepositError('The Cashbridge Router order has no deposit address')
  const { utxos } = await listWalletCoins(binding.lockingBytecode)
  return {
    reference: { ...reference, order },
    send: buildTokenSend(utxos, binding, token, sale.sell, to),
    sellTokens: sale.sell,
    bchOut: sale.output,
    minSats,
    expectedOut: leg.expectedOut,
    payoutRouter: leg.payoutRouter,
    ...(leg.near && { near: leg.near }),
    startBlock: leg.near ? undefined : await blockHeight(chain).catch(() => undefined)
  }
}

// THORChain's vault and memo for the sale's BCH less the deposit's fee reserve.
const thorchainDeposit = async ({ bchOut, binding, buyAsset, shortCode, destination, slippage }: { bchOut: bigint; binding: BchBinding; buyAsset: string; shortCode?: string; destination: string; slippage: number }): Promise<DepositLeg> => {
  const inbounds = (await getInboundAddresses()) as unknown as InboundAddress[]
  const routes = await getQuotes({
    sellAsset: BridgeConfig.buyAsset,
    buyAsset,
    sellAmount: formatBaseUnits(bchOut - DEPOSIT_FEE_RESERVE, 8),
    slippage,
    providers: [ProviderName.THORCHAIN],
    sourceAddress: binding.cashAddress,
    destinationAddress: destination,
    refundAddress: binding.cashAddress
  })
  const route = routes.find(r => r.providers[0] === ProviderName.THORCHAIN_STREAMING) ?? routes.find(r => r.providers[0] === ProviderName.THORCHAIN)
  if (!route?.memo || !route.inboundAddress) throw new DepositError('THORChain has no route for this amount right now')
  if (!isBridgeRoute(route, { sellAsset: BridgeConfig.buyAsset, buyAsset, destinationAddress: destination })) throw new DepositError('The quote is not for this bridge')
  checkDepositMemo(route.memo, { buyAsset, destination, shortCode, minOut: route.expectedBuyAmountMaxSlippage })
  const { router } = checkInbound(inbounds, route.inboundAddress, destinationChainOf(buyAsset))
  return { sale: { memo: route.memo, vaultAddress: route.inboundAddress }, expectedOut: route.expectedBuyAmount, payoutRouter: router }
}

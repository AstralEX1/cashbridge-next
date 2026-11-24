import { type BchBinding, listWalletCoins } from '@/lib/bch'
import { minOutputFor } from '@/lib/bridge'
import { CauldronError, prepareTokenTrade, quoteToken } from '@/lib/cauldron'
import type { CauldronToken } from '@/lib/cauldron-tokens'
import { prepareSale } from '@/lib/reverse-bridge'

// A swap that never leaves Bitcoin Cash: one Cauldron trade from the bound address, signed once in the BCH wallet.
// BCH buys a token, or a token sells for BCH; the pools take their fee in BCH.

// Room for a purchase's miner fee and the dust its token output carries, on top of the BCH it sells.
export const PURCHASE_FEE_ROOM = 5_000n

// The token-free coins a purchase of `sats` spends: the largest first until the sale and room for its fee are covered,
// else all of them (the trade is then fitted to what they hold, as Max asks).
export const purchaseCoins = <T extends { value: bigint; hasToken: boolean }>(utxos: T[], sats: bigint): T[] => {
  const coins = utxos.filter(u => !u.hasToken).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
  const chosen: T[] = []
  let total = 0n
  for (const coin of coins) {
    if (total >= sats + PURCHASE_FEE_ROOM) break
    chosen.push(coin)
    total += coin.value
  }
  return chosen
}

// What `units` of `from` buys of `to` on Cauldron now (sats when `to` is BCH, token units otherwise).
export const quoteBchSwap = (from: CauldronToken | null, to: CauldronToken | null, units: bigint) => {
  if (from && !to) return quoteToken({ category: from.category, side: 'sell', amount: units })
  if (!from && to) return quoteToken({ category: to.category, side: 'buy', amount: units })
  throw new CauldronError('bad_request', 'A swap on Bitcoin Cash trades BCH against one token')
}

// The reviewed, unsigned trade for `units` of `from`, on pools just checked unspent and with their covenants run.
export const prepareBchSwap = async (from: CauldronToken | null, to: CauldronToken | null, units: bigint, binding: BchBinding) => {
  if (from && !to) return prepareSale(from, units, binding)
  if (from || !to) throw new CauldronError('bad_request', 'A swap on Bitcoin Cash trades BCH against one token')
  const { utxos } = await listWalletCoins(binding.lockingBytecode)
  const coins = purchaseCoins(utxos, units)
  if (coins.length === 0) throw new CauldronError('insufficient_funds', 'The BCH wallet holds no plain BCH at the connected address')
  return prepareTokenTrade(
    {
      category: to.category,
      side: 'buy',
      funding: coins.map(u => ({ txid: u.txid, vout: u.vout, value: u.value.toString() })),
      lockingBytecode: binding.lockingBytecode,
      tokenAddress: binding.tokenAddress,
      cashAddress: binding.cashAddress
    },
    units,
    output => minOutputFor(output)
  )
}

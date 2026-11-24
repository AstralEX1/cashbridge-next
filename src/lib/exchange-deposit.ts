// Paying a Cashbridge Router order from a centralized exchange, with no source wallet: the order's NEAR Intents (1Click)
// deposit address on the source chain takes a plain withdrawal, 1Click pays the BCH into the order's contract, and the
// page or the Router buys the token there as for any Router order. THORChain is not offered: its deposit needs a memo or
// a router call, which an exchange withdrawal cannot make.
import { Chain, getChainConfig, type EVMChain } from '@tcswap/core'
import { formatBaseUnits } from '@/lib/bridge'
import { isNearChain, type NearStatusResponse } from '@/lib/near-intents'
import type { ChainPayout, PayoutExpectation } from '@/lib/payout-check'
import { isEvmChain, isPayoutChain } from '@/lib/payout-chains'

// Chains an exchange can withdraw to here: 1Click takes a plain transfer there, and this app reads the deposit back from
// that chain's own node (payout-check.ts), not from 1Click's word alone.
export const exchangeChain = (chain?: string) => !!chain && chain !== Chain.BitcoinCash && isNearChain(chain) && isPayoutChain(chain)

const contractOf = (asset: string) => {
  const dash = asset.lastIndexOf('-')
  return dash < 0 ? undefined : asset.slice(dash + 1)
}
const BIP21: Record<string, string> = { [Chain.Bitcoin]: 'bitcoin', [Chain.Litecoin]: 'litecoin', [Chain.Dogecoin]: 'dogecoin' }

// A payment request with coin, network and amount filled in, for a wallet app that reads one: EIP-681 on EVM chains
// (amount in base units), Solana Pay, BIP 21; the bare address elsewhere.
export const paymentRequest = (asset: string, deposit: string, units: bigint, decimals: number) => {
  const chain = asset.split('.')[0].toUpperCase()
  const token = contractOf(asset)
  if (isEvmChain(chain)) {
    const id = Number(getChainConfig(chain as EVMChain).chainId)
    return token ? `ethereum:0x${token.slice(2).toLowerCase()}@${id}/transfer?address=${deposit}&uint256=${units}` : `ethereum:${deposit}@${id}?value=${units}`
  }
  const amount = formatBaseUnits(units, decimals)
  if (chain === Chain.Solana) return `solana:${deposit}?amount=${amount}${token ? `&spl-token=${token}` : ''}`
  return BIP21[chain] ? `${BIP21[chain]}:${deposit}?amount=${amount}` : deposit
}

// What the page shows while it waits for the withdrawal: nothing yet; less than 1Click swaps (it counts what arrives by
// the deadline, and refunds a total under its minimum to the refund address); a deposit 1Click reports; or the deposit,
// once the source chain's own node shows it paying the deposit address. 1Click's status only names the transaction.
export type ExchangeWatch =
  | { kind: 'waiting' }
  | { kind: 'short'; received: bigint }
  | { kind: 'arriving' }
  | { kind: 'seen'; hash: string; amount: bigint }

export const watchExchangeDeposit = async (
  source: { chain: string; asset: string },
  depositAddress: string,
  status: Pick<NearStatusResponse, 'status' | 'swapDetails'>,
  paid: (chain: string, hash: string, expect: PayoutExpectation) => Promise<ChainPayout | undefined>
): Promise<ExchangeWatch> => {
  const hashes = [...new Set((status.swapDetails?.originChainTxHashes ?? []).map(item => item?.hash).filter(hash => typeof hash === 'string' && !!hash))]
  const expect = { destination: depositAddress, buyAsset: source.asset }
  const found = (await Promise.all(hashes.map(hash => paid(source.chain, hash, expect).catch(() => undefined)))).filter(item => item !== undefined)
  const amount = found.reduce((sum, item) => sum + BigInt(item.amount), 0n)
  if (status.status === 'INCOMPLETE_DEPOSIT') return { kind: 'short', received: amount }
  if (found.length) return { kind: 'seen', hash: found[0].hash, amount }
  return status.status === 'PENDING_DEPOSIT' ? { kind: 'waiting' } : { kind: 'arriving' }
}

import { Chain, getExplorerAddressUrl, getExplorerTxUrl } from '@tcswap/core'

// Bitcoin Cash links open Selene Wallet's explorer: it names CashTokens (PUSD, MUSD) and shows a transaction before its
// block. Blockchair, the toolkit's default, answers many visitors with HTTP 403.
const BCH_EXPLORER = 'https://explorer.selene.cash'

export const explorerTxUrl = ({ chain, txHash }: { chain: Chain; txHash: string }) =>
  chain === Chain.BitcoinCash ? `${BCH_EXPLORER}/tx/${txHash.toLowerCase()}` : getExplorerTxUrl({ chain, txHash })

export const explorerAddressUrl = ({ chain, address }: { chain: Chain; address: string }) =>
  chain === Chain.BitcoinCash ? `${BCH_EXPLORER}/address/${address}` : getExplorerAddressUrl({ chain, address })

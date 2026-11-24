import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth'
import { address, networks, type Network } from 'bitcoinjs-lib'
import { BCH_PREFIX, decodeTx, ELECTRUM_PROTOCOL, RpcError, txidOf, WsRpc } from '@/lib/bch'
import { BridgeConfig } from '@/config'
import { markDown, markUp, ordered } from '@/lib/fallback'

// Keyless public explorers behind the Blockchair-shaped routes the UTXO toolbox and this app call
// (src/app/api/blockchair), in five HTTP dialects: Esplora (mempool.space and its forks), Bitcore,
// BlockCypher, Blockbook (Trezor's public backends) and Blockchair's own, plus Fulcrum (Electrum
// servers) for Bitcoin Cash. Each chain lists its explorers in order; a call moves to the next one
// when an explorer is unreachable, rate-limited or failing, and stops at the first one that answers,
// including "not found" only once every explorer has said so.

const TIMEOUT_MS = 5_000

export interface Coin {
  hash: string
  index: number
  value: number
  blockId: number // -1 while in the mempool, like Blockchair's block_id
}

export interface TxOutput {
  recipient?: string
  value: number
  scriptHex: string
}

export interface Tx {
  blockId: number
  outputs: TxOutput[]
}

interface Explorer {
  name: string
  balance(addr: string): Promise<{ balance: number; txCount: number }>
  coins(addr: string): Promise<Coin[]>
  tx(hash: string): Promise<Tx | null> // null: this explorer does not know the hash
  rawTx(hash: string): Promise<string | null>
  broadcast(hex: string): Promise<string>
}

// An explorer that answered and refused the request (bad address, a transaction the node rejects).
// Asking another explorer would get the same answer, so the call stops here.
export class Rejected extends Error {}

async function ask(url: string, init?: RequestInit): Promise<string | null> {
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { accept: 'application/json, text/plain', ...init?.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await res.text()
  if (res.ok) return text
  if (res.status === 404) return null
  // Only a 400 or 422 is the explorer judging the request. Any other 4xx (a quota's 402 or 43x, a
  // 403, a 429) and any HTML page (a CDN's Cloudflare block page) is about this server's access, so
  // the next explorer may still answer.
  const page = /^\s*</.test(text) || !!res.headers.get('content-type')?.includes('text/html')
  if ((res.status === 400 || res.status === 422) && !page) throw new Rejected(text.slice(0, 300) || `HTTP ${res.status}`)
  throw new Error(`${url} answered ${res.status}${page ? ' with an HTML page' : ''}`)
}

const askJson = async (url: string, init?: RequestInit) => {
  const text = await ask(url, init)
  return text === null ? null : JSON.parse(text)
}

const txid = (text: string | null, name: string) => {
  const id = text?.trim() ?? ''
  if (!/^[0-9a-f]{64}$/i.test(id)) throw new Error(`${name} answered a broadcast with ${id.slice(0, 80) || 'nothing'}`)
  return id.toLowerCase()
}

function esplora(base: string): Explorer {
  return {
    name: base,
    async balance(addr) {
      const { chain_stats: c, mempool_stats: m } = await askJson(`${base}/address/${encodeURIComponent(addr)}`)
      return { balance: c.funded_txo_sum - c.spent_txo_sum + m.funded_txo_sum - m.spent_txo_sum, txCount: c.tx_count + m.tx_count }
    },
    async coins(addr) {
      const list: { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }[] =
        (await askJson(`${base}/address/${encodeURIComponent(addr)}/utxo`).catch(error => {
          // Esplora lists at most 500 coins and answers a 400 for an address holding more ("Too many unspent
          // transaction outputs (>500)" on mempool.space, "Too many unspent outputs" on Blockstream). That is
          // its own limit, not a bad address, so an explorer without it is asked next.
          if (error instanceof Rejected && /too many unspent/i.test(error.message)) throw new Error(`${base}: ${error.message}`)
          throw error
        })) ?? []
      return list.map(u => ({ hash: u.txid, index: u.vout, value: u.value, blockId: u.status.confirmed ? (u.status.block_height ?? -1) : -1 }))
    },
    async tx(hash) {
      const tx = await askJson(`${base}/tx/${hash}`)
      if (!tx) return null
      return {
        blockId: tx.status?.confirmed ? (tx.status.block_height ?? -1) : -1,
        outputs: tx.vout.map((o: { scriptpubkey: string; scriptpubkey_address?: string; value: number }) => ({
          recipient: o.scriptpubkey_address,
          value: o.value,
          scriptHex: o.scriptpubkey
        }))
      }
    },
    rawTx: hash => ask(`${base}/tx/${hash}/hex`).then(hex => hex?.trim() ?? null),
    broadcast: async hex => txid(await ask(`${base}/tx`, { method: 'POST', body: hex }), base)
  }
}

// Blockbook (https://github.com/trezor/blockbook/blob/master/docs/api.md), amounts as decimal strings.
function blockbook(base: string): Explorer {
  const api = `${base}/api/v2`
  const height = (h: unknown) => (typeof h === 'number' && h > 0 ? h : -1)
  const tx = async (hash: string) => {
    try {
      return await askJson(`${api}/tx/${hash}`)
    } catch (error) {
      // Blockbook reports an unknown transaction as a 400 whose error says "not found".
      if (error instanceof Rejected && /not found/i.test(error.message)) return null
      throw error
    }
  }
  return {
    name: base,
    async balance(addr) {
      const a = await askJson(`${api}/address/${encodeURIComponent(addr)}?details=basic`)
      return { balance: Number(a.balance) + Number(a.unconfirmedBalance ?? 0), txCount: Number(a.txs ?? 0) + Number(a.unconfirmedTxs ?? 0) }
    },
    async coins(addr) {
      const list: { txid: string; vout: number; value: string; height?: number }[] = (await askJson(`${api}/utxo/${encodeURIComponent(addr)}`)) ?? []
      return list.map(u => ({ hash: u.txid, index: u.vout, value: Number(u.value), blockId: height(u.height) }))
    },
    async tx(hash) {
      const t = await tx(hash)
      if (!t) return null
      return {
        blockId: height(t.blockHeight),
        outputs: t.vout.map((o: { value: string; hex: string; addresses?: string[]; isAddress?: boolean }) => ({
          recipient: o.isAddress === false ? undefined : o.addresses?.[0],
          value: Number(o.value),
          scriptHex: o.hex
        }))
      }
    },
    rawTx: async hash => (await tx(hash))?.hex ?? null,
    broadcast: async hex => {
      const answer = await askJson(`${api}/sendtx/`, { method: 'POST', body: hex })
      return txid(answer?.result, base)
    }
  }
}

// Bitcore (BitPay's Insight API, https://api.bitcore.io), chain names like 'DOGE'. It has no raw
// transaction endpoint, so raw lookups fall through to the next explorer.
function bitcore(chain: string): Explorer {
  const api = `https://api.bitcore.io/api/${chain}/mainnet`
  const height = (h: unknown) => (typeof h === 'number' && h > 0 ? h : -1)
  type Coin = { mintTxid: string; mintIndex: number; mintHeight: number; value: number; address?: string; script?: string; spentTxid?: string }
  return {
    name: api,
    async balance(addr) {
      const b = await askJson(`${api}/address/${encodeURIComponent(addr)}/balance`)
      // Bitcore does not count an address's transactions; nothing here reads the count.
      return { balance: Number(b.balance), txCount: 0 }
    },
    async coins(addr) {
      // shortcut: the first 1000 coins only, raise the limit if a wallet ever holds more.
      const list: Coin[] = (await askJson(`${api}/address/${encodeURIComponent(addr)}/?unspent=true&limit=1000`)) ?? []
      return list.filter(c => !c.spentTxid).map(c => ({ hash: c.mintTxid, index: c.mintIndex, value: Number(c.value), blockId: height(c.mintHeight) }))
    },
    async tx(hash) {
      const tx = await askJson(`${api}/tx/${hash}`)
      if (!tx) return null
      const coins = await askJson(`${api}/tx/${hash}/coins`)
      const outputs: Coin[] = [...(coins?.outputs ?? [])].sort((a: Coin, b: Coin) => a.mintIndex - b.mintIndex)
      if (outputs.length !== tx.outputCount) throw new Error(`${api} listed ${outputs.length} of ${tx.outputCount} outputs of ${hash}`)
      return {
        blockId: height(tx.blockHeight),
        outputs: outputs.map(o => ({ recipient: o.address && o.address !== 'false' ? o.address : undefined, value: Number(o.value), scriptHex: o.script ?? '' }))
      }
    },
    rawTx: () => Promise.reject(new Error(`${api} serves no raw transactions`)),
    broadcast: async hex => {
      const answer = await askJson(`${api}/tx/send`, { method: 'POST', body: JSON.stringify({ rawTx: hex }), headers: { 'content-type': 'application/json' } })
      return txid(answer?.txid, api)
    }
  }
}

// BlockCypher (https://www.blockcypher.com/dev/bitcoin/), coins like 'doge'. Keyless use is rate-limited
// per IP (a few hundred requests an hour), so it comes after an explorer without that limit.
function blockCypher(coin: string): Explorer {
  const api = `https://api.blockcypher.com/v1/${coin}/main`
  const height = (h: unknown) => (typeof h === 'number' && h > 0 ? h : -1)
  type Ref = { tx_hash: string; tx_output_n: number; value: number; block_height?: number; spent?: boolean; double_spend?: boolean }
  // The outputs come in pages of `limit`; a transaction with more than this is read elsewhere.
  const get = (hash: string) => askJson(`${api}/txs/${hash}?includeHex=true&limit=100`)
  return {
    name: api,
    async balance(addr) {
      const a = await askJson(`${api}/addrs/${encodeURIComponent(addr)}/balance`)
      return { balance: Number(a.final_balance), txCount: Number(a.final_n_tx ?? 0) }
    },
    async coins(addr) {
      const a = await askJson(`${api}/addrs/${encodeURIComponent(addr)}?unspentOnly=true&limit=2000`)
      // An unconfirmed ref can also be an input of a pending spend (tx_output_n -1).
      const refs: Ref[] = [...(a?.txrefs ?? []), ...(a?.unconfirmed_txrefs ?? [])].filter((r: Ref) => r.tx_output_n >= 0 && !r.spent && !r.double_spend)
      return refs.map(r => ({ hash: r.tx_hash, index: r.tx_output_n, value: Number(r.value), blockId: height(r.block_height) }))
    },
    async tx(hash) {
      const tx = await get(hash)
      if (!tx) return null
      if (tx.outputs.length !== tx.vout_sz) throw new Error(`${api} listed ${tx.outputs.length} of ${tx.vout_sz} outputs of ${hash}`)
      return {
        blockId: height(tx.block_height),
        outputs: tx.outputs.map((o: { value: number; script: string; addresses?: string[] | null }) => ({ recipient: o.addresses?.[0], value: Number(o.value), scriptHex: o.script }))
      }
    },
    rawTx: async hash => (await get(hash))?.hex ?? null,
    broadcast: async hex => {
      const answer = await askJson(`${api}/txs/push`, { method: 'POST', body: JSON.stringify({ tx: hex }), headers: { 'content-type': 'application/json' } })
      return txid(answer?.tx?.hash, api)
    }
  }
}

// Blockchair itself, the dialect this route speaks, so its answers map one to one. Keyless use has a
// small daily quota per IP, so it serves only the chain no other public explorer answers for.
function blockchair(slug: string): Explorer {
  const api = `https://api.blockchair.com/${slug}`
  // An unknown transaction is `data: []`, as Blockchair answers it.
  const entry = async (path: string, hash: string) => ((await askJson(`${api}/${path}/${hash}`))?.data ?? {})[hash] ?? null
  const noAddresses = () => Promise.reject(new Error(`${api} is not asked for addresses`))
  return {
    name: api,
    balance: noAddresses,
    coins: noAddresses,
    async tx(hash) {
      const tx = await entry('dashboards/transaction', hash)
      if (!tx) return null
      return {
        blockId: typeof tx.transaction?.block_id === 'number' && tx.transaction.block_id > 0 ? tx.transaction.block_id : -1,
        outputs: (tx.outputs ?? []).map((o: { recipient?: string; value: number; script_hex: string }) => ({ recipient: o.recipient || undefined, value: Number(o.value), scriptHex: o.script_hex }))
      }
    },
    rawTx: async hash => (await entry('raw/transaction', hash))?.raw_transaction ?? null,
    broadcast: async hex => {
      const answer = await askJson(`${api}/push/transaction`, { method: 'POST', body: JSON.stringify({ data: hex }), headers: { 'content-type': 'application/json' } })
      return txid(answer?.data?.transaction_hash, api)
    }
  }
}

// Fulcrum: the Electrum protocol over WebSocket, the server kind src/lib/bch.ts checks BCH with. No CDN
// bot filter sits in front of it, unlike Trezor's Blockbook, which answers the deployed site with a
// Cloudflare block page. Transactions only: Bitcoin Cash has no address lookups here (cashaddr scripts
// are not derived above). Raw bytes are hashed against the asked id and decoded locally.
function fulcrum(url: string): Explorer {
  const name = new URL(url).host
  const session = async <T>(run: (rpc: WsRpc) => Promise<T>) => {
    const rpc = new WsRpc(url, { jsonrpc: true, timeoutMs: TIMEOUT_MS })
    try {
      await rpc.open()
      await rpc.request('server.version', ['cashbridge', ELECTRUM_PROTOCOL])
      const value = await run(rpc)
      markUp(url)
      return value
    } catch (error) {
      // A server that is down or stalls is asked last for a while; an error from its node is an answer.
      if (!(error instanceof RpcError)) markDown(url)
      throw error
    } finally {
      rpc.close()
    }
  }
  // Fulcrum reports an unknown transaction as an error from its node.
  const raw = async (rpc: WsRpc, hash: string) => {
    const hex = await rpc.request<string>('blockchain.transaction.get', [hash.toLowerCase(), false]).catch(error => {
      if (error instanceof RpcError) return null
      throw error
    })
    if (hex === null) return null
    if (typeof hex !== 'string' || txidOf(hex) !== hash.toLowerCase()) throw new Error(`${name} answered a transaction that is not ${hash}`)
    return hex
  }
  const noAddresses = () => Promise.reject(new Error('Bitcoin Cash addresses are not looked up here'))
  return {
    name,
    balance: noAddresses,
    coins: noAddresses,
    tx: hash =>
      session(async rpc => {
        const hex = await raw(rpc, hash)
        if (!hex) return null
        const [verbose, tip] = await Promise.all([
          rpc.request<{ confirmations?: number }>('blockchain.transaction.get', [hash.toLowerCase(), true]),
          rpc.request<{ height: number }>('blockchain.headers.subscribe', [])
        ])
        const confirmations = Number(verbose?.confirmations ?? 0)
        if (confirmations > 0 && !Number.isInteger(tip?.height)) throw new Error(`${name} answered no chain tip`)
        return {
          blockId: confirmations > 0 ? tip.height - confirmations + 1 : -1,
          outputs: decodeTx(hex).outputs.map(o => {
            const cashaddr = lockingBytecodeToCashAddress({ prefix: BCH_PREFIX, bytecode: o.lockingBytecode })
            return { recipient: typeof cashaddr === 'string' ? undefined : cashaddr.address, value: Number(o.valueSatoshis), scriptHex: binToHex(o.lockingBytecode) }
          })
        }
      }),
    rawTx: hash => session(rpc => raw(rpc, hash)),
    // An error from the server is its node's verdict on the transaction, as in src/lib/bch.ts.
    broadcast: hex =>
      session(rpc => rpc.request<string>('blockchain.transaction.broadcast', [hex])).then(
        id => txid(id, name),
        error => {
          throw error instanceof RpcError ? new Rejected(error.message) : error
        }
      )
  }
}

// Output scripts are not in either explorer's UTXO list, so they are derived from the address.
const LITECOIN: Network = { ...networks.bitcoin, messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 }
const DOGECOIN: Network = { ...networks.bitcoin, messagePrefix: '\x19Dogecoin Signed Message:\n', bech32: 'doge', pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e }

export function outputScriptHex(addr: string, network: Network): string | undefined {
  try {
    return Buffer.from(address.toOutputScript(addr, network)).toString('hex')
  } catch {}
  // A taproot script is OP_1 <32-byte key>; toOutputScript wants an ECC library only to check the key.
  try {
    const { prefix, version, data } = address.fromBech32(addr)
    if (prefix === network.bech32 && version === 1 && data.length === 32) return `5120${Buffer.from(data).toString('hex')}`
  } catch {}
}

// slug (as the toolbox derives it) -> explorers. `network` set: addresses can be looked up too; a chain
// without it serves transaction lookups and broadcasts only. Trezor's hosts are numbered backends of
// one operator, so they back each other up against an outage but not against that operator blocking us.
export const UTXO_CHAINS: Record<string, { network?: Network; explorers: Explorer[] }> = {
  bitcoin: {
    network: networks.bitcoin,
    // Bitcore and BlockCypher list an address's coins past Esplora's 500 (Bitcore its first 1000).
    explorers: [esplora('https://mempool.space/api'), esplora('https://blockstream.info/api'), bitcore('BTC'), blockCypher('btc'), blockbook('https://btc1.trezor.io')]
  },
  litecoin: {
    network: LITECOIN,
    explorers: [esplora('https://litecoinspace.org/api'), bitcore('LTC'), blockCypher('ltc'), blockbook('https://ltc1.trezor.io'), blockbook('https://ltc2.trezor.io')]
  },
  dogecoin: {
    network: DOGECOIN,
    explorers: [bitcore('DOGE'), blockCypher('doge'), blockbook('https://doge1.trezor.io'), blockbook('https://doge2.trezor.io'), blockbook('https://doge3.trezor.io')]
  },
  // shortcut: four Fulcrum servers, healthy ones first; an unknown transaction is asked on each in turn, so all ten would be slow.
  get 'bitcoin-cash'() {
    return { explorers: [...ordered(BridgeConfig.electrumUrls).slice(0, 4).map(fulcrum), blockbook('https://bch1.trezor.io')] }
  },
  dash: { explorers: [blockCypher('dash'), blockbook('https://dash1.trezor.io')] },
  zcash: { explorers: [blockchair('zcash'), blockbook('https://zec1.trezor.io')] }
}

async function firstAnswer<T>(explorers: Explorer[], run: (explorer: Explorer) => Promise<T | null>): Promise<T | null> {
  const failures: string[] = []
  let unknown = false
  for (const explorer of explorers) {
    try {
      const answer = await run(explorer)
      if (answer !== null) return answer
      unknown = true
    } catch (error) {
      if (error instanceof Rejected) throw error
      failures.push(`${explorer.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (unknown) return null
  throw new Error(failures.join(' | '))
}

// --- The Blockchair-shaped answers (the `data` member), as the toolbox and our status checks read them ---

export async function addressDashboard(slug: string, addr: string) {
  const { explorers } = UTXO_CHAINS[slug]
  const { stats, coins } = (await firstAnswer(explorers, async e => {
    const [stats, coins] = await Promise.all([e.balance(addr), e.coins(addr)])
    return { stats, coins }
  }))!
  return {
    [addr]: {
      address: { balance: stats.balance, transaction_count: stats.txCount },
      transactions: [],
      utxo: coins.map(c => ({ block_id: c.blockId, index: c.index, transaction_hash: c.hash, value: c.value }))
    }
  }
}

// What `outputs?q=recipient(ADDR),is_spent(false)...&s=value(desc)&limit=&offset=` returns: the unspent
// outputs of one address, largest first, one page at a time.
export async function unspentOutputs(slug: string, addr: string, limit: number, offset: number) {
  const { network, explorers } = UTXO_CHAINS[slug]
  const script = outputScriptHex(addr, network!)
  if (!script) throw new Rejected(`${addr} is not a ${slug} address`)
  const coins = (await firstAnswer(explorers, e => e.coins(addr)))!
  return coins
    .sort((a, b) => b.value - a.value)
    .slice(offset, offset + limit)
    .map(c => ({
      is_spent: false,
      transaction_hash: c.hash,
      index: c.index,
      value: c.value,
      script_hex: script,
      block_id: c.blockId,
      spending_signature_hex: null
    }))
}

// An unknown hash is an empty object, as on Blockchair; a mempool transaction has block_id -1.
export async function transactionDashboard(slug: string, hash: string) {
  const tx = await firstAnswer(UTXO_CHAINS[slug].explorers, e => e.tx(hash))
  if (!tx) return {}
  return {
    [hash]: {
      transaction: { hash, block_id: tx.blockId },
      outputs: tx.outputs.map(o => ({ recipient: o.recipient, value: o.value, script_hex: o.scriptHex }))
    }
  }
}

export async function rawTransaction(slug: string, hash: string) {
  const hex = await firstAnswer(UTXO_CHAINS[slug].explorers, e => e.rawTx(hash))
  return hex ? { [hash]: { raw_transaction: hex } } : {}
}

export async function broadcast(slug: string, hex: string) {
  return { transaction_hash: (await firstAnswer(UTXO_CHAINS[slug].explorers, e => e.broadcast(hex)))! }
}

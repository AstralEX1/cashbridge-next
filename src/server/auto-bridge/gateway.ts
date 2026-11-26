import { hexToBin, sha256, binToHex, type Output } from '@bitauth/libauth'
import { normalizeTxid, txidOf, WsRpc } from '@/lib/bch'
import { toBaseUnits } from '@/lib/bridge'
import { BroadcastRejected, BroadcastUnknown, broadcastViaCauldron } from '@/lib/cauldron'
import type { TxStatusResponse } from '@/lib/api'
import type { InboundAddress } from '@/lib/thorchain-deposit'
import { nearAuthHeaders, ONE_CLICK_URL, submitNearDeposit, type NearStatusResponse } from '@/lib/near-intents'
import type { Attempt } from '@/server/auto-bridge/types'
import type { Gateway } from '@/server/auto-bridge/worker'
import { readCredential } from '@/server/auto-bridge/config'
import { BridgeConfig } from '@/config'
import { sourceTransactionId } from '@/lib/source-transaction'

class NodeError extends Error {
  constructor(readonly code: number) {
    super('BCH node rejected the RPC request')
  }
}

type RpcNode = { url: URL; headers: Record<string, string>; minIntervalMs: number; nextRequestAt: number; queue: Promise<void>; downUntil: number; indexed?: boolean }
// Throws when a 200 answer is empty or wrong, so the call goes on to the next node instead of returning it.
type Check<T> = (value: T) => void
const present: Check<unknown> = value => {
  if (value === null || value === undefined) throw new Error('Invalid BCH node response')
}
// A node that failed (not one that answered with an RPC error) is asked last for this long.
const COOLDOWN_MS = 60_000
// A confirmed transaction from block 170. Without a transaction index (txindex=1, no pruning) a node answers -5 for
// it, as it would for any confirmed deposit or payout, and the worker could not tell those from transactions that do not exist.
const INDEX_PROBE = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16'

export class BchGateway implements Gateway {
  private readonly nodes: RpcNode[]
  // Configured Fulcrum URLs first, then the app's public ones; a failing server is asked last for COOLDOWN_MS (same idea as RPC nodes).
  private readonly electrumServers: { url: string; downUntil: number }[]
  private readonly thornode: URL
  constructor() {
    try {
      const config = process.env.BCHN_RPC_CONFIG_FILE ? JSON.parse(readCredential(process.env.BCHN_RPC_CONFIG_FILE, true)) : undefined
      const entries = process.env.BCHN_RPC_CONFIG_FILE
        ? (config?.rpcs ?? [config])
        : [{ url: process.env.BCHN_RPC_URL ?? 'http://127.0.0.1:8332', headers: {} }]
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) throw new Error()
      this.nodes = entries.map(entry => {
        if (
          !entry ||
          typeof entry.url !== 'string' ||
          !entry.headers ||
          typeof entry.headers !== 'object' ||
          Array.isArray(entry.headers) ||
          Object.values(entry.headers).some(value => typeof value !== 'string')
        )
          throw new Error()
        const url = new URL(entry.url)
        const minIntervalMs = entry.minIntervalMs ?? 0
        if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60000) throw new Error()
        if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error()
        if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error()
        return { url, headers: Object.fromEntries(new Headers(entry.headers).entries()), minIntervalMs, nextRequestAt: 0, queue: Promise.resolve(), downUntil: 0 }
      })
    } catch {
      throw new Error('Invalid BCH RPC configuration or credential file')
    }
    // The configured Fulcrum servers (comma-separated) first, then the app's public ones, so one server down does not stall orders.
    this.electrumServers = [
      ...new Set(
        [...(process.env.AUTO_BRIDGE_FULCRUM_URL ?? 'ws://127.0.0.1:50003').split(','), ...BridgeConfig.electrumUrls].map(url => url.trim()).filter(Boolean)
      ),
    ].map(url => ({ url, downUntil: 0 }))
    this.thornode = new URL(process.env.THORNODE_URL ?? 'https://gateway.liquify.com/chain/thorchain_api/')
  }

  get fulcrums() {
    return this.electrumServers.map(server => server.url)
  }

  private async rpcAt<T>(node: RpcNode, method: string, params: unknown[]): Promise<T> {
    const cookie =
      !process.env.BCHN_RPC_CONFIG_FILE && process.env.BCHN_RPC_COOKIE_FILE ? readCredential(process.env.BCHN_RPC_COOKIE_FILE, true) : undefined
    // API quotes and the worker share one provider queue, including after event-loop delays.
    const previous = node.queue
    let release!: () => void
    node.queue = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    let response: Response
    try {
      const delay = Math.max(0, node.nextRequestAt - Date.now())
      if (delay) await new Promise<void>(resolve => setTimeout(resolve, delay))
      node.nextRequestAt = Date.now() + node.minIntervalMs
      response = await fetch(node.url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...node.headers,
          'Content-Type': 'application/json',
          ...(cookie && { Authorization: `Basic ${Buffer.from(cookie).toString('base64')}` })
        },
        body: JSON.stringify({ jsonrpc: '1.0', id: 'bridge', method, params }),
        signal: AbortSignal.timeout(15000)
      })
    } catch {
      throw new Error('BCH node RPC unavailable')
    } finally {
      release()
    }
    const body = (await response.json().catch(() => undefined)) as { result?: T; error?: { code?: number } } | undefined
    if (body?.error && Number.isInteger(body.error.code)) throw new NodeError(body.error.code!)
    if (!response.ok || !body || !Object.hasOwn(body, 'result')) throw new Error('Invalid BCH node response')
    return body.result as T
  }

  // A node that could not be reached when it had to prove its index (indexed === false) answers nothing until it proves it.
  private ordered() {
    const now = Date.now()
    return this.nodes.filter(node => node.indexed !== false).sort((a, b) => Number(a.downUntil > now) - Number(b.downUntil > now))
  }

  private async rpcFrom<T>(method: string, params: unknown[], check: Check<T> = present): Promise<{ node: RpcNode; value: T }> {
    let lastError: unknown
    for (const node of this.ordered()) {
      try {
        const value = await this.rpcAt<T>(node, method, params)
        check(value)
        node.downUntil = 0
        return { node, value }
      } catch (error) {
        lastError = error
        if (!(error instanceof NodeError)) node.downUntil = Date.now() + COOLDOWN_MS
      }
    }
    throw lastError ?? new Error('BCH node RPC unavailable')
  }

  private async rpc<T>(method: string, params: unknown[] = [], check?: Check<T>): Promise<T> {
    return (await this.rpcFrom<T>(method, params, check)).value
  }

  // gettxout says null for a spent output, which a faulty node can also say about an unspent one:
  // with several nodes configured, a second one has to agree before the output counts as spent.
  private async confirmSpent(answered: RpcNode, id: string, vout: number) {
    if (this.nodes.length < 2) return
    for (const node of this.ordered()) {
      if (node === answered) continue
      let other: unknown
      try {
        other = await this.rpcAt(node, 'gettxout', [id, vout, true])
      } catch {
        continue
      }
      if (other === null) return
      throw new Error('BCH nodes disagree about an output')
    }
    // No other RPC answered (out of credits or throttled): Fulcrum's own UTXO set is the second opinion (null = spent or unknown).
    let info: unknown
    try {
      info = await this.electrum('blockchain.utxo.get_info', [id, vout])
    } catch {
      throw new Error('BCH node answer could not be confirmed')
    }
    if (info !== null) throw new Error('BCH nodes disagree about an output')
  }

  private async electrum<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown
    const now = Date.now()
    // shortcut: at most four servers per call, so an outage fails within minutes instead of walking the whole public list; the next call starts on others.
    for (const server of [...this.electrumServers].sort((a, b) => Number(a.downUntil > now) - Number(b.downUntil > now)).slice(0, 4)) {
      const rpc = new WsRpc(server.url)
      try {
        await rpc.open()
        const answer = await rpc.request<T>(method, params)
        server.downUntil = 0
        return answer
      } catch (error) {
        lastError = error
        server.downUntil = Date.now() + COOLDOWN_MS
      } finally {
        rpc.close()
      }
    }
    throw lastError
  }

  async history(script: string) {
    const hash = binToHex(sha256.hash(hexToBin(script)).reverse())
    const history = await this.electrum<{ tx_hash: string }[]>('blockchain.scripthash.get_history', [hash])
    if (!Array.isArray(history)) throw new Error('Invalid Fulcrum history')
    return history.map(row => normalizeTxid(row.tx_hash))
  }
  async raw(id: string) {
    try {
      return await this.rpc<string>('getrawtransaction', [id, false], hex => {
        if (typeof hex !== 'string' || txidOf(hex) !== id) throw new Error('BCH transaction hash mismatch')
      })
    } catch (error) {
      if (error instanceof NodeError && error.code === -5) return undefined
      throw error
    }
  }
  tip() {
    return this.rpc<number>('getblockcount', [], height => {
      if (!Number.isSafeInteger(height) || height <= 0) throw new Error('Invalid BCH node response')
    })
  }
  async assertReady() {
    await this.rpc<{ chain: string; initialblockdownload: boolean; blocks: number; headers: number }>('getblockchaininfo', [], state => {
      if (
        state?.chain !== 'main' ||
        state.initialblockdownload !== false ||
        !Number.isSafeInteger(state.blocks) ||
        !Number.isSafeInteger(state.headers) ||
        state.blocks < state.headers - 1
      )
        throw new Error('BCH mainnet RPC is not synchronized')
    })
    // Every configured node proves its transaction index once per process before it answers for orders. A node without the index
    // or with a wrong answer stops the worker; one that cannot answer now (out of credits, down, warming up) is left out until it
    // proves it on a later pass.
    for (const node of this.nodes) {
      if (node.indexed) continue
      try {
        const hex = await this.rpcAt<string>(node, 'getrawtransaction', [INDEX_PROBE, false])
        if (typeof hex !== 'string' || txidOf(hex) !== INDEX_PROBE) throw new Error('BCH transaction hash mismatch')
        node.indexed = true
      } catch (error) {
        if (error instanceof NodeError && error.code === -5) throw new Error('A BCH RPC cannot look up confirmed transactions; it needs txindex=1 without pruning')
        if (error instanceof Error && error.message === 'BCH transaction hash mismatch') throw error
        node.indexed = false
      }
    }
    if (!this.nodes.some(node => node.indexed)) throw new Error('No BCH RPC can be reached to prove its transaction index')
  }
  async coin(id: string, vout: number) {
    const { node, value: coin } = await this.rpcFrom<{
      value: number
      confirmations: number
      scriptPubKey: { hex: string }
      tokenData?: { category: string; amount: string; nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: string } }
    } | null>('gettxout', [id, vout, true], () => {})
    if (!coin) {
      await this.confirmSpent(node, id, vout)
      return undefined
    }
    if (coin.tokenData?.nft && !['none', 'mutable', 'minting'].includes(coin.tokenData.nft.capability)) throw new Error('Invalid token metadata')
    const output: Output = {
      valueSatoshis: toBaseUnits(coin.value.toFixed(8), 8),
      lockingBytecode: hexToBin(coin.scriptPubKey.hex),
      ...(coin.tokenData && { token: { category: hexToBin(coin.tokenData.category), amount: BigInt(coin.tokenData.amount),
        ...(coin.tokenData.nft && { nft: { capability: coin.tokenData.nft.capability, commitment: hexToBin(coin.tokenData.nft.commitment) } }) } })
    }
    return { output, confirmations: coin.confirmations }
  }
  async thorStatus(id: string): Promise<TxStatusResponse | undefined> {
    const source = sourceTransactionId(id)
    if (!source) throw new Error('Invalid source transaction identifier')
    const base = this.thornode.toString().replace(/\/?$/, '/')
    const response = await fetch(new URL(`thorchain/tx/status/${encodeURIComponent(source)}`, base), {
      signal: AbortSignal.timeout(15000),
      cache: 'no-store'
    })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error('THORChain status unavailable')
    return response.json()
  }
  async inbound(): Promise<InboundAddress[]> {
    const base = this.thornode.toString().replace(/\/?$/, '/')
    const response = await fetch(new URL('thorchain/inbound_addresses', base), { signal: AbortSignal.timeout(15000), cache: 'no-store' })
    const inbounds = response.ok ? await response.json() : undefined
    if (!Array.isArray(inbounds)) throw new Error('THORChain inbound addresses unavailable')
    return inbounds
  }
  async mimir(): Promise<Record<string, number>> {
    const base = this.thornode.toString().replace(/\/?$/, '/')
    const response = await fetch(new URL('thorchain/mimir', base), { signal: AbortSignal.timeout(15000), cache: 'no-store' })
    const mimir = response.ok ? await response.json() : undefined
    if (!mimir || typeof mimir !== 'object' || Array.isArray(mimir)) throw new Error('THORChain mimir unavailable')
    return mimir
  }
  async nearStatus(depositAddress: string): Promise<NearStatusResponse | undefined> {
    const response = await fetch(`${ONE_CLICK_URL}/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
      headers: nearAuthHeaders(),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      cache: 'no-store'
    })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error('NEAR Intents status unavailable')
    return response.json()
  }
  nearSubmit(depositAddress: string, txHash: string) {
    return submitNearDeposit(depositAddress, txHash)
  }
  async observe(id: string) {
    try {
      const tx = await this.rpc<{ hex: string; confirmations?: number }>('getrawtransaction', [id, true], tx => {
        if (typeof tx?.hex !== 'string' || txidOf(tx.hex) !== id) throw new Error('BCH transaction hash mismatch')
      })
      if ((tx.confirmations ?? 0) > 0) return { seen: true, confirmations: tx.confirmations! }
      await this.rpc('getmempoolentry', [id])
      return { seen: true, confirmations: 0 }
    } catch (error) {
      if (error instanceof NodeError && error.code === -5) return { seen: false, confirmations: 0 }
      throw error
    }
  }
  async broadcast(attempt: Attempt) {
    let unknown = false
    for (const node of this.nodes) {
      try {
        const answer = await this.rpcAt<string>(node, 'sendrawtransaction', [attempt.hex])
        if (normalizeTxid(answer) !== attempt.txid) throw new BroadcastUnknown('BCH node returned another transaction id')
        return
      } catch (error) {
        if (error instanceof NodeError && error.code === -27) return
        if (!(error instanceof NodeError && [-26, -25, -22].includes(error.code))) unknown = true
      }
    }
    // A backup rejection cannot erase an uncertain first submission.
    if (!unknown) throw new BroadcastRejected('BCH RPCs rejected this submission')
    try {
      await broadcastViaCauldron(attempt.hex, attempt.txid)
    } catch {
      throw new BroadcastUnknown('RPC acceptance remains unknown')
    }
  }
}

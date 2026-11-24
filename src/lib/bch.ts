import {
  base58AddressToLockingBytecode,
  binToHex,
  binsAreEqual,
  cashAddressToLockingBytecode,
  decodeCashAddress,
  decodeTransaction,
  encodeCashAddress,
  hash160,
  hashTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  sha256,
  type Transaction
} from '@bitauth/libauth'
import { BridgeConfig } from '@/config'
import { markDown, markUp, ordered } from '@/lib/fallback'
import { sameSourceTransaction, sourceIdFromMemo } from '@/lib/source-transaction'

// BCH-side lookups and checks for the bridge. Nothing here trusts a server's decoding: raw
// transactions are fetched, decoded and hashed locally, and outputs are matched by locking script.

export const BCH_PREFIX = 'bitcoincash'

const isHex = (value: unknown, bytes?: number): value is string =>
  typeof value === 'string' && value.length % 2 === 0 && /^[0-9a-f]*$/i.test(value) && (bytes === undefined || value.length === bytes * 2)

export const isTxid = (value: unknown): value is string => isHex(value, 32)

// BCH hashes only. Source-chain identifiers use source-transaction.ts instead.
export const normalizeTxid = (hash: string) => (hash.startsWith('0x') || hash.startsWith('0X') ? hash.slice(2) : hash).toLowerCase()

// --- Addresses ---------------------------------------------------------------------------------

// WizardConnect hdwalletv1 path names (child 0 and child 7 of the wallet's account). A wallet may
// share only its DeFi path with dapps, so either is accepted; signing names the same path.
export const BINDING_PATHS = { receive: 0, defi: 7 } as const
export type BindingPath = keyof typeof BINDING_PATHS

export interface BchBinding {
  // Compressed public key the wallet derived at `path`/`addressIndex` (hex).
  pubkey: string
  path: BindingPath
  addressIndex: number
  // P2PKH locking script shared by both address forms below (hex).
  lockingBytecode: string
  // Plain CashAddr, given to THORChain as the first leg's destination.
  cashAddress: string
  // Token-aware CashAddr of the same script, given to Cauldron for the PUSD output.
  tokenAddress: string
}

export const bindingFromPubkey = (pubkey: Uint8Array, addressIndex: number, path: BindingPath = 'receive'): BchBinding => {
  if (pubkey.length !== 33 || (pubkey[0] !== 2 && pubkey[0] !== 3)) throw new Error('Wallet returned an invalid public key')
  const payload = hash160(pubkey)
  const lockingBytecode = binToHex(Uint8Array.from([0x76, 0xa9, 0x14, ...payload, 0x88, 0xac]))
  return {
    pubkey: binToHex(pubkey),
    path,
    addressIndex,
    lockingBytecode,
    cashAddress: encodeCashAddress({ prefix: BCH_PREFIX, type: 'p2pkh', payload }).address,
    tokenAddress: encodeCashAddress({ prefix: BCH_PREFIX, type: 'p2pkhWithTokens', payload }).address
  }
}

// The locking script an address pays, in any representation THORNode or a wallet may print:
// CashAddr with or without prefix, token-aware or not, or legacy base58.
export const addressToLockingBytecode = (address: string): string | undefined => {
  const trimmed = address.trim()
  if (!trimmed) return undefined
  const candidates = trimmed.includes(':') ? [trimmed.toLowerCase()] : [`${BCH_PREFIX}:${trimmed.toLowerCase()}`]
  for (const candidate of candidates) {
    const decoded = cashAddressToLockingBytecode(candidate)
    if (typeof decoded !== 'string') return decoded.prefix === BCH_PREFIX ? binToHex(decoded.bytecode) : undefined
  }
  const legacy = base58AddressToLockingBytecode(trimmed)
  if (typeof legacy !== 'string' && legacy.version === 0) return binToHex(legacy.bytecode)
  return undefined
}

export type BchAddressProblem = 'invalid' | 'notTokenAware'

// Why a pasted receiving address cannot be paid, or undefined when it can. Stricter than
// `addressToLockingBytecode`: only CashAddr passes (legacy 1… addresses read the same as Bitcoin's), in
// one case, with the mainnet prefix or none. A token (PUSD) must go to a token-aware address (z…), so
// it is never sent to a wallet that may not be able to hold CashTokens.
export const bchAddressProblem = (address: string, tokens: boolean): BchAddressProblem | undefined => {
  const text = address.trim()
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return 'invalid'
  const decoded = decodeCashAddress(text.includes(':') ? text.toLowerCase() : `${BCH_PREFIX}:${text.toLowerCase()}`)
  if (typeof decoded === 'string' || decoded.prefix !== BCH_PREFIX || !addressToLockingBytecode(text)) return 'invalid'
  return tokens && !decoded.type.endsWith('WithTokens') ? 'notTokenAware' : undefined
}

// A pasted address the user receives plain BCH at, with no wallet connected: nothing will be signed
// for it, so it carries no public key. Undefined for anything that is not a mainnet BCH address.
export const bindingFromAddress = (address: string): BchBinding | undefined => {
  const lockingBytecode = addressToLockingBytecode(address)
  if (!lockingBytecode) return undefined
  const bytecode = hexToBin(lockingBytecode)
  const plain = lockingBytecodeToCashAddress({ prefix: BCH_PREFIX, bytecode })
  const tokens = lockingBytecodeToCashAddress({ prefix: BCH_PREFIX, bytecode, tokenSupport: true })
  if (typeof plain === 'string' || typeof tokens === 'string') return undefined
  return { pubkey: '', path: 'receive', addressIndex: 0, lockingBytecode, cashAddress: plain.address, tokenAddress: tokens.address }
}

export const isWatchOnly = (binding: Pick<BchBinding, 'pubkey'>) => binding.pubkey === ''

export const addressPaysScript = (address: string | undefined, lockingBytecode: string) =>
  !!address && addressToLockingBytecode(address) === lockingBytecode.toLowerCase()

// A restored binding is only used again if every field still derives from its public key.
export const isValidBinding = (binding: unknown): binding is BchBinding => {
  const b = binding as BchBinding
  if (b && typeof b === 'object' && b.pubkey === '') {
    const fresh = typeof b.cashAddress === 'string' ? bindingFromAddress(b.cashAddress) : undefined
    return !!fresh && fresh.lockingBytecode === b.lockingBytecode && fresh.tokenAddress === b.tokenAddress && b.path === 'receive' && b.addressIndex === 0
  }
  if (!b || typeof b !== 'object' || !isHex(b.pubkey, 33) || !Object.hasOwn(BINDING_PATHS, b.path) || !Number.isSafeInteger(b.addressIndex) || b.addressIndex < 0) return false
  try {
    const fresh = bindingFromPubkey(hexToBin(b.pubkey), b.addressIndex, b.path)
    return fresh.lockingBytecode === b.lockingBytecode && fresh.cashAddress === b.cashAddress && fresh.tokenAddress === b.tokenAddress
  } catch {
    return false
  }
}

// --- Transactions ------------------------------------------------------------------------------

export const decodeTx = (hex: string): Transaction => {
  if (!isHex(hex) || hex.length === 0) throw new Error('Transaction is not hex')
  const decoded = decodeTransaction(hexToBin(hex))
  if (typeof decoded === 'string') throw new Error(`Transaction does not decode: ${decoded}`)
  return decoded
}

// Display-order transaction id of raw transaction hex.
export const txidOf = (hex: string) => hashTransaction(hexToBin(hex))

// The text of an OP_RETURN output with a single push, as THORChain's UTXO signer writes its memo.
export const opReturnText = (lockingBytecode: Uint8Array): string | undefined => {
  if (lockingBytecode[0] !== 0x6a || lockingBytecode.length < 2) return undefined
  const op = lockingBytecode[1]
  let start = 2
  let length = op
  if (op === 0x4c) {
    length = lockingBytecode[2]
    start = 3
  } else if (op > 0x4b) {
    return undefined
  }
  if (start + length !== lockingBytecode.length) return undefined
  return new TextDecoder().decode(lockingBytecode.slice(start, start + length))
}

// --- JSON over WebSocket -----------------------------------------------------------------------

// One request/response client for both Fulcrum (Electrum JSON-RPC) and the Cauldron Router, which
// share the `{ id, method, params } -> { id, result | error }` shape. Opened per use and closed after,
// unless a caller listens for server notifications (`onNotification`, a subscription) and keeps it open.
export class WsRpc {
  private ws?: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly url: string,
    private readonly options: {
      jsonrpc?: boolean
      timeoutMs?: number
      // A message the server pushes without a request: a subscription's updates.
      onNotification?: (method: string, params: unknown) => void
      // The socket went away, whether the server closed it or `close()` did.
      onClose?: () => void
    } = {}
  ) {}

  async open(): Promise<this> {
    if (this.ws?.readyState === WebSocket.OPEN) return this
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url)
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`Timed out connecting to ${new URL(this.url).host}`))
      }, this.options.timeoutMs ?? 15_000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`Could not connect to ${new URL(this.url).host}`))
      }
      ws.onclose = () => {
        this.failAll(new RpcDropError('Connection closed'))
        this.options.onClose?.()
      }
      ws.onmessage = event => this.onMessage(event.data)
      this.ws = ws
    })
    return this
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new RpcDropError('Not connected'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcTimeoutError(`${method} timed out`))
      }, this.options.timeoutMs ?? 20_000)
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer })
      ws.send(JSON.stringify(this.options.jsonrpc ? { jsonrpc: '2.0', id, method, params } : { id, method, params }))
    })
  }

  close() {
    this.ws?.close()
    this.ws = undefined
  }

  private onMessage(data: unknown) {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (typeof message?.id !== 'number') {
      if (typeof message?.method === 'string') {
        try {
          this.options.onNotification?.(message.method, message.params)
        } catch {
          // A listener's failure must not take the connection down.
        }
      }
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new RpcError(String(message.error.code ?? 'error'), String(message.error.message ?? 'Request failed')))
    else entry.resolve(message.result)
  }

  private failAll(error: Error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export class RpcTimeoutError extends Error {}
// The connection went away before the answer came.
export class RpcDropError extends Error {}

// --- Fulcrum lookups ---------------------------------------------------------------------------

// Token outputs (`token_data`, the `include_tokens` filter) are protocol 1.5.0; 1.6.0 changes result shapes this code
// reads, so the range stops at 1.5.3. A 1.4-only server still answers, as 1.4.
export const ELECTRUM_PROTOCOL = ['1.4', '1.5.3']

// Each call runs on one server, in BridgeConfig.electrumUrls order with a failing one asked last for a minute. A server
// that cannot be reached, or drops or stalls mid-call, hands the whole call to the next; its own answer (RpcError) or a
// failed check stands. Rerunning is safe: these are reads, and a broadcast of the same bytes is the same transaction.
// shortcut: at most four servers per call, so a stalled network fails within about a minute and a half; the next call starts on others.
const withElectrum = async <T>(fn: (client: WsRpc) => Promise<T>) => {
  let lastError: unknown = new Error('No BCH server reachable')
  for (const url of ordered(BridgeConfig.electrumUrls).slice(0, 4)) {
    const client = new WsRpc(url, { jsonrpc: true })
    try {
      try {
        await client.open()
        await client.request('server.version', ['thorchain-bch-bridge', ELECTRUM_PROTOCOL])
      } catch (error) {
        throw new RpcDropError(error instanceof Error ? error.message : 'BCH server unreachable')
      }
      const value = await fn(client)
      markUp(url)
      return value
    } catch (error) {
      if (!(error instanceof RpcDropError || error instanceof RpcTimeoutError)) throw error
      lastError = error
      markDown(url)
    } finally {
      client.close()
    }
  }
  throw lastError
}

// Electrum indexes scripts by the reversed sha256 of the locking script.
export const scriptHash = (lockingBytecode: string) => binToHex(sha256.hash(hexToBin(lockingBytecode)).reverse())

interface ElectrumUnspent {
  tx_hash: string
  tx_pos: number
  height: number
  value: number
  token_data?: { category?: unknown; amount?: unknown; nft?: unknown } | null
}

export interface RawTx {
  hex: string
  tx: Transaction
}

// null when no server knows the transaction (yet). The hex is hashed locally against the txid.
const fetchRawTx = async (client: WsRpc, txid: string): Promise<RawTx | null> => {
  const hex = await client.request<string>('blockchain.transaction.get', [normalizeTxid(txid), false]).catch(error => {
    if (error instanceof RpcError) return null
    throw error
  })
  if (hex === null) return null
  if (!isHex(hex) || txidOf(hex) !== normalizeTxid(txid)) throw new Error('BCH server returned a transaction that does not match its id')
  return { hex, tx: decodeTx(hex) }
}

export const getRawTransaction = (txid: string) => withElectrum(client => fetchRawTx(client, txid))

// shortcut: inspect at most 80 recent transactions for 10 seconds, remain uncertain beyond that budget.
export const findWalletTransaction = (lockingBytecode: string, matches: (raw: RawTx) => boolean) =>
  withElectrum(async client => {
    const history = await client.request<{ tx_hash: string; height: number }[]>('blockchain.scripthash.get_history', [scriptHash(lockingBytecode)])
    if (!Array.isArray(history) || history.some(h => !h || !isTxid(h.tx_hash) || !Number.isInteger(h.height) || h.height < -1))
      throw new Error('Unexpected BCH history response')
    const recent = [...history].sort((a, b) => (b.height <= 0 ? Infinity : b.height) - (a.height <= 0 ? Infinity : a.height))
    const deadline = Date.now() + 10_000
    for (const item of recent.slice(0, 80)) {
      if (Date.now() > deadline) throw new Error('BCH history recovery budget exceeded')
      const raw = await fetchRawTx(client, item.tx_hash)
      if (!raw) throw new Error('BCH history transaction is unavailable')
      if (matches(raw)) return { ...raw, txid: normalizeTxid(item.tx_hash) }
    }
    if (recent.length > 80) throw new Error('BCH history recovery limit exceeded')
  })

export interface ScriptUtxo {
  txid: string
  vout: number
  value: bigint
  height: number
  hasToken: boolean
  // The CashToken the output carries, as Fulcrum reports it (`nft` set when it carries an NFT).
  token?: { category: string; amount: bigint; nft: boolean }
}

const tokenOf = (data: ElectrumUnspent['token_data']) => {
  if (!data || typeof data.category !== 'string' || !/^[0-9a-f]{64}$/.test(data.category)) return undefined
  let amount = 0n
  try {
    amount = BigInt(String(data.amount ?? '0'))
  } catch {
    return undefined
  }
  return { category: data.category, amount, nft: data.nft !== undefined && data.nft !== null }
}

const fetchUnspent = async (client: WsRpc, lockingBytecode: string): Promise<{ tip: number; utxos: ScriptUtxo[] }> => {
  const header = await client.request<{ height: number }>('blockchain.headers.subscribe', [])
  // Fulcrum lists token outputs only when asked; 'include_tokens' keeps them in the answer so a
  // token-carrying output is seen (and refused) rather than silently missing.
  const list = await client.request<ElectrumUnspent[]>('blockchain.scripthash.listunspent', [scriptHash(lockingBytecode), 'include_tokens']).catch(error => {
    if (error instanceof RpcError) return client.request<ElectrumUnspent[]>('blockchain.scripthash.listunspent', [scriptHash(lockingBytecode)])
    throw error
  })
  if (!Array.isArray(list) || typeof header?.height !== 'number') throw new Error('Unexpected BCH server response')
  return {
    tip: header.height,
    utxos: list.map(u => ({
      txid: normalizeTxid(String(u.tx_hash)),
      vout: Number(u.tx_pos),
      value: BigInt(u.value),
      height: Number(u.height),
      hasToken: u.token_data !== undefined && u.token_data !== null,
      token: tokenOf(u.token_data)
    }))
  }
}

export const confirmationsAt = (height: number, tip: number) => (height > 0 ? tip - height + 1 : 0)

// --- THORChain outbound receipt ----------------------------------------------------------------

export interface VerifiedOutput {
  txid: string
  vout: number
  // Satoshis, as a decimal string.
  value: string
  confirmations: number
  unspent: boolean
}

export type ReceiptCheck =
  | { kind: 'not_found' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; outputs: VerifiedOutput[]; total: string; confirmations: number }

// Checks that `outTxid` is THORChain's BCH outbound for `inboundHash`, paying `lockingBytecode`
// `expectedSats` in plain (token-free) outputs, and reports which of those outputs are still
// unspent and how deeply confirmed. A planned outbound, a wallet balance or the tracker's amount
// is never evidence: only this transaction's own outputs are.
export const verifyThorchainOutbound = async ({
  outTxid,
  inboundHash,
  lockingBytecode,
  expectedSats
}: {
  outTxid: string
  inboundHash: string
  lockingBytecode: string
  expectedSats: bigint
}): Promise<ReceiptCheck> =>
  withElectrum(async client => {
    const raw = await fetchRawTx(client, outTxid)
    if (!raw) return { kind: 'not_found' }
    return checkOutbound(raw, { inboundHash, lockingBytecode, expectedSats }, await fetchUnspent(client, lockingBytecode))
  })

export const checkOutbound = (
  raw: RawTx,
  { inboundHash, lockingBytecode, expectedSats, action = 'OUT' }: { inboundHash: string; lockingBytecode: string; expectedSats: bigint; action?: 'OUT' | 'REFUND' },
  { tip, utxos }: { tip: number; utxos: ScriptUtxo[] }
): ReceiptCheck => {
  const memos = raw.tx.outputs.map(o => opReturnText(o.lockingBytecode)).filter((m): m is string => m !== undefined)
  if (!memos.some(m => sameSourceTransaction(sourceIdFromMemo(m, action), inboundHash)))
    return { kind: 'invalid', reason: 'The BCH transaction is not THORChain’s outbound for this swap (memo mismatch)' }
  const check = checkPayment(raw, lockingBytecode, { tip, utxos })
  if (check.kind === 'ok' && check.total !== expectedSats.toString()) return { kind: 'invalid', reason: `Received ${check.total} sats, THORChain reports ${expectedSats}` }
  return check
}

// What `raw` pays `lockingBytecode` in plain (token-free) outputs, and which of those are still unspent.
export const checkPayment = (raw: RawTx, lockingBytecode: string, { tip, utxos }: { tip: number; utxos: ScriptUtxo[] }): ReceiptCheck => {
  const txid = txidOf(raw.hex)
  const script = hexToBin(lockingBytecode)
  const ours = raw.tx.outputs.map((o, vout) => ({ o, vout })).filter(({ o }) => binsAreEqual(o.lockingBytecode, script))
  if (ours.length === 0) return { kind: 'invalid', reason: 'The BCH transaction pays nothing to the bound address' }
  if (ours.some(({ o }) => o.token)) return { kind: 'invalid', reason: 'The BCH transaction sends tokens to the bound address' }

  const total = ours.reduce((sum, { o }) => sum + o.valueSatoshis, 0n)
  const outputs = ours.map(({ o, vout }) => {
    const utxo = utxos.find(u => u.txid === txid && u.vout === vout)
    return {
      txid,
      vout,
      value: o.valueSatoshis.toString(),
      unspent: !!utxo && utxo.value === o.valueSatoshis && !utxo.hasToken,
      confirmations: utxo ? confirmationsAt(utxo.height, tip) : 0
    }
  })

  return { kind: 'ok', outputs, total: total.toString(), confirmations: Math.min(...outputs.map(o => o.confirmations)) }
}

// Watches the bound address itself: THORChain's outbound for `inboundHash` among its unspent
// outputs (mempool included), found by the OUT:<inbound hash> memo (REFUND:<hash> for a refund of
// a BCH deposit) and checked like any outbound. Lets the BCH count as arrived without waiting for
// THORNode or the tracker to report it.
export const findThorchainOutbound = (inboundHash: string, lockingBytecode: string, action: 'OUT' | 'REFUND' = 'OUT'): Promise<ReceiptCheck> =>
  withElectrum(async client => {
    const unspent = await fetchUnspent(client, lockingBytecode)
    // Newest first: the outbound is the latest payment, unconfirmed ones (height 0) before any block.
    const txids = [...new Set([...unspent.utxos].sort((a, b) => (a.height || Infinity) - (b.height || Infinity)).reverse().map(u => u.txid))]
    for (const txid of txids.slice(0, 20)) {
      const raw = await fetchRawTx(client, txid)
      if (!raw) continue
      const script = hexToBin(lockingBytecode)
      const paid = raw.tx.outputs.reduce((sum, o) => (binsAreEqual(o.lockingBytecode, script) ? sum + o.valueSatoshis : sum), 0n)
      const check = checkOutbound(raw, { inboundHash, lockingBytecode, expectedSats: paid, action }, unspent)
      if (check.kind === 'ok') return check
    }
    return { kind: 'not_found' }
  })

// The BCH that a bridge without a memo (NEAR Intents) says it paid: each listed transaction's plain outputs to
// `lockingBytecode`, read from the chain, together at least `minimumSats`. A transaction no server has yet is
// 'not_found'; one paying less than promised is refused.
export const verifyPayments = (txids: string[], lockingBytecode: string, minimumSats: bigint): Promise<ReceiptCheck> =>
  withElectrum(async client => {
    const unspent = await fetchUnspent(client, lockingBytecode)
    const outputs: VerifiedOutput[] = []
    for (const txid of [...new Set(txids.map(normalizeTxid))]) {
      if (!isTxid(txid)) return { kind: 'invalid', reason: 'The bridge reported a BCH payout that is not a transaction id' }
      const raw = await fetchRawTx(client, txid)
      if (!raw) return { kind: 'not_found' }
      const check = checkPayment(raw, lockingBytecode, unspent)
      if (check.kind !== 'ok') return check
      outputs.push(...check.outputs)
    }
    if (!outputs.length) return { kind: 'not_found' }
    const total = outputs.reduce((sum, o) => sum + BigInt(o.value), 0n)
    if (total < minimumSats) return { kind: 'invalid', reason: `Received ${total} sats, the quote promised at least ${minimumSats}` }
    return { kind: 'ok', outputs, total: total.toString(), confirmations: Math.min(...outputs.map(o => o.confirmations)) }
  })

// Which of `txids` the address's history holds (mempool included): a spend of its outputs by one of
// these is this app's own transaction, whatever a single server says about the txid itself.
export const historyIncludes = (lockingBytecode: string, txids: string[]) =>
  withElectrum(async client => {
    const history = await client.request<{ tx_hash: string }[]>('blockchain.scripthash.get_history', [scriptHash(lockingBytecode)])
    const seen = new Set((Array.isArray(history) ? history : []).map(h => normalizeTxid(String(h.tx_hash))))
    return txids.map(normalizeTxid).filter(id => seen.has(id))
  })

// Every unspent output of `lockingBytecode` (mempool included), with the tokens it carries.
export const listWalletCoins = (lockingBytecode: string) => withElectrum(client => fetchUnspent(client, lockingBytecode))

// Whether each outpoint is still an unspent, token-free output of `lockingBytecode`.
export const checkUnspent = (lockingBytecode: string, outpoints: { txid: string; vout: number; value: string }[]) =>
  withElectrum(async client => {
    const { tip, utxos } = await fetchUnspent(client, lockingBytecode)
    return outpoints.map(p => {
      const utxo = utxos.find(u => u.txid === normalizeTxid(p.txid) && u.vout === p.vout)
      return { ...p, unspent: !!utxo && utxo.value.toString() === p.value && !utxo.hasToken, confirmations: utxo ? confirmationsAt(utxo.height, tip) : 0 }
    })
  })

// Whether each outpoint is still unspent with the value and token it is claimed to hold, whatever
// script it pays (Fulcrum's blockchain.utxo.get_info answers null for a spent or unknown output).
export const checkOutpointsLive = async (outpoints: { txid: string; vout: number; value: bigint; token?: { category: string; amount: bigint } }[]) =>
  !outpoints.length ? [] : withElectrum(client =>
    Promise.all(
      outpoints.map(async p => {
        const info = await client.request<{ value?: number; token_data?: { category?: string; amount?: string | number } } | null>('blockchain.utxo.get_info', [
          normalizeTxid(p.txid),
          p.vout
        ])
        const token = info?.token_data
        const tokenMatches = p.token
          ? token?.category === p.token.category && BigInt(token.amount ?? -1) === p.token.amount
          : token === undefined || token === null
        return { ...p, live: !!info && BigInt(info.value ?? -1) === p.value && tokenMatches }
      })
    )
  )

// Sends a signed transaction to the network through Fulcrum; answers the txid. A server error
// (RpcError) is the node's verdict on the transaction; any other error is a failed delivery.
export const broadcastTransaction = (signedHex: string) => withElectrum(client => client.request<string>('blockchain.transaction.broadcast', [signedHex]))

// The second leg's state on chain: 'unknown' when no server has it, else its confirmations.
export const getTransactionState = (txid: string) =>
  withElectrum(async client => {
    const raw = await fetchRawTx(client, txid)
    if (!raw) return { seen: false as const }
    const verbose = await client.request<{ confirmations?: number }>('blockchain.transaction.get', [normalizeTxid(txid), true]).catch(() => ({}) as { confirmations?: number })
    return { seen: true as const, confirmations: Number(verbose.confirmations ?? 0) }
  })

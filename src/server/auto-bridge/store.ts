import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { addressToLockingBytecode, bchAddressProblem, decodeTx, type VerifiedOutput } from '@/lib/bch'
import { binToHex, hexToBin, secp256k1, utf8ToBin } from '@bitauth/libauth'
import { MAX_MEMO_BYTES } from '@/lib/thorchain-deposit'
import { REFUND_AFTER_SECONDS, SALE_EXACT_RESERVE } from '@/lib/router-contract'
import { sourceTransactionId } from '@/lib/source-transaction'
import { PublicWallet } from '@/server/auto-bridge/wallet'
import { OrderError, orderCategory, positiveAmount, type Attempt, type Limits, type Order, type OrderIntent, type PublicOrder } from '@/server/auto-bridge/types'
import { ROUTE_MEMO, type FeedOrder } from '@/lib/auto-bridge-contract'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const capabilityHash = (capability: string) => {
  if (!/^[a-f0-9]{64}$/.test(capability)) throw new OrderError(401, 'Order authorization required')
  return hash(capability)
}
const intentHash = (intent: OrderIntent) =>
  hash(JSON.stringify([intent.recipientAddress, intent.refundAddress, intent.expectedBchSats, ...(intent.source ? [intent.source] : []), ...(intent.category ? [{ category: intent.category }] : []),
    ...(intent.sale ? [{ sale: intent.sale }] : [])]))
type Patch = Partial<Pick<Order, 'state' | 'inboundHash' | 'sourceHash' | 'funding' | 'receivedAt' | 'deadline' | 'payoutTxid' | 'error' | 'observedFunding' | 'lastCheckedAt' | 'observation' | 'sourceRefunds' | 'nearDepositAddress' | 'shapeshiftQuoteId'>>
const terminal = new Set(['completed', 'refunded', 'source_refunded', 'manual_review'])
const coinsHeld = (order: Order) => [...new Map([
  ...(!['completed', 'refunded', 'source_refunded'].includes(order.state) ? order.funding : []),
  ...(order.observedFunding ?? [])
].map(coin => [`${coin.txid}:${coin.vout}`, coin])).values()]

export class OrderStore {
  private readonly db: DatabaseSync
  private readonly wallet: PublicWallet
  private readonly guardFile?: string
  private writing = false
  private dirty = false

  constructor(
    path: string,
    xpub: string,
    readonly limits: Limits,
    private readonly maxWaitMs = 1800000,
    guardFile = path === ':memory:' ? undefined : `${path}.guard`,
    // New orders get a contract deposit (non-custodial) instead of a plain Router address.
    private readonly contractOrders = false,
    // Sale orders (back from BCH through the sale contract) are admitted.
    private readonly saleOrders = false,
    // Orders may take their first leg through NEAR Intents (api.ts attachSource).
    readonly nearOrders = false,
    // Sales may pay a NEAR Intents or ShapeShift deposit address instead of THORChain's vault.
    readonly saleRoutes = false,
    // Forward contract orders use contracts/router-order-v2.cash (the page's key, a coin's share of the minimum).
    private readonly orderV2 = false
  ) {
    this.wallet = new PublicWallet(xpub)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, address_index INTEGER NOT NULL UNIQUE,
        capability_hash TEXT NOT NULL, intent_hash TEXT NOT NULL,
        state TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        txid TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
        status TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_order ON attempts(order_id);`)
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('wallet', xpub)
    if ((this.db.prepare('SELECT value FROM metadata WHERE name=?').get('wallet') as { value: string }).value !== xpub) {
      this.db.close()
      throw new Error('Database belongs to another wallet')
    }
    this.guardFile = guardFile
    const sequence = this.db.prepare('SELECT value FROM metadata WHERE name=?').get('recovery_sequence') as { value: string } | undefined
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('recovery_sequence', '0')
    // Legacy databases bootstrap once. A missing guard after that is a recovery stop, never a reset.
    if (guardFile && !existsSync(guardFile) && !sequence) this.writeGuard('0')
  }

  get recoveryRequired() {
    if (!this.guardFile) return false
    try {
      const row = this.db.prepare('SELECT value FROM metadata WHERE name=?').get('recovery_sequence') as { value: string }
      return readFileSync(this.guardFile, 'utf8').trim() !== row.value
    } catch { return true }
  }
  assertWritable() {
    if (this.recoveryRequired) throw new OrderError(503, 'Order database requires recovery verification; admission and signing are paused')
  }
  private writeGuard(value: string) {
    if (!this.guardFile) return
    mkdirSync(dirname(this.guardFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.guardFile}.${randomUUID()}.tmp`
    const file = openSync(temporary, 'wx', 0o600)
    try { writeSync(file, `${value}\n`); fsyncSync(file) } finally { closeSync(file) }
    renameSync(temporary, this.guardFile)
    const directory = openSync(dirname(this.guardFile), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
  private write<T>(fn: () => T): T {
    if (this.writing) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.writing = true
    this.dirty = false
    let advanced = false
    try {
      this.assertWritable()
      const result = fn()
      if (this.dirty) {
        const current = this.db.prepare('SELECT value FROM metadata WHERE name=?').get('recovery_sequence') as { value: string }
        const next = (BigInt(current.value) + 1n).toString()
        // Before SQLite commit: a crash can require review, but cannot silently allow a stale restore.
        advanced = true
        this.writeGuard(next)
        this.db.prepare('UPDATE metadata SET value=? WHERE name=?').run(next, 'recovery_sequence')
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* SQLite already ended the transaction */ }
      // A failed write (disk full, I/O error) must not leave the guard ahead of the database, which would
      // read as a stale restore and stop signing for good. Bring it back to what the database holds.
      if (advanced) {
        try { this.writeGuard((this.db.prepare('SELECT value FROM metadata WHERE name=?').get('recovery_sequence') as { value: string }).value) } catch { /* stays ahead: the recovery stop */ }
      }
      throw error
    } finally { this.writing = false }
  }

  close() {
    this.db.close()
  }
  get(id: string): Order | undefined {
    const row = this.db.prepare('SELECT payload FROM orders WHERE id=?').get(id) as { payload: string } | undefined
    return row ? (JSON.parse(row.payload) as Order) : undefined
  }
  isDepositScript(script: string) {
    return !!this.db.prepare("SELECT 1 FROM orders WHERE json_extract(payload,'$.binding.lockingBytecode')=? LIMIT 1").get(script)
  }
  active() {
    // shortcut: poll retained scripts; add a subscription cache before sustained abandoned-order volume.
    return (
      this.db
        .prepare("SELECT payload FROM orders WHERE state NOT IN ('completed','refunded','source_refunded','manual_review') ORDER BY address_index")
        .all() as { payload: string }[]
    ).map(row => JSON.parse(row.payload) as Order)
  }
  exposure() {
    return this.all().reduce((sum, order) => sum + coinsHeld(order).reduce((total, coin) => total + BigInt(coin.value), 0n), 0n)
  }
  private all(): Order[] {
    return (this.db.prepare('SELECT payload FROM orders').all() as { payload: string }[]).map(row => JSON.parse(row.payload))
  }
  nextWork(now = Date.now(), coldLimit = 5) {
    const hot = this.db.prepare(`SELECT payload FROM orders WHERE state NOT IN ('completed','refunded','source_refunded','manual_review') AND
      (json_array_length(payload,'$.funding')>0 OR json_array_length(payload,'$.observedFunding')>0 OR
      EXISTS(SELECT 1 FROM attempts WHERE order_id=orders.id) OR json_extract(payload,'$.createdAt')>?)
      ORDER BY CASE WHEN EXISTS(SELECT 1 FROM attempts WHERE order_id=orders.id) THEN 0
      WHEN json_array_length(payload,'$.funding')>0 OR json_array_length(payload,'$.observedFunding')>0 THEN 1 ELSE 2 END, address_index`)
      .all(now - 1800000) as { payload: string }[]
    const cold = (this.db.prepare(`SELECT payload FROM orders WHERE COALESCE(json_extract(payload,'$.lastCheckedAt'),0)<=?
      AND (state IN ('completed','refunded','source_refunded','manual_review') OR
        (COALESCE(json_array_length(payload,'$.funding'),0)=0 AND COALESCE(json_array_length(payload,'$.observedFunding'),0)=0
        AND NOT EXISTS(SELECT 1 FROM attempts WHERE order_id=orders.id) AND json_extract(payload,'$.createdAt')<=?))
      ORDER BY COALESCE(json_extract(payload,'$.lastCheckedAt'),0), address_index LIMIT ?`)
      .all(now - 300000, now - 1800000, coldLimit) as { payload: string }[]).map(row => JSON.parse(row.payload) as Order)
    return [...hot.map(row => JSON.parse(row.payload) as Order), ...cold].map(order => {
      this.update(order.id, order.version, { lastCheckedAt: now }, now)
      return this.get(order.id)!
    })
  }

  authorized(id: string, capability: string): Order {
    const supplied = capabilityHash(capability)
    const row = this.db.prepare('SELECT capability_hash FROM orders WHERE id=?').get(id) as { capability_hash: string } | undefined
    if (!row || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(row.capability_hash, 'hex'))) throw new OrderError(404, 'Order not found')
    return this.get(id)!
  }

  create(id: string, capability: string, intent: OrderIntent, minPusd: string, now = Date.now()): Order {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new OrderError(400, 'Invalid order identifier')
    const auth = capabilityHash(capability)
    positiveAmount(intent.expectedBchSats)
    positiveAmount(minPusd)
    if (intent.category !== undefined && !/^[0-9a-f]{64}$/.test(intent.category)) throw new OrderError(400, 'Invalid token category')
    if (intent.pageKey !== undefined && (intent.sale || !/^0[23][0-9a-f]{64}$/.test(intent.pageKey) || !secp256k1.validatePublicKey(hexToBin(intent.pageKey))))
      throw new OrderError(400, 'Invalid page key')
    const recipientScript = addressToLockingBytecode(intent.recipientAddress)
    const refundScript = addressToLockingBytecode(intent.refundAddress)
    if (!recipientScript || !refundScript) throw new OrderError(400, 'Valid mainnet BCH recipient and fallback addresses are required')
    // CashTokens: token-aware software must refuse to send tokens to an address without explicit token support.
    if (!intent.sale && bchAddressProblem(intent.recipientAddress, true)) throw new OrderError(400, 'The token recipient must be a token-aware BCH address (z…)')
    if (intent.sale) {
      const { sale } = intent
      if (!this.saleOrders) throw new OrderError(400, 'Transfers back from BCH are not available through the Cashbridge Router')
      positiveAmount(sale.tokenAmount)
      const vault = addressToLockingBytecode(sale.vaultAddress)
      if (
        !/^[0-9a-f]{64}$/.test(sale.category) || intent.source || intent.category || recipientScript !== refundScript ||
        !vault || !/^76a914[0-9a-f]{40}88ac$/.test(vault) || vault === recipientScript ||
        typeof sale.buyAsset !== 'string' || !/^[A-Z0-9]+\.[A-Z0-9._-]+$/i.test(sale.buyAsset) ||
        typeof sale.destination !== 'string' || !/^\S{1,100}$/.test(sale.destination) ||
        typeof sale.memo !== 'string' || !sale.memo || utf8ToBin(sale.memo).length > MAX_MEMO_BYTES
      )
        throw new OrderError(400, 'Invalid sale order')
      if (sale.route !== undefined || sale.depositSats !== undefined || sale.quoteId !== undefined) {
        if (!this.saleRoutes) throw new OrderError(400, 'Transfers back from BCH through NEAR Intents or ShapeShift are not available through the Cashbridge Router')
        if (
          !['near', 'shapeshift'].includes(sale.route as string) || sale.memo !== ROUTE_MEMO ||
          (sale.route === 'shapeshift') !== (sale.depositSats !== undefined) ||
          (sale.quoteId !== undefined && (sale.route !== 'shapeshift' || !/^[0-9A-Za-z-]{1,100}$/.test(sale.quoteId)))
        )
          throw new OrderError(400, 'Invalid sale order')
        // The exact deposit leaves the miner fee and a relayable change out of the least the sale may bring.
        if (sale.depositSats !== undefined && BigInt(positiveAmount(sale.depositSats)) + SALE_EXACT_RESERVE > BigInt(minPusd))
          throw new OrderError(400, 'Amount is too small for the automatic bridge')
      }
    }
    return this.write(() => {
      const existing = this.get(id)
      if (existing) {
        this.authorized(id, capability)
        const row = this.db.prepare('SELECT intent_hash FROM orders WHERE id=?').get(id) as { intent_hash: string }
        if (row.intent_hash !== intentHash(intent)) throw new OrderError(409, 'Order intent is immutable')
        return existing
      }
      // Release admission capacity, while active() continues watching the never-reused script.
      const active = this.all().filter(order => coinsHeld(order).length > 0 || (!terminal.has(order.state) && now - order.createdAt < 30 * 60 * 1000))
      if (BigInt(intent.expectedBchSats) > this.limits.maxOrderSats) throw new OrderError(400, 'Amount exceeds the order limit')
      if (
        active.length >= this.limits.maxOpenOrders ||
        active.reduce((sum, order) => {
          const actual = coinsHeld(order).reduce((total, coin) => total + BigInt(coin.value), 0n)
          // An order nobody has paid holds nothing, so a burst of unpaid ones cannot close admission; each swap checks the
          // real exposure again (saveAttempt) and sends any excess back as BCH.
          if (actual === 0n && !order.sourceHash && !order.inboundHash) return sum
          return sum + (actual > BigInt(order.expectedBchSats) ? actual : BigInt(order.expectedBchSats))
        }, 0n) +
          BigInt(intent.expectedBchSats) >
          this.limits.maxPendingSats
      )
        throw new OrderError(503, 'Bridge capacity reached')
      const { next } = this.db.prepare('SELECT COALESCE(MAX(address_index), -1) + 1 AS next FROM orders').get() as { next: number }
      // A contract order's deposit commits to its payout terms; anyone may send it back after REFUND_AFTER_SECONDS.
      const refundAfter = Math.floor(now / 1000) + REFUND_AFTER_SECONDS
      const contract = intent.sale
        ? { refundAfter }
        : this.contractOrders
          ? this.orderV2 ? { refundAfter, version: 2 as const, ...(intent.pageKey && { pageKey: intent.pageKey }) } : { refundAfter }
          : undefined
      const binding = this.wallet.deposit({ ...intent, addressIndex: next, contract, recipientScript, refundScript, minPusd })
      if ([recipientScript, refundScript].some(script => script === binding.lockingBytecode || this.isDepositScript(script)))
        throw new OrderError(400, 'Recipient must be outside the deposit wallet')
      const order: Order = {
        ...intent,
        id,
        addressIndex: next,
        binding,
        recipientScript,
        refundScript,
        minPusd,
        maxWaitMs: this.maxWaitMs,
        state: 'awaiting_deposit',
        version: 0,
        createdAt: now,
        updatedAt: now,
        funding: [],
        ...(contract && { contract })
      }
      this.db
        .prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, next, auth, intentHash(intent), order.state, order.version, JSON.stringify(order))
      this.dirty = true
      return order
    })
  }

  update(id: string, version: number, patch: Patch, now = Date.now()) {
    return this.write(() => {
    const old = this.get(id)
    if (!old || old.version !== version) return false
    const allowed: Patch = {}
    for (const name of ['state', 'inboundHash', 'sourceHash', 'funding', 'receivedAt', 'deadline', 'payoutTxid', 'error', 'observedFunding', 'lastCheckedAt', 'observation', 'sourceRefunds', 'nearDepositAddress', 'shapeshiftQuoteId'] as const) {
      if (Object.hasOwn(patch, name)) Object.assign(allowed, { [name]: patch[name] })
    }
    const order = { ...old, ...allowed, version: version + 1, updatedAt: now }
    const changed = (
      this.db
        .prepare('UPDATE orders SET state=?, version=?, payload=? WHERE id=? AND version=?')
        .run(order.state, order.version, JSON.stringify(order), id, version).changes === 1
    )
    // Polling bookkeeping alone does not need the stale-restore guard; it would open the crash window every pass.
    this.dirty ||= changed && Object.keys(allowed).some(name => name !== 'lastCheckedAt')
    return changed
    })
  }

  attempts(id: string): Attempt[] {
    return (this.db.prepare('SELECT payload FROM attempts WHERE order_id=? ORDER BY rowid').all(id) as { payload: string }[]).map(
      row => JSON.parse(row.payload) as Attempt
    )
  }

  saveAttempt(order: Order, attempt: Attempt, now = Date.now()) {
    return this.write(() => {
      if (
        attempt.kind === 'swap' &&
        (this.exposure() > this.limits.maxPendingSats || order.funding.reduce((sum, coin) => sum + BigInt(coin.value), 0n) > this.limits.maxOrderSats)
      )
        throw new OrderError(409, 'Receipt exceeds swap exposure policy')
      if (!this.update(order.id, order.version, { state: 'broadcasting', error: undefined }, now)) {
        return false
      }
      this.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?)').run(attempt.txid, order.id, attempt.status, JSON.stringify(attempt))
      this.dirty = true
      return true
    })
  }

  // A settlement of a contract order that the Router did not sign, already on the network. The Router's own attempts
  // spent the same coins, so none can confirm any more; the worker still watches them, as it does every rejected one.
  recordSettlement(order: Order, attempt: Attempt, funding: VerifiedOutput[], now = Date.now()) {
    return this.write(() => {
      const patch = { state: 'submitted' as const, payoutTxid: attempt.txid, funding, receivedAt: order.receivedAt ?? now, error: undefined }
      if (!this.update(order.id, order.version, patch, now)) return false
      for (const prior of this.attempts(order.id)) if (prior.status !== 'rejected') this.attemptStatus(prior.txid, 'rejected', true)
      this.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?)').run(attempt.txid, order.id, attempt.status, JSON.stringify(attempt))
      this.dirty = true
      return true
    })
  }

  beginBroadcast(txid: string) {
    return this.write(() => {
    const row = this.db.prepare('SELECT payload FROM attempts WHERE txid=?').get(txid) as { payload: string } | undefined
    if (!row) throw new Error('Unknown signed attempt')
    const attempt: Attempt = JSON.parse(row.payload)
    if (!['signed', 'rejected'].includes(attempt.status)) return false
    const changed = (
      this.db
        .prepare("UPDATE attempts SET status='unknown', payload=? WHERE txid=? AND status=?")
        .run(JSON.stringify({ ...attempt, status: 'unknown' }), txid, attempt.status).changes === 1
    )
    this.dirty ||= changed
    return changed
    })
  }

  // `conflicted`: the attempt's inputs were spent elsewhere, which overrides an earlier node acceptance.
  attemptStatus(txid: string, status: Attempt['status'], conflicted = false) {
    return this.write(() => {
    const row = this.db.prepare('SELECT payload FROM attempts WHERE txid=?').get(txid) as { payload: string } | undefined
    if (!row) throw new Error('Unknown signed attempt')
    if (JSON.parse(row.payload).status === 'accepted' && status !== 'accepted' && !conflicted) return
    const attempt = { ...JSON.parse(row.payload), status }
    this.db.prepare('UPDATE attempts SET status=?, payload=? WHERE txid=?').run(status, JSON.stringify(attempt), txid)
    this.dirty = true
    })
  }

  // Counts a definite refusal of a resent attempt and returns the total so far.
  noteRefusal(txid: string) {
    return this.write(() => {
    const row = this.db.prepare('SELECT payload FROM attempts WHERE txid=?').get(txid) as { payload: string } | undefined
    if (!row) throw new Error('Unknown signed attempt')
    const attempt: Attempt = JSON.parse(row.payload)
    const refusals = (attempt.refusals ?? 0) + 1
    this.db.prepare('UPDATE attempts SET payload=? WHERE txid=?').run(JSON.stringify({ ...attempt, refusals }), txid)
    this.dirty = true
    return refusals
    })
  }

  // What the order's payout transaction paid: the token to the recipient, and BCH to the refund script or, for a sale, THORChain's vault.
  private payout(order: Order) {
    const winner = order.payoutTxid ? this.attempts(order.id).find(attempt => attempt.txid === order.payoutTxid) : undefined
    if (!winner) return undefined
    const outputs = decodeTx(winner.hex).outputs
    return {
      winner,
      tokenAmount: outputs
        .filter(
          out =>
            out.token &&
            !out.token.nft &&
            binToHex(out.token.category) === (order.sale?.category ?? orderCategory(order)) &&
            binToHex(out.lockingBytecode) === order.recipientScript
        )
        .reduce((sum, out) => sum + out.token!.amount, 0n)
        .toString(),
      bchAmount: (winner.kind === 'deposit'
        ? [outputs[0]]
        : outputs.filter(out => !out.token && binToHex(out.lockingBytecode) === order.refundScript)
      )
        .reduce((sum, out) => sum + out.valueSatoshis, 0n)
        .toString()
    }
  }

  // The newest orders that reached a chain, for the public scanner. Orders nobody paid into are left out.
  // With `address`, only orders tied to that wallet: its source, either BCH address (in any form of the same
  // script) or a sale's destination. Answers carry no addresses either way.
  feed(limit = 40, address?: string): FeedOrder[] {
    const script = address && addressToLockingBytecode(address)
    const key = (value?: string) => (value && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : value)
    const owns = (order: Order) =>
      (!!script && (order.recipientScript === script || order.refundScript === script)) ||
      [order.source?.address, order.sale?.destination].some(value => !!value && key(value) === key(address))
    return (this.db.prepare('SELECT payload FROM orders ORDER BY address_index DESC LIMIT ?').all(address ? 20000 : limit * 5) as { payload: string }[])
      .map(row => JSON.parse(row.payload) as Order)
      .filter(order => (order.sourceHash || order.inboundHash || order.funding.length || order.payoutTxid) && (!address || owns(order)))
      .slice(0, limit)
      .map((order): FeedOrder => {
        const paid = this.payout(order)
        const source = sourceTransactionId(order.sourceHash) ?? order.inboundHash
        return {
          ref: hash(order.id).slice(0, 12),
          kind: order.sale ? 'sale' : 'forward',
          state: order.state,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          contract: !!order.contract,
          ...((order.nearDepositAddress || order.sale?.route) && { near: true }),
          ...((order.shapeshiftQuoteId || order.sale?.route === 'shapeshift') && { shapeshift: true }),
          ...((order.nearDepositAddress || order.sale?.route) && { nearDeposit: order.nearDepositAddress ?? order.sale!.vaultAddress }),
          category: order.sale?.category ?? orderCategory(order),
          expectedBchSats: order.expectedBchSats,
          ...(order.source && { source: { chain: order.source.chain, asset: order.source.asset, amount: order.source.amount } }),
          ...(order.sale && { sale: { tokenAmount: order.sale.tokenAmount, buyAsset: order.sale.buyAsset } }),
          ...(source && { sourceHash: source }),
          bchReceipts: [...new Map(order.funding.map(coin => [coin.txid, coin.txid])).keys()].map(txid => ({
            txid,
            amountSats: order.funding
              .filter(coin => coin.txid === txid)
              .reduce((sum, coin) => sum + BigInt(coin.value), 0n)
              .toString()
          })),
          ...(paid && { settlement: { kind: paid.winner.kind, txid: paid.winner.txid, tokenAmount: paid.tokenAmount, bchAmount: paid.bchAmount } })
        }
      })
  }

  public(id: string, capability: string): PublicOrder {
    const order = this.authorized(id, capability)
    const paid = this.payout(order)
    const winner = paid?.winner
    const seen = !!order.observation && order.observation.txid === order.payoutTxid && order.observation.seen
    const receipts = new Map<string, { txid: string; amountSats: string; confirmations: number }>()
    for (const coin of order.funding) {
      const old = receipts.get(coin.txid)
      receipts.set(coin.txid, { txid: coin.txid, amountSats: (BigInt(old?.amountSats ?? '0') + BigInt(coin.value)).toString(), confirmations: Math.min(old?.confirmations ?? coin.confirmations, coin.confirmations) })
    }
    return {
      apiVersion: 2,
      id,
      recipientAddress: order.recipientAddress,
      refundAddress: order.refundAddress,
      expectedBchSats: order.expectedBchSats,
      ...(order.category && { category: order.category }),
      ...(order.sale && { sale: order.sale }),
      source: order.source,
      depositAddress: order.binding.cashAddress,
      contract: order.contract && {
        routerKey: order.binding.pubkey,
        refundAfter: order.contract.refundAfter,
        ...(order.contract.version === 2 && { version: 2 as const, pageKey: order.contract.pageKey ?? order.binding.pubkey })
      },
      minPusd: order.minPusd,
      maxWaitSeconds: Math.floor(order.maxWaitMs / 1000),
      state: order.state,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      // The customer's own source stays visible; the verified inbound only stands in for a malformed legacy hint.
      sourceHash: sourceTransactionId(order.sourceHash) ?? order.inboundHash,
      inboundHash: order.inboundHash,
      ...(order.nearDepositAddress && { nearDepositAddress: order.nearDepositAddress }),
      ...(order.shapeshiftQuoteId && { shapeshiftQuoteId: order.shapeshiftQuoteId }),
      receivedSats: order.funding.reduce((sum, coin) => sum + BigInt(coin.value), 0n).toString(),
      receivedAt: order.receivedAt,
      deadline: order.deadline ?? (order.receivedAt === undefined ? undefined : order.receivedAt + order.maxWaitMs),
      bchReceipts: [...receipts.values()],
      payoutTxid: order.payoutTxid,
      error: order.error,
      recoveryRequired: this.recoveryRequired || undefined,
      recoverySats: (order.observedFunding ?? []).filter(coin => terminal.has(order.state) || !order.funding.some(f => f.txid === coin.txid && f.vout === coin.vout))
        .reduce((sum, coin) => sum + BigInt(coin.value), 0n).toString(),
      sourceRefunds: order.sourceRefunds,
      settlement:
        paid && winner
          ? {
              kind: winner.kind,
              txid: winner.txid,
              seen: !!seen,
              confirmations: seen ? order.observation!.confirmations : 0,
              pusdAmount: paid.tokenAmount,
              bchAmount: paid.bchAmount,
              recipientAddress: order.recipientAddress,
              refundAddress: order.refundAddress
            }
          : undefined,
      attempts: this.attempts(id)
        .slice(-20)
        .map(({ hex: _hex, ...attempt }) => attempt)
    }
  }
}

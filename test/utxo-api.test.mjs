// The keyless UTXO explorers behind /api/blockchair: each explorer dialect is read from recorded-shape
// fixtures, a failing explorer hands over to the next, and the answers keep the Blockchair shape the UTXO
// toolbox and the payout/status checks read. Run: npm run test:bridge
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { binToHex, encodeTransaction, hashTransaction, lockingBytecodeToCashAddress } from '@bitauth/libauth'
import { address, networks, Transaction } from 'bitcoinjs-lib'
import { NextRequest } from 'next/server.js'
import { BLOCKCHAIR_CHAINS } from '../src/lib/blockchair.ts'
import { utxoPayout } from '../src/lib/payout-check.ts'
import { outputScriptHex, UTXO_CHAINS } from '../src/lib/utxo-api.ts'

const route = await import('../src/app/api/blockchair/[...path]/route.ts')
const realFetch = globalThis.fetch
const realWebSocket = globalThis.WebSocket
afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.WebSocket = realWebSocket
})

const hex = bytes => Buffer.from(bytes).toString('hex')
const doge = address.toBase58Check(Buffer.alloc(20, 7), 0x1e)
const dogeScript = `76a914${'07'.repeat(20)}88ac`
const ltcBech = 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9'
const btc = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
const btcScript = '0014e8df018c7e326cc253faac7e46cdc51e68542c42'
const hashA = 'aa'.repeat(32)
const hashB = 'bb'.repeat(32)
const deposit = 'ab'.repeat(32)
const memoScript = `6a${(`OUT:${deposit.toUpperCase()}`.length).toString(16)}${hex(Buffer.from(`OUT:${deposit.toUpperCase()}`))}`

const MEMPOOL = 'https://mempool.space/api'
const BLOCKSTREAM = 'https://blockstream.info/api'
const DOGE1 = 'https://doge1.trezor.io/api/v2'
const BITCORE = 'https://api.bitcore.io/api/DOGE/mainnet'
const CYPHER = 'https://api.blockcypher.com/v1/doge/main'

// Upstreams by exact URL: a Response, a function of the request, or an Error for an unreachable host.
const calls = []
function upstreams(table) {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
    const reply = table[String(url)]
    if (reply === undefined) throw new TypeError(`unexpected upstream ${url}`)
    const answer = typeof reply === 'function' ? reply(init) : reply
    if (answer instanceof Error) throw answer
    return answer.clone()
  }
}
// Fulcrum servers by URL: method -> { result } | { error } (or a function of the params); a URL left out is unreachable.
const sockets = []
function fulcrumServers(servers) {
  sockets.length = 0
  globalThis.WebSocket = class {
    static OPEN = 1
    readyState = 0
    sent = []
    constructor(url) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => {
        if (!servers[url]) return this.onerror?.()
        this.readyState = 1
        this.onopen?.()
      })
    }
    send(data) {
      const { id, method, params } = JSON.parse(data)
      this.sent.push({ method, params })
      const reply = servers[this.url][method] ?? { error: { code: -32601, message: `unknown method ${method}` } }
      const answer = typeof reply === 'function' ? reply(params) : reply
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, ...answer }) }))
    }
    close() {
      this.readyState = 3
      this.onclose?.()
    }
  }
}
const IMAGINARY = 'wss://bch.imaginary.cash:50004'
const LOPING = 'wss://bch.loping.net:50004'

const json = (value, status = 200) => Response.json(value, { status })
const text = (value, status = 200) => new Response(value, { status })
const down = () => new TypeError('fetch failed')

async function call(path, { method = 'GET', body, query = '', headers } = {}) {
  const req = new NextRequest(`http://localhost:3000/api/blockchair/${path.join('/')}${query}`, {
    method,
    headers: { 'sec-fetch-site': 'same-origin', ...headers },
    body
  })
  const res = await route[method](req, { params: Promise.resolve({ path }) })
  return { status: res.status, body: await res.json() }
}

const esploraAddress = { chain_stats: { funded_txo_sum: 500_000, spent_txo_sum: 100_000, tx_count: 3 }, mempool_stats: { funded_txo_sum: 20_000, spent_txo_sum: 0, tx_count: 1 } }
const esploraCoins = [
  { txid: hashA, vout: 0, value: 50_000, status: { confirmed: true, block_height: 900_000 } },
  { txid: hashB, vout: 1, value: 370_000, status: { confirmed: true, block_height: 900_001 } },
  { txid: 'cc'.repeat(32), vout: 2, value: 20_000, status: { confirmed: false } }
]

test('every slug the toolbox derives is configured, and only the chains with a network look up addresses', () => {
  for (const slug of Object.values(BLOCKCHAIR_CHAINS)) assert.ok(UTXO_CHAINS[slug]?.explorers.length, slug)
  assert.deepEqual(
    Object.keys(UTXO_CHAINS).filter(slug => UTXO_CHAINS[slug].network),
    ['bitcoin', 'litecoin', 'dogecoin']
  )
})

test('output scripts are derived for the address kinds a wallet holds', () => {
  assert.equal(outputScriptHex(btc, networks.bitcoin), btcScript)
  assert.equal(outputScriptHex('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', networks.bitcoin), `76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac`)
  assert.equal(outputScriptHex('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', networks.bitcoin)?.slice(0, 4), '5120')
  assert.equal(outputScriptHex(doge, UTXO_CHAINS.dogecoin.network), dogeScript)
  assert.equal(outputScriptHex(ltcBech, UTXO_CHAINS.litecoin.network)?.slice(0, 4), '0014')
  assert.equal(outputScriptHex(btc, UTXO_CHAINS.litecoin.network), undefined, 'a Bitcoin address is not a Litecoin one')
})

test('an Esplora address dashboard carries the balance and the UTXOs in Blockchair’s shape', async () => {
  upstreams({ [`${MEMPOOL}/address/${btc}`]: json(esploraAddress), [`${MEMPOOL}/address/${btc}/utxo`]: json(esploraCoins) })
  const { status, body } = await call(['bitcoin', 'dashboards', 'address', btc], { query: '?transaction_details=true&key=sto' })
  assert.equal(status, 200)
  assert.equal(body.context.code, 200)
  assert.deepEqual(body.data[btc].address, { balance: 420_000, transaction_count: 4 })
  assert.deepEqual(body.data[btc].utxo[2], { block_id: -1, index: 2, transaction_hash: 'cc'.repeat(32), value: 20_000 })
  assert.equal(body.data[btc].utxo[0].block_id, 900_000)
})

test('outputs list the unspent coins largest first with their scripts, one page at a time', async () => {
  upstreams({ [`${MEMPOOL}/address/${btc}/utxo`]: json(esploraCoins) })
  const q = `?q=recipient(${btc}),is_spent(false),value(..2000000000000000)&s=value(desc)&limit=2&offset=0`
  const first = await call(['bitcoin', 'outputs'], { query: q })
  assert.deepEqual(first.body.data.map(o => o.value), [370_000, 50_000])
  assert.deepEqual(first.body.data[0], { is_spent: false, transaction_hash: hashB, index: 1, value: 370_000, script_hex: btcScript, block_id: 900_001, spending_signature_hex: null })
  const second = await call(['bitcoin', 'outputs'], { query: q.replace('offset=0', 'offset=2') })
  assert.deepEqual(second.body.data.map(o => o.block_id), [-1], 'the mempool coin is last and unconfirmed')
})

test('Blockbook (Dogecoin) is read for the address, its coins and a transaction with a memo', async () => {
  const tx = {
    txid: hashA,
    blockHeight: -1,
    hex: 'deadbeef',
    vout: [
      { value: '150000', n: 0, hex: dogeScript, addresses: [doge], isAddress: true },
      { value: '0', n: 1, hex: memoScript, addresses: ['OP_RETURN (OUT:AB)'], isAddress: false }
    ]
  }
  upstreams({
    [`${DOGE1}/address/${doge}?details=basic`]: json({ balance: '1000', unconfirmedBalance: '-100', txs: 5, unconfirmedTxs: 1 }),
    [`${DOGE1}/utxo/${doge}`]: json([{ txid: hashA, vout: 1, value: '900', height: 5_000_000, confirmations: 4 }, { txid: hashB, vout: 0, value: '5', confirmations: 0 }]),
    [`${DOGE1}/tx/${hashA}`]: json(tx)
  })
  const dashboard = await call(['dogecoin', 'dashboards', 'address', doge])
  assert.deepEqual(dashboard.body.data[doge].address, { balance: 900, transaction_count: 6 })
  assert.deepEqual(dashboard.body.data[doge].utxo.map(u => u.block_id), [5_000_000, -1])

  const outputs = await call(['dogecoin', 'outputs'], { query: `?q=recipient(${doge}),is_spent(false)&limit=30&offset=0` })
  assert.deepEqual(outputs.body.data.map(o => [o.value, o.script_hex]), [[900, dogeScript], [5, dogeScript]])

  const raw = await call(['dogecoin', 'raw', 'transaction', hashA])
  assert.deepEqual(raw.body.data, { [hashA]: { raw_transaction: 'deadbeef' } })

  // The payout check reads exactly this: a mempool transaction paying the destination with the deposit's memo.
  const transaction = await call(['dogecoin', 'dashboards', 'transaction', hashA])
  assert.equal(transaction.body.data[hashA].transaction.block_id, -1)
  assert.deepEqual(utxoPayout(transaction.body, hashA, { destination: doge, depositTxid: deposit, buyAsset: 'DOGE.DOGE' }), { hash: hashA, amount: '150000' })
})

test('an Esplora transaction is confirmed by its block height', async () => {
  upstreams({
    [`${MEMPOOL}/tx/${hashA}`]: json({ txid: hashA, status: { confirmed: true, block_height: 912_345 }, vout: [{ scriptpubkey: btcScript, scriptpubkey_address: btc, value: 7 }] })
  })
  const { body } = await call(['bitcoin', 'dashboards', 'transaction', hashA])
  assert.deepEqual(body.data[hashA], { transaction: { hash: hashA, block_id: 912_345 }, outputs: [{ recipient: btc, value: 7, script_hex: btcScript }] })
})

test('an explorer that is down, rate-limited or failing hands the call to the next one', async () => {
  upstreams({
    [`${MEMPOOL}/address/${btc}`]: text('slow down', 429),
    [`${MEMPOOL}/address/${btc}/utxo`]: json(esploraCoins),
    [`${BLOCKSTREAM}/address/${btc}`]: text('bad gateway', 502),
    [`${BLOCKSTREAM}/address/${btc}/utxo`]: json(esploraCoins),
    [`https://btc1.trezor.io/api/v2/address/${btc}?details=basic`]: json({ balance: '12', txs: 1 }),
    [`https://btc1.trezor.io/api/v2/utxo/${btc}`]: json([])
  })
  const { status, body } = await call(['bitcoin', 'dashboards', 'address', btc])
  assert.equal(status, 200)
  assert.equal(body.data[btc].address.balance, 12, 'the third explorer answered')
})

test('an address with more coins than Esplora lists is read from Bitcore, not refused', async () => {
  const bitcore = 'https://api.bitcore.io/api/BTC/mainnet'
  upstreams({
    [`${MEMPOOL}/address/${btc}`]: json(esploraAddress),
    [`${MEMPOOL}/address/${btc}/utxo`]: text('Too many unspent transaction outputs (>500). Contact support to raise limits.', 400),
    [`${BLOCKSTREAM}/address/${btc}`]: json(esploraAddress),
    [`${BLOCKSTREAM}/address/${btc}/utxo`]: text('Too many unspent outputs', 400),
    [`${bitcore}/address/${btc}/balance`]: json({ confirmed: 420_000, unconfirmed: 0, balance: 420_000 }),
    [`${bitcore}/address/${btc}/?unspent=true&limit=1000`]: json([{ mintTxid: hashA, mintIndex: 0, mintHeight: 900_000, value: 420_000, spentTxid: '' }])
  })
  const { status, body } = await call(['bitcoin', 'dashboards', 'address', btc], { query: '?limit=1' })
  assert.equal(status, 200)
  assert.equal(body.data[btc].address.balance, 420_000)
  assert.deepEqual(body.data[btc].utxo, [{ block_id: 900_000, index: 0, transaction_hash: hashA, value: 420_000 }])

  const outputs = await call(['bitcoin', 'outputs'], { query: `?q=recipient(${btc}),is_spent(false)&limit=10` })
  assert.deepEqual(outputs.body.data.map(o => [o.transaction_hash, o.script_hex]), [[hashA, btcScript]])
})

test('a CDN block page is the explorer turning us away, so the next explorer is asked', async () => {
  const blocked = () => new Response('<!DOCTYPE html>\n<html class="no-js" lang="en-US"><title>Attention Required! | Cloudflare</title></html>', { status: 403, headers: { 'content-type': 'text/html' } })
  upstreams({
    [`${DOGE1}/tx/${hashA}`]: blocked(),
    [`https://doge2.trezor.io/api/v2/tx/${hashA}`]: json({ txid: hashA, blockHeight: 5_000_001, vout: [] })
  })
  const { status, body } = await call(['dogecoin', 'dashboards', 'transaction', hashA])
  assert.equal(status, 200)
  assert.equal(body.data[hashA].transaction.block_id, 5_000_001)

  upstreams(Object.fromEntries(['doge1', 'doge2', 'doge3'].map(h => [`https://${h}.trezor.io/api/v2/tx/${hashA}`, blocked()])))
  const failed = await call(['dogecoin', 'dashboards', 'transaction', hashA])
  assert.equal(failed.status, 502, 'every explorer blocking us is an outage, not a bad request')
  assert.doesNotMatch(JSON.stringify(failed.body), /DOCTYPE/)
})

test('every explorer failing is a 502 and a refused request is a 400 that stops at the first explorer', async () => {
  upstreams({ ...Object.fromEntries(['doge1', 'doge2', 'doge3'].flatMap(h => [[`https://${h}.trezor.io/api/v2/address/${doge}?details=basic`, down()], [`https://${h}.trezor.io/api/v2/utxo/${doge}`, down()]])) })
  const failed = await call(['dogecoin', 'dashboards', 'address', doge])
  assert.equal(failed.status, 502)
  assert.equal(failed.body.code, 'upstream_unreachable')

  upstreams({ [`${MEMPOOL}/tx`]: text('sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}', 400) })
  const refused = await call(['bitcoin', 'push', 'transaction'], { method: 'POST', body: JSON.stringify({ data: '0200' }) })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /min relay fee not met/)
  assert.equal(calls.length, 1, 'no other explorer is asked to relay a transaction the node refused')
})

test('an unknown transaction is an empty dashboard once every explorer has said so', async () => {
  const notFound = Object.fromEntries(['doge1', 'doge2', 'doge3'].map(h => [`https://${h}.trezor.io/api/v2/tx/${hashA}`, json({ error: `Transaction '${hashA}' not found` }, 400)]))
  upstreams(notFound)
  assert.deepEqual((await call(['dogecoin', 'dashboards', 'transaction', hashA])).body.data, {})
  assert.deepEqual((await call(['dogecoin', 'raw', 'transaction', hashA])).body.data, {})

  upstreams({ [`${MEMPOOL}/tx/${hashA}`]: text('Transaction not found', 404), [`${BLOCKSTREAM}/tx/${hashA}`]: down(), [`https://btc1.trezor.io/api/v2/tx/${hashA}`]: text('x', 500) })
  assert.equal((await call(['bitcoin', 'dashboards', 'transaction', hashA])).body.data[hashA], undefined, 'one explorer not knowing it, the rest failing')
})

test('broadcasting returns the transaction hash from either dialect', async () => {
  upstreams({ [`${MEMPOOL}/tx`]: init => text(init.body === '0200' ? hashA : 'wrong') })
  const esplora = await call(['bitcoin', 'push', 'transaction'], { method: 'POST', body: JSON.stringify({ data: '0200' }) })
  assert.deepEqual(esplora.body, { data: { transaction_hash: hashA }, context: { code: 200 } })

  upstreams({ 'https://doge1.trezor.io/api/v2/sendtx/': () => json({ result: hashB.toUpperCase() }) })
  const blockbook = await call(['dogecoin', 'push', 'transaction'], { method: 'POST', body: JSON.stringify({ data: '0200' }) })
  assert.equal(blockbook.body.data.transaction_hash, hashB)
  assert.equal(calls.at(-1).body, '0200')

  upstreams({ [`${BITCORE}/tx/send`]: init => json(JSON.parse(init.body).rawTx === '0200' ? { txid: hashA } : {}) })
  assert.equal((await call(['dogecoin', 'push', 'transaction'], { method: 'POST', body: JSON.stringify({ data: '0200' }) })).body.data.transaction_hash, hashA)

  upstreams({ [`${BITCORE}/tx/send`]: down(), [`${CYPHER}/txs/push`]: init => json(JSON.parse(init.body).tx === '0200' ? { tx: { hash: hashB } } : {}, 201) })
  assert.equal((await call(['dogecoin', 'push', 'transaction'], { method: 'POST', body: JSON.stringify({ data: '0200' }) })).body.data.transaction_hash, hashB)
})

test('Dogecoin is read from Bitcore, with raw transactions from BlockCypher', async () => {
  upstreams({
    [`${BITCORE}/address/${doge}/balance`]: json({ confirmed: 1000, unconfirmed: -100, balance: 900 }),
    [`${BITCORE}/address/${doge}/?unspent=true&limit=1000`]: json([
      { mintTxid: hashA, mintIndex: 1, mintHeight: 5_000_000, value: 900, spentTxid: '' },
      { mintTxid: hashB, mintIndex: 0, mintHeight: -1, value: 5, spentTxid: '' },
      { mintTxid: 'cc'.repeat(32), mintIndex: 0, mintHeight: 4_000_000, value: 100, spentTxid: 'dd'.repeat(32) }
    ]),
    [`${BITCORE}/tx/${hashA}`]: json({ txid: hashA, blockHeight: -1, outputCount: 2 }),
    [`${BITCORE}/tx/${hashA}/coins`]: json({
      inputs: [],
      outputs: [
        { mintIndex: 1, address: 'false', script: memoScript, value: 0 },
        { mintIndex: 0, address: doge, script: dogeScript, value: 150_000 }
      ]
    }),
    [`${CYPHER}/txs/${hashA}?includeHex=true&limit=100`]: json({ hash: hashA, hex: 'deadbeef', block_height: -1, vout_sz: 0, outputs: [] })
  })
  const dashboard = await call(['dogecoin', 'dashboards', 'address', doge])
  assert.deepEqual(dashboard.body.data[doge].address.balance, 900)
  assert.deepEqual(dashboard.body.data[doge].utxo.map(u => [u.transaction_hash, u.block_id]), [[hashA, 5_000_000], [hashB, -1]], 'a spent coin is left out')

  const transaction = await call(['dogecoin', 'dashboards', 'transaction', hashA])
  assert.deepEqual(transaction.body.data[hashA].outputs[0], { recipient: doge, value: 150_000, script_hex: dogeScript })
  assert.deepEqual(utxoPayout(transaction.body, hashA, { destination: doge, depositTxid: deposit, buyAsset: 'DOGE.DOGE' }), { hash: hashA, amount: '150000' })

  assert.deepEqual((await call(['dogecoin', 'raw', 'transaction', hashA])).body.data, { [hashA]: { raw_transaction: 'deadbeef' } })
})

test('BlockCypher answers when Bitcore cannot, and a transaction it lists only in part is read elsewhere', async () => {
  upstreams({
    [`${BITCORE}/address/${doge}/balance`]: text('bad gateway', 502),
    [`${BITCORE}/address/${doge}/?unspent=true&limit=1000`]: text('bad gateway', 502),
    [`${CYPHER}/addrs/${doge}/balance`]: json({ final_balance: 905, final_n_tx: 6 }),
    [`${CYPHER}/addrs/${doge}?unspentOnly=true&limit=2000`]: json({
      txrefs: [{ tx_hash: hashA, tx_output_n: 1, value: 900, block_height: 5_000_000 }],
      unconfirmed_txrefs: [
        { tx_hash: hashB, tx_output_n: 0, value: 5, block_height: -1 },
        { tx_hash: 'cc'.repeat(32), tx_output_n: -1, value: 50, block_height: -1 }
      ]
    })
  })
  const dashboard = await call(['dogecoin', 'dashboards', 'address', doge])
  assert.deepEqual(dashboard.body.data[doge].address, { balance: 905, transaction_count: 6 })
  assert.deepEqual(dashboard.body.data[doge].utxo.map(u => u.block_id), [5_000_000, -1], 'a pending spend’s input is not a coin')

  upstreams({
    [`${BITCORE}/tx/${hashA}`]: down(),
    [`${CYPHER}/txs/${hashA}?includeHex=true&limit=100`]: json({ hash: hashA, block_height: 5_000_002, vout_sz: 101, outputs: [{ value: 1, script: dogeScript, addresses: [doge] }] }),
    [`${DOGE1}/tx/${hashA}`]: json({ txid: hashA, blockHeight: 5_000_002, vout: [] })
  })
  const { status, body } = await call(['dogecoin', 'dashboards', 'transaction', hashA])
  assert.equal(status, 200)
  assert.deepEqual(body.data[hashA].outputs, [], 'Blockbook’s full answer, not BlockCypher’s first page')
})

test('the route serves only the toolbox endpoints, for configured chains, with checked input', async () => {
  upstreams({})
  const refused = [
    [['bitcoin', 'stats']],
    [['__proto__', 'dashboards', 'address', btc]],
    [['constructor', 'outputs']],
    [['bitcoin', 'dashboards', 'transaction', `${hashA},${hashB}`], { status: 400 }],
    [['bitcoin', 'dashboards', 'address', 'bc1q/../x']],
    [['bitcoin', 'dashboards', 'address', '..', 'x']],
    [['bitcoin', 'dashboards', 'address', 'short'], { status: 400 }],
    [['bitcoin', 'outputs'], { status: 400, query: '?q=is_spent(false)' }],
    [['bitcoin-cash', 'dashboards', 'address', btc]],
    [['dash', 'outputs'], { query: `?q=recipient(${btc})` }],
    [['bitcoin', 'push', 'transaction'], { status: 400, method: 'POST', body: '{"data":"not hex"}' }],
    [['bitcoin', 'dashboards', 'address', btc], { method: 'POST', body: '{}' }]
  ]
  for (const [path, { status = 404, ...options } = {}] of refused) assert.equal((await call(path, options)).status, status, `${path.join('/')} ${options.query ?? ''}`)
  assert.equal(calls.length, 0, 'nothing reached an explorer')
  assert.equal((await call(['bitcoin', 'dashboards', 'address', btc], { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
})

test('Zcash is read from Blockchair in its own shape, and a used-up quota hands over to the next explorer', async () => {
  const ZEC = 'https://api.blockchair.com/zcash'
  const tAddr = 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU'
  upstreams({
    [`${ZEC}/dashboards/transaction/${hashA}`]: json({
      data: { [hashA]: { transaction: { hash: hashA, block_id: 3_588_844 }, inputs: [], outputs: [{ recipient: tAddr, value: 150_000, script_hex: dogeScript, type: 'pubkeyhash' }, { recipient: '', value: 0, script_hex: memoScript, type: 'nulldata' }] } },
      context: { code: 200 }
    }),
    [`${ZEC}/raw/transaction/${hashA}`]: json({ data: { [hashA]: { raw_transaction: 'deadbeef', decoded_raw_transaction: {} } }, context: { code: 200 } }),
    [`${ZEC}/dashboards/transaction/${hashB}`]: json({ data: [], context: { code: 200 } }),
    [`https://zec1.trezor.io/api/v2/tx/${hashB}`]: down(),
    [`${ZEC}/push/transaction`]: init => json(JSON.parse(init.body).data === '0400' ? { data: { transaction_hash: hashB } } : {})
  })
  const { body } = await call(['zcash', 'dashboards', 'transaction', hashA])
  assert.deepEqual(body.data[hashA], {
    transaction: { hash: hashA, block_id: 3_588_844 },
    outputs: [{ recipient: tAddr, value: 150_000, script_hex: dogeScript }, { value: 0, script_hex: memoScript }]
  })
  assert.deepEqual(utxoPayout(body, hashA, { destination: tAddr, depositTxid: deposit, buyAsset: 'ZEC.ZEC' }), { hash: hashA, amount: '150000' })
  assert.deepEqual((await call(['zcash', 'raw', 'transaction', hashA])).body.data, { [hashA]: { raw_transaction: 'deadbeef' } })
  assert.deepEqual((await call(['zcash', 'dashboards', 'transaction', hashB])).body.data, {}, 'unknown to Blockchair, Trezor down')
  assert.equal((await call(['zcash', 'push', 'transaction'], { method: 'POST', body: JSON.stringify({ data: '0400' }) })).body.data.transaction_hash, hashB)

  upstreams({
    [`${ZEC}/dashboards/transaction/${hashA}`]: json({ data: null, context: { code: 402, error: 'Limit exceeded' } }, 402),
    [`https://zec1.trezor.io/api/v2/tx/${hashA}`]: json({ txid: hashA, blockHeight: 3_000_000, vout: [] })
  })
  const fallback = await call(['zcash', 'dashboards', 'transaction', hashA])
  assert.equal(fallback.status, 200, 'a quota answer is not a bad request')
  assert.equal(fallback.body.data[hashA].transaction.block_id, 3_000_000)
})

test('transaction lookups work on the chains that cannot look up addresses', async () => {
  upstreams({ [`https://zec1.trezor.io/api/v2/tx/${hashA}`]: json({ txid: hashA, blockHeight: 3_000_000, vout: [] }) })
  assert.equal((await call(['zcash', 'dashboards', 'transaction', hashA])).body.data[hashA].transaction.block_id, 3_000_000)
})

// A BCH transaction paying a P2PKH address with THORChain's memo, as Fulcrum hands it over: raw hex.
const bchScript = Uint8Array.from(Buffer.from(`76a914${'09'.repeat(20)}88ac`, 'hex'))
const bchAddress = lockingBytecodeToCashAddress({ prefix: 'bitcoincash', bytecode: bchScript }).address
const bchTx = encodeTransaction({
  version: 2,
  inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(3), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
  outputs: [
    { lockingBytecode: bchScript, valueSatoshis: 150_000n },
    { lockingBytecode: Uint8Array.from(Buffer.from(memoScript, 'hex')), valueSatoshis: 0n }
  ],
  locktime: 0
})
const bchHex = binToHex(bchTx)
const bchHash = hashTransaction(bchTx)
const fulcrumWith = (answers = {}) => ({
  'server.version': { result: ['Fulcrum 2.1.4', '1.4'] },
  'blockchain.transaction.get': ([hash, verbose]) =>
    hash !== bchHash ? { error: { code: 2, message: 'No such mempool or blockchain transaction' } } : verbose ? { result: { confirmations: 3 } } : { result: bchHex },
  'blockchain.headers.subscribe': { result: { height: 978_000 } },
  ...answers
})

test('Bitcoin Cash transactions are read from Fulcrum and keep the payout check’s shape', async () => {
  upstreams({})
  fulcrumServers({ [IMAGINARY]: fulcrumWith() })
  const { status, body } = await call(['bitcoin-cash', 'dashboards', 'transaction', bchHash])
  assert.equal(status, 200)
  assert.deepEqual(body.data[bchHash].transaction, { hash: bchHash, block_id: 977_998 })
  assert.deepEqual(body.data[bchHash].outputs[0], { recipient: bchAddress, value: 150_000, script_hex: binToHex(bchScript) })
  assert.equal(body.data[bchHash].outputs[1].recipient, undefined, 'the memo pays nobody')
  assert.deepEqual(utxoPayout(body, bchHash, { destination: bchAddress, depositTxid: deposit, buyAsset: 'BCH.BCH' }), { hash: bchHash, amount: '150000' })
  assert.deepEqual((await call(['bitcoin-cash', 'raw', 'transaction', bchHash])).body.data, { [bchHash]: { raw_transaction: bchHex } })
  assert.equal(calls.length, 0, 'Trezor is not asked while Fulcrum answers')
})

test('a Fulcrum server that is down or answers another transaction hands over to the next', async () => {
  upstreams({})
  // The first server is unreachable; the second has it in the mempool (no confirmations yet).
  fulcrumServers({ [LOPING]: fulcrumWith({ 'blockchain.transaction.get': ([, verbose]) => ({ result: verbose ? {} : bchHex }) }) })
  const mempool = await call(['bitcoin-cash', 'dashboards', 'transaction', bchHash])
  assert.equal(mempool.body.data[bchHash].transaction.block_id, -1)
  // The dead server is asked last for a while: the next call starts with the one that answered.
  sockets.length = 0
  assert.deepEqual((await call(['bitcoin-cash', 'raw', 'transaction', bchHash])).body.data, { [bchHash]: { raw_transaction: bchHex } })
  assert.equal(sockets[0].url, LOPING)

  fulcrumServers({ [IMAGINARY]: fulcrumWith({ 'blockchain.transaction.get': () => ({ result: '0200' }) }), [LOPING]: fulcrumWith() })
  assert.deepEqual((await call(['bitcoin-cash', 'raw', 'transaction', bchHash])).body.data, { [bchHash]: { raw_transaction: bchHex } })

  // Both servers down and Trezor turning the site away is an outage.
  fulcrumServers({})
  upstreams({ [`https://bch1.trezor.io/api/v2/tx/${bchHash}`]: new Response('<!DOCTYPE html><html></html>', { status: 403 }) })
  assert.equal((await call(['bitcoin-cash', 'dashboards', 'transaction', bchHash])).status, 502)

  // Unknown everywhere is an empty dashboard.
  fulcrumServers({ [IMAGINARY]: fulcrumWith(), [LOPING]: fulcrumWith() })
  upstreams({ [`https://bch1.trezor.io/api/v2/tx/${hashA}`]: json({ error: `Transaction '${hashA}' not found` }, 400) })
  assert.deepEqual((await call(['bitcoin-cash', 'dashboards', 'transaction', hashA])).body.data, {})
})

test('a Bitcoin Cash broadcast goes through Fulcrum, and a node refusal stops there', async () => {
  upstreams({})
  fulcrumServers({ [IMAGINARY]: fulcrumWith({ 'blockchain.transaction.broadcast': ([hex]) => ({ result: hex === bchHex ? bchHash : 'x' }) }) })
  const sent = await call(['bitcoin-cash', 'push', 'transaction'], { method: 'POST', body: JSON.stringify({ data: bchHex }) })
  assert.deepEqual(sent.body, { data: { transaction_hash: bchHash }, context: { code: 200 } })

  fulcrumServers({
    [IMAGINARY]: fulcrumWith({ 'blockchain.transaction.broadcast': { error: { code: 1, message: 'the transaction was rejected by network rules (min relay fee not met)' } } }),
    [LOPING]: fulcrumWith()
  })
  const refused = await call(['bitcoin-cash', 'push', 'transaction'], { method: 'POST', body: JSON.stringify({ data: bchHex }) })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /min relay fee not met/)
  assert.deepEqual(sockets.map(s => s.url), [IMAGINARY], 'no other server is asked to relay a transaction the node refused')
})

// The toolbox itself, pointed at the route the way src/lib/wallets.ts points it, builds spendable
// transactions from the explorers' answers: fee estimate, maximum amount, UTXOs with scripts and raw transactions.
test('the UTXO toolbox builds Dogecoin and Bitcoin transactions through the route', async () => {
  const require = createRequire(import.meta.url)
  const { USwapConfig, Chain, AssetValue } = require('@tcswap/helpers')
  // The package's ESM entry cannot be imported by Node (a directory import); its CommonJS entry is the same code.
  const { getToolbox } = require(fileURLToPath(new URL('../node_modules/@tcswap/toolboxes/dist/index.cjs', import.meta.url)))
  USwapConfig.setEnv('blockchairApiUrl', 'http://localhost:3000/api/blockchair')

  const funding = new Transaction()
  funding.addInput(Buffer.alloc(32, 1), 0)
  funding.addOutput(Buffer.from(dogeScript, 'hex'), 1_000_000_000n)
  upstreams({
    [`${DOGE1}/address/${doge}?details=basic`]: json({ balance: '1000000000', txs: 1 }),
    [`${DOGE1}/utxo/${doge}`]: json([{ txid: funding.getId(), vout: 0, value: '1000000000', height: 5_000_000 }]),
    [`${DOGE1}/tx/${funding.getId()}`]: json({ txid: funding.getId(), hex: funding.toHex(), blockHeight: 5_000_000, vout: [] }),
    'https://app.bitgo.com/api/v2/doge/tx/fee': json({ feePerKb: 100_000_000 }),
    'https://app.bitgo.com/api/v2/btc/tx/fee': json({ feePerKb: 2_000 }),
    [`${MEMPOOL}/address/${btc}`]: json(esploraAddress),
    [`${MEMPOOL}/address/${btc}/utxo`]: json([esploraCoins[1]])
  })
  const facade = globalThis.fetch
  globalThis.fetch = (url, init) => {
    if (!String(url).startsWith('http://localhost:3000/api/blockchair/')) return facade(url, init)
    const path = new URL(url).pathname.replace('/api/blockchair/', '').split('/')
    const req = new NextRequest(url, { method: init?.method ?? 'GET', headers: { 'sec-fetch-site': 'same-origin' }, body: init?.body })
    return route[init?.method ?? 'GET'](req, { params: Promise.resolve({ path }) })
  }

  const dogeToolbox = await getToolbox(Chain.Dogecoin)
  const max = await dogeToolbox.estimateMaxSendableAmount({ from: doge, feeOptionKey: 'fast' })
  // The toolbox reports satoshis in the value field here; what matters is balance less a fee.
  assert.ok(Number(max.getValue('string')) > 0 && Number(max.getValue('string')) < 1_000_000_000, 'the maximum is the balance less a fee')
  const sent = await dogeToolbox.createTransaction({ assetValue: AssetValue.from({ chain: Chain.Dogecoin, value: 1 }), recipient: doge, sender: doge, memo: 'hello', feeRate: 1000 })
  assert.deepEqual(sent.inputs.map(i => [i.hash, i.index]), [[funding.getId(), 0]])

  const btcToolbox = await getToolbox(Chain.Bitcoin)
  const utxos = await btcToolbox.getInputsOutputsFee({ assetValue: AssetValue.from({ chain: Chain.Bitcoin, value: 0.0001 }), recipient: btc, sender: btc, feeRate: 2 })
  assert.equal(utxos.inputs[0].value, 370_000)
  assert.equal(calls.some(c => c.url.startsWith(MEMPOOL)), true)
})

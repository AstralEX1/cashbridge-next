import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { RUNS } from '../src/lib/mainnet-runs.ts'
import { explorerIcon, hashLookups, matchesQuery, rowFromOrder, rowFromRun, rowsFromThorchain, SCAN_START, scanRows, walletRows } from '../src/lib/scanner.ts'
import { FEATURED_TOKENS } from '../src/lib/cauldron-tokens.ts'

const PUSD = FEATURED_TOKENS[0]
const order = {
  ref: 'a1b2c3d4e5f6',
  kind: 'forward',
  state: 'completed',
  createdAt: Date.UTC(2026, 10, 19),
  updatedAt: 2000,
  contract: false,
  category: PUSD.category,
  expectedBchSats: '1000000',
  source: { chain: 'BASE', asset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', amount: '5' },
  sourceHash: 'ab'.repeat(32),
  bchReceipts: [{ txid: 'cd'.repeat(32), amountSats: '1000000' }],
  settlement: { kind: 'swap', txid: 'ef'.repeat(32), tokenAmount: '339', bchAmount: '0' }
}

test('every verified mainnet run becomes a completed scanner row with both ends and explorer links', () => {
  for (const run of RUNS) {
    const row = rowFromRun(run)
    assert.equal(row.status, 'completed')
    assert.equal(row.verified, true)
    assert.ok(row.from.amount && row.from.ticker && row.to.amount && row.to.ticker, run.amounts)
    assert.equal(row.legs.length, run.links.length)
    for (const leg of row.legs) assert.match(leg.url, /^https:\/\//)
  }
})

test('the README lists every verified mainnet run with all of its links', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const run of RUNS) for (const [label, url] of run.links) assert.ok(readme.includes(`(${url})`), `${run.amounts}: ${label}`)
})

test('a Router order shows source, THORChain, BCH and payout legs with chain-specific links', () => {
  const row = rowFromOrder(order)
  assert.deepEqual(
    row.legs.map(leg => leg.label),
    ['Base deposit', 'THORChain swap', 'BCH to order', 'PUSD payout']
  )
  assert.match(row.legs[0].url, new RegExp(`0x${'ab'.repeat(32)}$`), 'an EVM deposit hash links with its 0x prefix')
  assert.equal(row.legs[1].url, `https://thorchain.net/tx/${'ab'.repeat(32)}`)
  assert.deepEqual([row.from.ticker, row.from.chain, row.to.ticker, row.to.amount], ['USDC', 'BASE', 'PUSD', '3.39'])
  assert.equal(row.router, true)

  const refunded = rowFromOrder({ ...order, state: 'refunded', settlement: { kind: 'refund', txid: 'ef'.repeat(32), tokenAmount: '0', bchAmount: '99000' } })
  assert.equal(refunded.status, 'refunded')
  assert.equal(rowFromOrder({ ...order, state: 'submitted' }).status, 'completed', 'a payout on the network is done without confirmations')
  assert.equal(rowFromOrder({ ...order, state: 'submitted', settlement: { kind: 'refund', txid: 'ef'.repeat(32), tokenAmount: '0', bchAmount: '1' } }).status, 'refunded')
  assert.equal(rowFromOrder({ ...order, state: 'retrying' }).status, 'pending', 'a refused payout is not done')
  assert.deepEqual([refunded.to.ticker, refunded.to.amount, refunded.legs.at(-1).label], ['BCH', '0.00099', 'BCH refund'])
})

test('a Router order whose first leg went through NEAR Intents links no THORChain record', () => {
  const row = rowFromOrder({ ...order, near: true })
  assert.deepEqual(
    row.legs.map(leg => leg.label),
    ['Base deposit', 'BCH to order', 'PUSD payout']
  )
})

test("each bridge's own tracker is linked: NEAR Intents and ShapeShift by their deposit address, on both directions", () => {
  const nearDeposit = `0x${'12'.repeat(20)}`
  const near = rowFromOrder({ ...order, near: true, nearDeposit })
  assert.deepEqual(near.legs.map(leg => leg.label), ['Base deposit', 'NEAR Intents swap', 'BCH to order', 'PUSD payout'])
  assert.equal(near.legs[1].url, `https://explorer.near-intents.org/transactions/${nearDeposit}`)
  assert.equal(near.legs[1].icon, '/networks/near.svg')
  const shapeshift = rowFromOrder({ ...order, near: true, shapeshift: true, nearDeposit })
  assert.deepEqual([shapeshift.legs[1].label, shapeshift.legs[1].icon], ['ShapeShift swap', '/providers/shapeshift.svg'])
  const sale = {
    ...order,
    kind: 'sale',
    near: true,
    nearDeposit: `bitcoincash:qq${'0'.repeat(40)}`,
    sale: { tokenAmount: '339', buyAsset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' },
    settlement: { kind: 'deposit', txid: 'ef'.repeat(32), tokenAmount: '0', bchAmount: '990000' }
  }
  assert.deepEqual(rowFromOrder(sale).legs.map(leg => leg.label), ['Tokens to contract', 'Sale and NEAR Intents deposit', 'NEAR Intents swap'])
  assert.ok(!rowFromOrder(sale).legs.some(leg => leg.url.includes('thorchain.net')), 'a NEAR Intents sale has no THORChain record')
  assert.equal(rowFromOrder({ ...sale, state: 'submitted' }).status, 'pending', "a sale's deposit is not its payout")
  const thorSale = rowFromOrder({ ...sale, near: undefined, nearDeposit: undefined })
  assert.deepEqual(thorSale.legs.map(leg => leg.label), ['Tokens to contract', 'Sale and THORChain deposit', 'THORChain swap'])
})

test('each end shows its coin with the chain mark only where the coin does not name the chain, and each step its explorer chain', () => {
  const row = rowFromOrder(order)
  assert.deepEqual([row.from.icon, row.from.badge], ['/tokens/usdc.svg', '/networks/base.svg'])
  assert.deepEqual([row.to.icon, row.to.badge], [PUSD.icon, '/networks/bch.svg'])
  assert.deepEqual(
    row.legs.map(leg => leg.icon),
    ['/networks/base.svg', '/networks/thor.svg', '/networks/bch.svg', '/networks/bch.svg']
  )
  const bnb = rowFromRun(RUNS.find(run => run.amounts.startsWith('0.0062 BNB')))
  assert.deepEqual([bnb.from.icon, bnb.from.badge], ['/networks/bsc.svg', undefined], 'a native coin carries no extra chain mark')
  assert.equal(explorerIcon('https://optimistic.etherscan.io/tx/0x1'), '/networks/op.svg')
  assert.equal(explorerIcon('https://etherscan.io/tx/0x1'), '/networks/eth.svg')
  assert.equal(explorerIcon('https://example.com/tx/1'), undefined)
})

test('scanner lists Router orders first and drops a verified run the feed already has', () => {
  const run = RUNS.find(r => r.router)
  const hash = run.links[0][1].split('/').pop().replace(/^0x/i, '')
  const rows = scanRows([{ ...order, sourceHash: hash }], RUNS)
  assert.equal(rows[0].key, order.ref)
  assert.equal(rows.length, RUNS.length)
  assert.ok(matchesQuery(rows[0], hash.toUpperCase()))
  assert.ok(matchesQuery(rows[0], 'base'))
  assert.equal(matchesQuery(rows[0], 'doge'), false)
})

test('a full hash not in the list gets explorer lookups', () => {
  assert.equal(hashLookups('abc').length, 0)
  assert.equal(hashLookups('ab'.repeat(32)).length, 2)
  assert.equal(hashLookups(`0x${'ab'.repeat(32)}`).length, 1)
})

// Midgard's /v2/actions as THORChain reports one swap: amounts in 1e8 units, dates in nanoseconds.
const action = (inAsset, outAsset, extra = {}) => ({
  date: String(BigInt(Date.UTC(2026, 10, 18)) * 1000000n),
  status: 'success',
  type: 'swap',
  in: [{ address: '0xabc', txID: 'AB'.repeat(32), coins: [{ asset: inAsset, amount: '300000000' }] }],
  out: [{ address: 'qq', txID: 'CD'.repeat(32), coins: [{ asset: outAsset, amount: '1306603' }] }],
  metadata: { swap: { memo: '=:c:qq:1' } },
  ...extra
})

test("a wallet's THORChain swaps into or out of BCH become rows; other swaps and malformed answers do not", () => {
  const [row, ...rest] = rowsFromThorchain([
    action('BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', 'BCH.BCH'),
    action('ETH.ETH', 'BTC.BTC', { metadata: { swap: { memo: '=:b:bc1q:1' } } }),
    { type: 'swap', in: 'nope', out: [] },
    null
  ])
  assert.equal(rest.length, 0)
  assert.deepEqual([row.from.amount, row.from.ticker, row.to.amount, row.to.ticker], ['3', 'USDC', '0.01306603', 'BCH'])
  assert.deepEqual(row.legs.map(leg => leg.label), ['Base deposit', 'THORChain swap', 'Payout'])
  assert.match(row.legs[2].url, new RegExp(`explorer\\.selene\\.cash/tx/${'cd'.repeat(32)}$`))
  assert.deepEqual([row.status, row.router, row.time], ['completed', false, Date.UTC(2026, 10, 18)])

  const [refund] = rowsFromThorchain([
    action('ETH.ETH', 'ETH.ETH', { type: 'refund', metadata: { refund: { memo: '=:BCH.BCH:qq:1' } }, out: [{ address: '0xabc', txID: 'EF'.repeat(32), coins: [{ asset: 'ETH.ETH', amount: '100' }] }] })
  ])
  assert.deepEqual([refund.status, refund.to.ticker, refund.legs.at(-1).label], ['refunded', 'ETH', 'Refund'])
  const [pending] = rowsFromThorchain([action('BCH.BCH', 'ETH.ETH', { status: 'pending', out: [] })])
  assert.deepEqual([pending.status, pending.from.ticker], ['pending', 'BCH'])
  assert.deepEqual(pending.legs.map(leg => leg.label), ['Bitcoin Cash deposit', 'THORChain swap'], 'no payout yet')
  const [paying] = rowsFromThorchain([action('BCH.BCH', 'ETH.ETH', { status: 'pending' })])
  assert.equal(paying.status, 'completed', 'a payout with its hash counts, before THORChain finishes')
  const [unsigned] = rowsFromThorchain([action('BCH.BCH', 'ETH.ETH', { status: 'pending', out: [{ address: '0xabc', txID: '0'.repeat(64), coins: [{ asset: 'ETH.ETH', amount: '1' }] }] })])
  assert.equal(unsigned.status, 'pending', 'an outbound without a hash is not paid yet')
})

test("a wallet's rows keep one row per transfer: the Router's order, then a listed row sharing a hash, then its own records", () => {
  const thor = rowsFromThorchain([action('BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', 'BCH.BCH', { in: [{ address: '0xabc', txID: 'AB'.repeat(32), coins: [{ asset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', amount: '500000000' }] }] })])
  const manual = rowsFromThorchain([
    action('ETH.ETH', 'BCH.BCH', {
      date: '1800000000000000000',
      in: [{ address: '0xabc', txID: '12'.repeat(32), coins: [{ asset: 'ETH.ETH', amount: '1' }] }],
      out: [{ address: 'qq', txID: '34'.repeat(32), coins: [{ asset: 'BCH.BCH', amount: '1' }] }]
    })
  ])
  const rows = walletRows({ router: [order], feed: [], local: [], thorchain: [...thor, ...manual] })
  assert.deepEqual(rows.map(row => row.router), [false, true], 'newest first, and the THORChain copy of the Router order is dropped')
  assert.equal(rows[1].key, order.ref)
  const run = RUNS.find(r => r.links.some(([, url]) => url.includes('thorchain.net')))
  const runHash = run.links.find(([, url]) => url.includes('thorchain.net'))[1].split('/').pop()
  const linked = walletRows({ router: [], feed: [rowFromRun(run)], local: [], thorchain: rowsFromThorchain([action('ETH.ETH', 'BCH.BCH', { in: [{ address: '0xabc', txID: runHash.toUpperCase(), coins: [{ asset: 'ETH.ETH', amount: '1' }] }], out: [] })]) })
  assert.deepEqual(linked.map(row => row.verified), [true], 'the verified run stands for its THORChain swap')

  // Transfers before Cash Bridge's first one are not its own: neither the feed nor a wallet lists them.
  const before = SCAN_START - 1
  const old = rowsFromThorchain([action('ETH.ETH', 'BCH.BCH', { date: String(BigInt(before) * 1000000n), in: [{ address: '0xabc', txID: '56'.repeat(32), coins: [{ asset: 'ETH.ETH', amount: '1' }] }] })])
  assert.deepEqual(walletRows({ router: [{ ...order, createdAt: before }], feed: [], local: [], thorchain: old }), [])
  assert.equal(scanRows([{ ...order, createdAt: before }], []).length, 0)
  assert.equal(scanRows([order], []).length, 1)
})

test('Bitcoin Cash links open an explorer that names CashTokens; other chains keep their own', async () => {
  const { explorerTxUrl, explorerAddressUrl } = await import('../src/lib/explorer.ts')
  assert.equal(explorerTxUrl({ chain: 'BCH', txHash: 'AB'.repeat(32) }), `https://explorer.selene.cash/tx/${'ab'.repeat(32)}`)
  assert.equal(explorerAddressUrl({ chain: 'BCH', address: 'bitcoincash:qabc' }), 'https://explorer.selene.cash/address/bitcoincash:qabc')
  assert.match(explorerTxUrl({ chain: 'ETH', txHash: 'ab'.repeat(32) }), /^https:\/\/etherscan\.io\/tx\/0x/)
  for (const run of RUNS) for (const [, url] of run.links) assert.doesNotMatch(url, /blockchair\.com\/bitcoin-cash/)
  assert.equal(explorerIcon(`https://explorer.selene.cash/tx/${'ab'.repeat(32)}`), explorerIcon('https://www.blockchair.com/bitcoin-cash/transaction/x'))
})

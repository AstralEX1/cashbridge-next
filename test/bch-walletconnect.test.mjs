// BCH over WalletConnect v2 (Paytaca, Cashonize): key proof, request encoding and signing outcomes.
// Run: npm run test:bridge
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { binToHex, hexToBin, secp256k1 } from '@bitauth/libauth'
import { bindingFromPubkey } from '../src/lib/bch.ts'
import { reviewBuild, sourcesOf } from '../src/lib/cauldron.ts'
import { signingNoteKey, signInWallet, SignCancelled, SignDeclined, SignSessionLost, SignTimedOut, SignUndelivered } from '../src/lib/bch-signing.ts'
import {
  cashonizeWalletConnectUrl,
  firstP2pkhAddress,
  keyProofMessage,
  paytacaExtensionUrl,
  proveWalletConnectKey,
  recoverMessageKey,
  sessionAddress,
  signedHexOf,
  signedMessageHash,
  walletConnectSignParams,
  walletConnectSigner,
  zapitExtensionUrl
} from '../src/lib/bch-walletconnect.ts'
import { otherKey, privateKey, pubkey, PUSD, signBuild, swapBuild } from './fixtures/bridge-fixtures.mjs'

const binding = bindingFromPubkey(pubkey, 0)
const other = bindingFromPubkey(secp256k1.derivePublicKeyCompressed(otherKey), 0)

// libauth's extended JSON, read back the way Cashonize's and Paytaca's parsers do.
const parseExtended = value =>
  JSON.parse(JSON.stringify(value), (_, v) => {
    if (typeof v !== 'string') return v
    const bytes = /^<Uint8Array: 0x([0-9a-f]*)>$/i.exec(v)
    if (bytes) return hexToBin(bytes[1])
    const big = /^<bigint: (\d+)n>$/.exec(v)
    return big ? BigInt(big[1]) : v
  })

// Signs a message the way Paytaca's signMessage does: recoverable ECDSA, header 31 + recovery id.
const walletSignMessage = (message, key = privateKey) => {
  const sig = secp256k1.signMessageHashRecoverableCompact(key, signedMessageHash(message))
  return btoa(String.fromCharCode(sig.recoveryId + 31, ...sig.signature))
}

test('the session address is the first BCH mainnet P2PKH account', () => {
  assert.equal(sessionAddress(['bch:bchtest:qq', `bch:${other.cashAddress}`, `bch:${binding.cashAddress}`]), other.cashAddress)
  assert.equal(sessionAddress(['eip155:1:0xabc']), undefined)
  assert.equal(sessionAddress(undefined), undefined)
  assert.equal(firstP2pkhAddress([binding.cashAddress.slice('bitcoincash:'.length)]), binding.cashAddress)
  assert.equal(firstP2pkhAddress('nope'), undefined)
})

test('the key is recovered from the connect signature and must hash to the shared address', () => {
  const message = keyProofMessage('Cash Bridge', binding.cashAddress, '00ff')
  assert.match(message, /Nonce: 00ff$/)
  assert.equal(binToHex(recoverMessageKey(message, walletSignMessage(message), binding.cashAddress)), binding.pubkey)
  // Another key's signature, a different message or a garbled one prove nothing.
  assert.throws(() => recoverMessageKey(message, walletSignMessage(message, otherKey), binding.cashAddress), /not signed by the key/)
  assert.throws(() => recoverMessageKey(`${message}!`, walletSignMessage(message), binding.cashAddress), /not signed by the key/)
  assert.throws(() => recoverMessageKey(message, 'AAAA', binding.cashAddress), /unreadable/)
})

test('proving the key asks bch_signMessage once and yields the same binding as WizardConnect', async () => {
  const calls = []
  const client = {
    request: async args => {
      calls.push(args)
      return walletSignMessage(args.request.params.message)
    }
  }
  const proven = await proveWalletConnectKey(client, 'topic', binding.cashAddress, 'Cash Bridge')
  assert.deepEqual(proven, binding)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].request.method, 'bch_signMessage')
  assert.equal(calls[0].chainId, 'bch:bitcoincash')

  const liar = { request: async args => walletSignMessage(args.request.params.message, otherKey) }
  await assert.rejects(proveWalletConnectKey(liar, 'topic', binding.cashAddress, 'Cash Bridge'), /not signed by the key/)
  const refuses = { request: async () => Promise.reject({ code: 5000, message: 'User rejected' }) }
  await assert.rejects(proveWalletConnectKey(refuses, 'topic', binding.cashAddress, 'Cash Bridge'), /declined the connection message/)
})

const funding = [{ txid: 'cc'.repeat(32), vout: 0, value: '1000000' }]
const intent = { category: PUSD, side: 'buy', funding, lockingBytecode: binding.lockingBytecode, tokenAddress: binding.tokenAddress, cashAddress: binding.cashAddress, sell: 990_000n, minOutput: 4_900n }
const reviewed = reviewBuild(swapBuild({ ownScript: hexToBin(binding.lockingBytecode), funding, sellSats: 990_000n, pusdOut: 5_000n }), intent)

// A wallet as the spec describes it: signs the P2PKH inputs whose unlocking bytecode is empty and
// leaves every other input alone.
const specWallet = (key = privateKey) => {
  const calls = []
  return {
    calls,
    request: async args => {
      calls.push(args)
      const { transaction, sourceOutputs } = parseExtended(args.request.params)
      const own = sourceOutputs.flatMap((s, i) => (s.unlockingBytecode.length === 0 ? [i] : []))
      return { signedTransaction: signBuild(transaction, sourceOutputs, own, key), signedTransactionHash: 'unused' }
    }
  }
}

test('bch_signTransaction carries the libauth transaction and source outputs, never asking to broadcast', () => {
  const params = walletConnectSignParams(reviewed, 'Swap BCH for PUSD')
  assert.equal(params.broadcast, false)
  assert.equal(params.userPrompt, 'Swap BCH for PUSD')
  const decoded = parseExtended(params)
  assert.equal(decoded.sourceOutputs.length, decoded.transaction.inputs.length)
  decoded.sourceOutputs.forEach((source, i) => {
    // Cashonize's strict schema: outpoint, sequence, both bytecodes and the value on every entry.
    for (const key of ['outpointIndex', 'outpointTransactionHash', 'sequenceNumber', 'lockingBytecode', 'unlockingBytecode', 'valueSatoshis']) assert.ok(key in source, key)
    assert.equal(source.unlockingBytecode.length === 0, reviewed.ownIndexes.includes(i), 'only our own inputs are marked for signing')
    assert.equal(source.valueSatoshis, sourcesOf(reviewed)[i].valueSatoshis)
  })
})

test('a WalletConnect signature goes through the same checks as a WizardConnect one', async () => {
  const wallet = specWallet()
  const { txid, signedHex } = await signInWallet(walletConnectSigner(wallet, 'topic'), binding, reviewed, 'Swap')
  assert.equal(wallet.calls[0].request.method, 'bch_signTransaction')
  assert.equal(wallet.calls[0].topic, 'topic')
  assert.match(txid, /^[0-9a-f]{64}$/)
  assert.ok(signedHex.length > reviewed.unsignedHex.length)

  // A wallet whose address holds another key cannot pass for the bound one.
  await assert.rejects(signInWallet(walletConnectSigner(specWallet(otherKey), 'topic'), binding, reviewed, 'Swap'), /different key|does not verify|unsigned/)
})

test('a WalletConnect refusal reads as declined, and an abort stops waiting', async () => {
  const refuses = { request: () => Promise.reject({ code: 5000, message: 'User rejected the request' }) }
  await assert.rejects(signInWallet(walletConnectSigner(refuses, 't'), binding, reviewed, 'x'), SignDeclined)

  const controller = new AbortController()
  const pending = signInWallet(walletConnectSigner({ request: () => new Promise(() => {}) }, 't'), binding, reviewed, 'x', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, SignCancelled)
})

test('a request withdrawn after a WalletConnect wallet got it is reported as still open there, and expires at the minimum', async () => {
  const calls = []
  const delivered = Promise.withResolvers()
  const wallet = { request: args => (calls.push(args), delivered.resolve(), new Promise(() => {})) }
  const controller = new AbortController()
  const pending = signInWallet(walletConnectSigner(wallet, 't'), binding, reviewed, 'x', { signal: controller.signal })
  await delivered.promise
  controller.abort()
  await assert.rejects(pending, error => error instanceof SignCancelled && error.stillOpen === true)
  assert.equal(calls[0].expiry, 300)

  const timedOut = signInWallet(walletConnectSigner({ request: () => new Promise(() => {}) }, 't'), binding, reviewed, 'x', { timeoutMs: 1 })
  // AbortSignal.timeout does not hold the event loop open on its own.
  const awake = setTimeout(() => {}, 1000)
  await assert.rejects(timedOut, error => error instanceof SignTimedOut && error.stillOpen === true)
  clearTimeout(awake)

  // A connection that withdraws the request on abort (WizardConnect's sign_cancel) leaves nothing open.
  const withdrawing = { signTransaction: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')))) }
  const other = new AbortController()
  const closed = signInWallet(withdrawing, binding, reviewed, 'x', { signal: other.signal })
  await new Promise(resolve => setImmediate(resolve))
  other.abort()
  await assert.rejects(closed, error => error instanceof SignCancelled && error.stillOpen === false)
})

test('the signed transaction is read as hex or libauth bytes, and anything else is no signature', () => {
  assert.equal(signedHexOf({ signedTransaction: 'ABcd' }), 'abcd')
  assert.equal(signedHexOf({ signedTransaction: '<Uint8Array: 0xabcd>' }), 'abcd')
  assert.equal(signedHexOf({ signedTransaction: 'xyz' }), undefined)
  assert.equal(signedHexOf(null), undefined)
})

test('a connection already gone is reported before anything reaches a wallet', async () => {
  const wallet = specWallet()
  const ended = walletConnectSigner(wallet, 'topic', { isLive: () => false })
  const lost = await signInWallet(ended, binding, reviewed, 'Swap').catch(e => e)
  assert.ok(lost instanceof SignSessionLost)
  // Every caller that handles an undelivered request handles this one too.
  assert.ok(lost instanceof SignUndelivered)
  assert.equal(wallet.calls.length, 0)

  // A check that cannot answer proves nothing: the request goes out as before.
  const unsure = { ...walletConnectSigner(wallet, 'topic'), isLive: () => Promise.reject(new Error('no store')) }
  assert.match((await signInWallet(unsure, binding, reviewed, 'Swap')).txid, /^[0-9a-f]{64}$/)
  assert.equal(wallet.calls.length, 1)
})

test('Paytaca, Cashonize and Zapit WalletConnect deep links carry the pairing URI', async () => {
  assert.equal(paytacaExtensionUrl(), 'chrome-extension://pakphhpnneopheifihmjcjnbdbhaaiaa/www/index.html#/apps/wallet-connect')
  assert.equal(cashonizeWalletConnectUrl(), 'https://cashonize.com/#/wc')
  assert.equal(zapitExtensionUrl(), 'chrome-extension://fccgmnglbhajioalokbcidhcaikhlcpm/index.html#/wallet-connect')
  const uri = 'wc:ab12@2?relay-protocol=irn&symKey=00ff'
  assert.equal(new URLSearchParams(paytacaExtensionUrl(uri).split('?')[1]).get('uri'), uri)
  assert.equal(new URLSearchParams(cashonizeWalletConnectUrl(uri).split('?')[1]).get('uri'), uri)
  assert.equal(new URLSearchParams(zapitExtensionUrl(uri).split('?')[1]).get('uri'), uri)

  const order = []
  const wallet = specWallet()
  const request = wallet.request
  wallet.request = args => (order.push('request'), request(args))
  await signInWallet(walletConnectSigner(wallet, 'topic', { isLive: () => true, beforeRequest: () => order.push('open') }), binding, reviewed, 'Swap')
  assert.deepEqual(order, ['open', 'request'])
})

test('each way a signature did not happen has its own note; a lost session is not shown as an undelivered request', () => {
  assert.equal(signingNoteKey(new SignCancelled('x')), 'signCancelled')
  assert.equal(signingNoteKey(new SignDeclined('x')), 'signDeclined')
  assert.equal(signingNoteKey(new SignTimedOut('x')), 'signTimedOut')
  assert.equal(signingNoteKey(new SignSessionLost('x')), 'signSessionLost')
  assert.equal(signingNoteKey(new SignUndelivered('x')), 'signUndelivered')
  assert.equal(signingNoteKey(new Error('x')), undefined)
})

// Synthetic but consensus-valid BCH transactions for the bridge tests: a THORChain-style outbound
// to the bound address, and a Cauldron-style BCH -> PUSD swap spending it against a stand-in pool.
import {
  binToHex,
  encodeLockingBytecodeP2sh32,
  encodeTransaction,
  generateTransaction,
  hash256,
  hexToBin,
  secp256k1,
  utf8ToBin,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBch
} from '@bitauth/libauth'

export const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544'
export const OTHER_TOKEN = 'ab'.repeat(32)

export const privateKey = hexToBin('11'.repeat(32))
export const pubkey = secp256k1.derivePublicKeyCompressed(privateKey)
export const otherKey = hexToBin('22'.repeat(32))
export const otherPubkey = secp256k1.derivePublicKeyCompressed(otherKey)

const p2pkh = pkh => Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac])
export const scriptFor = async pub => {
  const { hash160 } = await import('@bitauth/libauth')
  return p2pkh(hash160(pub))
}

// A stand-in pool: P2SH32 of `OP_1`, spendable by pushing the redeem script.
export const poolRedeem = Uint8Array.from([0x51])
export const poolScript = encodeLockingBytecodeP2sh32(hash256(poolRedeem))
export const poolUnlock = Uint8Array.from([0x01, 0x51])

export const inboundHash = 'E3A1B0C2D4F6A8B0C2D4E6F8A0B2C4D6E8F0A2B4C6D8E0F2A4B6C8D0E2F4A6B8'

const opReturn = text => {
  const data = utf8ToBin(text)
  return Uint8Array.from([0x6a, ...(data.length < 76 ? [data.length] : [0x4c, data.length]), ...data])
}

export const outboundTx = ({ to, amount, memo = `OUT:${inboundHash}`, token }) => {
  const tx = {
    version: 2,
    locktime: 0,
    inputs: [{ outpointTransactionHash: hexToBin('aa'.repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.from([0x00]) }],
    outputs: [
      { lockingBytecode: to, valueSatoshis: amount, ...(token && { token }) },
      { lockingBytecode: poolScript, valueSatoshis: 50_000_000n },
      { lockingBytecode: opReturn(memo), valueSatoshis: 0n }
    ]
  }
  return binToHex(encodeTransaction(tx))
}

// What tx.build would return for selling `sellSats` of the funding outputs into the pool.
export const swapBuild = ({
  ownScript,
  funding,
  sellSats,
  pusdOut,
  poolBch = 10_000_000_000n,
  poolTokens = 10_000_000n,
  routerFee = 0n,
  minerFee = 600n,
  tokenDust = 1_000n,
  tokenCategory = PUSD,
  extraInputs = [],
  mutate
}) => {
  const fundingTotal = funding.reduce((s, f) => s + BigInt(f.value), 0n)
  const change = fundingTotal - sellSats - routerFee - minerFee - tokenDust
  if (change < 0n) throw new Error('fixture: funding does not cover the sale and fees')
  const inputs = [
    ...funding.map(f => ({ outpointTransactionHash: hexToBin(f.txid), outpointIndex: f.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() })),
    ...extraInputs.map(e => ({ outpointTransactionHash: hexToBin(e.txid), outpointIndex: e.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() })),
    { outpointTransactionHash: hexToBin('bb'.repeat(32)), outpointIndex: 1, sequenceNumber: 0xffffffff, unlockingBytecode: poolUnlock }
  ]
  const sources = [
    ...funding.map(f => ({ value: f.value, locking_script_hex: binToHex(ownScript) })),
    ...extraInputs.map(e => ({ value: e.value, locking_script_hex: binToHex(ownScript) })),
    { value: poolBch.toString(), locking_script_hex: binToHex(poolScript), token: { category: PUSD, amount: poolTokens.toString() } }
  ]
  let outputs = [
    { lockingBytecode: poolScript, valueSatoshis: poolBch + sellSats, token: { category: hexToBin(PUSD), amount: poolTokens - pusdOut } },
    { lockingBytecode: ownScript, valueSatoshis: tokenDust, token: { category: hexToBin(tokenCategory), amount: pusdOut } },
    { lockingBytecode: ownScript, valueSatoshis: change + extraInputs.reduce((s, e) => s + BigInt(e.value), 0n) }
  ]
  if (routerFee > 0n) outputs.push({ lockingBytecode: p2pkh(new Uint8Array(20).fill(9)), valueSatoshis: routerFee })
  const tx = { version: 2, locktime: 0, inputs, outputs }
  mutate?.(tx, sources)
  return {
    unsigned_tx_hex: binToHex(encodeTransaction(tx)),
    source_outputs: sources,
    inputs_to_sign: [...funding, ...extraInputs].map((_, i) => i),
    expected_output: pusdOut.toString(),
    miner_fee_sats: minerFee.toString()
  }
}

// Signs the bound wallet's inputs the way a wallet would (Schnorr, SIGHASH_ALL|FORKID).
export const signBuild = (unsignedTx, sourceOutputs, ownIndexes, key = privateKey) => {
  const compiler = walletTemplateToCompilerBch(walletTemplateP2pkhNonHd)
  const result = generateTransaction({
    version: unsignedTx.version,
    locktime: unsignedTx.locktime,
    inputs: unsignedTx.inputs.map((input, i) =>
      ownIndexes.includes(i)
        ? {
            ...input,
            unlockingBytecode: { compiler, data: { keys: { privateKeys: { key } } }, script: 'unlock', valueSatoshis: sourceOutputs[i].valueSatoshis, ...(sourceOutputs[i].token && { token: sourceOutputs[i].token }) }
          }
        : input
    ),
    outputs: unsignedTx.outputs,
    sourceOutputs
  })
  if (!result.success) throw new Error(JSON.stringify(result.errors ?? result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
  return binToHex(encodeTransaction(result.transaction))
}

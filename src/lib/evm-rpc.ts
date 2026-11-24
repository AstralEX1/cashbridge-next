import { JsonRpcProvider, Network, type JsonRpcPayload, type JsonRpcResult } from 'ethers'
import { getChainConfig, type EVMChain } from '@tcswap/core'
import { EVM_RPC_URLS } from '@/lib/endpoints'
import { rpcFirst } from '@/lib/fallback'

// A node serves reads only once its eth_chainId matches, so a mislisted or wrong-network endpoint never answers.
// A failed check (no answer, or an error answer with no result) is asked again later; a wrong chain stays refused.
const chainChecks = new Map<string, Promise<boolean>>()
const servesChain = (url: string, chainId: bigint) => {
  const key = `${chainId}:${url}`
  let check = chainChecks.get(key)
  if (!check) {
    const retryLater = () => {
      chainChecks.delete(key)
      return false
    }
    check = rpcFirst([url], { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }).then(answer => {
      const result = (answer as { result?: string }).result
      return result === undefined ? retryLater() : BigInt(result) === chainId
    }, retryLater)
    chainChecks.set(key, check)
  }
  return check
}

// ethers' JSON-RPC provider over every listed node of a chain: each call goes to the first node that answers it.
class RotatingProvider extends JsonRpcProvider {
  constructor(
    private readonly urls: string[],
    private readonly chainId: bigint
  ) {
    const network = Network.from(chainId)
    // Public nodes cap batches differently; one call per request avoids a batch refusal failing them all.
    super(urls[0], network, { staticNetwork: network, batchMaxCount: 1 })
  }

  // Error answers come back in the same array (as JsonRpcProvider's own _send returns them); ethers raises them.
  async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const answer = await rpcFirst(this.urls, payload, { accept: url => servesChain(url, this.chainId) })
    return (Array.isArray(answer) ? answer : [answer]) as JsonRpcResult[]
  }
}

const providers = new Map<string, RotatingProvider>()

// Drop-in for the SDK's getProvider: the same JsonRpcProvider API, with the chain's whole endpoint list behind it.
export async function getProvider(chain: EVMChain) {
  let provider = providers.get(chain)
  if (!provider) {
    const config = getChainConfig(chain)
    provider = new RotatingProvider(EVM_RPC_URLS[chain] ?? config.rpcUrls, BigInt(config.chainId))
    providers.set(chain, provider)
  }
  return provider
}

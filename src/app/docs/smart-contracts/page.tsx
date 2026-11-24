import type { Metadata } from 'next'
import Link from 'next/link'
import { ContractSpec, ExitMap, KeyTimeline, TermsMap, TxAnatomy } from '@/components/docs/contract-figures'
import { DocsArticle } from '@/components/docs/docs-ui'
import { FloorCalculator } from '@/components/docs/floor-calculator'
import { RouteFigure } from '@/components/docs/route-figure'
import { LOGO, routeScene } from '@/components/docs/route-scenes'
import { AppConfig } from '@/config'

export const metadata: Metadata = {
  title: 'Smart contracts',
  description: 'How the Cashbridge Router contracts work: one per order, built from its terms, and every way out pays you.',
  alternates: { canonical: '/docs/smart-contracts' }
}

const source = (file: string) => `${AppConfig.repoUrl}/blob/main/contracts/${file}`
const tx = (hash: string) => `https://explorer.selene.cash/tx/${hash}`

// Router runs from Proof on mainnet that went through these contracts.
const RUNS: { route: string; contract: string; links: [string, string][] }[] = [
  {
    route: '5 USDC (Base) → 4.93 PUSD, NEAR Intents',
    contract: 'Order',
    links: [
      ['BCH into the contract', tx('394584f5437ace7fa8688838ad989302ebb72337e7d5cdcc44fc5fa5d0ed22b8')],
      ['convert: PUSD out', tx('bcb7309b577e4063eb7b60b9b3bf805739553edf3f942e5cf76a3b7e944f8cb0')]
    ]
  },
  {
    route: '3 USDC (Base) → 2.71 PUSD, THORChain',
    contract: 'Order',
    links: [
      ['BCH into the contract', tx('38b2f49613c07e9ef918c9612d192623730cda0919770b4efed3429ee55cd6d8')],
      ['convert: PUSD out', tx('15b4f826e22ed0b4982862f20b4f2781fb527cd72cc611aa14a5bd45b8a496f0')]
    ]
  },
  {
    route: 'ETH (Base) → BCH back, THORChain',
    contract: 'Order',
    links: [
      ['BCH into the contract', tx('93c651c63cbbdfc636d98fbac26dd2eda740dc90335e728e71f660fa05bce16b')],
      ['giveBack: BCH out', tx('cbc2a2b00b7c758997f81dc0b2f0d7447b04a24c6584ed79679078a0d3c63349')]
    ]
  },
  {
    route: '2.71 PUSD → 2.43 USDC (Base), THORChain',
    contract: 'Sale',
    links: [
      ['PUSD into the contract', tx('7c9ce40ab7661f4623cbfad3990331d839a2c4c9b62101117bc655865e4a8eda')],
      ['sell', tx('e7e04746a3db1c89113a90751d37e80807e86606a98831e79f92a44ad65cc1a0')],
      ['deposit', tx('7cb8b6fac3b25f494d307660ccf0f97466661ed60e9d06ccde48ab60a6e2a4d8')]
    ]
  },
  {
    route: '4.93 PUSD → 4.96 USDC (Base), NEAR Intents',
    contract: 'Sale',
    links: [
      ['PUSD into the contract', tx('63b66a39947bd65d59cbe1b5a8aa54378a37e0c85d3b5809fe03df35b4677da7')],
      ['sell', tx('a5a2cced6582bf9df79c68c96644a4381b9af333f38000d7aa3d3b848ff956a7')],
      ['deposit', tx('69cfb82f9cff1d62106a3f68198e9047c9b54f4ff08b6857b474e10198b7ff96')]
    ]
  }
]

export default function Page() {
  return (
    <DocsArticle
      href="/docs/smart-contracts"
      title="Smart contracts"
      lead="With the Cashbridge Router you sign once in each direction. Your coins wait in a small CashScript contract on Bitcoin Cash, made for your order alone and built from its terms. Every way out of it pays you: the token you asked for, or your coins back."
    >
      <h2 id="at-a-glance">At a glance</h2>
      <p>
        Two contracts, plain Bitcoin Cash script with no chain, token or admin key of our own. Each order gets a fresh address, and the address is the contract. In every
        check, <code>i</code> is the index of the coin being spent.
      </p>
      <ContractSpec
        name="RouterOrderV2"
        params={['router', 'page', 'payoutLock', 'fallbackLock', 'token', 'minTokens', 'quotedSats', 'refundTime']}
        fns={[
          {
            name: 'convert(sig, key)',
            checks: ['key == router || key == page', 'checkSig(sig, key)', 'out[i].lockingBytecode == payoutLock', 'out[i].tokenCategory == token', 'out[i].tokenAmount >= floor'],
            pays: 'the token to you',
            tone: 'pay'
          },
          {
            name: 'giveBack(sig, key)',
            checks: ['key == router || key == page', 'checkSig(sig, key)', 'out[i].lockingBytecode == fallbackLock', 'out[i].tokenCategory == 0x', 'out[i].value + 2000 >= in[i].value'],
            pays: 'the BCH to your fallback',
            tone: 'back'
          },
          {
            name: 'expire()',
            checks: ['tx.time >= refundTime', 'out[i].lockingBytecode == fallbackLock', 'out[i].tokenCategory == 0x', 'out[i].value + 2000 >= in[i].value'],
            pays: 'the same, with no signature',
            tone: 'back'
          }
        ]}
        caption={
          <>
            Into Bitcoin Cash, with all three bridges. <code>floor = min(in[i].value × minTokens ÷ quotedSats, minTokens)</code>. Source:{' '}
            <a href={source('router-order-v2.cash')} target="_blank" rel="noopener noreferrer">
              router-order-v2.cash
            </a>
            .
          </>
        }
      />
      <ContractSpec
        name="RouterSale"
        params={['router', 'vaultLock', 'memoLock', 'fallbackLock', 'minSats', 'refundTime']}
        fns={[
          {
            name: 'sell(sig)',
            checks: ['checkSig(sig, router)', 'out[i].lockingBytecode == in[i].lockingBytecode', 'out[i].tokenCategory == 0x', 'out[i].value >= minSats'],
            pays: 'BCH back into the contract',
            tone: 'loop'
          },
          {
            name: 'deposit(sig)',
            checks: ['checkSig(sig, router)', 'i == 0, 1 input, 2 outputs, in[0] has no token', 'in[0].value >= minSats', 'out[0] == vaultLock, out[0].value + 2000 >= in[0].value', 'out[1] == memoLock'],
            pays: 'the BCH to the bridge, with the memo',
            tone: 'bridge'
          },
          {
            name: 'giveBack(sig)',
            checks: ['checkSig(sig, router)', 'out[i].lockingBytecode == fallbackLock', 'out[i] token, amount, commitment == in[i]', 'out[i].value + 2000 >= in[i].value'],
            pays: 'your coins back as they came',
            tone: 'back'
          },
          {
            name: 'expire()',
            checks: ['tx.time >= refundTime', 'the same outputs as giveBack'],
            pays: 'the same, with no signature',
            tone: 'back'
          }
        ]}
        caption={
          <>
            Back out, through THORChain or NEAR Intents. ShapeShift takes an exact amount, so its sales use{' '}
            <a href={source('router-sale-exact.cash')} target="_blank" rel="noopener noreferrer">
              RouterSaleExact
            </a>
            : the same, plus <code>depositSats</code>, and <code>deposit</code> pays exactly that to <code>out[0]</code>, the memo to <code>out[1]</code> and the rest to
            your address at <code>out[2]</code>. Source:{' '}
            <a href={source('router-sale.cash')} target="_blank" rel="noopener noreferrer">
              router-sale.cash
            </a>
            .
          </>
        }
      />

      <h2 id="trip">The trip</h2>
      <RouteFigure
        figure={routeScene('in', 'router', 'any').figure}
        caption="Into PUSD with one signature. Whichever bridge quotes best pays its BCH to the order's contract; the trade on Cauldron must pay you at least the quoted minimum, or the BCH goes back to you (dashed)."
      />

      <h2 id="order-contract">The order contract: every way out pays you</h2>
      <p>
        The bridge pays the BCH to the order&apos;s contract. From there a coin can leave three ways, and each one is checked against the output with the coin&apos;s own
        index in the spending transaction, so one payout can never settle two coins.
      </p>
      <ExitMap
        input={{ logo: LOGO.bch, label: 'BCH from the bridge', sub: 'THORChain, NEAR Intents or ShapeShift' }}
        title="Order contract"
        sub="one per order · P2SH20"
        exits={[
          { fn: 'convert', who: 'keys', when: 'any time', logo: LOGO.pusd, result: 'The token, to you', detail: 'at least the floor (your minimum, or its share)', tone: 'pay' },
          { fn: 'giveBack', who: 'keys', when: 'any time', logo: LOGO.bch, result: 'The BCH, to your fallback', detail: 'at most 2,000 sats to the miner', tone: 'back' },
          { fn: 'expire', who: 'anyone', when: 'after the refund time', logo: LOGO.bch, result: 'The BCH, to your fallback', detail: 'same terms, no signature needed', tone: 'back' }
        ]}
        caption={
          <>
            Three functions, three outputs, all to addresses you gave. Source:{' '}
            <a href={source('router-order-v2.cash')} target="_blank" rel="noopener noreferrer">
              contracts/router-order-v2.cash
            </a>
            .
          </>
        }
      />

      <h2 id="terms">The terms are the address</h2>
      <p>
        When you confirm, the Cashbridge Router returns the order&apos;s terms and a deposit address. Your page builds the contract from those terms, hashes it, and
        compares. Only then does it ask your wallet to sign.
      </p>
      <TermsMap />

      <h2 id="keys">Two keys and a clock</h2>
      <p>
        An order has two keys that can <code>convert</code> or <code>giveBack</code>. One is the Router&apos;s. The other is a one-use key your page makes for this
        order, so the page can buy the token the moment the BCH lands, without asking your wallet again. If the tab is closed, the Router finishes.
      </p>
      <KeyTimeline />
      <p>
        The page key stays in this browser while the order runs and is erased once the order is done and no BCH is left at the contract. A leaked key could at most
        buy your token at your minimum or send the BCH back to you, and the site runs only scripts it served with its own nonce, so injected code cannot read the
        key. Sale contracts have only the Router&apos;s key: the sale and the deposit happen while you wait, so there is nothing for the page to finish.
      </p>

      <h2 id="floor">The floor</h2>
      <p>
        A bridge can pay a little less BCH than it quoted. The contract does not send the order back for that: a smaller coin must buy its share of the minimum.
        Drag the amount and see what the contract would demand.
      </p>
      <FloorCalculator />
      <p>
        Only the order&apos;s largest coin of at least half the quoted BCH settles it, so a stranger&apos;s small payment to the address cannot block or hijack the
        swap. Dust under 1,000 sats is ignored, and any other coin goes back to you as BCH once the order is done.
      </p>

      <h2 id="inside-the-trade">Inside the trade</h2>
      <TxAnatomy
        title="A convert transaction"
        rows={[
          { in: { label: 'Cauldron pool', sub: 'one or more', tone: 'pool', logo: LOGO.cauldron }, out: { label: 'The pool, updated', sub: "checked by the pool's own contract", tone: 'pool', logo: LOGO.cauldron } },
          { in: { label: 'Order contract coin', sub: 'the BCH from the bridge', tone: 'contract', logo: LOGO.bch }, out: { label: 'PUSD to you', sub: 'at least the floor', tone: 'you', logo: LOGO.pusd }, checked: true },
          { out: { label: 'The rest of the BCH', sub: 'where the signer sends it', tone: 'free', logo: LOGO.bch } }
        ]}
        caption="The order contract checks the output at its own index: your token address, the token's category and at least the floor. BCH the trade does not need is not checked, so between your minimum and the best price you trust the page or the Router that signs."
      />

      <h2 id="sale-contract">The sale contract: back out in one signature</h2>
      <RouteFigure
        figure={routeScene('out', 'router', 'any').figure}
        caption="PUSD back to USDC with one signature. The Router sells into the contract itself, then the contract deposits the BCH to the bridge fixed in its terms; at any point it can return your coins as they came (dashed)."
      />
      <ExitMap
        input={{ logo: LOGO.pusd, label: 'Your PUSD', sub: 'one signature in your BCH wallet' }}
        title="Sale contract"
        sub="one per sale · P2SH20"
        exits={[
          { fn: 'sell', who: 'router', when: 'any time', logo: LOGO.cauldron, result: 'BCH back into this contract', detail: 'at least the minimum BCH, no token left', tone: 'loop' },
          { fn: 'deposit', who: 'router', when: 'any time', result: 'The BCH, to the bridge in the terms', detail: "THORChain's vault with your memo, or the deposit address", tone: 'bridge' },
          { fn: 'giveBack', who: 'router', when: 'any time', logo: LOGO.pusd, result: 'Your coins, back as they came', detail: 'same token, amount and commitment; ≤ 2,000 sats fee', tone: 'back' },
          { fn: 'expire', who: 'anyone', when: 'after the refund time', logo: LOGO.pusd, result: 'Your coins, back as they came', detail: 'same terms, no signature needed', tone: 'back' }
        ]}
        caption={
          <>
            Four functions; none pays an address that was not in the terms. Sources:{' '}
            <a href={source('router-sale.cash')} target="_blank" rel="noopener noreferrer">
              router-sale.cash
            </a>{' '}
            and{' '}
            <a href={source('router-sale-exact.cash')} target="_blank" rel="noopener noreferrer">
              router-sale-exact.cash
            </a>
            .
          </>
        }
      />
      <div className="fig-pair">
        <TxAnatomy
          title="deposit, THORChain or NEAR Intents"
          rows={[
            { in: { label: 'Sale contract', sub: 'BCH from the sale', tone: 'contract', logo: LOGO.bch }, out: { label: 'Bridge deposit', sub: 'vault or deposit address', tone: 'bridge' }, checked: true },
            { out: { label: 'OP_RETURN memo', sub: 'swap memo, or cashbridge', tone: 'memo' }, checked: true }
          ]}
          caption="The contract is the only input, so THORChain treats it as the sender and a refund comes back to it, then on to you."
        />
        <TxAnatomy
          title="deposit, ShapeShift (exact amount)"
          rows={[
            { in: { label: 'Exact sale contract', sub: 'BCH from the sale', tone: 'contract', logo: LOGO.bch }, out: { label: 'Bridge deposit', sub: 'exactly the quoted BCH', tone: 'bridge' }, checked: true },
            { out: { label: 'OP_RETURN memo', sub: 'cashbridge', tone: 'memo' }, checked: true },
            { out: { label: 'The rest, to you', sub: 'as plain BCH', tone: 'you', logo: LOGO.bch }, checked: true }
          ]}
          caption="ShapeShift quotes an exact amount, so this contract pays exactly that and sends the rest back to your BCH address."
        />
      </div>

      <h2 id="guarantees">What the script guarantees, and what it does not</h2>
      <div className="gx">
        <section data-tone="yes">
          <h3>Guaranteed by the script</h3>
          <ul>
            <li>Coins leave only to your addresses, or to the bridge deposit fixed in a sale&apos;s terms.</li>
            <li>A token payout is at least the floor.</li>
            <li>A refund leaves at most 2,000 sats per coin to the miner.</li>
            <li>After the refund time anyone can send the coins back, so a stopped Router strands nothing.</li>
          </ul>
        </section>
        <section data-tone="trust">
          <h3>Trusted to Cash Bridge</h3>
          <ul>
            <li>The price between your minimum and the best trade.</li>
            <li>When to act before the refund time.</li>
            <li>The bridge itself: THORChain, NEAR Intents or ShapeShift paying the BCH, or the USDC on the way out.</li>
            <li>Your page key while it sits in this browser.</li>
          </ul>
        </section>
      </div>
      <p>
        Manual mode uses no contract at all: your wallets sign every step. See <Link href="/docs/security">Security and custody</Link> for the whole picture.
      </p>

      <h2 id="mainnet">Seen on mainnet</h2>
      <p>
        Router runs from <Link href="/docs/mainnet">Proof on mainnet</Link> that went through these contracts. Open a transaction on the explorer to see the contract&apos;s
        address and its unlocking script.
      </p>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Contract</th>
            <th>On Bitcoin Cash</th>
          </tr>
        </thead>
        <tbody>
          {RUNS.map(run => (
            <tr key={run.route}>
              <td>{run.route}</td>
              <td>{run.contract}</td>
              <td>
                {run.links.map(([label, href], i) => (
                  <span key={href}>
                    {i > 0 && ' · '}
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {label}
                    </a>
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 id="tests">How it is checked</h2>
      <ul>
        <li>
          Every contract runs in the Bitcoin Cash VM in the test suite, on a real Cauldron trade: the honest spend passes, and these fail: a payout to anyone else,
          one unit under the floor, a signature from any other key, an early <code>expire</code>, a refund leaving the miner more than 2,000 sats.
        </li>
        <li>The sale contracts must sell only back into themselves, deposit only to the vault or address in their terms with the memo, and return coins exactly as they came.</li>
        <li>The page and the Router check every transaction they sign in the VM before it is broadcast, and the page only signs inputs of its own order.</li>
        <li>
          <code>npm run test:auto-bridge</code> runs them, with the Router&apos;s side played against a fake network that VM-checks every broadcast.
        </li>
      </ul>

      <h2 id="builders">For developers</h2>
      <table>
        <tbody>
          <tr>
            <th>Source</th>
            <td>
              <a href={`${AppConfig.repoUrl}/tree/main/contracts`} target="_blank" rel="noopener noreferrer">
                contracts/
              </a>{' '}
              (CashScript 0.14). <code>npm run contract:compile</code> rebuilds the JSON artifacts with cashc 0.14.0.
            </td>
          </tr>
          <tr>
            <th>In the app</th>
            <td>
              <code>src/lib/router-contract.ts</code> holds the bytecode; the page and the Router build every address and unlocking script from it.
            </td>
          </tr>
          <tr>
            <th>Address</th>
            <td>P2SH20, because THORChain pays only 20-byte script hashes (a P2SH32 destination fails its address check).</td>
          </tr>
          <tr>
            <th>Signatures</th>
            <td>
              Schnorr with <code>SIGHASH_ALL | SIGHASH_UTXOS</code> (<code>0x61</code>): each signature covers every output and every coin spent.
            </td>
          </tr>
          <tr>
            <th>Refund time</th>
            <td>
              An absolute Unix time (<code>tx.time</code>, compiled to <code>OP_CHECKLOCKTIMEVERIFY</code>), set three hours after the order is made. It is checked
              against the chain&apos;s median time, which runs about an hour behind the clock.
            </td>
          </tr>
          <tr>
            <th>Unlocking</th>
            <td>
              Order contract: <code>&lt;key&gt; &lt;signature&gt; &lt;function&gt; &lt;redeem script&gt;</code>. Sale contracts:{' '}
              <code>&lt;signature&gt; &lt;function&gt; &lt;redeem script&gt;</code>.
            </td>
          </tr>
          <tr>
            <th>Order API</th>
            <td>
              Contract orders come back with <code>apiVersion=2</code> and their terms; agents get the same through the <Link href="/docs/agents">MCP server</Link>.
            </td>
          </tr>
        </tbody>
      </table>
    </DocsArticle>
  )
}

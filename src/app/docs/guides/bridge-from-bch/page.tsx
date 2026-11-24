import type { Metadata } from 'next'
import Link from 'next/link'
import { Callout, DocsArticle, Shot, Step, Steps } from '@/components/docs/docs-ui'

export const metadata: Metadata = {
  title: 'Bridge back from Bitcoin Cash',
  alternates: { canonical: '/docs/guides/bridge-from-bch' }
}

export default function Page() {
  return (
    <DocsArticle
      href="/docs/guides/bridge-from-bch"
      title="Bridge back from Bitcoin Cash"
      lead="Sell BCH or a CashToken such as PUSD and receive an asset on another chain, for example USDC on Ethereum. Your BCH wallet signs every step on the Bitcoin Cash side."
    >
      <Callout kind="note">
        The Cashbridge Router does not cover this direction. The Cashbridge Router option is greyed out and both steps are signed in your own wallets.
      </Callout>

      <Steps>
        <Step title="Switch the direction">
          <p>
            Press the arrows between the two fields. The heading changes to <strong>Bridge from Bitcoin Cash</strong>. The top field now holds the token you sell and the bottom one the asset you receive.
          </p>
          <Shot name="form-reverse" alt="The reversed form: sell 20 PUSD on Bitcoin Cash, receive about 19.51 USDC on Ethereum" caption="20 PUSD is estimated at about 19.51 USDC on Ethereum." />
        </Step>

        <Step title="Pick the assets and an amount">
          <p>
            Choose what you sell: BCH, PUSD or another Cauldron token. Choose the chain and token you want to receive. Enter the amount to sell. The pickers work as in the <Link href="/docs/guides/bridge-to-bch">forward guide</Link>.
          </p>
        </Step>

        <Step title="Connect both wallets">
          <p>
            Connect your BCH wallet on the top side and a wallet for the destination chain on the bottom side, or open that button&apos;s menu and choose <strong>Paste wallet address</strong> to be paid at an address without connecting its wallet. The payout goes to that wallet or address, so make sure it is an account you control. See <Link href="/docs/wallets">Wallets</Link>.
          </p>
        </Step>

        <Step title="Review the route">
          <p>
            <strong>Confirm swap</strong> lists the route. Selling a token takes two steps: <strong>1/2 Swap PUSD → BCH</strong> on Cauldron, then <strong>2/2 Bridge BCH → USDC</strong> through THORChain. Selling BCH needs only the bridge step. Check the minimum you will receive and press the button for step 1.
          </p>
        </Step>

        <Step title="Approve in your BCH wallet">
          <p>
            Your BCH wallet app asks you to approve the Cauldron swap. Keep it open, because the request waits there. If you decline, cancel, or the wallet does not answer in time, nothing is sent and you can try again. A WalletConnect wallet keeps a cancelled request for five minutes, so reject it there as well.
          </p>
        </Step>

        <Step title="Approve the deposit to THORChain">
          <p>
            When the swap is through, the screen offers <strong>Bridge BCH → USDC (2/2)</strong>. Approve it in the BCH wallet. This transaction sends the BCH to THORChain together with the instructions for the payout.
          </p>
          <Shot name="reverse-progress" alt="The reversed progress screen: Swap (1/2) in progress, Bridge (2/2) waiting" size="lg" caption="Step 1 of 2 in progress. Amounts here are examples." />
        </Step>

        <Step title="Receive on the other chain">
          <p>
            THORChain pays the asset to your destination wallet. Cash Bridge confirms the payout on the destination chain itself, not through THORChain, and then shows the receipt.
          </p>
          <Shot name="reverse-receipt" alt="The receipt for a reversed transfer: Received 0.00088 ETH, with the Cauldron swap, the BCH deposit and the payout listed" caption="The receipt lists the swap on Cauldron, the deposit and the payout, each with an explorer link. Amounts here are examples." />
        </Step>
      </Steps>

      <h2 id="to-an-exchange">Pay out to an exchange</h2>
      <p>
        To be paid straight on an exchange, open the payout button&apos;s menu, choose <strong>Send to an exchange</strong> and paste the deposit address the exchange shows for that coin and network. Manual and Cashbridge Router transfers pay it the same way. The payout carries no memo or destination tag, so:
      </p>
      <ul>
        <li>
          <strong>XRP Ledger, Cosmos and THORChain are refused.</strong> Exchanges there credit a deposit by its memo or tag, and neither THORChain nor NEAR Intents can send one with a payout. Pick another network, or receive in your own wallet and send it on from there.
        </li>
        <li>
          <strong>Native coins on EVM chains</strong> such as ETH are paid by a contract as an internal transfer, which some exchanges do not credit. Check yours, or receive a token such as USDC.
        </li>
        <li>
          <strong>Check the exchange&apos;s minimum deposit.</strong> If the swap cannot run, the refund comes back to your BCH wallet, not to the exchange.
        </li>
      </ul>

      <h2 id="stops">If a step stops</h2>
      <ul>
        <li>
          <strong>Stopped after the swap.</strong> If you do not continue to step 2, the BCH from the swap stays in your wallet. Nothing is lost.
        </li>
        <li>
          <strong>Refunded by THORChain.</strong> If THORChain cannot complete the swap, for example because the price moved past your slippage limit, it sends the BCH back to your wallet. The receipt shows a <em>Refund on Bitcoin Cash</em> line.
        </li>
      </ul>
      <p>
        See <Link href="/docs/guides/track-a-transfer">Track a transfer</Link> for how to find a transfer again, and <Link href="/docs/faq">FAQ and troubleshooting</Link> for wallet messages.
      </p>
    </DocsArticle>
  )
}

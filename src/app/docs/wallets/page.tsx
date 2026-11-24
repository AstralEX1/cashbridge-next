import type { Metadata } from 'next'
import Link from 'next/link'
import { Callout, DocsArticle, Shot } from '@/components/docs/docs-ui'

export const metadata: Metadata = {
  title: 'Wallets',
  alternates: { canonical: '/docs/wallets' }
}

export default function Page() {
  return (
    <DocsArticle
      href="/docs/wallets"
      title="Wallets"
      lead="A transfer touches up to two wallets: one on the source or destination chain, and a Bitcoin Cash wallet. Cash Bridge works with the wallets you already use and never asks for a seed phrase or a private key."
    >
      <table>
        <thead>
          <tr>
            <th>Side</th>
            <th>Wallets</th>
            <th>How it connects</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Source or destination chain</td>
            <td>
              MetaMask, Rabby, Brave Wallet, OKX, Phantom, Trust Wallet, Exodus, Bitget Wallet, OneKey, Keplr, Cosmostation, Vultisig, TronLink, Ledger, Trezor, and any wallet app over
              WalletConnect. Sui: Slush, Suiet, Nightly, OneKey. Solana: Phantom, Solflare, Backpack, Nightly. Bitcoin: UniSat, Leather, Bitget Wallet. Cardano: Lace, Eternl, Yoroi. TON: Telegram Wallet, Tonkeeper and the rest over TON Connect. NEAR: HOT, Meteor, Intear, MyNearWallet and the rest over NEAR Connect
            </td>
            <td>Browser extension, hardware wallet, WalletConnect, TON Connect or NEAR Connect with a QR code or a link</td>
          </tr>
          <tr>
            <td>Bitcoin Cash</td>
            <td>WizardConnect, Selene, Paytaca</td>
            <td>WizardConnect, with a QR code or a link; Paytaca uses its browser extension when installed</td>
          </tr>
          <tr>
            <td>Bitcoin Cash</td>
            <td>Cashonize, Zapit</td>
            <td>WalletConnect: Cashonize opens in the browser; Zapit uses its extension when installed, otherwise a QR code or link</td>
          </tr>
        </tbody>
      </table>
      <p>Which wallets appear for a chain depends on that chain. The list in the app is the source of truth.</p>

      <h2 id="source">Source and destination wallets</h2>
      <p>
        Press <strong>Connect wallet</strong> on the side that is not Bitcoin Cash. The list shows the wallets that can connect to the chosen chain. Wallets your browser already has are marked <strong>Detected</strong> and come first, wallets you could install show <strong>Install</strong> with a link to their site, and hardware wallets sit at the end. A click on a detected wallet connects it and your wallet asks you to approve.
      </p>
      <Shot name="connect-evm" alt="The Connect Wallet dialog listing Brave Wallet, Exodus, Keplr, MetaMask, OKX, Phantom, Rabby Wallet, Trust Wallet and Vultisig" size="md" caption="The list on a browser with no wallet installed. Wallets it finds are marked Detected." />
      <ul>
        <li>
          <strong>Hardware wallets.</strong> Unlock the device and open the matching app on it first, such as Ethereum for an Ethereum account. Trezor also asks you to confirm in its Connect popup.
        </li>
        <li>
          <strong>Any wallet app, over WalletConnect.</strong> Choose <strong>WalletConnect</strong>, right after the detected wallets. On a computer, scan the QR code with your wallet app. On a phone, pick your wallet from the list and it opens to approve. Cash Bridge reconnects it on later visits for as long as the wallet keeps the session.
        </li>
        <li>
          <strong>TON and NEAR.</strong> <strong>Telegram Wallet</strong> and <strong>Tonkeeper</strong> open their own TON Connect window: a QR code on a computer, the app on a phone. <strong>TON Connect</strong> lists every other TON wallet. <strong>NEAR wallets</strong> opens NEAR Connect, the wallet list NEAR&apos;s docs recommend. Both reconnect on later visits while the wallet keeps the session.
        </li>
        <li>
          <strong>On a phone.</strong> MetaMask is not detected in a normal mobile browser. The row then reads <strong>Open app</strong> and opens Cash Bridge inside the MetaMask app, where it can connect.
        </li>
        <li>
          <strong>Receiving on another chain.</strong> When you bridge back from Bitcoin Cash, the wallet on the destination chain only receives. It does not sign anything.
        </li>
      </ul>

      <h2 id="bch">Bitcoin Cash wallets</h2>
      <p>
        Press <strong>Connect BCH wallet</strong> and choose how the wallet connects. The BCH wallet receives the BCH from THORChain and signs the Cauldron swap, so it must support CashTokens when you receive PUSD or another token.
      </p>
      <h3>WizardConnect, Selene and Paytaca</h3>
      <p>
        Choose <strong>WizardConnect</strong>, <strong>Selene</strong> or <strong>Paytaca</strong>. Scan the QR code with the wallet or open the link in it, then approve the connection. Keep the wallet app open while you sign. The request waits there until you answer it. Paytaca and Selene both speak WizardConnect; Cauldron and the wallet docs recommend it when the wallet supports it.
      </p>
      <p>
        If the Paytaca browser extension is installed, choosing <strong>Paytaca</strong> opens the extension on its WalletConnect screen instead of a WizardConnect QR code.
      </p>
      <Shot name="connect-wizardconnect" alt="The WizardConnect dialog with a QR code to scan with a WizardConnect wallet" size="sm" caption="Scan the code with the wallet. The code in this image is blurred; yours is live." />
      <h3>Cashonize and Zapit, over WalletConnect</h3>
      <p>
        Choose <strong>Cashonize</strong> to open cashonize.com on its WalletConnect screen with the pairing link already filled in. Choose <strong>Zapit</strong> to open its browser extension when it is installed, or to show a QR code and link otherwise. On a phone, <strong>Open wallet</strong> jumps to the app. Your wallet asks you to approve a short connection message. It proves that the address is yours and sends nothing.
      </p>
      <Callout kind="note" title="A wallet may send the transaction itself">
        Cash Bridge asks the wallet only to sign. A wallet that also broadcasts the transaction after you approve it is fine: Cash Bridge follows the transaction by its id, and broadcasting the same signed transaction a second time does nothing extra.
      </Callout>

      <h2 id="reconnect">Reconnecting</h2>
      <p>
        Wallets reconnect on their own the next time you visit the site in the same browser. If a BCH wallet does not answer, the page says <em>Open the wallet app to finish</em>. Open the wallet. If that does not help, press <strong>New QR</strong> to pair again. <strong>Disconnect</strong> in the wallet menu forgets the connection.
      </p>
      <p>
        An unfinished transfer is bound to the BCH wallet that received the BCH. If you open the site with another wallet or account, it shows <em>Connect the wallet and account that own the bound address</em>. Connect the same account to continue.
      </p>

      <h2 id="paste">Pasting an address</h2>
      <p>
        With the <Link href="/docs/guides/cashbridge-router">Cashbridge Router</Link> on, the BCH button has a menu with <strong>Paste wallet address</strong>. You can then receive PUSD or BCH at an address without connecting its wallet, because receiving needs no signature. A pasted PUSD address must be a token-aware one that starts with <code>bitcoincash:z</code>; many wallets show it separately from the plain <code>bitcoincash:q</code> address. A plain BCH address takes the <code>q</code> form. The field turns red and the button stays disabled for anything else, including addresses of other chains and old-style <code>1…</code> addresses, which look the same as Bitcoin&apos;s.
      </p>
      <p>
        Bridging from Bitcoin Cash, the payout button has the same <strong>Paste wallet address</strong> entry. The address must be in the destination chain&apos;s own format: <code>0x…</code> on Ethereum, Base and the other EVM chains, <code>bc1…</code>, <code>1…</code> or <code>3…</code> on Bitcoin, a classic <code>r…</code> address on XRP, and so on. Anything else is refused the same way. On EVM chains a smart contract or an EIP-7702 delegated account is refused too, because THORChain cannot pay it. The payout carries no memo or tag. To be paid on an exchange, use the <strong>Send to an exchange</strong> entry instead; see <Link href="/docs/guides/bridge-from-bch#to-an-exchange">Pay out to an exchange</Link>.
      </p>

      <h2 id="safety">What a wallet connection can and cannot do</h2>
      <ul>
        <li>Connecting shows Cash Bridge your public address. It does not move funds.</li>
        <li>Every transaction is a separate request that your wallet shows you before it signs.</li>
        <li>Cash Bridge has no feature to import a seed phrase or a private key. If a site asks for one, it is not Cash Bridge.</li>
      </ul>
      <p>
        Wallet messages and what they mean are in <Link href="/docs/faq">FAQ and troubleshooting</Link>.
      </p>
    </DocsArticle>
  )
}

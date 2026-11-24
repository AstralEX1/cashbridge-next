// Real transfers through this site, each checked on public explorers. The docs page /docs/mainnet and the
// scanner both list them.

const bch = (id: string) => `https://explorer.selene.cash/tx/${id}`
const bsc = (hash: string) => `https://bscscan.com/tx/${hash}`
const avax = (hash: string) => `https://snowscan.xyz/tx/${hash}`
const base = (hash: string) => `https://basescan.org/tx/${hash}`
const eth = (hash: string) => `https://etherscan.io/tx/${hash}`
const ton = (hash: string) => `https://tonviewer.com/transaction/${hash}`
const nearIntents = (depositAddress: string) => `https://explorer.near-intents.org/transactions/${depositAddress}`
// thorchain.net looks a swap up by its deposit hash, without 0x.
const thor = (hash: string) => `https://thorchain.net/tx/${hash.replace(/^0x/i, '').toLowerCase()}`

export type Run = {
  date: string
  router?: boolean
  // The Router's per-order contract that held the funds; a Router run without one used the legacy order address.
  contract?: 'order' | 'sale'
  route: string
  amounts: string
  note?: string
  links: [string, string][]
}

// Oldest first; the docs page lists them newest first. README.md lists the same runs: add new ones to both
// (test/scanner.test.mjs checks that every link is in the README).
export const RUNS: Run[] = [
  {
    date: '17 Nov 2026',
    route: 'BCH → BNB (BNB Smart Chain)',
    amounts: '0.019 BCH → 0.00624508 BNB',
    links: [
      ['BCH deposit', bch('6d703a743adcf02f27f11407ba3383debd6365fd7cf7aa34ffb422968c342031')],
      ['THORChain swap', thor('6d703a743adcf02f27f11407ba3383debd6365fd7cf7aa34ffb422968c342031')],
      ['BNB payout', bsc('0x0E4F95150CC7232B8E55C95AB011CA4EF4883716E30379FC326D4852632F8555')]
    ]
  },
  {
    date: '17 Nov 2026',
    route: 'BNB (BNB Smart Chain) → PUSD',
    amounts: '0.0062 BNB → 0.01639004 BCH → 3.39 PUSD',
    links: [
      ['BNB deposit', bsc('0x592eaa37bc2ca30efff2be5eb75b94bbb4819f1f1c99c4144c707aec7c5d8218')],
      ['THORChain swap', thor('0x592eaa37bc2ca30efff2be5eb75b94bbb4819f1f1c99c4144c707aec7c5d8218')],
      ['BCH payout', bch('92e5b363570ba683b3f519ce1c5256249c1c6f9cfdaf3af09d7ff35247061ba5')],
      ['PUSD purchase', bch('7c8a408cc401278ba6f6c1eda2aa9692de5eb8ea12a06d4f8ffdce6407e331fc')]
    ]
  },
  {
    date: '17 Nov 2026',
    route: 'PUSD → BNB (BNB Smart Chain)',
    amounts: '3.39 PUSD → 0.01622613 BCH → 0.00527858 BNB',
    links: [
      ['PUSD sale', bch('a42ef6ed1dfe72ea9d6aa33d5438a34f5d86a24ed5db6ad53542bd53fe5552a7')],
      ['BCH deposit', bch('369ab490999475475869996741a6834ccb18d0bb9a821018d97d474f3d2d88a1')],
      ['THORChain swap', thor('369ab490999475475869996741a6834ccb18d0bb9a821018d97d474f3d2d88a1')],
      ['BNB payout', bsc('0x4CD293F0BFCC30D052061578745C38A00D7D06A8FD3F4912CCADAA46CC805384')]
    ]
  },
  {
    date: '17 Nov 2026',
    router: true,
    route: 'BNB (BNB Smart Chain) → PUSD',
    amounts: '0.003 BNB → 1.51 PUSD',
    links: [
      ['BNB deposit', bsc('0x10eb6893cb6736b67fa4d6c0c6fc8fac30453faf65fc010665f2d657f05303e8')],
      ['THORChain swap', thor('0x10eb6893cb6736b67fa4d6c0c6fc8fac30453faf65fc010665f2d657f05303e8')],
      ['BCH to order', bch('8b0d008f5c36749d15fe9d3b206ea7b283664d4c65f1734be4b06d7aad0e4f88')],
      ['PUSD payout', bch('0cf4ab532642433f0305339d003cecb9e0d826f69dcd58871d2cb255ebe4fde0')]
    ]
  },
  {
    date: '17 Nov 2026',
    route: 'BNB (BNB Smart Chain) → MUSD',
    amounts: '0.0022 BNB → 0.00504863 BCH → 1.02 MUSD',
    links: [
      ['BNB deposit', bsc('0xea82f1c2744b9ea41a4f6e1d928708a3914ab4bbe411edd5663e3d83c1980759')],
      ['THORChain swap', thor('0xea82f1c2744b9ea41a4f6e1d928708a3914ab4bbe411edd5663e3d83c1980759')],
      ['BCH payout', bch('a6d7d4056baccc99e2fbcbfe6788b3e5fdefd9864d0c4071c362a31296275937')],
      ['MUSD purchase', bch('4edb9d9a879a70c45183f9fa56aa0350a61c8988b60a4f6d7feb80f527892202')]
    ]
  },
  {
    date: '17 Nov 2026',
    route: 'MUSD → BNB (BNB Smart Chain)',
    amounts: '1.02 MUSD → 0.00492643 BCH → 0.00130668 BNB',
    links: [
      ['MUSD sale', bch('5523949b6b738a8a51b2621bef80daa590066b269725376adcdf4563861be6e3')],
      ['BCH deposit', bch('4de9d7f6c5fc0104065454163a339b548ffedcd56161186e68b87e07badbdd4f')],
      ['THORChain swap', thor('4de9d7f6c5fc0104065454163a339b548ffedcd56161186e68b87e07badbdd4f')],
      ['BNB payout', bsc('0x67074DC513DFE6169884283722E04434D58C477219F997BF86DF3DC45F16851E')]
    ]
  },
  {
    date: '17 Nov 2026',
    route: 'PUSD → AVAX (Avalanche)',
    amounts: '1.51 PUSD → 0.00722206 BCH → 0.17553838 AVAX',
    links: [
      ['PUSD sale', bch('318e55dc4b912fc4c774d436a57d1d22fdfaa65dab92bf82a88e43bf35302d9c')],
      ['BCH deposit', bch('02c3d7eb5e199f49f7f55362e1e0f2664e83634439a719c158246ed99a06a210')],
      ['THORChain swap', thor('02c3d7eb5e199f49f7f55362e1e0f2664e83634439a719c158246ed99a06a210')],
      ['AVAX payout', avax('0xD8A8C83CCA712EDC8C805C331D9F66614B48BE637A2545AC3612525D091C87E5')]
    ]
  },
  {
    date: '18 Nov 2026',
    router: true,
    route: 'ETH (Ethereum) → PUSD',
    amounts: '0.0239214 ETH → 0.20364266 BCH → 42.77 PUSD',
    links: [
      ['ETH deposit', eth('0x8760d8dca4ef0469ff807c2224b103ced60d4a15a7a406f6bd73dbb12826bd59')],
      ['THORChain swap', thor('0x8760d8dca4ef0469ff807c2224b103ced60d4a15a7a406f6bd73dbb12826bd59')],
      ['BCH to order', bch('0ecafc8a84a4cbcf42ab6b3b0f2995ae1b33fbf37d42dff1dfad41dc8665d114')],
      ['PUSD payout', bch('8a3d6c7398b8220deaeedd5bdeb4e39e894d008df939c0ac72555b241dedeaa1')]
    ]
  },
  {
    date: '19 Nov 2026',
    router: true,
    contract: 'order',
    route: 'USDC (Base) → PUSD',
    amounts: '3 USDC → 0.01306603 BCH → 2.71 PUSD',
    links: [
      ['USDC approval', base('0x840444ab096bfda4a767bfb6e0e924b65cc8cd4b421654a611fe7b1419cf740b')],
      ['USDC deposit', base('0xe8660dc09f7976a12fbcce1638973412d2dec4c1de86b067ab98b8c64525e18c')],
      ['THORChain swap', thor('0xe8660dc09f7976a12fbcce1638973412d2dec4c1de86b067ab98b8c64525e18c')],
      ['BCH to contract', bch('38b2f49613c07e9ef918c9612d192623730cda0919770b4efed3429ee55cd6d8')],
      ['PUSD payout', bch('15b4f826e22ed0b4982862f20b4f2781fb527cd72cc611aa14a5bd45b8a496f0')]
    ]
  },
  {
    date: '19 Nov 2026',
    router: true,
    contract: 'order',
    route: 'ETH (Base) → PUSD',
    amounts: '0.00419841 ETH → 0.03481972 BCH → 0.03481596 BCH back',
    note: 'the contract gave the BCH back to the fallback address',
    links: [
      ['ETH deposit', base('0x2b2bf1b709c126ca2ae49e7e505d961e4f306cb4199cc2bf2139cffb8f0ee04d')],
      ['THORChain swap', thor('0x2b2bf1b709c126ca2ae49e7e505d961e4f306cb4199cc2bf2139cffb8f0ee04d')],
      ['BCH to contract', bch('93c651c63cbbdfc636d98fbac26dd2eda740dc90335e728e71f660fa05bce16b')],
      ['BCH refund', bch('cbc2a2b00b7c758997f81dc0b2f0d7447b04a24c6584ed79679078a0d3c63349')]
    ]
  },
  {
    date: '19 Nov 2026',
    router: true,
    contract: 'sale',
    route: 'PUSD → USDC (Base)',
    amounts: '2.71 PUSD → 0.01290603 BCH → 2.429573 USDC',
    links: [
      ['PUSD to contract', bch('7c9ce40ab7661f4623cbfad3990331d839a2c4c9b62101117bc655865e4a8eda')],
      ['Cauldron sale', bch('e7e04746a3db1c89113a90751d37e80807e86606a98831e79f92a44ad65cc1a0')],
      ['BCH deposit', bch('7cb8b6fac3b25f494d307660ccf0f97466661ed60e9d06ccde48ab60a6e2a4d8')],
      ['THORChain swap', thor('7cb8b6fac3b25f494d307660ccf0f97466661ed60e9d06ccde48ab60a6e2a4d8')],
      ['USDC payout', base('0x00451b7b4657184f3d5c1f6d0f6fad9cbdd564d50e99b31655791c6ad19161f7')]
    ]
  },
  {
    date: '20 Nov 2026',
    router: true,
    contract: 'order',
    route: 'USDC (Base) → PUSD',
    amounts: '5 USDC → 0.02449021 BCH → 4.93 PUSD',
    links: [
      ['USDC deposit', base('0xc4f9d9ef1b3e0406908eac16aee46eb418111f27a2504f197da1177c41f6e35f')],
      ['NEAR Intents swap', nearIntents('0x435c854B89BE175F79f05AE9Ffbfc367D9F2052f')],
      ['BCH to contract', bch('394584f5437ace7fa8688838ad989302ebb72337e7d5cdcc44fc5fa5d0ed22b8')],
      ['PUSD payout', bch('bcb7309b577e4063eb7b60b9b3bf805739553edf3f942e5cf76a3b7e944f8cb0')]
    ]
  },
  {
    date: '20 Nov 2026',
    router: true,
    contract: 'sale',
    route: 'PUSD → USDC (Base)',
    amounts: '4.93 PUSD → 0.02492599 BCH → 4.962201 USDC',
    links: [
      ['PUSD to contract', bch('63b66a39947bd65d59cbe1b5a8aa54378a37e0c85d3b5809fe03df35b4677da7')],
      ['Cauldron sale', bch('a5a2cced6582bf9df79c68c96644a4381b9af333f38000d7aa3d3b848ff956a7')],
      ['BCH deposit', bch('69cfb82f9cff1d62106a3f68198e9047c9b54f4ff08b6857b474e10198b7ff96')],
      ['NEAR Intents swap', nearIntents('bitcoincash:qrmzp6fk7cstle77qt6q3mqc7y2rh9g9aqnljtr8w2')],
      ['USDC payout', base('0x0cda109863f29a7bf2d681e71f8f9671fd0a94b95208f4c86a94bfaea391f0dd')]
    ]
  },
  {
    date: '20 Nov 2026',
    router: true,
    contract: 'order',
    route: 'USDC (Base) → PUSD',
    amounts: '99.8932 USDC → 0.49994357 BCH → 98.93 PUSD',
    links: [
      ['USDC deposit', base('0x890604ed3c895565571b122644022f7d3ec452e025ed89acd297aa011fddb3cb')],
      ['NEAR Intents swap', nearIntents('0x509c39ee45C24E0e42814a0E705F94095FA089ed')],
      ['BCH to contract', bch('44fcf1b08c3c417e26ceb41ade7b9d562bfd30a34da597382b601f9525bd3190')],
      ['PUSD payout', bch('8a9b6c3acb9dd330ec3e54369568867232b3b53305cf8f932491f93c0a5e2ab5')]
    ]
  },
  {
    date: '20 Nov 2026',
    router: true,
    contract: 'order',
    route: 'USDT (BNB Smart Chain) → PUSD',
    amounts: '1.97137 USDT → 0.00989847 BCH → 1.95 PUSD',
    links: [
      ['USDT deposit', bsc('0x589ae6780bdd454a0afa38c6e8c03b9c211e47e5dcb1c8947238eb6d268272ae')],
      ['NEAR Intents swap', nearIntents('0x65001523f7118e27D3820532357c2E4C59a862dB')],
      ['BCH to contract', bch('6b5ffa400171a9df42301f0f912533f054e28c994fbf4f20dcc354717b3be2fe')],
      ['PUSD payout', bch('a1dd1067dc7b9fe9cbce05a8f9c37e1c2ef75fd733ab1a815ec2969460be92e0')]
    ]
  },
  {
    date: '20 Nov 2026',
    router: true,
    contract: 'order',
    route: 'TON → PUSD',
    amounts: '2.68943 TON → 0.0139448 BCH → 2.61 PUSD',
    links: [
      ['TON deposit', ton('7935dc078f614b99f0b89bb262d97c92987bb0da3ea2bc380e5ccbb7fb7cfdc8')],
      ['NEAR Intents swap', nearIntents('UQAd3hu2yTWESAYp2ryqwhl8f8qzPeVHf9CtGahi6FDmKqJt')],
      ['BCH to contract', bch('f73610484aba18031fa23e97f946f740f0b27286d21eb1d1d3cf1fb21a437911')],
      ['PUSD payout', bch('a363c0be8fe6749a4d94d3e5a1a6b4d10461cf9e98c05443e72305a8638b9618')]
    ]
  }
]

export type PreBlazeRun = Run & { story: string }

// Mainnet tests from before BCH BLAZE 2026, run by hand from a local build. Shown on /docs/demo only, never
// in the scanner.
export const PRE_BLAZE_RUNS: PreBlazeRun[] = [
  {
    date: '26 Oct 2026',
    route: 'ETH (Base) → BCH',
    amounts: '0.001 ETH → 0.00742334 BCH',
    story:
      'The first mainnet test of the THORChain API connection. The build fetched a quote, and the Base wallet sent 0.001 ETH to THORChain’s Base router with a swap memo naming the BCH address and a minimum of 735,031 sats. THORChain paid out 742,334 sats.',
    links: [
      ['ETH deposit', base('0x42f46e18e87c5928d19d319f5c15a33f8800a4899685c7f6f959d54143defaf8')],
      ['THORChain swap', thor('0x42f46e18e87c5928d19d319f5c15a33f8800a4899685c7f6f959d54143defaf8')],
      ['BCH payout', bch('c671e6d9db989ea3822ec8503a8ba9479c9c0e54a013b1c7bc50fa837edee631')]
    ]
  },
  {
    date: '27 Oct 2026',
    route: 'USDC (Base) → BCH',
    amounts: '5 USDC → 0.01683509 BCH',
    story: 'The first stablecoin deposit, through the same THORChain router. The memo asked for at least 1,666,791 sats; THORChain paid 1,683,509.',
    links: [
      ['USDC deposit', base('0x47bc0fe6aacda4cc19d1cbc0ac09da271c5ea671c2bfd04a45521ab263ef97a7')],
      ['THORChain swap', thor('0x47bc0fe6aacda4cc19d1cbc0ac09da271c5ea671c2bfd04a45521ab263ef97a7')],
      ['BCH payout', bch('3d71cf6ae0a6eb645f3f504c1fdf2534fef8c716d6306857eebd6699d207b720')]
    ]
  },
  {
    date: '27 Oct 2026',
    route: 'ETH (Base) → BCH → PUSD',
    amounts: '0.00607009 ETH → 0.04873362 BCH → 13.75 PUSD',
    story:
      'The first full route to PUSD. THORChain paid the BCH (the memo’s minimum was 4,825,323 sats), and then the build bought PUSD from Cauldron pools in a second transaction, signed in the BCH wallet.',
    links: [
      ['ETH deposit', base('0xd562c70fc80cc0dfd4d260fcee94733707325273190cb3b6c40f398c35918604')],
      ['THORChain swap', thor('0xd562c70fc80cc0dfd4d260fcee94733707325273190cb3b6c40f398c35918604')],
      ['BCH payout', bch('907e32b5e197958c67df000b049aa45c43d85592072d40702faca5134d69cd1d')],
      ['PUSD purchase', bch('8d0f8289403a76b59ba4b9b4f587c5ebe847a13d6c1ffc464251a666ef57d187')]
    ]
  },
  {
    date: '28 Oct 2026',
    route: 'PUSD → BCH → USDC (Base)',
    amounts: '13.75 PUSD → 0.04619023 BCH → 13.504362 USDC',
    story:
      'The first trip back. The BCH wallet sold the 13.75 PUSD on Cauldron, then sent the BCH to THORChain’s BCH vault with a memo asking for USDC on Base. THORChain paid 13.504362 USDC, and its payout memo names the BCH deposit.',
    links: [
      ['PUSD sale', bch('d8e593b5cf2bcea297628610f178770f5fde2e64e199d7fccf63703322fa37c6')],
      ['BCH deposit', bch('08b0670088830cf4ec545883662f23343306c714f3239b7cd3731873d0741944')],
      ['THORChain swap', thor('08b0670088830cf4ec545883662f23343306c714f3239b7cd3731873d0741944')],
      ['USDC payout', base('0x6e123199a21ecd46c947ea6ad0a38b96b9fedbe8b05ec59cb058061cdde33976')]
    ]
  },
  {
    date: '28 Oct 2026',
    route: 'ETH (Base) → BCH → PUSD',
    amounts: '0.0005463 ETH → 0.00346192 BCH → 1.01 PUSD',
    story: 'The same route to PUSD with a much smaller amount, ending in 1.01 PUSD.',
    links: [
      ['ETH deposit', base('0xa13cbbc9ccfb7306d5c29cfaa2e05f1b202e6d03e067540dda9aeb64e090026d')],
      ['THORChain swap', thor('0xa13cbbc9ccfb7306d5c29cfaa2e05f1b202e6d03e067540dda9aeb64e090026d')],
      ['BCH payout', bch('0e8198c92905fe501e93ba9ec019db10cfe6c4cdddd269622603400a9fbc73fa')],
      ['PUSD purchase', bch('058dbce0666f360aa578c8489467e5d9103b0e6d9f448fedeb076f2ff8e8c7b5')]
    ]
  },
  {
    date: '28 Oct 2026',
    route: 'USDC (Base) → BCH',
    amounts: '1 USDC → 0.00252294 BCH',
    story: 'One USDC to a second BCH address. The memo asked for at least 249,594 sats; THORChain paid 252,294.',
    links: [
      ['USDC deposit', base('0xaf7978a30710f8508da32d6dfcfab00ec9f53747ade67bc53a2bb1da4546731a')],
      ['THORChain swap', thor('0xaf7978a30710f8508da32d6dfcfab00ec9f53747ade67bc53a2bb1da4546731a')],
      ['BCH payout', bch('aca76d300c7362d36bd2520ce16a8407fde103258b9e9fbb7859989d1b8055dc')]
    ]
  },
  {
    date: '29 Oct 2026',
    route: 'USDC (Base) → BCH',
    amounts: '5 USDC → 0.01697737 BCH',
    story:
      'A run from a fresh test wallet, so it starts with the USDC approval for THORChain’s router and then the deposit. THORChain paid 1,697,737 sats to the test wallet’s BCH address.',
    links: [
      ['USDC approval', base('0x74057b1163cf078c7d045e92b4bc8c9605d834f60f8e4926ac35c86da8f65ae8')],
      ['USDC deposit', base('0x33b7e852fbf3da2ee6b069add21a1dc594317b69b91afd4bb1531e86bcec4849')],
      ['THORChain swap', thor('0x33b7e852fbf3da2ee6b069add21a1dc594317b69b91afd4bb1531e86bcec4849')],
      ['BCH payout', bch('669ce123307d935ce4469000c87fb600d815d6a2d4411d94aff34ce6524242c2')]
    ]
  },
  {
    date: '31 Oct 2026',
    route: 'BCH → PUSD → BCH → USDC (Base)',
    amounts: '0.01676938 BCH → 4.87 PUSD → 0.01676541 BCH → 4.83236 USDC',
    story:
      'A round trip on the test wallet: it bought 4.87 PUSD on Cauldron, sold it back for BCH, and sent that BCH through THORChain to USDC on Base.',
    links: [
      ['PUSD purchase', bch('4c5c9d945f3b2005044f7513f6f9ab722ece6850080eaf01e76aab553b9148f2')],
      ['PUSD sale', bch('dc8505fcf095782d5e3f71ae3bb62d19287d02b017adbbfb3e1bfa22fda98f27')],
      ['BCH deposit', bch('997a00e92f93041fdf82b6a2920b9ffd0d456bcaba0415fc2d0fc75111f0e0fb')],
      ['THORChain swap', thor('997a00e92f93041fdf82b6a2920b9ffd0d456bcaba0415fc2d0fc75111f0e0fb')],
      ['USDC payout', base('0x7287ac8770ab991197c36d5ab3704bdcf0ebb0fe7d25aacea7c5d22d90261591')]
    ]
  }
]

import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import { Noto_Sans_Runic } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { headers } from 'next/headers'
import { Toaster } from '@/components/ui/sonner'
import { ReactQueryProvider } from '@/components/react-query/react-query-provider'
import { WalletStoreHydration } from '@/components/wallet-store-hydration'
import { AppConfig } from '@/config'
import { BchWalletProvider } from '@/components/bch-wallet'
import { BridgeTracker } from '@/components/swap/pusd-swap'
import { getLangDir, type Locale } from '@/i18n/config'
import '@/components/tx-toast.css'
import './globals.css'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Every page is dark, whatever the system theme: a light bar above the dark header looked like a gap.
  themeColor: '#020707'
}

export const metadata: Metadata = {
  metadataBase: new URL(AppConfig.baseUrl),
  title: AppConfig.title,
  description: AppConfig.description,
  icons: {
    icon: [{ url: AppConfig.logo, type: 'image/svg+xml' }],
    apple: [{ url: AppConfig.logo }]
  },
  appleWebApp: {
    capable: true,
    title: AppConfig.appName,
    statusBarStyle: 'black-translucent'
  },
  openGraph: {
    title: AppConfig.title,
    description: AppConfig.description,
    url: AppConfig.baseUrl,
    siteName: AppConfig.appName,
    type: 'website',
    locale: 'en_US',
    images: [{ url: AppConfig.logo, width: 64, height: 64, alt: AppConfig.appName }]
  },
  twitter: {
    card: 'summary',
    title: AppConfig.title,
    description: AppConfig.description,
    images: [AppConfig.logo]
  }
}

const crit = localFont({
  variable: '--font-crit',
  display: 'swap',
  src: [
    { path: './fonts/Crit-Light-Trial.otf', weight: '300', style: 'normal' },
    { path: './fonts/Crit-Light-Italic-Trial.otf', weight: '300', style: 'italic' },
    { path: './fonts/Crit-Regular-Trial.otf', weight: '400', style: 'normal' },
    { path: './fonts/Crit-Italic-Trial.otf', weight: '400', style: 'italic' },
    { path: './fonts/Crit-Medium-Trial.otf', weight: '500', style: 'normal' },
    { path: './fonts/Crit-Medium-Italic-Trial.otf', weight: '500', style: 'italic' },
    { path: './fonts/Crit-Semibold-Trial.otf', weight: '600', style: 'normal' },
    { path: './fonts/Crit-Semibold-Italic-Trial.otf', weight: '600', style: 'italic' },
    { path: './fonts/Crit-Bold-Trial.otf', weight: '700', style: 'normal' },
    { path: './fonts/Crit-Bold-Italic-Trial.otf', weight: '700', style: 'italic' }
  ]
})

const notoRunic = Noto_Sans_Runic({
  variable: '--font-runic',
  display: 'swap',
  weight: '400',
  subsets: ['runic']
})

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = (await getLocale()) as Locale
  const messages = await getMessages()
  // The theme's inline script runs before paint, so it carries the page's CSP nonce (src/proxy.ts).
  const nonce = (await headers()).get('x-nonce') ?? undefined

  return (
    <html lang={locale} dir={getLangDir(locale)} data-brand={AppConfig.id} suppressHydrationWarning>
      <body className={`${crit.variable} ${notoRunic.variable} bg-[#020707] font-sans antialiased`}>
        <WalletStoreHydration />
        <ReactQueryProvider>
          <NextIntlClientProvider locale={locale} messages={messages}>
            <ThemeProvider defaultTheme="light" attribute="class" disableTransitionOnChange nonce={nonce}>
              <BchWalletProvider>
                {children}
                <BridgeTracker />
              </BchWalletProvider>
            </ThemeProvider>
            <Toaster />
          </NextIntlClientProvider>
        </ReactQueryProvider>
      </body>
    </html>
  )
}

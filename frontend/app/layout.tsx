import "./globals.css";
import type { Metadata } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { OnboardingTour } from "@/components/OnboardingTour";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { SiteNav } from "@/components/SiteNav";
import { NetworkBanner } from "@/components/NetworkBanner";
import { Footer } from "@/components/Footer";
import { LocaleMetaTags } from "@/components/LocaleMetaTags";
import { WalletProvider } from "@/lib/wallet-context";
import { ToastProvider } from "@/components/Toast";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import type { Locale } from "@/i18n.config";

const body = Inter({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-body",
});

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "StellarCred — Prove anything. Reveal nothing.",
  description:
    "Zero-knowledge credentials on Stellar. Prove facts about yourself without the data ever touching the chain.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let locale = "en";
  try {
    locale = await getLocale();
  } catch {
    locale = "en";
  }

  let messages = {};
  try {
    messages = await getMessages();
  } catch {
    messages = {};
  }

  return (
    <html
      lang={locale}
      className={`${body.variable} ${display.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          id="theme-detection"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
        <LocaleMetaTags locale={locale as Locale} />
      </head>
      <body>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ToastProvider>
            <WalletProvider>
              <OnboardingTour />
              <SiteNav />
              <NetworkBanner />
              <OnboardingWizard />
              <main id="main-content" tabIndex={-1} className="container">
                {children}
              </main>
              <Footer />
            </WalletProvider>
          </ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
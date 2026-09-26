import "./globals.css";
import type { Metadata } from "next";
import localFont from "next/font/local";
import { OnboardingTour } from "@/components/OnboardingTour";
import { getLocale } from "next-intl/server";
import { SiteNav } from "@/components/SiteNav";
import { NetworkBanner } from "@/components/NetworkBanner";
import { Footer } from "@/components/Footer";
import { LocaleMetaTags } from "@/components/LocaleMetaTags";
import { WalletProvider } from "@/lib/wallet-context";
import { ToastProvider } from "@/components/Toast";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

// Self-hosted via next/font/local instead of next/font/google: the Google
// loader fetches font CSS/metadata from fonts.googleapis.com at BUILD time,
// which fails on CI runners with restricted or proxied egress (a 200 response
// with a mangled body made the loader crash with
// "TypeError: Cannot read properties of null (reading '1')" instead of
// erroring cleanly). The woff2 files are the latin-subset variable fonts
// exactly as served by Google Fonts (Inter 100-900, Space Grotesk 300-700,
// JetBrains Mono 100-800); the weight ranges below cover every weight the
// previous per-weight declarations used.
const body = localFont({
  src: "./fonts/inter-latin-variable.woff2",
  weight: "100 900",
  variable: "--font-body",
  display: "swap",
});

const display = localFont({
  src: "./fonts/space-grotesk-latin-variable.woff2",
  weight: "300 700",
  variable: "--font-display",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/jetbrains-mono-latin-variable.woff2",
  weight: "100 800",
  variable: "--font-mono",
  display: "swap",
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
  const locale = await getLocale();

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
        <LocaleMetaTags />
      </head>
      <body>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
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
      </body>
    </html>
  );
}
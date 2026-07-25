import type { Metadata } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { OnboardingTour } from "@/components/OnboardingTour";`nimport { SiteNav } from "@/components/SiteNav";
import { WalletProvider } from "@/lib/wallet-context";
import "./globals.css";

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

export const metadata: Metadata = {
  title: "StellarCred — Prove anything. Reveal nothing.",
  description:
    "Zero-knowledge credentials on Stellar. Prove facts about yourself without the data ever touching the chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable} ${mono.variable}`}>
      <body>
        <WalletProvider>
          <OnboardingTour />
          <SiteNav />
          <main className="container">{children}</main>
          <footer className="site-footer">
            <div className="site-footer-inner">
              <span className="faint" style={{ fontSize: "0.8125rem" }}>
                © {new Date().getFullYear()} StellarCred
              </span>
              <div className="row" style={{ gap: "1.5rem" }}>
                <a
                  href="https://github.com/Psalmuel01/StellarCred"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="footer-link"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-label="GitHub">
                    <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                  </svg>
                  GitHub
                </a>
                <a
                  href="https://github.com/Psalmuel01/StellarCred/tree/main/frontend/packages/sdk"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="footer-link mono"
                  style={{ fontSize: "0.75rem" }}
                >
                  @stellarcred/sdk
                </a>
                <a href="/developers" className="footer-link">Docs</a>
              </div>
            </div>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  IconLock,
  IconWallet,
  IconKey,
  IconAlertCircle,
  IconCheck,
  IconArrowRight,
  IconShieldCheck,
} from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet } from "@/lib/wallet-context";

export function LoginPageClient() {
  const router = useRouter();
  const { address } = useWallet();
  const isConnected = Boolean(address);
  const [activeTab, setActiveTab] = useState<"wallet" | "passphrase">("wallet");
  const [identifier, setIdentifier] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!identifier.trim()) {
      setError("Please enter your email or Stellar public key.");
      return;
    }
    if (!passphrase.trim()) {
      setError("Please enter your credential passphrase.");
      return;
    }

    setLoading(true);
    try {
      // Simulate client-side key derivation / authentication check
      await new Promise((resolve) => setTimeout(resolve, 600));
      setSuccess(true);
      setTimeout(() => {
        router.push("/holder");
      }, 500);
    } catch {
      setError("Invalid credentials or passphrase. Please verify and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main id="main-content" className="login-page-container">
      <div className="login-card-wrapper card">
        <header className="login-header">
          <div className="login-icon-badge" aria-hidden="true">
            <IconShieldCheck size={28} color="var(--accent)" stroke={1.8} />
          </div>
          <h1 className="login-title">Sign in to StellarCred</h1>
          <p className="login-subtitle muted">
            Authenticate to manage zero-knowledge credentials and verify on-chain claims.
          </p>
        </header>

        {/* Tab switcher for accessible mode selection */}
        <div
          role="tablist"
          aria-label="Login methods"
          className="login-tablist"
        >
          <button
            type="button"
            role="tab"
            id="tab-wallet"
            aria-selected={activeTab === "wallet"}
            aria-controls="panel-wallet"
            tabIndex={activeTab === "wallet" ? 0 : -1}
            className={`btn btn-sm ${activeTab === "wallet" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => {
              setActiveTab("wallet");
              setError(null);
            }}
          >
            <IconWallet size={16} aria-hidden="true" />
            <span>Stellar Wallet</span>
          </button>
          <button
            type="button"
            role="tab"
            id="tab-passphrase"
            aria-selected={activeTab === "passphrase"}
            aria-controls="panel-passphrase"
            tabIndex={activeTab === "passphrase" ? 0 : -1}
            className={`btn btn-sm ${activeTab === "passphrase" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => {
              setActiveTab("passphrase");
              setError(null);
            }}
          >
            <IconKey size={16} aria-hidden="true" />
            <span>Passphrase Login</span>
          </button>
        </div>

        {/* Panel 1: Wallet Login */}
        <section
          id="panel-wallet"
          role="tabpanel"
          aria-labelledby="tab-wallet"
          hidden={activeTab !== "wallet"}
          className="login-tabpanel"
        >
          <div className="wallet-login-content">
            <p className="muted wallet-instructions">
              Connect your Stellar wallet to authenticate automatically without sending secret keys or passwords over the network.
            </p>

            <div className="wallet-button-container">
              <WalletButton />
            </div>

            {isConnected && address ? (
              <div
                role="status"
                aria-live="polite"
                className="wallet-status-connected"
              >
                <IconCheck size={18} color="var(--accent)" aria-hidden="true" />
                <span>
                  Connected as <code className="mono">{address.slice(0, 4)}...{address.slice(-4)}</code>
                </span>
                <Link
                  href="/holder"
                  className="btn btn-primary btn-sm"
                  aria-label="Proceed to holder dashboard"
                >
                  Enter Dashboard <IconArrowRight size={14} aria-hidden="true" />
                </Link>
              </div>
            ) : (
              <p className="wallet-supported-hint faint mono">
                Supported: Freighter, Ledger, Trezor, Albedo, xBull
              </p>
            )}
          </div>
        </section>

        {/* Panel 2: Passphrase / Credential Login */}
        <section
          id="panel-passphrase"
          role="tabpanel"
          aria-labelledby="tab-passphrase"
          hidden={activeTab !== "passphrase"}
          className="login-tabpanel"
        >
          <form onSubmit={handleSubmit} noValidate className="login-form">
            {error && (
              <div
                id="login-error"
                role="alert"
                aria-live="assertive"
                className="login-error-alert"
              >
                <IconAlertCircle size={18} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            {success && (
              <div
                role="status"
                aria-live="polite"
                className="login-success-alert"
              >
                <IconCheck size={18} aria-hidden="true" />
                <span>Credentials verified. Redirecting...</span>
              </div>
            )}

            <div className="form-group">
              <label htmlFor="login-identifier" className="form-label">
                Email or Public Key <span aria-hidden="true" className="required-star">*</span>
              </label>
              <input
                id="login-identifier"
                name="identifier"
                type="text"
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                aria-required="true"
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? "login-error" : "login-identifier-hint"}
                placeholder="you@domain.com or G..."
                className="form-input"
              />
              <p id="login-identifier-hint" className="form-hint">
                Enter your registered identifier or Stellar public key.
              </p>
            </div>

            <div className="form-group">
              <label htmlFor="login-passphrase" className="form-label">
                Passphrase or Backup Secret <span aria-hidden="true" className="required-star">*</span>
              </label>
              <input
                id="login-passphrase"
                name="passphrase"
                type="password"
                autoComplete="current-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                required
                aria-required="true"
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? "login-error" : "login-passphrase-hint"}
                placeholder="Enter secret passphrase"
                className="form-input"
              />
              <p id="login-passphrase-hint" className="form-hint">
                Your passphrase is processed locally to decrypt your zero-knowledge credentials.
              </p>
            </div>

            <div className="form-checkbox-row">
              <input
                id="login-remember"
                name="remember"
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="form-checkbox"
              />
              <label htmlFor="login-remember" className="checkbox-label">
                Remember this device for 30 days
              </label>
            </div>

            <button
              type="submit"
              disabled={loading || success}
              className="btn btn-primary btn-lg submit-btn"
              aria-label={loading ? "Authenticating, please wait" : "Sign in to your account"}
            >
              {loading ? (
                <span>Signing in...</span>
              ) : (
                <>
                  <IconLock size={16} aria-hidden="true" />
                  <span>Sign in</span>
                </>
              )}
            </button>
          </form>
        </section>

        <footer className="login-card-footer">
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Don&apos;t have credentials yet?{" "}
            <Link href="/verify" className="login-footer-link">
              Get verified
            </Link>{" "}
            or view{" "}
            <Link href="/docs" className="login-footer-link">
              documentation
            </Link>
            .
          </p>
        </footer>
      </div>
    </main>
  );
}

"use client";

/**
 * WalletOnboarding — progressive wallet installation and network compatibility
 * guidance for first-time users.
 *
 * This component renders three states:
 *
 * 1. **No wallet detected** — shows a list of known Stellar wallets with
 *    installation links and a short description. Once the user installs one,
 *    they can click "I've installed a wallet" to retry detection.
 *
 * 2. **Wallet detected, not connected** — shows a single "Connect wallet"
 *    button (delegates to WalletButton's connect).
 *
 * 3. **Connected but network mismatch** — shows a warning that the wallet is
 *    on a different network than the app expects, with instructions to switch.
 *
 * The component is self-contained and can be dropped into any page that needs
 * wallet onboarding (holder, verify, developers). It collapses to null once
 * the wallet is connected and on the right network, so it never clutters the
 * UI for returning users.
 */

import { useState, useEffect, useCallback } from "react";
import {
  IconWallet,
  IconAlertTriangle,
  IconExternalLink,
  IconRefresh,
  IconPlugConnected,
} from "@tabler/icons-react";
import { useWallet } from "@/lib/wallet-context";
import {
  KNOWN_WALLETS,
  isWalletInstalled,
  appNetworkName,
  walletNetworkName,
} from "@/lib/wallet";

export function WalletOnboarding() {
  const { address, connect, connecting, networkMismatch } = useWallet();
  const [installed, setInstalled] = useState(false);
  const [walletNetwork, setWalletNetwork] = useState<string | null>(null);

  // Re-check installation status when the component mounts and when the
  // user clicks "I've installed a wallet" (the extension may have been
  // installed in another tab since the last check).
  const checkInstallation = useCallback(() => {
    setInstalled(isWalletInstalled());
  }, []);

  useEffect(() => {
    checkInstallation();
  }, [checkInstallation]);

  // Read the wallet's current network for the mismatch warning.
  useEffect(() => {
    if (!address || !networkMismatch) {
      setWalletNetwork(null);
      return;
    }
    walletNetworkName().then(setWalletNetwork);
  }, [address, networkMismatch]);

  // ── Connected and on the right network — nothing to show ──
  if (address && !networkMismatch) return null;

  // ── Connected but wrong network ──
  if (address && networkMismatch) {
    return (
      <div
        className="card"
        style={{
          padding: "1.25rem 1.5rem",
          border: "1px solid rgba(234,179,8,0.3)",
          backgroundColor: "rgba(234,179,8,0.06)",
          marginBottom: "1.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
          <IconAlertTriangle
            size={20}
            style={{ color: "var(--warn)", flexShrink: 0, marginTop: "0.1rem" }}
            aria-hidden="true"
          />
          <div>
            <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.3rem" }}>
              Network mismatch
            </h3>
            <p
              className="muted"
              style={{ fontSize: "0.85rem", lineHeight: 1.6, margin: 0 }}
            >
              Your wallet is set to{" "}
              <span className="mono" style={{ fontWeight: 600 }}>
                {walletNetwork ?? "a different network"}
              </span>
              , but this app runs on{" "}
              <span className="mono" style={{ fontWeight: 600 }}>
                {appNetworkName()}
              </span>
              . Switch your wallet&rsquo;s network setting to{" "}
              <span className="mono">{appNetworkName()}</span> to continue.
            </p>
            <p
              className="faint"
              style={{ fontSize: "0.75rem", lineHeight: 1.5, marginTop: "0.6rem", marginBottom: 0 }}
            >
              The warning clears automatically once the switch is detected — no
              need to reconnect.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Wallet installed but not connected ──
  if (installed) {
    return (
      <div
        className="card"
        style={{
          padding: "1.25rem 1.5rem",
          marginBottom: "1.5rem",
          textAlign: "center",
        }}
      >
        <IconPlugConnected
          size={24}
          color="var(--accent)"
          style={{ marginBottom: "0.5rem" }}
          aria-hidden="true"
        />
        <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.35rem" }}>
          Connect your wallet
        </h3>
        <p
          className="muted"
          style={{ fontSize: "0.85rem", lineHeight: 1.6, margin: "0 auto 1rem", maxWidth: 380 }}
        >
          A Stellar wallet was detected. Connect it to manage your credentials
          and generate zero-knowledge proofs.
        </p>
        <button
          className="btn btn-primary"
          onClick={connect}
          disabled={connecting}
          aria-label={connecting ? "Connecting wallet" : "Connect wallet"}
        >
          <IconWallet size={14} aria-hidden="true" />
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      </div>
    );
  }

  // ── No wallet detected — installation guidance ──
  return (
    <div
      className="card"
      style={{
        padding: "1.5rem",
        marginBottom: "1.5rem",
        borderStyle: "dashed",
      }}
    >
      <div style={{ textAlign: "center", marginBottom: "1.25rem" }}>
        <IconWallet
          size={26}
          color="var(--faint)"
          style={{ marginBottom: "0.4rem" }}
          aria-hidden="true"
        />
        <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.3rem" }}>
          Get a Stellar wallet
        </h3>
        <p
          className="muted"
          style={{ fontSize: "0.85rem", lineHeight: 1.6, maxWidth: 400, margin: "0 auto" }}
        >
          A Stellar wallet stores your keys and signs transactions. Install one
          of the wallets below, then connect it to start using StellarCred.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {KNOWN_WALLETS.map((w) => (
          <div
            key={w.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.75rem",
              padding: "0.65rem 0.85rem",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <IconWallet size={16} color="var(--accent)" aria-hidden="true" />
              <div>
                <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>{w.name}</div>
                <div className="faint" style={{ fontSize: "0.75rem" }}>
                  {w.description}
                </div>
              </div>
            </div>
            <a
              href={w.installUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "0.78rem", flexShrink: 0 }}
            >
              {w.isExtension ? "Install" : "Open"}
              <IconExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
        ))}
      </div>

      <div style={{ textAlign: "center", marginTop: "1.25rem" }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={checkInstallation}
          aria-label="Recheck for installed wallet"
        >
          <IconRefresh size={14} aria-hidden="true" />
          I&rsquo;ve installed a wallet
        </button>
      </div>

      <p
        className="faint"
        style={{ fontSize: "0.72rem", lineHeight: 1.5, marginTop: "1rem", textAlign: "center", marginBottom: 0 }}
      >
        Prefer a web wallet?{" "}
        <a
          href="https://albedo.link/"
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--accent)", textDecoration: "underline" }}
        >
          Albedo
        </a>{" "}
        requires no installation — it signs in your browser.
      </p>
    </div>
  );
}

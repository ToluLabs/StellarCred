"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import { useWallet } from "@/lib/wallet-context";
import { NETWORK } from "@/lib/stellar";

// Persistent warning shown whenever the connected wallet is on the wrong
// network. Driven by a live poll in wallet-context.tsx, so it appears/clears
// on its own as the user switches networks — no reconnect required.
export function NetworkBanner() {
  const { address, networkMismatch } = useWallet();
  if (!address || !networkMismatch) return null;

  const want = NETWORK === "mainnet" ? "Mainnet" : NETWORK === "futurenet" ? "Futurenet" : "Testnet";

  return (
    <div
      className="row"
      style={{
        gap: "0.6rem",
        padding: "0.7rem 1.5rem",
        borderBottom: "1px solid rgba(227, 179, 65, 0.3)",
        background: "rgba(227, 179, 65, 0.08)",
        fontSize: "0.8125rem",
        justifyContent: "center",
      }}
    >
      <IconAlertTriangle size={16} style={{ color: "var(--warn)", flexShrink: 0 }} />
      <span style={{ color: "var(--text)" }}>
        Wrong network detected. Switch your wallet to <strong>{want}</strong> to continue.
      </span>
    </div>
  );
}

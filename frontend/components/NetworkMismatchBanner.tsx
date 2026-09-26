"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import { NETWORK } from "@/lib/stellar";

// Shown when the connected wallet's selected network doesn't match this app's
// configured network (testnet vs mainnet passphrase mismatch). The kit's
// `network` option only configures which network we sign/submit for — it
// can't switch the wallet extension's own selected network — so this is a
// user action, not something we can silently fix. `wallet-context.tsx` polls
// live so this clears itself the moment the user switches (Issue #214).
export function NetworkMismatchBanner() {
  return (
    <div
      className="row"
      style={{
        gap: "0.6rem",
        padding: "0.7rem 1rem",
        marginBottom: "1.25rem",
        borderRadius: "var(--radius)",
        border: "1px solid rgba(240,96,77,0.3)",
        background: "rgba(240,96,77,0.06)",
        fontSize: "0.8125rem",
      }}
    >
      <IconAlertTriangle size={16} style={{ color: "var(--danger)", flexShrink: 0 }} />
      <span>
        Your wallet is on the wrong network. Switch to{" "}
        <strong>{NETWORK === "mainnet" ? "Mainnet" : NETWORK === "futurenet" ? "Futurenet" : "Testnet"}</strong> in your wallet
        extension to submit — proving still works, but submission is blocked
        until networks match.
      </span>
    </div>
  );
}

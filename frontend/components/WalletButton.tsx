"use client";

import { IconWallet, IconChevronDown } from "@tabler/icons-react";
import { useWallet } from "@/lib/wallet-context";
import { truncateAddress } from "@/lib/format";
import CopyButton from "@/components/CopyButton";

export function WalletButton() {
  const { address, connecting, error, connect, disconnect } = useWallet();

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.35rem" }}>
      {address ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            className="btn btn-secondary"
            onClick={disconnect}
            disabled={connecting}
            title="Click to disconnect"
            style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.8rem" }}
          >
            <IconWallet size={14} />
            {truncateAddress(address)}
            <IconChevronDown size={13} style={{ opacity: 0.5 }} />
          </button>

          <CopyButton value={address} />
        </div>
      ) : (
        <button
          className="btn btn-primary"
          onClick={connect}
          disabled={connecting}
        >
          <IconWallet size={14} />
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      )}

      {error && (
        <span
          className="mono"
          style={{ color: "var(--danger)", fontSize: "0.7rem", maxWidth: 260, textAlign: "right", lineHeight: 1.4, }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
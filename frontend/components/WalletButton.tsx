"use client";

import { IconWallet, IconChevronDown, IconAlertTriangle, IconInfoCircle, IconRefresh } from "@tabler/icons-react";
import { useWallet } from "@/lib/wallet-context";
import { getWalletErrorInfo, getWalletReportUrl } from "@/lib/wallet";
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

      {error && (() => {
        const info = getWalletErrorInfo(error);
        const Icon = info.benign ? IconInfoCircle : IconAlertTriangle;
        const color = info.benign ? "var(--muted)" : "var(--danger)";
        return (
          <div style={{ display: "flex", alignItems: "flex-start", gap: "0.4rem", maxWidth: 300 }}>
            <Icon size={13} style={{ color, flexShrink: 0, marginTop: "0.15rem" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
              <span
                className="mono"
                style={{ color, fontSize: "0.7rem", fontWeight: 600, textAlign: "right", lineHeight: 1.4 }}
              >
                {info.title}
              </span>
              <span
                className="mono"
                style={{ color, fontSize: "0.7rem", textAlign: "right", lineHeight: 1.4, opacity: info.benign ? 0.85 : 0.9 }}
              >
                {info.message}
              </span>
              <div style={{ display: "flex", gap: "0.35rem", justifyContent: "flex-end", marginTop: "0.1rem" }}>
                {info.action === "install" && error.installUrl ? (
                  <a
                    href={error.installUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem" }}
                  >
                    Install {error.walletName ?? "wallet"}
                  </a>
                ) : (
                  <>
                    {info.action === "retry-report" && (
                      <a
                        href={getWalletReportUrl()}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem" }}
                      >
                        Report
                      </a>
                    )}
                    <button
                      onClick={connect}
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem", flexShrink: 0 }}
                    >
                      <IconRefresh size={12} />
                      Retry
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
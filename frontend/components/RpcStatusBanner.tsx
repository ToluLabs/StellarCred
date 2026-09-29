"use client";

import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { useRpcHealth } from "@/lib/rpc-health";

/**
 * App-level degraded-mode indicator (Issue #634).
 *
 * When the Soroban endpoint is unreachable every read in the app is
 * unattributable: the honest statement is "unknown", not "unverified". This
 * banner states that once, globally, so each surface's `unknown` state is
 * read as a network problem rather than as a verdict on the credential. It
 * clears itself on the next successful probe — including one triggered by any
 * read elsewhere in the app.
 */
export function RpcStatusBanner() {
  const { degraded, issue, recheck } = useRpcHealth();
  if (!degraded) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="row"
      style={{
        gap: "0.6rem",
        padding: "0.7rem 1.5rem",
        borderBottom: "1px solid rgba(240, 96, 77, 0.35)",
        background: "rgba(240, 96, 77, 0.08)",
        fontSize: "0.8125rem",
        justifyContent: "center",
        flexWrap: "wrap",
      }}
    >
      <IconAlertTriangle size={16} style={{ color: "var(--danger)", flexShrink: 0 }} />
      <span style={{ color: "var(--text)" }}>
        <strong>Stellar network unavailable.</strong>{" "}
        <span className="muted">
          {issue?.message ?? "The RPC endpoint is not responding."} Credential
          status is <strong>unknown</strong>, not unverified — nothing here is
          a rejection, and submissions will fail until it recovers.
        </span>
      </span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={recheck}
        style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
      >
        <IconRefresh size={12} stroke={2} />
        Retry
      </button>
    </div>
  );
}

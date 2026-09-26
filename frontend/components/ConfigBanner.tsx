"use client";

import { IconInfoCircle } from "@tabler/icons-react";
import {
  contractsConfigured,
  issuanceConfigured,
  missingContractEnvVars,
  missingIssueConfigEnvVars,
} from "@/lib/config";
import { checkNetworkConfig } from "@/lib/network-check";
import { NETWORK } from "@/lib/stellar";

/**
 * Shown up front on any page with actions that depend on deploy config.
 * Uses the same shared checks as /api/ready (lib/config.ts), so the banner
 * and the readiness probe always agree on what "configured" means.
 *
 * Pass `requireIssuance` on pages whose primary action issues credentials
 * (/verify, /issuer): those additionally need NEXT_PUBLIC_ISSUER_ADDRESS and
 * IssuerRegistry, not just the contract IDs.
 */
export function ConfigBanner({ requireIssuance = false }: { requireIssuance?: boolean }) {
  const missing = missingContractEnvVars();
  const missingIssue = requireIssuance ? missingIssueConfigEnvVars() : [];
  const allMissing = Array.from(new Set([...missing, ...missingIssue]));

  // Mixed-network preflight (Issue #408): passphrase/RPC belonging to a
  // different network than the selector is a hard misconfiguration — surface
  // it before any signing happens.
  const networkProblems = checkNetworkConfig();
  if (networkProblems.length > 0) {
    return (
      <div
        className="row"
        style={{
          gap: "0.6rem",
          padding: "0.7rem 1rem",
          marginBottom: "1.5rem",
          borderRadius: "var(--radius)",
          border: "1px solid rgba(240,96,77,0.4)",
          background: "rgba(240,96,77,0.08)",
          fontSize: "0.8125rem",
          alignItems: "flex-start",
        }}
        role="alert"
      >
        <IconInfoCircle size={16} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
        <span>
          <strong style={{ color: "var(--danger)" }}>Mixed-network configuration detected.</strong>{" "}
          {networkProblems.map((p) => (
            <span key={p.key} style={{ display: "block", marginTop: "0.25rem" }}>
              <span className="mono">{p.key}</span>: {p.message}
            </span>
          ))}
          <span style={{ display: "block", marginTop: "0.4rem" }}>
            Fix NEXT_PUBLIC_STELLAR_NETWORK (or the conflicting overrides) in{" "}
            <span className="mono">frontend/.env.local</span> — signing and indexing are
            unsafe until the config is coherent.
          </span>
        </span>
      </div>
    );
  }

  if (allMissing.length === 0 && contractsConfigured() && (!requireIssuance || issuanceConfigured()))
    return null;
  if (allMissing.length === 0) return null;

  return (
    <div
      className="config-banner"
      role="alert"
    >

      <IconInfoCircle size={16} className="config-banner__icon" />
      <span className="config-banner__text">
        <strong className="config-banner__strong">App not fully configured.</strong>{" "}
        Active network: <strong>{NETWORK}</strong>.{" "}
        {requireIssuance ? "Credential issuance and " : ""}On-chain submission is
        disabled — missing env vars:{" "}
        <span className="config-banner__code">{allMissing.join(", ")}</span>. Run{" "}
        <span className="config-banner__code">./scripts/deploy.sh</span> and set them in{" "}
        <span className="config-banner__code">frontend/.env.local</span>.
      </span>
    </div>
  );
}

"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  IconCheck,
  IconX,
  IconLoader2,
  IconQuestionMark,
} from "@tabler/icons-react";
import { truncateHash } from "@/lib/format";
import { isVerified } from "@/lib/contracts";
import { classifyRpcError, type RpcIssue } from "@/lib/rpc-health";

/**
 * The embedded badge reads ProofRegistry for one (wallet, claim) pair.
 *
 * Degraded mode (Issue #634): the badge has three outcomes, not two. A read
 * that never reached the ledger renders as "Unknown — network unavailable" in
 * amber, never as "Not verified": an embedded badge that says "not verified"
 * during an outage misleads every third party that embeds it.
 */
type BadgeStatus = "loading" | "verified" | "unverified" | "unknown";

/** Re-check cadence while the network is unreachable, in ms. */
const UNKNOWN_RETRY_MS = 10_000;

function BadgeContent() {
  const searchParams = useSearchParams();
  const wallet = searchParams.get("wallet") || "";
  const claim = searchParams.get("claim") || searchParams.get("type") || "kyc";
  const theme = searchParams.get("theme") || "dark";
  const isCompact =
    searchParams.get("compact") === "1" ||
    searchParams.get("compact") === "true";

  const [status, setStatus] = useState<BadgeStatus>("loading");
  const [issue, setIssue] = useState<RpcIssue | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!wallet) {
      setStatus("unverified");
      setIssue(null);
      return;
    }

    let isMounted = true;
    setStatus("loading");
    (async () => {
      try {
        const result = await isVerified(wallet, claim);
        if (!isMounted) return;
        // `unknown` means the ledger never answered — a failed read is not a
        // negative result and must not render as one.
        setStatus(result.status === "unknown" ? "unknown" : result.status);
        setIssue(result.status === "unknown" ? result.issue : null);
      } catch (err) {
        if (!isMounted) return;
        setStatus("unknown");
        setIssue(classifyRpcError(err));
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [wallet, claim, nonce]);

  // While the read cannot be completed, keep trying: the badge heals itself
  // once the node is back instead of staying "Unknown" until someone reloads.
  useEffect(() => {
    if (status !== "unknown") return;
    const timer = setTimeout(() => setNonce((n) => n + 1), UNKNOWN_RETRY_MS);
    return () => clearTimeout(timer);
  }, [status, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  const isDark =
    theme === "dark" ||
    (theme === "auto" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  const bgColor = isDark ? "#0d1117" : "#f8fafc";
  const textColor = isDark ? "#f1f5f9" : "#0f172a";
  const borderColor = isDark ? "#30363d" : "#e2e8f0";
  const faintColor = isDark ? "#8b949e" : "#64748b";

  // Amber is reserved for "cannot determine" — never used for a negative.
  const toneColor =
    status === "verified" ? "#10b981" : status === "unverified" ? "#ef4444" : "#e3b341";
  const toneBg =
    status === "verified"
      ? "rgba(16, 185, 129, 0.15)"
      : status === "unverified"
        ? "rgba(239, 68, 68, 0.15)"
        : "rgba(227, 179, 65, 0.15)";

  const claimLabels: Record<string, string> = {
    kyc: "KYC",
    age: "Age 18+",
    funds: "Funds",
    income: "Income",
    jurisdiction: "Jurisdiction",
    accreditation: "Accredited",
    employment: "Employment",
  };

  const claimText = claimLabels[claim.toLowerCase()] || claim.toUpperCase();

  const title =
    status === "loading"
      ? "Verifying StellarCred claim on-chain..."
      : status === "verified"
        ? `StellarCred: ${claimText} Verified for ${wallet}`
        : status === "unknown"
          ? `StellarCred: ${claimText} status unknown — ${
              issue?.message ?? "the network could not be reached"
            } This is not a rejection.`
          : `StellarCred: ${claimText} Not Verified`;

  return (
    <div
      style={{
        margin: 0,
        padding: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        background: "transparent",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <a
        href="https://stellarcred.xyz"
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        // data-status lets embedders style or script around the unknown state.
        data-status={status}
        style={{
          textDecoration: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: isCompact ? "0.45rem" : "0.6rem",
          padding: isCompact ? "0.3rem 0.55rem" : "0.45rem 0.75rem",
          background: bgColor,
          color: textColor,
          border: `1px solid ${borderColor}`,
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          transition: "border-color 0.15s ease",
          fontSize: isCompact ? "0.75rem" : "0.82rem",
          userSelect: "none",
          cursor: "pointer",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: isCompact ? "18px" : "22px",
            height: isCompact ? "18px" : "22px",
            borderRadius: "50%",
            background: status === "loading" ? "rgba(148, 163, 184, 0.15)" : toneBg,
            color: status === "loading" ? faintColor : toneColor,
            flexShrink: 0,
          }}
        >
          {status === "loading" ? (
            <IconLoader2 size={isCompact ? 12 : 14} className="animate-spin" />
          ) : status === "verified" ? (
            <IconCheck size={isCompact ? 12 : 14} stroke={2.5} />
          ) : status === "unknown" ? (
            <IconQuestionMark size={isCompact ? 12 : 14} stroke={2.5} />
          ) : (
            <IconX size={isCompact ? 12 : 14} stroke={2.5} />
          )}
        </div>

        <div
          style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            <span style={{ fontWeight: 600 }}>StellarCred</span>
            <span style={{ color: faintColor }}>·</span>
            <span style={{ fontWeight: 500, color: faintColor }}>
              {claimText}
            </span>
          </div>

          {!isCompact && (
            <div
              style={{
                fontSize: "0.68rem",
                color: faintColor,
                marginTop: "0.1rem",
              }}
            >
              {status === "loading" ? (
                "Checking on-chain..."
              ) : status === "verified" ? (
                <span style={{ color: "#10b981", fontWeight: 500 }}>
                  Verified{" "}
                  {wallet ? `(${truncateHash(wallet)})` : ""}
                </span>
              ) : status === "unknown" ? (
                <span style={{ color: "#e3b341" }}>
                  Unknown — network unavailable
                </span>
              ) : (
                <span style={{ color: "#ef4444" }}>Not verified</span>
              )}
            </div>
          )}
        </div>
      </a>

      {/* Recovering the badge must not require a reload of the embedding page. */}
      {status === "unknown" && !isCompact && (
        <button
          type="button"
          onClick={retry}
          style={{
            marginLeft: "0.5rem",
            padding: "0.25rem 0.5rem",
            fontSize: "0.7rem",
            color: faintColor,
            background: "transparent",
            border: `1px solid ${borderColor}`,
            borderRadius: "6px",
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

export default function BadgePageClient() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: "0.5rem", fontSize: "0.75rem", color: "#888" }}>
          Loading verification badge...
        </div>
      }
    >
      <BadgeContent />
    </Suspense>
  );
}

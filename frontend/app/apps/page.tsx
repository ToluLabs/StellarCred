"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  IconCheck,
  IconCircle,
  IconSearch,
  IconFilter,
  IconLoader2,
  IconAlertCircle,
  IconRefresh,
} from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet, usePreviewMode } from "@/lib/wallet-context";
import { Badge } from "@/components/Badge";
import { ConfigBanner } from "@/components/ConfigBanner";
import { PROTOCOLS, type Protocol } from "@/lib/protocols";
import { CREDENTIAL_TYPES } from "@/lib/stellar";
import { useProtocolAccessCheck } from "@/lib/use-protocol-access";

const CLAIM_LABELS: Record<string, string> = {
  kyc: "KYC",
  age: "Age",
  jurisdiction: "Jurisdiction",
  income: "Income",
  funds: "Funds",
};

function ProtocolCard({
  protocol,
  activeWallet,
  networkKey,
}: {
  protocol: Protocol;
  activeWallet: string | null;
  networkKey: string | boolean;
}) {
  const router = useRouter();
  const isPreview = usePreviewMode();
  const { state, statuses, retry, checking } = useProtocolAccessCheck(
    protocol.requirements,
    activeWallet,
    // Preview mode is "!address"; don't auto-grant when disconnected — show Connect wallet.
    { isPreview: isPreview && Boolean(activeWallet), networkKey },
  );

  return (
    <div
      className="card protocol-card"
      onClick={() => router.push(`/apps/${protocol.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(`/apps/${protocol.id}`);
        }
      }}
      role="link"
      tabIndex={0}
      aria-label={`Open ${protocol.name} — ${protocol.tagline}`}
      style={{ display: "flex", flexDirection: "column", gap: 0, cursor: "pointer" }}
    >
      <div className="between" style={{ marginBottom: "0.35rem" }}>
        <span
          className="row"
          style={{
            gap: "0.5rem",
            color: "var(--accent)",
            fontWeight: 600,
            fontSize: "1.1rem",
          }}
        >
          {protocol.icon}
          {protocol.name}
        </span>
        <div className="row" style={{ gap: "0.3rem" }}>
          {protocol.requirements.map((r, i) => {
            const isClaimMet = state === "granted" || (state === "denied" && statuses[i]);
            return (
              <span
                key={r.type}
                style={{
                  padding: "0.15rem 0.5rem",
                  borderRadius: "999px",
                  fontSize: "0.65rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  background: isClaimMet
                    ? "rgba(62,207,142,0.15)"
                    : "rgba(255,255,255,0.05)",
                  color: isClaimMet ? "var(--accent)" : "var(--faint)",
                  border: `1px solid ${
                    isClaimMet ? "rgba(62,207,142,0.35)" : "var(--border)"
                  }`,
                  opacity: checking ? 0.55 : 1,
                }}
              >
                {CLAIM_LABELS[r.type] || r.type}
              </span>
            );
          })}
        </div>
      </div>
      <p className="mono faint" style={{ fontSize: "0.72rem", marginBottom: "0.75rem" }}>
        {protocol.tagline}
      </p>
      <p className="muted" style={{ fontSize: "0.8125rem", lineHeight: 1.65, marginBottom: "1.25rem" }}>
        {protocol.description}
      </p>
      <div
        style={{
          padding: "0.65rem 0.9rem",
          borderRadius: "var(--radius)",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid var(--border)",
          marginBottom: "1.25rem",
        }}
      >
        <div className="faint" style={{ fontSize: "0.72rem", marginBottom: "0.2rem" }}>
          {protocol.stat.label}
        </div>
        <div style={{ fontWeight: 600, fontSize: "1.5rem", letterSpacing: "-0.03em" }}>
          {protocol.stat.value}
        </div>
        <div className="mono faint" style={{ fontSize: "0.7rem" }}>
          {protocol.stat.sub}
        </div>
      </div>
      <div className="eyebrow" style={{ marginBottom: "0.4rem" }}>
        Requirements
      </div>
      <div className="stack" style={{ marginBottom: "1rem" }}>
        {protocol.requirements.map((r, i) => (
          <div className="line" key={r.label}>
            <span className="row" style={{ gap: "0.6rem" }}>
              {checking ? (
                <IconLoader2 size={15} color="var(--faint)" className="spin" />
              ) : state === "error" ? (
                <IconAlertCircle size={15} color="var(--danger)" />
              ) : statuses[i] ? (
                <IconCheck size={15} color="var(--accent)" stroke={2.5} />
              ) : (
                <IconCircle size={15} color="var(--faint)" />
              )}
              <span
                style={{
                  fontSize: "0.875rem",
                  color:
                    !checking && state !== "error" && statuses[i]
                      ? "var(--text)"
                      : "var(--muted)",
                }}
              >
                {r.label}
              </span>
            </span>
            {checking ? (
              <Badge variant="pending">Checking</Badge>
            ) : state === "error" ? (
              <Badge variant="denied">Unavailable</Badge>
            ) : statuses[i] ? (
              <Badge variant="verified">Proved</Badge>
            ) : (
              <Badge variant="pending">Needed</Badge>
            )}
          </div>
        ))}
      </div>

      {/* Per-card access outcome — never flash denied while a check is in flight */}
      <div
        className="between"
        style={{
          marginTop: "auto",
          paddingTop: "0.75rem",
          borderTop: "1px solid var(--border)",
          minHeight: "1.75rem",
        }}
        onClick={(e) => {
          // Keep retry/control clicks from navigating into the protocol.
          if (state === "error") e.stopPropagation();
        }}
      >
        {!activeWallet ? (
          <span className="faint" style={{ fontSize: "0.75rem" }}>
            Connect wallet to check access
          </span>
        ) : (
          <>
            {state === "loading" && (
              <span className="row faint" style={{ gap: "0.4rem", fontSize: "0.75rem" }}>
                <IconLoader2 size={14} className="spin" />
                Checking access…
              </span>
            )}
            {state === "granted" && <Badge variant="verified">Access granted</Badge>}
            {state === "denied" && <Badge variant="denied">Access denied</Badge>}
            {state === "error" && (
              <>
                <span className="row" style={{ gap: "0.4rem" }}>
                  <Badge variant="denied">Check failed</Badge>
                  <span className="faint" style={{ fontSize: "0.72rem" }}>
                    RPC error
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    retry();
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    fontSize: "0.72rem",
                    padding: "0.25rem 0.55rem",
                  }}
                >
                  <IconRefresh size={12} stroke={2} />
                  Retry
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AppsInner() {
  const { address, networkMismatch } = useWallet();
  const searchParams = useSearchParams();
  const scVerified = searchParams.get("sc_verified") === "true";
  const scWallet = searchParams.get("sc_wallet");
  // `address` is "" when disconnected — use || so we fall through to scWallet/null.
  const activeWallet = address || scWallet || null;
  // Include mismatch so a live network switch re-runs checks after debounce.
  const networkKey = networkMismatch ? "mismatch" : "ok";

  const [search, setSearch] = useState("");
  const [selectedClaims, setSelectedClaims] = useState<Set<string>>(new Set());

  const toggleClaim = (claim: string) => {
    setSelectedClaims((prev) => {
      const next = new Set(prev);
      if (next.has(claim)) next.delete(claim);
      else next.add(claim);
      return next;
    });
  };

  const filtered = useMemo(() => {
    return PROTOCOLS.filter((p) => {
      const matchesSearch =
        !search.trim() ||
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.description.toLowerCase().includes(search.toLowerCase()) ||
        p.tagline.toLowerCase().includes(search.toLowerCase());
      const matchesClaims =
        selectedClaims.size === 0 ||
        p.requirements.some((r) => selectedClaims.has(r.type));
      return matchesSearch && matchesClaims;
    });
  }, [search, selectedClaims]);

  return (
    <>
      <div className="between" style={{ marginBottom: "2rem" }}>
        <div>
          <span className="eyebrow">Demo protocols</span>
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>Apps</h1>
        </div>
        <WalletButton />
      </div>

      <div
        style={{
          marginBottom: "1.75rem",
          padding: "0.75rem 1rem",
          borderRadius: "var(--radius)",
          background: "rgba(62,207,142,0.05)",
          border: "1px solid rgba(62,207,142,0.15)",
          fontSize: "0.8125rem",
          color: "var(--muted)",
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: "var(--text)" }}>Any protocol, any claim.</strong>{" "}
        Each app below gates access on a different credential type — one read-only call to{" "}
        <span className="mono" style={{ fontSize: "0.75rem" }}>
          ProofRegistry.is_verified
        </span>
        . The protocol never sees the credential, the commitment, or the proof itself.
      </div>

      {scVerified && (
        <div
          className="reveal"
          style={{
            marginBottom: "1.5rem",
            padding: "0.85rem 1rem",
            borderRadius: "var(--radius)",
            background: "rgba(62,207,142,0.08)",
            border: "1px solid rgba(62,207,142,0.35)",
            fontSize: "0.875rem",
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
          }}
        >
          <IconCheck size={18} color="var(--accent)" stroke={2.5} />
          <span>
            <strong>Verification complete.</strong>{" "}
            <span className="muted">You were returned here from StellarCred automatically.</span>
          </span>
        </div>
      )}

      <ConfigBanner />

      <div className="stack" style={{ gap: "0.75rem", marginBottom: "1.5rem" }}>
        <div style={{ position: "relative" }}>
          <IconSearch
            size={16}
            stroke={1.8}
            color="var(--faint)"
            style={{
              position: "absolute",
              left: "0.75rem",
              top: "50%",
              transform: "translateY(-50%)",
            }}
          />
          <input
            type="text"
            aria-label="Search apps by name, description, or tagline"
            placeholder="Search apps by name, description, or tagline..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%",
              padding: "0.65rem 0.75rem 0.65rem 2.25rem",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--bg-raised)",
              color: "var(--text)",
              fontSize: "0.875rem",
            }}
          />
        </div>
        <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
          <IconFilter size={14} stroke={1.8} color="var(--faint)" />
          {CREDENTIAL_TYPES.map((claim) => {
            const isActive = selectedClaims.has(claim);
            return (
              <button
                key={claim}
                onClick={() => toggleClaim(claim)}
                type="button"
                style={{
                  padding: "0.3rem 0.7rem",
                  borderRadius: "999px",
                  fontSize: "0.72rem",
                  fontWeight: 500,
                  border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                  background: isActive ? "rgba(62,207,142,0.12)" : "transparent",
                  color: isActive ? "var(--accent)" : "var(--muted)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                {CLAIM_LABELS[claim] || claim}
              </button>
            );
          })}
          {selectedClaims.size > 0 && (
            <button
              onClick={() => setSelectedClaims(new Set())}
              type="button"
              style={{
                padding: "0.3rem 0.7rem",
                borderRadius: "999px",
                fontSize: "0.72rem",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--faint)",
                cursor: "pointer",
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div
          className="card"
          style={{ textAlign: "center", padding: "3.5rem 1.5rem", borderStyle: "dashed" }}
        >
          <IconSearch size={30} stroke={1.3} color="var(--faint)" />
          <h3 style={{ margin: "1rem 0 0.4rem" }}>No apps match</h3>
          <p className="muted" style={{ fontSize: "0.875rem" }}>
            Try adjusting your search or removing claim filters.
          </p>
        </div>
      ) : (
        <div className="grid grid-3" style={{ alignItems: "start", gap: "1.25rem" }}>
          {filtered.map((p) => (
            <ProtocolCard
              key={p.id}
              protocol={p}
              activeWallet={activeWallet}
              networkKey={networkKey}
            />
          ))}
        </div>
      )}

      <p
        className="faint"
        style={{
          marginTop: "2rem",
          fontSize: "0.8rem",
          textAlign: "center",
          lineHeight: 1.6,
        }}
      >
        Go to{" "}
        <Link href="/holder" style={{ color: "var(--muted)" }}>
          Wallet
        </Link>{" "}
        to generate proofs from your credentials, then return here to unlock access.
      </p>
    </>
  );
}

export default function AppsPage() {
  return (
    <Suspense fallback={null}>
      <AppsInner />
    </Suspense>
  );
}
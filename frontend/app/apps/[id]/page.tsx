"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  IconLock,
  IconCheck,
  IconCircle,
  IconArrowRight,
  IconArrowLeft,
} from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet } from "@/lib/wallet-context";
import { Badge } from "@/components/Badge";
import { ConfigBanner } from "@/components/ConfigBanner";
import { usePreviewMode } from "@/lib/wallet-context";
import { checkClaim } from "@/lib/contracts";
import { getProtocol } from "@/lib/protocols";

function ProtocolDetailInner() {
  const { id } = useParams<{ id: string }>();
  const { address } = useWallet();
  const searchParams = useSearchParams();

  const scVerified = searchParams.get("sc_verified") === "true";
  const scWallet = searchParams.get("sc_wallet");
  const activeWallet = address ?? scWallet ?? null;
  const isPreview = usePreviewMode();

  const protocol = getProtocol(id);

  const [statuses, setStatuses] = useState<boolean[]>([]);
  const [checked, setChecked] = useState(false);
  const [inputValue, setInputValue] = useState(protocol?.inputDefault ?? "");

  useEffect(() => {
    if (!protocol) return;
    setStatuses(protocol.requirements.map(() => false));
  }, [protocol]);

  useEffect(() => {
    if (isPreview && protocol) {
      setChecked(true);
      setStatuses(protocol.requirements.map(() => true));
      return;
    }
    if (!activeWallet || !protocol) {
      setChecked(false);
      setStatuses(protocol?.requirements.map(() => false) ?? []);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const results = await Promise.all(
          protocol.requirements.map((r) => checkClaim(activeWallet, r.type, r.minThreshold)),
        );
        if (!cancelled) setStatuses(results);
      } catch {
        // contracts not deployed — requirements stay unmet
      } finally {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [activeWallet, protocol]);

  if (!protocol) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <p className="muted">Protocol not found.</p>
        <Link href="/apps" className="btn btn-secondary btn-sm" style={{ marginTop: "1rem" }}>
          <IconArrowLeft size={14} /> Back to Apps
        </Link>
      </div>
    );
  }

  const eligible = statuses.length > 0 && statuses.every(Boolean);

  return (
    <>
      <div className="between" style={{ marginBottom: "2rem" }}>
        <div>
          <Link
            href="/apps"
            className="row faint"
            style={{ fontSize: "0.8125rem", gap: "0.35rem", marginBottom: "0.5rem", textDecoration: "none" }}
          >
            <IconArrowLeft size={13} /> Apps
          </Link>
          <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
            <span style={{ color: "var(--accent)" }}>{protocol.icon}</span>
            <h1 style={{ fontSize: "2rem", margin: 0 }}>{protocol.name}</h1>
          </div>
          <p className="mono faint" style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>
            {protocol.tagline}
          </p>
        </div>
        <WalletButton />
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

      <div className="grid grid-2" style={{ alignItems: "start", gap: "1.5rem" }}>
        {/* Left — info + eligibility */}
        <div className="card">
          <p className="muted" style={{ fontSize: "0.875rem", lineHeight: 1.7, marginBottom: "1.5rem" }}>
            {protocol.description}
          </p>

          {/* Stat */}
          <div
            style={{
              padding: "0.65rem 0.9rem",
              borderRadius: "var(--radius)",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid var(--border)",
              marginBottom: "1.5rem",
            }}
          >
            <div className="faint" style={{ fontSize: "0.72rem", marginBottom: "0.2rem" }}>
              {protocol.stat.label}
            </div>
            <div style={{ fontWeight: 600, fontSize: "1.75rem", letterSpacing: "-0.03em" }}>
              {protocol.stat.value}
            </div>
            <div className="mono faint" style={{ fontSize: "0.7rem" }}>{protocol.stat.sub}</div>
          </div>

          {/* Requirements */}
          <span className="eyebrow" style={{ marginBottom: "0.4rem", display: "block" }}>Requirements</span>
          <div className="stack" style={{ marginBottom: "1.25rem" }}>
            {protocol.requirements.map((r, i) => (
              <div className="line" key={r.label}>
                <span className="row" style={{ gap: "0.6rem" }}>
                  {statuses[i] ? (
                    <IconCheck size={15} color="var(--accent)" stroke={2.5} />
                  ) : (
                    <IconCircle size={15} color="var(--faint)" />
                  )}
                  <span style={{ fontSize: "0.875rem", color: statuses[i] ? "var(--text)" : "var(--muted)" }}>
                    {r.label}
                  </span>
                </span>
                {statuses[i] ? (
                  <Badge variant="verified">Proved</Badge>
                ) : (
                  <Badge variant="pending">Needed</Badge>
                )}
              </div>
            ))}
          </div>

          {checked && !eligible && !isPreview && (
            <Link
              href={protocol.verifyUrl}
              className="btn btn-secondary"
              style={{ width: "100%" }}
            >
              Get verified
              <IconArrowRight size={14} />
            </Link>
          )}

          {!activeWallet && !isPreview && (
            <p className="faint" style={{ marginTop: "0.75rem", fontSize: "0.8rem" }}>
              Connect your wallet to check eligibility.
            </p>
          )}
        </div>

        {/* Right — action */}
        <div
          className="card"
          style={{
            borderColor: eligible ? "rgba(62,207,142,0.4)" : "var(--border)",
            transition: "border-color 0.5s var(--ease)",
          }}
        >
          <div className="between" style={{ marginBottom: "1.5rem" }}>
            <span className="eyebrow">{protocol.actionLabel}</span>
            {checked && (
              eligible
                ? <Badge variant="verified">Access granted</Badge>
                : <Badge variant="denied">Access denied</Badge>
            )}
          </div>

          <label className="field-label">{protocol.inputLabel}</label>
          <input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={!eligible}
            style={{ opacity: eligible ? 1 : 0.5 }}
          />

          <button
            className="btn btn-primary"
            style={{
              marginTop: "0.9rem",
              width: "100%",
              opacity: eligible ? 1 : 0.45,
              transition: "opacity 0.4s var(--ease)",
            }}
            disabled={!eligible || isPreview}
          >
            {isPreview ? "Connect wallet to check access" : eligible ? protocol.actionLabel : (
              <><IconLock size={14} /> Prove eligibility first</>
            )}
          </button>

          <p className="faint" style={{ marginTop: "1.25rem", fontSize: "0.8125rem", lineHeight: 1.6 }}>
            {eligible
              ? `${protocol.name} read ProofRegistry.check_claim and found valid proofs for your address. No personal data was shared.`
              : `${protocol.name} only reads ProofRegistry.check_claim for your address — it never sees the credential data behind your proofs.`}
          </p>
        </div>
      </div>
    </>
  );
}

export default function ProtocolDetailPage() {
  return (
    <Suspense fallback={null}>
      <ProtocolDetailInner />
    </Suspense>
  );
}

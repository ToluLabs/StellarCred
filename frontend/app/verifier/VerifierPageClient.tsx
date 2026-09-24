"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";

import { useSearchParams } from "next/navigation";
import { IconLock, IconCheck, IconCircle, IconArrowRight } from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet } from "@/lib/wallet-context";
import { Badge } from "@/components/Badge";
import { ConfigBanner } from "@/components/ConfigBanner";
import { checkClaim } from "@/lib/contracts";

interface Requirement {
  label: string;
  type: string;
  minThreshold?: number;
  proved: boolean;
}

const REQUIREMENTS: Omit<Requirement, "proved">[] = [
  { label: "KYC verified", type: "kyc" },
  { label: "Age ≥ 18", type: "age", minThreshold: 18 },
  { label: "Accredited investor", type: "income", minThreshold: 200000 },
];

function VerifierInner() {
  const { address } = useWallet();
  const searchParams = useSearchParams();

  // When StellarCred redirects the user back after verification it appends
  // sc_verified=true and sc_wallet=<address>. We trust the wallet param only to
  // decide *which* address to read on-chain status for - the actual access
  // decision still comes from ProofRegistry, never from the URL.
  const scVerified = searchParams.get("sc_verified") === "true";
  const scWallet = searchParams.get("sc_wallet");
  const activeWallet = address ?? scWallet ?? null;

  // LendFi gates deposits on three credential proofs, read live from the
  // ProofRegistry.
  const [reqs, setReqs] = useState<Requirement[]>(
    REQUIREMENTS.map((r) => ({ ...r, proved: false })),
  );
  const [amount, setAmount] = useState("5,000");
  const [checked, setChecked] = useState(false);
  const eligible = reqs.every((r) => r.proved);

  // Reflect real on-chain status for each requirement whenever the wallet we
  // care about changes - connected wallet, or the one handed back in sc_wallet.
  useEffect(() => {
    if (!activeWallet) {
      setChecked(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const statuses = await Promise.all(
          REQUIREMENTS.map((r) => checkClaim(activeWallet, r.type, r.minThreshold)),
        );
        if (!cancelled) {
          setReqs((rs) => rs.map((r, i) => ({ ...r, proved: statuses[i] })));
        }
      } catch {
        // contracts not deployed / account unfunded - requirements stay unmet
      } finally {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWallet]);

  return (
    <>
      <div className="between" style={{ marginBottom: "2rem" }}>
        <div>
          <span className="eyebrow">Gated protocol · demo</span>
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>LendFi</h1>
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
            <strong>Verification complete - access granted.</strong>{" "}
            <span className="muted">You were returned here from StellarCred automatically.</span>
          </span>
        </div>
      )}

      <div
        style={{
          marginBottom: "1.75rem",
          padding: "0.75rem 1rem",
          borderRadius: "var(--radius)",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid var(--border)",
          fontSize: "0.8125rem",
          color: "var(--muted)",
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: "var(--text)" }}>Simulates a third-party protocol.</strong>{" "}
        Any DeFi pool, DAO, or app can gate access this way - one read-only call to{" "}
        <span className="mono" style={{ fontSize: "0.75rem" }}>ProofRegistry.is_verified</span>.
        It never sees the credential data, the commitment, or the proof itself. Only the
        on-chain result: verified or not.
      </div>

      <ConfigBanner />

      <div className="grid grid-2" style={{ alignItems: "start", gap: "1.5rem" }}>
        <div className="card">
          <span className="eyebrow">Total value locked</span>
          <div style={{ margin: "0.5rem 0 0.25rem", fontSize: "2.25rem", fontWeight: 600, letterSpacing: "-0.03em" }}>
            $124,800
          </div>
          <span className="mono faint">USDC · stellar:testnet</span>

          <hr className="divider" />

          <span className="eyebrow">Eligibility</span>
          <div className="stack" style={{ marginTop: "0.5rem" }}>
            {reqs.map((r) => (
              <div className="line" key={r.label}>
                <span className="row" style={{ gap: "0.6rem" }}>
                  {r.proved ? (
                    <IconCheck size={16} color="var(--accent)" stroke={2.5} />
                  ) : (
                    <IconCircle size={16} color="var(--faint)" />
                  )}
                  <span style={{ color: r.proved ? "var(--text)" : "var(--muted)" }}>
                    {r.label}
                  </span>
                </span>
                {r.proved ? (
                  <Badge variant="verified">Proved</Badge>
                ) : (
                  <Badge variant="pending">Needed</Badge>
                )}
              </div>
            ))}
          </div>

          {checked && !eligible && (
            <p className="faint" style={{ marginTop: "1.25rem", fontSize: "0.8125rem" }}>
              Missing proofs? Generate and submit them on the Holder page, then
              reconnect here.
            </p>
          )}

          {/* Demonstrates the full protocol → StellarCred → protocol loop without
              needing a separate app: redirect to /verify, then bounce back. */}
          <Link
            href="/verify?return_url=/apps&claim=kyc"
            className="btn btn-secondary btn-sm"
            style={{ marginTop: "1.25rem", width: "100%" }}
          >
            Simulate protocol redirect
            <IconArrowRight size={14} />
          </Link>
        </div>

        <div
          className="card"
          style={{
            borderColor: eligible ? "rgba(62,207,142,0.4)" : "var(--border)",
            transition: "border-color 0.5s var(--ease)",
          }}
        >
          <div className="between" style={{ marginBottom: "1.5rem" }}>
            <span className="eyebrow">Deposit</span>
            {eligible ? (
              <Badge variant="verified">Access granted</Badge>
            ) : (
              <Badge variant="denied">Access denied</Badge>
            )}
          </div>

          <label className="field-label" htmlFor="deposit-amount">Amount (USDC)</label>
          <input id="deposit-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />

          <button
            className="btn btn-primary"
            style={{
              marginTop: "1.25rem",
              width: "100%",
              opacity: eligible ? 1 : 0.45,
              transition: "opacity 0.5s var(--ease)",
            }}
            disabled={!eligible}
          >
            {eligible ? (
              "Deposit"
            ) : (
              <>
                <IconLock size={15} />
                Prove eligibility to deposit
              </>
            )}
          </button>

          <p className="faint" style={{ marginTop: "1.25rem", fontSize: "0.8125rem", lineHeight: 1.6 }}>
            {eligible
              ? "LendFi read ProofRegistry.is_verified and found valid proofs for your address. No personal data was shared."
              : "LendFi only reads ProofRegistry.is_verified for your address - it never sees the credential data behind your proofs."}
          </p>
        </div>
      </div>
    </>
  );
}

export default function VerifierPageClient() {
  return (
    <Suspense fallback={null}>
      <VerifierInner />
    </Suspense>
  );
}

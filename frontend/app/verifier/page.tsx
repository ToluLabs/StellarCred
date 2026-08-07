"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("verifier");

  const REQUIREMENTS_I18N: Omit<Requirement, "proved">[] = [
    { label: t("kycVerified"), type: "kyc" },
    { label: t("ageMin"), type: "age", minThreshold: 18 },
    { label: t("accredited"), type: "income", minThreshold: 200000 },
  ];

  const scVerified = searchParams.get("sc_verified") === "true";
  const scWallet = searchParams.get("sc_wallet");
  const activeWallet = address ?? scWallet ?? null;

  const [reqs, setReqs] = useState<Requirement[]>(
    REQUIREMENTS_I18N.map((r) => ({ ...r, proved: false })),
  );
  const [amount, setAmount] = useState("5,000");
  const [checked, setChecked] = useState(false);
  const eligible = reqs.every((r) => r.proved);

  useEffect(() => {
    if (!activeWallet) {
      setChecked(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const statuses = await Promise.all(
          REQUIREMENTS_I18N.map((r) => checkClaim(activeWallet, r.type, r.minThreshold)),
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
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWallet]);
  return (
    <>
      <div className="between" style={{ marginBottom: "2rem" }}>
        <div>
          <span className="eyebrow">{t("eyebrow")}</span>
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>{t("title")}</h1>
        </div>
        <WalletButton />
      </div>

      {scVerified && (
        <div className="reveal" style={{ marginBottom: "1.5rem", padding: "0.85rem 1rem", borderRadius: "var(--radius)", background: "rgba(62,207,142,0.08)", border: "1px solid rgba(62,207,142,0.35)", fontSize: "0.875rem", color: "var(--text)", display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <IconCheck size={18} color="var(--accent)" stroke={2.5} />
          <span>
            <strong>{t("accessGranted")}.</strong>{" "}
            <span className="muted">You were returned here from StellarCred automatically.</span>
          </span>
        </div>
      )}

      <div style={{ marginBottom: "1.75rem", padding: "0.75rem 1rem", borderRadius: "var(--radius)", background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", fontSize: "0.8125rem", color: "var(--muted)", lineHeight: 1.6 }}>
        <strong style={{ color: "var(--text)" }}>Simulates a third-party protocol.</strong>{" "}
        Any DeFi pool, DAO, or app can gate access this way — one read-only call to{" "}
        <span className="mono" style={{ fontSize: "0.75rem" }}>ProofRegistry.is_verified</span>.
        It never sees the credential data, the commitment, or the proof itself.
      </div>

      <ConfigBanner />

      <div className="grid grid-2" style={{ alignItems: "start", gap: "1.5rem" }}>
        <div className="card">
          <span className="eyebrow">{t("tvl")}</span>
          <div style={{ margin: "0.5rem 0 0.25rem", fontSize: "2.25rem", fontWeight: 600, letterSpacing: "-0.03em" }}>$124,800</div>
          <span className="mono faint">USDC · stellar:testnet</span>

          <hr className="divider" />

          <span className="eyebrow">{t("eligibility")}</span>
          <div className="stack" style={{ marginTop: "0.5rem" }}>
            {reqs.map((r) => (
              <div className="line" key={r.label}>
                <span className="row" style={{ gap: "0.6rem" }}>
                  {r.proved ? <IconCheck size={16} color="var(--accent)" stroke={2.5} /> : <IconCircle size={16} color="var(--faint)" />}
                  <span style={{ color: r.proved ? "var(--text)" : "var(--muted)" }}>{r.label}</span>
                </span>
                {r.proved ? <Badge variant="verified">Proved</Badge> : <Badge variant="pending">Needed</Badge>}
              </div>
            ))}
          </div>

          <Link href="/verify?return_url=/apps&claim=kyc" className="btn btn-secondary btn-sm" style={{ marginTop: "1.25rem", width: "100%" }}>
            {t("simulation")}
            <IconArrowRight size={14} />
          </Link>
        </div>

        <div className="card" style={{ borderColor: eligible ? "rgba(62,207,142,0.4)" : "var(--border)", transition: "border-color 0.5s var(--ease)" }}>
          <div className="between" style={{ marginBottom: "1.5rem" }}>
            <span className="eyebrow">{t("deposit")}</span>
            {eligible
              ? <Badge variant="verified">{t("accessGranted")}</Badge>
              : <Badge variant="denied">{t("accessDenied")}</Badge>}
          </div>

          <label className="field-label" htmlFor="deposit-amount">Amount (USDC)</label>
          <input id="deposit-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />

          <button className="btn btn-primary" style={{ marginTop: "1.25rem", width: "100%", opacity: eligible ? 1 : 0.45, transition: "opacity 0.5s var(--ease)" }} disabled={!eligible}>
            {eligible ? t("deposit") : <><IconLock size={15} /> Prove eligibility to deposit</>}
          </button>

          <p className="faint" style={{ marginTop: "1.25rem", fontSize: "0.8125rem", lineHeight: 1.6 }}>
            {eligible
              ? "LendFi read ProofRegistry.is_verified and found valid proofs for your address. No personal data was shared."
              : "LendFi only reads ProofRegistry.is_verified for your address — it never sees the credential data behind your proofs."}
          </p>
        </div>
      </div>
    </>
  );
}

export default function VerifierPage() {
  return (
    <Suspense fallback={null}>
      <VerifierInner />
    </Suspense>
  );
}

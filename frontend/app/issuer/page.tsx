"use client";

import { useState } from "react";
import {
  IconKey,
  IconArrowRight,
  IconLoader2,
} from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet } from "@/lib/wallet-context";
import { Badge } from "@/components/Badge";
import { saveCredential, TYPE_META, type Credential } from "@/lib/credential";
import type { CredentialType } from "@/lib/stellar";
import CopyButton from "@/components/CopyButton";

const TYPES = Object.entries(TYPE_META) as [
  CredentialType,
  (typeof TYPE_META)[CredentialType],
][];

// Sensible default attribute per type (the issuer can change it).
const DEFAULT_ATTR: Record<CredentialType, string> = {
  kyc: "",
  age: "1995-06-15",
  income: "250000",
  jurisdiction: "566",
  funds: "50000",
  accreditation: "1500000",
};

const COUNTRIES = [
  { code: "566", name: "Nigeria" },
  { code: "276", name: "Germany" },
  { code: "356", name: "India" },
  { code: "840", name: "United States (restricted)" },
  { code: "364", name: "Iran (restricted)" },
];

export default function IssuerPage() {
  const { address } = useWallet();
  const issuerId = process.env.NEXT_PUBLIC_ISSUER_ADDRESS ?? address;
  const [holder, setHolder] = useState("");
  const [type, setType] = useState<CredentialType>("kyc");
  const [attribute, setAttribute] = useState(DEFAULT_ATTR.kyc);
  const [expiry, setExpiry] = useState("90 days");
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const meta = TYPE_META[type];
  const needsAttr = !!meta.attribute;

  function onType(t: CredentialType) {
    setType(t);
    setAttribute(DEFAULT_ATTR[t]);
  }

  async function onIssue() {
    setBusy(true);
    setError("");
    try {
      // Map this page's single attribute onto the shared attributes shape, then
      // request one credential type wrapped in an array (multi-claim API).
      const attributes: Record<string, string> = {};
      if (type === "age") attributes.date_of_birth = attribute;
      else if (type === "income") attributes.income = attribute;
      else if (type === "funds") attributes.balance = attribute;
      else if (type === "accreditation") attributes.net_worth = attribute;
      else if (type === "jurisdiction") attributes.country_code = attribute;

      const res = await fetch("/api/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credential_types: [type],
          holder,
          issuerId,
          issuerName: "StellarCred Authority",
          expiry,
          attributes,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { credentials } = (await res.json()) as { credentials: Credential[] };
      const cred = credentials[0];
      saveCredential(cred);
      setIssued(JSON.stringify(cred, null, 2));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="between" style={{ marginBottom: "2rem" }}>
        <div>
          <span className="eyebrow">Issuer admin · demo</span>
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>Issue a credential</h1>
        </div>
        <WalletButton />
      </div>

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
        <strong style={{ color: "var(--text)" }}>Simulates the issuer's side.</strong>{" "}
        In production this would be a separate authenticated app run by the institution —
        KYC provider, bank, employer — after verifying the holder off-chain. The holder
        would never see this interface.
      </div>

      <div className="grid grid-2" style={{ alignItems: "start", gap: "1.5rem" }}>
        <div className="card">
          <label className="field-label">Holder address</label>
          <input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="G…" />

          <div className="grid grid-2" style={{ marginTop: "1.25rem", gap: "1rem" }}>
            <div>
              <label className="field-label">Credential type</label>
              <select value={type} onChange={(e) => onType(e.target.value as CredentialType)}>
                {TYPES.map(([key, m]) => (
                  <option key={key} value={key}>
                    {m.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Expiry</label>
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {["30 days", "90 days", "1 year"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          {needsAttr && (
            <div style={{ marginTop: "1.25rem" }}>
              <label className="field-label">{meta.attribute}</label>
              {type === "age" ? (
                <input type="date" value={attribute} onChange={(e) => setAttribute(e.target.value)} />
              ) : type === "jurisdiction" ? (
                <select value={attribute} onChange={(e) => setAttribute(e.target.value)}>
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="number"
                  value={attribute}
                  onChange={(e) => setAttribute(e.target.value)}
                />
              )}
            </div>
          )}

          <div className="row faint" style={{ marginTop: "1.25rem", fontSize: "0.8125rem" }}>
            <IconKey size={14} />
            <span>
              {needsAttr
                ? "The attribute is committed with Poseidon2 and stays private — the holder proves a claim about it."
                : "A fresh secret is generated and committed with Poseidon2 — the holder proves it without revealing it."}
            </span>
          </div>

          <button
            className="btn btn-primary"
            style={{ marginTop: "1.5rem", width: "100%" }}
            disabled={!holder || !issuerId || (needsAttr && !attribute) || busy}
            title={!issuerId ? "Connect the issuer wallet first" : undefined}
            onClick={onIssue}
          >
            {busy ? (
              <>
                <IconLoader2 size={15} className="spin" />
                Computing commitment…
              </>
            ) : (
              <>
                Sign &amp; issue
                <IconArrowRight size={15} />
              </>
            )}
          </button>
          {!issuerId && (
            <p className="faint" style={{ marginTop: "0.6rem", fontSize: "0.8125rem" }}>
              Connect the registered issuer wallet to issue.
            </p>
          )}
          {error && (
            <p style={{ marginTop: "0.6rem", fontSize: "0.8125rem", color: "var(--danger)" }}>
              {error}
            </p>
          )}
        </div>

        <div className="card" style={{ minHeight: 280 }}>
          <div className="between" style={{ marginBottom: "1rem" }}>
            <span className="eyebrow">Signed credential</span>
            {issued && (
              <div className="row" style={{ gap: "0.5rem" }}>
                <Badge variant="verified">Saved to wallet</Badge>
                <CopyButton value={issued} />
              </div>
            )}
          </div>
          {issued ? (
            <pre
              className="mono"
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--muted)",
                lineHeight: 1.7,
                maxHeight: 380,
                overflow: "auto",
              }}
            >
              {issued}
            </pre>
          ) : (
            <div style={{ height: 200, display: "grid", placeItems: "center", textAlign: "center" }}>
              <p className="faint" style={{ maxWidth: 280, fontSize: "0.875rem" }}>
                Issue a credential to generate signed JSON. It is saved to this
                browser&rsquo;s wallet and ready to prove on the Holder page — we
                never store it server-side.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

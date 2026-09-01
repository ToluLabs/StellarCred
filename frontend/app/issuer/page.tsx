"use client";

import { useEffect, useMemo, useState } from "react";
import {
  IconKey,
  IconArrowRight,
  IconLoader2,
  IconShieldCheck,
} from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet } from "@/lib/wallet-context";
import { Badge } from "@/components/Badge";
import { saveCredential, TYPE_META, type Credential } from "@/lib/credential";
import type { CredentialType } from "@/lib/stellar";
import CopyButton from "@/components/CopyButton";
import { ConfigBanner } from "@/components/ConfigBanner";
import { issuanceConfigured } from "@/lib/config";
import { truncateAddress, truncatePubkey } from "@/lib/format";
import type { RegisteredIssuer } from "@/lib/issuer-registry";
import type { IssuerStats } from "@/app/api/issuer-stats/route";
import { UsageDashboard } from "@/components/UsageDashboard";

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
  employment: "5",
};

const COUNTRIES = [
  { code: "566", name: "Nigeria" },
  { code: "276", name: "Germany" },
  { code: "356", name: "India" },
  { code: "840", name: "United States (restricted)" },
  { code: "364", name: "Iran (restricted)" },
];

async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { error?: string };
    return json.error ?? text;
  } catch {
    return text;
  }
}

export default function IssuerPage() {
  const { address } = useWallet();
  const [issuers, setIssuers] = useState<RegisteredIssuer[]>([]);
  const [issuersLoading, setIssuersLoading] = useState(true);
  const [issuersError, setIssuersError] = useState("");
  const [selectedIssuerId, setSelectedIssuerId] = useState("");
  const [issuerStats, setIssuerStats] = useState<IssuerStats | null>(null);
  const [issuerStatsError, setIssuerStatsError] = useState("");
  const [holder, setHolder] = useState("");
  const [type, setType] = useState<CredentialType>("kyc");
  const [attribute, setAttribute] = useState(DEFAULT_ATTR.kyc);
  const [expiry, setExpiry] = useState("90 days");
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedIssuer = useMemo(
    () => issuers.find((issuer) => issuer.id === selectedIssuerId) ?? null,
    [issuers, selectedIssuerId],
  );

  const availableTypes = useMemo(() => {
    if (!selectedIssuer) return TYPES;
    const allowed = new Set(selectedIssuer.credentialTypes);
    return TYPES.filter(([key]) => allowed.has(key));
  }, [selectedIssuer]);

  useEffect(() => {
    let cancelled = false;
    async function loadIssuers() {
      setIssuersLoading(true);
      setIssuersError("");
      try {
        const res = await fetch("/api/issuers");
        if (!res.ok) throw new Error(await readApiError(res));
        const { issuers: loaded } = (await res.json()) as { issuers: RegisteredIssuer[] };
        if (cancelled) return;
        setIssuers(loaded);
        if (loaded.length > 0) {
          const preferred =
            loaded.find((issuer) => issuer.id === address)?.id ??
            loaded.find((issuer) => issuer.id === process.env.NEXT_PUBLIC_ISSUER_ADDRESS)?.id ??
            loaded[0].id;
          setSelectedIssuerId(preferred);
        }
      } catch (e) {
        if (!cancelled) setIssuersError((e as Error).message);
      } finally {
        if (!cancelled) setIssuersLoading(false);
      }
    }
    loadIssuers();
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Reputation stats for whichever issuer is currently selected (#398) —
  // derived from indexed on-chain events, not the IssuerRegistry itself, so
  // it's fetched separately per selection rather than bundled into `issuers`.
  useEffect(() => {
    if (!selectedIssuer) {
      setIssuerStats(null);
      setIssuerStatsError("");
      return;
    }
    let cancelled = false;
    async function loadIssuerStats() {
      setIssuerStatsError("");
      try {
        const res = await fetch(
          `/api/issuer-stats?issuer=${encodeURIComponent(selectedIssuer!.id)}`,
        );
        if (!res.ok) throw new Error(await readApiError(res));
        const stats = (await res.json()) as IssuerStats;
        if (!cancelled) setIssuerStats(stats);
      } catch (e) {
        if (!cancelled) {
          setIssuerStats(null);
          setIssuerStatsError((e as Error).message);
        }
      }
    }
    loadIssuerStats();
    return () => {
      cancelled = true;
    };
  }, [selectedIssuer]);

  useEffect(() => {
    if (availableTypes.length === 0) return;
    if (!availableTypes.some(([key]) => key === type)) {
      onType(availableTypes[0][0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableTypes, type]);

  const meta = TYPE_META[type];
  const needsAttr = !!meta.attribute;

  function onType(nextType: CredentialType) {
    setType(nextType);
    setAttribute(DEFAULT_ATTR[nextType]);
  }

  async function onIssue() {
    if (!selectedIssuer) return;
    setBusy(true);
    setError("");
    try {
      const attributes: Record<string, string> = {};
      if (type === "age") attributes.date_of_birth = attribute;
      else if (type === "income") attributes.income = attribute;
      else if (type === "funds") attributes.balance = attribute;
      else if (type === "accreditation") attributes.net_worth = attribute;
      else if (type === "jurisdiction") attributes.country_code = attribute;
      // employment: the value is the binary status tag (set server-side to "1"),
      // the user-supplied attribute is the holder's seniority in years.

      const res = await fetch("/api/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credential_types: [type],
          holder,
          issuerId: selectedIssuer.id,
          issuerName: selectedIssuer.name,
          expiry,
          attributes,
        }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
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
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>
            Issue a credential
          </h1>
        </div>
        <WalletButton />
      </div>

      {/* Same shared check as /api/ready — issuance can't work without the
          demo issuer address and IssuerRegistry, so say so up front. */}
      <ConfigBanner requireIssuance />

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
        <strong style={{ color: "var(--text)" }}>
          Simulates the issuer&apos;s side.
        </strong>{" "}
        In production this would be a separate authenticated app run by the
        institution — KYC provider, bank, employer — after verifying the holder
        off-chain. The holder would never see this interface.
      </div>

      <div
        className="grid grid-2"
        style={{ alignItems: "start", gap: "1.5rem" }}
      >
        <div className="card">
          <label className="field-label" htmlFor="registered-issuer">Registered issuer</label>
          {issuersLoading ? (
            <p className="faint" style={{ fontSize: "0.8125rem", marginTop: "0.35rem" }}>
              Loading issuers from IssuerRegistry…
            </p>
          ) : issuers.length === 0 ? (
            <p className="faint" style={{ fontSize: "0.8125rem", marginTop: "0.35rem" }}>
              {issuersError ||
                "No registered issuers found. Deploy contracts and register issuers on IssuerRegistry."}
            </p>
          ) : (
            <>
              <select
                id="registered-issuer"
                value={selectedIssuerId}
                onChange={(e) => setSelectedIssuerId(e.target.value)}
              >
                {issuers.map((issuer) => (
                  <option key={issuer.id} value={issuer.id}>
                    {issuer.name} ({truncateAddress(issuer.id)})
                  </option>
                ))}
              </select>
              {selectedIssuer && (
                <div
                  className="row faint"
                  style={{
                    marginTop: "0.75rem",
                    gap: "0.45rem",
                    fontSize: "0.8125rem",
                    flexWrap: "wrap",
                  }}
                >
                  <IconShieldCheck size={14} />
                  <span>
                    Registered key{" "}
                    <code className="mono">{truncatePubkey(selectedIssuer.pubkeyHex)}</code>
                  </span>
                </div>
              )}
              {selectedIssuer && issuerStats && (
                <div
                  className="row faint"
                  style={{
                    marginTop: "0.5rem",
                    gap: "0.9rem",
                    fontSize: "0.8125rem",
                    flexWrap: "wrap",
                  }}
                  title="Issuer reputation, derived from indexed on-chain events"
                >
                  <span>
                    <strong style={{ color: "var(--text)" }}>{issuerStats.total}</strong> issued
                  </span>
                  <span>
                    <strong style={{ color: "var(--text)" }}>{issuerStats.active}</strong> active
                  </span>
                  {issuerStats.revoked > 0 && (
                    <span>
                      <strong style={{ color: "var(--text)" }}>{issuerStats.revoked}</strong>{" "}
                      revoked
                    </span>
                  )}
                  {issuerStats.credential_types.length > 0 && (
                    <span>{issuerStats.credential_types.join(", ")}</span>
                  )}
                  {issuerStats.first_seen && (
                    <span>
                      since{" "}
                      {new Date(issuerStats.first_seen * 1000).toLocaleDateString()}
                    </span>
                  )}
                </div>
              )}
              {selectedIssuer && issuerStatsError && (
                <p
                  className="faint"
                  style={{ marginTop: "0.5rem", fontSize: "0.75rem" }}
                >
                  Issuer stats unavailable: {issuerStatsError}
                </p>
              )}
            </>
          )}

          <label className="field-label" htmlFor="holder-address" style={{ marginTop: "1.25rem" }}>
            Holder address
          </label>
          <input id="holder-address" value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="G…" />

          <div
            className="grid grid-2"
            style={{ marginTop: "1.25rem", gap: "1rem" }}
          >
            <div>
              <label className="field-label" htmlFor="credential-type">Credential type</label>
              <select
                id="credential-type"
                value={type}
                onChange={(e) => onType(e.target.value as CredentialType)}
                disabled={availableTypes.length === 0}
              >
                {availableTypes.map(([key, m]) => (
                  <option key={key} value={key}>
                    {m.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="issuer-expiry">Expiry</label>
              <select
                id="issuer-expiry"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              >
                {["30 days", "90 days", "1 year"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          {needsAttr && (
            <div style={{ marginTop: "1.25rem" }}>
              <label className="field-label" htmlFor="issuer-attribute">{meta.attribute}</label>
              {type === "age" ? (
                <input
                  id="issuer-attribute"
                  type="date"
                  value={attribute}
                  onChange={(e) => setAttribute(e.target.value)}
                />
              ) : type === "jurisdiction" ? (
                <select
                  id="issuer-attribute"
                  value={attribute}
                  onChange={(e) => setAttribute(e.target.value)}
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="issuer-attribute"
                  type="number"
                  value={attribute}
                  onChange={(e) => setAttribute(e.target.value)}
                />
              )}
            </div>
          )}

          <div
            className="row faint"
            style={{ marginTop: "1.25rem", fontSize: "0.8125rem" }}
          >
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
            disabled={
              !holder ||
              !selectedIssuer ||
              availableTypes.length === 0 ||
              (needsAttr && !attribute) ||
              busy ||
              issuersLoading ||
              // Fail loudly up front instead of mid-request.
              !issuanceConfigured()
            }
            title={
              issuanceConfigured()
                ? undefined
                : "App not configured — NEXT_PUBLIC_ISSUER_ADDRESS / IssuerRegistry missing"
            }
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
          {error && (
            <p
              style={{
                marginTop: "0.6rem",
                fontSize: "0.8125rem",
                color: "var(--danger)",
              }}
            >
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
            <div
              style={{
                height: 200,
                display: "grid",
                placeItems: "center",
                textAlign: "center",
              }}
            >
              <p
                className="faint"
                style={{ maxWidth: 280, fontSize: "0.875rem" }}
              >
                Issue a credential to generate signed JSON. It is saved to this
                browser&rsquo;s wallet and ready to prove on the Holder page —
                we never store it server-side.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Self-serve usage & rate-limit dashboard — see GitHub #424. Shows the
          issuer their recent issuance volume, current rate-limit status, and
          remaining quota for the window, with a clear reset timestamp when
          throttled. `holder` is passed so the per-wallet dimension reflects
          the address being issued to; the IP dimension always reflects this
          connection. */}
      <UsageDashboard wallet={holder} />
    </>
  );
}

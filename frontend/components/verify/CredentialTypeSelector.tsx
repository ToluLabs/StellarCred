"use client";

import { useRef } from "react";
import { TYPE_META } from "@/lib/credential";
import type { CredentialType } from "@/lib/stellar";
import { PlaidBalanceWidget } from "./PlaidBalanceWidget";
import type { ClaimParamsFromUrl } from "@/lib/hooks/useVerifyParams";

const TYPES = Object.entries(TYPE_META) as [
  CredentialType,
  (typeof TYPE_META)[CredentialType],
][];

const COUNTRIES = [
  { code: "566", name: "Nigeria" },
  { code: "276", name: "Germany" },
  { code: "356", name: "India" },
  { code: "840", name: "United States (restricted)" },
  { code: "364", name: "Iran (restricted)" },
];

export interface CredentialTypeSelectorProps {
  selected: CredentialType | null;
  setSelected: (type: CredentialType) => void;
  requiredClaim: CredentialType | null;
  locked: boolean;
  attributes: Record<string, string>;
  setAttr: (key: string, val: string) => void;
  claimParamsFromUrl: ClaimParamsFromUrl;
  jurisdictionMode: string;
  setJurisdictionMode: (mode: string) => void;
  plaidBalance: number | null;
  plaidAccounts: { name: string; available: number }[];
  plaidSources: number | null;
  plaidMock: boolean;
}

export function CredentialTypeSelector({
  selected,
  setSelected,
  requiredClaim,
  locked,
  attributes,
  setAttr,
  claimParamsFromUrl,
  jurisdictionMode,
  setJurisdictionMode,
  plaidBalance,
  plaidAccounts,
  plaidSources,
  plaidMock,
}: CredentialTypeSelectorProps) {
  const radioRefs = useRef<Record<string, HTMLDivElement | null>>({});

  return (
    <>
      <label className="field-label" id="credential-type-label">
        Credential type
      </label>
      {locked && (
        <p
          className="faint"
          style={{ fontSize: "0.8125rem", margin: "0.4rem 0 0" }}
        >
          A protocol requested the{" "}
          <strong style={{ color: "var(--accent)" }}>{requiredClaim}</strong>{" "}
          credential.
        </p>
      )}
      <div
        className="stack"
        role="radiogroup"
        aria-labelledby="credential-type-label"
        style={{
          gap: "0.5rem",
          marginTop: "0.5rem",
          marginBottom: "1.25rem",
        }}
      >
        {TYPES.map(([key, m]) => {
          const on = selected === key;
          if (locked && key !== requiredClaim) return null;
          const visibleTypes = locked
            ? TYPES.filter(([k]) => k === requiredClaim)
            : TYPES;
          return (
            <div
              key={key}
              ref={(el) => {
                radioRefs.current[key] = el;
              }}
              onClick={() => {
                if (!locked) setSelected(key);
              }}
              onKeyDown={(e) => {
                if (locked) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(key);
                } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const i = visibleTypes.findIndex(([k]) => k === key);
                  const [nextKey] =
                    visibleTypes[(i + 1) % visibleTypes.length];
                  setSelected(nextKey);
                  radioRefs.current[nextKey]?.focus();
                } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const i = visibleTypes.findIndex(([k]) => k === key);
                  const [prevKey] =
                    visibleTypes[
                      (i - 1 + visibleTypes.length) % visibleTypes.length
                    ];
                  setSelected(prevKey);
                  radioRefs.current[prevKey]?.focus();
                }
              }}
              role="radio"
              aria-checked={on}
              aria-label={m.title}
              tabIndex={on ? 0 : -1}
              style={{
                padding: "0.75rem 0.9rem",
                borderRadius: "var(--radius)",
                border: `1px solid ${on ? "rgba(62,207,142,0.4)" : "var(--border)"}`,
                background: on ? "rgba(62,207,142,0.05)" : "transparent",
                cursor: locked ? "default" : "pointer",
                transition:
                  "border-color 0.2s var(--ease), background 0.2s var(--ease)",
              }}
            >
              <div className="between" style={{ alignItems: "center" }}>
                <span className="row" style={{ gap: "0.6rem" }}>
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      display: "grid",
                      placeItems: "center",
                      border: `2px solid ${on ? "var(--accent)" : "var(--border)"}`,
                      flexShrink: 0,
                    }}
                  >
                    {on && (
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "var(--accent)",
                        }}
                      />
                    )}
                  </span>
                  <span style={{ fontWeight: 500, fontSize: "0.9rem" }}>
                    {m.title}
                  </span>
                </span>
                <span
                  className="mono faint"
                  style={{ fontSize: "0.72rem" }}
                >
                  {key === "funds" && claimParamsFromUrl.threshold
                    ? `balance > $${Number(claimParamsFromUrl.threshold).toLocaleString("en-US")}`
                    : key === "age" && claimParamsFromUrl.threshold_years
                      ? `age ≥ ${claimParamsFromUrl.threshold_years}`
                      : key === "income" && claimParamsFromUrl.threshold
                        ? `income > $${Number(claimParamsFromUrl.threshold).toLocaleString("en-US")}`
                        : key === "accreditation" &&
                            claimParamsFromUrl.threshold
                          ? `net worth ≥ $${Number(claimParamsFromUrl.threshold).toLocaleString("en-US")}`
                          : key === "employment" &&
                              claimParamsFromUrl.threshold
                            ? `seniority ≥ ${claimParamsFromUrl.threshold} yrs`
                            : m.claim}
                </span>
              </div>

              {on && key === "kyc" && (
                <p
                  className="faint"
                  style={{ fontSize: "0.75rem", margin: "0.5rem 0 0" }}
                >
                  You&rsquo;ll be taken to a secure identity verification flow.
                  No personal data is stored by StellarCred.
                </p>
              )}
              {on && key === "age" && (
                <div
                  style={{ marginTop: "0.75rem" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <label
                    className="field-label"
                    htmlFor="attr-date-of-birth"
                  >
                    {m.attribute}
                  </label>
                  <input
                    id="attr-date-of-birth"
                    type="date"
                    value={attributes.date_of_birth}
                    onChange={(e) =>
                      setAttr("date_of_birth", e.target.value)
                    }
                  />
                </div>
              )}
              {on && key === "income" && (
                <div
                  style={{ marginTop: "0.75rem" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <label className="field-label" htmlFor="attr-income">
                    {m.attribute}
                  </label>
                  <input
                    id="attr-income"
                    type="number"
                    value={attributes.income}
                    onChange={(e) => setAttr("income", e.target.value)}
                  />
                </div>
              )}
              {on && key === "accreditation" && (
                <div
                  style={{ marginTop: "0.75rem" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <label
                    className="field-label"
                    htmlFor="attr-net-worth"
                  >
                    {m.attribute}
                  </label>
                  <input
                    id="attr-net-worth"
                    type="number"
                    value={attributes.net_worth}
                    onChange={(e) => setAttr("net_worth", e.target.value)}
                  />
                </div>
              )}
              {on && key === "funds" && (
                <div
                  style={{ marginTop: "0.75rem" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <PlaidBalanceWidget
                    plaidBalance={plaidBalance}
                    plaidAccounts={plaidAccounts}
                    plaidSources={plaidSources}
                    plaidMock={plaidMock}
                    threshold={claimParamsFromUrl.threshold}
                  />
                </div>
              )}
              {on && key === "jurisdiction" && (
                <div
                  style={{ marginTop: "0.75rem" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <label
                    className="field-label"
                    style={{ marginBottom: "0.35rem" }}
                  >
                    Mode
                  </label>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      marginBottom: "0.75rem",
                    }}
                  >
                    <button
                      type="button"
                      className={`btn btn-sm ${jurisdictionMode === "0" ? "btn-primary" : "btn-outline"}`}
                      style={{
                        flex: 1,
                        fontSize: "0.78rem",
                        padding: "0.4rem 0.75rem",
                      }}
                      onClick={() => setJurisdictionMode("0")}
                    >
                      Block countries
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${jurisdictionMode === "1" ? "btn-primary" : "btn-outline"}`}
                      style={{
                        flex: 1,
                        fontSize: "0.78rem",
                        padding: "0.4rem 0.75rem",
                      }}
                      onClick={() => setJurisdictionMode("1")}
                    >
                      Allow countries
                    </button>
                  </div>
                  <label
                    className="field-label"
                    htmlFor="attr-country-code"
                  >
                    {m.attribute}
                  </label>
                  <select
                    id="attr-country-code"
                    value={attributes.country_code}
                    onChange={(e) =>
                      setAttr("country_code", e.target.value)
                    }
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>
                  <p
                    className="faint"
                    style={{ fontSize: "0.72rem", margin: "0.35rem 0 0" }}
                  >
                    {jurisdictionMode === "0"
                      ? "Proves your country is NOT in the restricted list — your country is never revealed on-chain."
                      : "Proves your country IS in the allowed list — your country is never revealed on-chain."}
                  </p>
                </div>
              )}
              {on && key === "employment" && (
                <div
                  style={{ marginTop: "0.75rem" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <label
                    className="field-label"
                    htmlFor="attr-seniority"
                  >
                    {m.attribute}
                  </label>
                  <input
                    id="attr-seniority"
                    type="number"
                    value={attributes.seniority}
                    onChange={(e) =>
                      setAttr("seniority", e.target.value)
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

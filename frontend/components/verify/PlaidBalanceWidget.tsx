"use client";

import { IconBuildingBank, IconLoader2 } from "@tabler/icons-react";

export interface PlaidBalanceWidgetProps {
  plaidBalance: number | null;
  plaidAccounts: { name: string; available: number }[];
  plaidSources: number | null;
  plaidMock: boolean;
  threshold?: string;
}

export function PlaidBalanceWidget({
  plaidBalance,
  plaidAccounts,
  plaidSources,
  plaidMock,
  threshold,
}: PlaidBalanceWidgetProps) {
  if (plaidBalance === null) {
    return (
      <p
        className="faint"
        style={{
          fontSize: "0.75rem",
          margin: 0,
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
        }}
      >
        <IconLoader2 size={12} className="spin" />
        Reading balance from Plaid…
      </p>
    );
  }

  return (
    <div
      style={{
        padding: "0.65rem 0.9rem",
        borderRadius: "var(--radius)",
        background: "rgba(62,207,142,0.05)",
        border: "1px solid rgba(62,207,142,0.2)",
      }}
    >
      <div
        className="between"
        style={{
          alignItems: "center",
          marginBottom: plaidAccounts.length > 1 ? "0.5rem" : 0,
        }}
      >
        <span
          className="row"
          style={{
            gap: "0.4rem",
            fontSize: "0.75rem",
            color: "var(--faint)",
          }}
        >
          <IconBuildingBank size={12} stroke={1.6} />
          {plaidMock
            ? "Mock balance"
            : plaidSources && plaidSources > 1
              ? `Aggregate balance — ${plaidSources} linked sources`
              : "Verified balance (Plaid)"}
        </span>
        <span
          style={{
            fontWeight: 600,
            fontSize: "1rem",
            color: "var(--text)",
          }}
        >
          ${plaidBalance.toLocaleString("en-US")}
        </span>
      </div>
      {plaidAccounts.length > 1 && (
        <div className="stack" style={{ gap: "0.2rem" }}>
          {plaidAccounts.map((a, i) => (
            <div
              key={`${a.name}-${i}`}
              className="between"
              style={{ fontSize: "0.72rem" }}
            >
              <span className="faint">{a.name}</span>
              <span className="mono" style={{ color: "var(--muted)" }}>
                ${a.available.toLocaleString("en-US")}
              </span>
            </div>
          ))}
        </div>
      )}
      <hr
        style={{
          margin: "0.5rem 0",
          borderColor: "rgba(62,207,142,0.15)",
        }}
      />
      <div className="between" style={{ alignItems: "center" }}>
        <span className="faint" style={{ fontSize: "0.72rem" }}>
          Proof will certify
        </span>
        <span
          style={{
            fontSize: "0.8rem",
            fontWeight: 500,
            color: "var(--accent)",
          }}
        >
          balance ≥ ${Number(threshold ?? "10000").toLocaleString("en-US")}
        </span>
      </div>
      <p
        className="faint"
        style={{
          fontSize: "0.72rem",
          margin: "0.35rem 0 0",
        }}
      >
        Balances from all linked accounts are summed before attestation. The
        aggregate — not any individual account — is committed, and only this
        threshold is ever public.
      </p>
    </div>
  );
}

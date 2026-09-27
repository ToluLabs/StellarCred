"use client";

// PrivacyIndicator — inline, non-intrusive disclosure of what happens locally
// vs what is sent during the issue and prove flows (#533).
//
// Design goals:
//  • Collapsed by default — one line, non-alarming, informational.
//  • Expandable to a step-by-step breakdown of each data movement.
//  • Accurate: the steps here are derived from the actual call sites:
//      prove flow  → lib/proof.ts (computeWitness → /api/witness, proveWithBackend → browser WASM)
//      issue flow  → app/api/issue/route.ts (Persona for kyc, Plaid for funds, then commitment signing)
//  • Stays accurate as flows change: each variant maps 1-to-1 to a call site.

import { useState } from "react";
import { IconShieldLock, IconChevronDown, IconChevronUp } from "@tabler/icons-react";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single step in the privacy breakdown. */
interface PrivacyStep {
  /** Short label shown in the collapsed pill and the expanded row heading. */
  label: string;
  /** Where this step executes. */
  where: "local" | "server" | "chain";
  /** What exactly is transmitted (for server/chain steps) or processed (local). */
  what: string;
  /** Longer clarification shown only in expanded state. */
  detail?: string;
}

export type PrivacyVariant =
  /** Used on the holder /prove flow. */
  | "prove"
  /** Used on the issuer /issue flow.  Pass credentialType so Persona/Plaid
   *  steps are included only when they are actually called. */
  | { variant: "issue"; credentialType: "kyc" | "funds" | "other" };

// ── Step definitions — derived from actual call sites ─────────────────────────

function proveSteps(): PrivacyStep[] {
  return [
    {
      label: "Witness generation",
      where: "server",
      what: "Credential data (private inputs) sent to /api/witness",
      detail:
        "Your credential's private values (value, salt, signature) are sent to the StellarCred server to execute the Noir circuit and compute the ACVM witness. The server never stores them.",
    },
    {
      label: "ZK proof generation",
      where: "local",
      what: "WASM proving runs entirely in your browser",
      detail:
        "UltraHonk proving (bb.js) runs locally in browser WASM using the witness from the previous step. Your private inputs never leave your device during this step.",
    },
    {
      label: "On-chain submission",
      where: "chain",
      what: "Proof bytes + public inputs sent to Stellar ProofRegistry",
      detail:
        "Only the proof (456 field elements) and public inputs (commitment hash, issuer public key, credential type, expiry) are written on-chain. The private value and salt are never included.",
    },
  ];
}

function issueSteps(credentialType: "kyc" | "funds" | "other"): PrivacyStep[] {
  const steps: PrivacyStep[] = [];

  if (credentialType === "kyc") {
    steps.push({
      label: "Identity verification",
      where: "server",
      what: "Holder redirected to Persona for KYC — StellarCred does not receive your documents",
      detail:
        "The KYC check is handled by Persona (a third-party identity provider). StellarCred only receives a verified status and the minimal attributes needed to issue the credential (e.g. date of birth, country). Documents and photos are handled entirely by Persona.",
    });
  }

  if (credentialType === "funds") {
    steps.push({
      label: "Balance check",
      where: "server",
      what: "Account balance fetched from Plaid — only the numeric amount is used",
      detail:
        "Plaid retrieves your account balance. StellarCred's issuance server reads only the numeric balance and does not retain your bank credentials, account number, or transaction history.",
    });
  }

  steps.push(
    {
      label: "Commitment",
      where: "server",
      what: "Poseidon2 hash of (value, salt) computed server-side",
      detail:
        "The credential value and a random salt are hashed together with Poseidon2. Only the commitment hash is stored in the issued credential — the raw value and salt stay inside the credential JSON on your device.",
    },
    {
      label: "Credential signing",
      where: "server",
      what: "Issuer signs the commitment with Ed25519 — no value leaves the server",
      detail:
        "The issuer's private key signs the commitment. The signature is included in the credential JSON returned to you. The private key and the raw attribute value never leave the server.",
    },
    {
      label: "Credential stored locally",
      where: "local",
      what: "Signed credential saved in your browser's localStorage — nothing goes on-chain yet",
      detail:
        "The credential JSON (commitment, salt, value, signature) is stored only in this browser's localStorage. It is not uploaded anywhere. Proving is a separate step that you initiate.",
    },
  );

  return steps;
}

// ── Where-badge colour map ────────────────────────────────────────────────────

const WHERE_STYLE: Record<
  PrivacyStep["where"],
  { bg: string; color: string; label: string }
> = {
  local: {
    bg: "rgba(62,207,142,0.12)",
    color: "var(--accent, #3ecf8e)",
    label: "In browser",
  },
  server: {
    bg: "rgba(99,179,237,0.12)",
    color: "#63b3ed",
    label: "StellarCred server",
  },
  chain: {
    bg: "rgba(167,139,250,0.12)",
    color: "#a78bfa",
    label: "Stellar blockchain",
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

interface PrivacyIndicatorProps {
  variant: PrivacyVariant;
  /** Additional container styles. */
  style?: React.CSSProperties;
}

export function PrivacyIndicator({ variant, style }: PrivacyIndicatorProps) {
  const [open, setOpen] = useState(false);

  const steps =
    variant === "prove"
      ? proveSteps()
      : issueSteps(
          (variant as { variant: "issue"; credentialType: "kyc" | "funds" | "other" })
            .credentialType,
        );

  // Count server steps to determine the collapsed summary text.
  const serverCount = steps.filter((s) => s.where === "server").length;

  const summaryText =
    variant === "prove"
      ? "Proof generated locally — only proof bytes go on-chain, never your data"
      : serverCount === 0
        ? "Credential stored locally — nothing sent until you prove"
        : "Commitment computed server-side — your raw value is never transmitted";

  return (
    <div
      style={{
        borderRadius: "var(--radius, 8px)",
        border: "1px solid var(--border, rgba(255,255,255,0.08))",
        overflow: "hidden",
        fontSize: "0.8rem",
        ...style,
      }}
      role="region"
      aria-label="Privacy summary"
    >
      {/* ── Collapsed pill / toggle ── */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "0.55rem",
          padding: "0.55rem 0.85rem",
          background: "rgba(62,207,142,0.06)",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: "inherit",
        }}
      >
        <IconShieldLock
          size={14}
          style={{ color: "var(--accent, #3ecf8e)", flexShrink: 0 }}
          aria-hidden="true"
        />
        <span
          style={{
            flex: 1,
            fontSize: "0.775rem",
            color: "var(--muted, #94a3b8)",
            lineHeight: 1.4,
          }}
        >
          {summaryText}
        </span>
        <span
          style={{
            fontSize: "0.68rem",
            color: "var(--accent, #3ecf8e)",
            display: "flex",
            alignItems: "center",
            gap: "0.2rem",
            flexShrink: 0,
            opacity: 0.8,
          }}
        >
          {open ? (
            <>
              Less <IconChevronUp size={11} aria-hidden="true" />
            </>
          ) : (
            <>
              Details <IconChevronDown size={11} aria-hidden="true" />
            </>
          )}
        </span>
      </button>

      {/* ── Expanded step list ── */}
      {open && (
        <div
          style={{
            padding: "0.75rem 0.85rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.65rem",
            background: "var(--surface, rgba(255,255,255,0.02))",
            borderTop: "1px solid var(--border, rgba(255,255,255,0.06))",
          }}
        >
          {/* Legend */}
          <div
            style={{
              display: "flex",
              gap: "0.85rem",
              flexWrap: "wrap",
              marginBottom: "0.1rem",
            }}
            role="list"
            aria-label="Legend"
          >
            {(Object.entries(WHERE_STYLE) as [PrivacyStep["where"], typeof WHERE_STYLE[keyof typeof WHERE_STYLE]][]).map(
              ([key, s]) => (
                <span
                  key={key}
                  role="listitem"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    fontSize: "0.68rem",
                    color: s.color,
                    background: s.bg,
                    borderRadius: 999,
                    padding: "0.15rem 0.5rem",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: s.color,
                      flexShrink: 0,
                    }}
                    aria-hidden="true"
                  />
                  {s.label}
                </span>
              ),
            )}
          </div>

          {/* Steps */}
          {steps.map((step, idx) => {
            const ws = WHERE_STYLE[step.where];
            return (
              <div
                key={idx}
                style={{
                  display: "flex",
                  gap: "0.7rem",
                  alignItems: "flex-start",
                }}
              >
                {/* Step number */}
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: ws.bg,
                    color: ws.color,
                    fontSize: "0.65rem",
                    fontWeight: 700,
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                  aria-hidden="true"
                >
                  {idx + 1}
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Step heading row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.45rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: "0.8rem", lineHeight: 1.3 }}>
                      {step.label}
                    </span>
                    <span
                      style={{
                        fontSize: "0.65rem",
                        color: ws.color,
                        background: ws.bg,
                        borderRadius: 999,
                        padding: "0.1rem 0.4rem",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {ws.label}
                    </span>
                  </div>

                  {/* What is transmitted */}
                  <p
                    style={{
                      margin: "0.2rem 0 0",
                      fontSize: "0.755rem",
                      color: "var(--muted, #94a3b8)",
                      lineHeight: 1.5,
                    }}
                  >
                    {step.what}
                  </p>

                  {/* Optional detail */}
                  {step.detail && (
                    <p
                      style={{
                        margin: "0.2rem 0 0",
                        fontSize: "0.72rem",
                        color: "var(--faint, #64748b)",
                        lineHeight: 1.5,
                      }}
                    >
                      {step.detail}
                    </p>
                  )}
                </div>
              </div>
            );
          })}

          {/* Footer note */}
          <p
            style={{
              margin: "0.15rem 0 0",
              fontSize: "0.7rem",
              color: "var(--faint, #64748b)",
              lineHeight: 1.5,
              paddingTop: "0.35rem",
              borderTop: "1px solid var(--border, rgba(255,255,255,0.05))",
            }}
          >
            {variant === "prove"
              ? "The credential value and salt are used only to generate the witness server-side and are never logged or stored by StellarCred."
              : "The raw credential value and salt are never transmitted beyond the issuance server and are never written to a database."}
          </p>
        </div>
      )}
    </div>
  );
}

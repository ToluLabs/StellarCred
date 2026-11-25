"use client";

/**
 * LedgerGuide — the in-app visual guide for hardware-wallet credential
 * management (issue #1040).
 *
 * Two things were uninformative about signing with a Ledger: the device's
 * screens (a Soroban invocation is presented as a bare hash) and the errors
 * when the USB session dropped. This panel states, in the same order the
 * device walks through them, the derivation path that produces the account,
 * the derivation chain down to the G… address, and every field that makes up
 * the signature — plus a live review of an envelope when one is supplied, so
 * the hash on the device can be compared with the hash StellarCred computed.
 *
 * Pure presentation: all facts come from lib/ledger-guide.ts and
 * lib/ledger-review.ts (type-only here, so no stellar-sdk in this chunk).
 */

import {
  IconUsb,
  IconKey,
  IconEye,
  IconRefresh,
  IconShieldLock,
  IconAlertTriangle,
} from "@tabler/icons-react";
import {
  BLIND_SIGNING_FIELDS,
  LEDGER_COIN_TYPE,
  LEDGER_DEFAULT_PATH,
  LEDGER_DISCONNECT_STEPS,
  LEDGER_SETUP_STEPS,
  derivationSteps,
  deriveLedgerPath,
} from "@/lib/ledger-guide";
import type { LedgerReview } from "@/lib/ledger-review";

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.45rem",
};

const numberBadgeStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 18,
  height: 18,
  borderRadius: "50%",
  border: "1px solid var(--border)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "0.65rem",
  fontFamily: "var(--font-mono), monospace",
  color: "var(--muted)",
};

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={sectionStyle}>
      <h4
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          fontSize: "0.82rem",
          margin: 0,
        }}
      >
        <span style={{ color: "var(--accent)", display: "inline-flex" }} aria-hidden="true">
          {icon}
        </span>
        {title}
      </h4>
      {description && (
        <p className="muted" style={{ fontSize: "0.78rem", lineHeight: 1.55, margin: 0 }}>
          {description}
        </p>
      )}
      {children}
    </section>
  );
}

function Steps({ steps, label }: { steps: readonly string[]; label: string }) {
  return (
    <ol
      aria-label={label}
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: "0.4rem",
      }}
    >
      {steps.map((step, i) => (
        <li key={step} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
          <span style={numberBadgeStyle} aria-hidden="true">
            {i + 1}
          </span>
          <span style={{ fontSize: "0.78rem", lineHeight: 1.55 }}>{step}</span>
        </li>
      ))}
    </ol>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
      <dt
        className="faint"
        style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em" }}
      >
        {label}
      </dt>
      <dd
        className="mono"
        style={{ fontSize: "0.75rem", margin: 0, lineHeight: 1.5, wordBreak: "break-all" }}
      >
        {children}
      </dd>
    </div>
  );
}

export function LedgerGuide({
  address,
  accountIndex = 0,
  review = null,
}: {
  /** The connected Ledger account, when one is connected. */
  address?: string;
  /** Account index used for the derivation shown (SEP-0005 default is 0). */
  accountIndex?: number;
  /** Live review of the envelope about to be signed, when available. */
  review?: LedgerReview | null;
}) {
  const path = deriveLedgerPath(accountIndex);

  return (
    <details
      className="card"
      style={{ padding: "1rem 1.25rem", marginBottom: "1.5rem" }}
      data-testid="ledger-guide"
    >
      <summary
        style={{
          cursor: "pointer",
          fontSize: "0.85rem",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
        }}
      >
        <IconUsb size={16} color="var(--accent)" aria-hidden="true" />
        Ledger hardware wallet guide
      </summary>

      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem", marginTop: "1rem" }}>
        <Section
          icon={<IconUsb size={14} />}
          title="1. Connect the Stellar app"
          description="StellarCred talks to the Stellar app directly over WebUSB. The device must stay unlocked and on the Stellar app for the whole session."
        >
          <Steps steps={LEDGER_SETUP_STEPS} label="Ledger connection steps" />
        </Section>

        <Section
          icon={<IconKey size={14} />}
          title="2. How your public key is derived"
          description={`Your Ledger derives the Stellar account from the hardened path m/${path}. Only the public key leaves the device; the private key never does.`}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {derivationSteps(accountIndex).map((step) => (
              <div
                key={step}
                className="mono"
                style={{ fontSize: "0.75rem", color: "var(--muted)", paddingLeft: "1.35rem" }}
              >
                {step}
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.25rem",
              padding: "0.6rem 0.75rem",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              marginTop: "0.2rem",
            }}
          >
            <div className="faint" style={{ fontSize: "0.7rem" }}>
              m/{path} → ed25519 public key (32 bytes) → StrKey G… address
            </div>
            {address ? (
              <div className="mono" style={{ fontSize: "0.72rem", wordBreak: "break-all" }}>
                {address}
              </div>
            ) : (
              <div className="muted" style={{ fontSize: "0.72rem" }}>
                Connect a Ledger to see the address this path produces.
              </div>
            )}
          </div>

          <p className="faint" style={{ fontSize: "0.72rem", lineHeight: 1.5, margin: 0 }}>
            The account index is hardened and part of the path: index 0 is the device&rsquo;s first
            Stellar account, and a credential issued to one index cannot be proven by another.
            StellarCred signs with {LEDGER_DEFAULT_PATH} unless a SEP-43 request names a different
            path. Coin type {LEDGER_COIN_TYPE} is Stellar&rsquo;s SEP-0005 assignment.
          </p>
        </Section>

        <Section
          icon={<IconEye size={14} />}
          title="3. What your Ledger shows when signing"
          description="These are the fields of the signature request. Compare them with the device before you approve."
        >
          <dl style={{ display: "flex", flexDirection: "column", gap: "0.6rem", margin: 0 }}>
            {review ? (
              <>
                <Field label="Network passphrase">{review.networkPassphrase}</Field>
                <Field label="Envelope hash (SHA-256)">{review.envelopeHash}</Field>
                <Field label="Derivation path">m/{path}</Field>
                <Field label="Fee (stroops)">{review.fee}</Field>
                <Field label="Sequence number">{review.sequence}</Field>
                <Field label="Operations">
                  {review.operationCount === 0
                    ? "none"
                    : `${review.operationCount} — ${review.operationTypes.join(", ")}`}
                </Field>
                {review.memo && <Field label="Memo">{review.memo}</Field>}
                {review.timeBounds && (
                  <Field label="Time bounds">
                    {review.timeBounds.minTime} – {review.timeBounds.maxTime}
                  </Field>
                )}
              </>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.55rem",
                  padding: "0.6rem 0.75rem",
                  border: "1px dashed var(--border)",
                  borderRadius: "var(--radius)",
                }}
              >
                {BLIND_SIGNING_FIELDS.map((f) => (
                  <div
                    key={f.label}
                    style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}
                  >
                    <span style={{ fontSize: "0.75rem", fontWeight: 600 }}>{f.label}</span>
                    <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.5 }}>
                      {f.detail}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </dl>

          {review?.blindSigning && (
            <div
              role="note"
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "flex-start",
                padding: "0.6rem 0.75rem",
                border: "1px solid rgba(232,176,75,0.35)",
                background: "rgba(232,176,75,0.07)",
                borderRadius: "var(--radius)",
              }}
            >
              <IconAlertTriangle
                size={14}
                style={{ color: "var(--warn, #e8b04b)", flexShrink: 0, marginTop: "0.1rem" }}
                aria-hidden="true"
              />
              <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                <span style={{ fontSize: "0.75rem", fontWeight: 600 }}>
                  Hash signing (blind signing)
                </span>
                {review.blindSigningReasons.map((reason) => (
                  <span
                    key={reason}
                    className="muted"
                    style={{ fontSize: "0.72rem", lineHeight: 1.5 }}
                  >
                    {reason}
                  </span>
                ))}
                <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.5 }}>
                  Confirm the hash on the device matches the envelope hash above — that hash covers
                  every field in this request.
                </span>
              </div>
            </div>
          )}

          {!review?.blindSigning && review && (
            <p className="faint" style={{ fontSize: "0.72rem", lineHeight: 1.5, margin: 0 }}>
              The Ledger Stellar app can render every operation in this envelope, so the device
              shows the operation details as well as the hash.
            </p>
          )}
        </Section>

        <Section
          icon={<IconRefresh size={14} />}
          title="4. If the device disconnects"
          description="A dropped USB session is not a failed credential: nothing is submitted until the signed envelope is returned, so reconnecting and retrying is safe."
        >
          <Steps steps={LEDGER_DISCONNECT_STEPS} label="Ledger reconnect steps" />
        </Section>

        <p
          className="faint"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "0.35rem",
            fontSize: "0.7rem",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          <IconShieldLock
            size={13}
            style={{ flexShrink: 0, marginTop: "0.1rem" }}
            aria-hidden="true"
          />
          StellarCred never asks for your recovery phrase and never sends your private key anywhere.
          Approving on the device is the only way a signature is produced.
        </p>
      </div>
    </details>
  );
}

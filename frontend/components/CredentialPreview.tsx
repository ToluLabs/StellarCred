"use client";

// Issuer-side credential preview (#617).
//
// Shown after the issuer fills in the form but before the "Sign & issue"
// button fires the POST /api/issue call. The preview lists every field that
// will be committed and signed so the issuer can verify — and go back to
// correct — before the signature is irrevocable.

import { IconArrowLeft, IconKey, IconAlertTriangle, IconShieldCheck } from "@tabler/icons-react";
import type { CredentialPreviewData } from "@/lib/credential-preview";
import { formatAttributeDisplay } from "@/lib/credential-preview";
import { truncateAddress } from "@/lib/format";

interface CredentialPreviewProps {
  data: CredentialPreviewData;
  /** Called when the issuer confirms and the POST /api/issue should fire. */
  onConfirm: () => void;
  /** Called when the issuer wants to go back and edit a field. */
  onBack: () => void;
  /** True while the POST /api/issue is in flight. */
  busy: boolean;
}

function PreviewRow({
  label,
  value,
  mono = false,
  muted = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: "1rem",
        padding: "0.6rem 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span
        style={{
          fontSize: "0.8125rem",
          color: "var(--faint)",
          flexShrink: 0,
          minWidth: 130,
        }}
      >
        {label}
      </span>
      <span
        className={mono ? "mono" : undefined}
        style={{
          fontSize: "0.8125rem",
          color: muted ? "var(--muted)" : "var(--text)",
          textAlign: "right",
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function CredentialPreview({
  data,
  onConfirm,
  onBack,
  busy,
}: CredentialPreviewProps) {
  const displayValue = formatAttributeDisplay(
    data.type,
    data.attributeValue ?? "",
    data.attributeLabel,
  );

  return (
    <div className="card reveal" style={{ maxWidth: 560, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: "1.25rem" }}>
        <span className="eyebrow" style={{ marginBottom: "0.4rem", display: "block" }}>
          Confirm before signing
        </span>
        <h2 style={{ fontSize: "1.35rem", margin: 0 }}>
          Review the attestation
        </h2>
        <p
          style={{
            fontSize: "0.8125rem",
            color: "var(--muted)",
            marginTop: "0.4rem",
            lineHeight: 1.55,
          }}
        >
          Once you sign, the commitment is irrevocable. Check every field
          before proceeding.
        </p>
      </div>

      {/* Fields */}
      <div
        style={{
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          padding: "0 1rem",
          marginBottom: "1.25rem",
        }}
      >
        <PreviewRow label="Credential type" value={data.title} />
        <PreviewRow label="Claim / threshold" value={data.claimLabel} />
        {data.attributeLabel && displayValue && (
          <PreviewRow label={data.attributeLabel} value={displayValue} />
        )}
        <PreviewRow label="Holder" value={data.holder} mono />
        <PreviewRow label="Issuer" value={data.issuerName} />
        <PreviewRow
          label="Issuer address"
          value={
            <span className="mono" title={data.issuerId}>
              {truncateAddress(data.issuerId)}
            </span>
          }
        />
        <PreviewRow label="Expiry" value={data.expiry} />
      </div>

      {/* Privacy notice */}
      <div
        style={{
          display: "flex",
          gap: "0.65rem",
          padding: "0.75rem 1rem",
          borderRadius: "var(--radius)",
          background: "rgba(255,255,255,0.025)",
          border: "1px solid var(--border)",
          marginBottom: "1.5rem",
        }}
      >
        <IconKey size={16} style={{ color: "var(--faint)", flexShrink: 0, marginTop: 1 }} />
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)", lineHeight: 1.55 }}>
          {data.attributeLabel
            ? <>
                This <strong style={{ color: "var(--text)" }}>{data.attributeLabel.toLowerCase()}</strong> is
                hashed into a Poseidon2 commitment. The issuance service stores
                only that commitment in its audit log, not the raw attribute.
                The signed credential retains proof material on the holder&apos;s
                device so they can later prove this claim.
              </>
            : <>
                A fresh random secret is hashed into a Poseidon2 commitment.
                The issuance service stores only that commitment in its audit
                log; the signed credential retains the proof material needed to
                prove the binary claim.
              </>}
        </p>
      </div>

      {/* Warning */}
      <div
        role="note"
        style={{
          display: "flex",
          gap: "0.65rem",
          padding: "0.75rem 1rem",
          borderRadius: "var(--radius)",
          background: "rgba(234,179,8,0.07)",
          border: "1px solid rgba(234,179,8,0.3)",
          marginBottom: "1.5rem",
        }}
      >
        <IconAlertTriangle size={16} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)", lineHeight: 1.55 }}>
          Signing is <strong style={{ color: "var(--text)" }}>irrevocable</strong>.
          A wrong threshold or expiry can only be fixed by revoking and
          re-issuing the credential. Use the Back button to correct any field.
        </p>
      </div>

      {/* Actions */}
      <div className="row" style={{ gap: "0.75rem" }}>
        <button
          className="btn btn-ghost"
          onClick={onBack}
          disabled={busy}
          style={{ gap: "0.4rem" }}
        >
          <IconArrowLeft size={14} />
          Back
        </button>
        <button
          className="btn btn-primary"
          style={{ flex: 1, gap: "0.5rem" }}
          onClick={onConfirm}
          disabled={busy}
          data-testid="confirm-sign-btn"
        >
          {busy ? (
            "Computing commitment…"
          ) : (
            <>
              <IconShieldCheck size={15} />
              Confirm &amp; sign
            </>
          )}
        </button>
      </div>
    </div>
  );
}

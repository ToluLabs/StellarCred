// Standalone invalid-link error screen for the /verify page. Extracted into its
// own component so it can be unit-tested independently and reused anywhere a
// malformed verification link needs a clear, actionable error state.

import { IconAlertTriangle } from "@tabler/icons-react";
import type { VerifyError } from "@/lib/verifyParams";

export function VerifyLinkError({ error, onBack }: { error: VerifyError; onBack: () => void }) {
  return (
    <div className="reveal" data-testid="verify-link-error" style={{ textAlign: "center", padding: "2rem 1rem" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: "rgba(240, 96, 77, 0.12)",
          marginBottom: "1rem",
        }}
      >
        <IconAlertTriangle size={24} color="var(--danger)" stroke={2.2} />
      </span>
      <div className="eyebrow" style={{ marginBottom: "0.4rem" }}>Verification link unavailable</div>
      <div data-testid="verify-error-title" style={{ fontWeight: 600, fontSize: "1.05rem", lineHeight: 1.4 }}>
        {error.title}
      </div>
      <p className="muted" style={{ fontSize: "0.875rem", lineHeight: 1.65, margin: "0.9rem auto 0", maxWidth: 400 }}>
        {error.detail}
      </p>
      <div className="row" style={{ justifyContent: "center", gap: "0.6rem", marginTop: "1.5rem" }}>
        <a href="/holder" className="btn btn-primary btn-sm">
          Go to your credentials
        </a>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          Back home
        </button>
      </div>
      <p className="faint" style={{ fontSize: "0.75rem", marginTop: "1.25rem" }}>
        You can also start a fresh verification from any app below.
      </p>
    </div>
  );
}

export default VerifyLinkError;
"use client";

import { IconCheck } from "@tabler/icons-react";

export interface VerifyDoneViewProps {
  requestingDomain?: string;
  urlError?: string;
}

export function VerifyDoneView({
  requestingDomain,
  urlError,
}: VerifyDoneViewProps) {
  const isVerifiedProtocol = Boolean(requestingDomain && !urlError);

  return (
    <div
      className="reveal"
      style={{ textAlign: "center", padding: "2rem 0" }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: "var(--accent-soft)",
          marginBottom: "1rem",
        }}
      >
        <IconCheck size={24} color="var(--accent)" stroke={2.5} />
      </span>
      <div style={{ fontWeight: 500 }}>
        {isVerifiedProtocol ? "Verified" : "Credential saved"}
      </div>
      <div
        className="muted"
        style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}
      >
        {isVerifiedProtocol
          ? `Returning to ${requestingDomain}…`
          : "Credential saved — redirecting to your wallet…"}
      </div>
    </div>
  );
}

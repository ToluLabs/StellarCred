"use client";

import { IconAlertTriangle } from "@tabler/icons-react";

/**
 * Expiry warning shown above the holder's credential list (#441): extracted
 * from HolderPageClient so the page shell stays under its line cap.
 */
export function ExpiryBanner({
  expiredCount,
  expiringSoonCount,
}: {
  expiredCount: number;
  expiringSoonCount: number;
}) {
  const hasExpired = expiredCount > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="card"
      style={{
        padding: "0.85rem 1.15rem",
        backgroundColor: hasExpired ? "rgba(239, 68, 68, 0.08)" : "rgba(234, 179, 8, 0.08)",
        borderColor: hasExpired ? "rgba(239, 68, 68, 0.3)" : "rgba(234, 179, 8, 0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        flexWrap: "wrap",
      }}
    >
      <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
        <IconAlertTriangle
          size={18}
          style={{
            color: hasExpired ? "var(--danger)" : "var(--warn)",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
          {hasExpired
            ? `${expiredCount} proof${expiredCount > 1 ? "s have" : " has"} expired and ${expiredCount > 1 ? "need" : "needs"} re-proving.`
            : `${expiringSoonCount} proof${expiringSoonCount > 1 ? "s are" : " is"} expiring within 7 days.`}
        </span>
      </div>
      <span className="mono faint" style={{ fontSize: "0.75rem" }}>
        One-click re-prove available below
      </span>
    </div>
  );
}

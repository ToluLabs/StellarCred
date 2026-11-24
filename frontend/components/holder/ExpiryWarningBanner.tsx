import { IconAlertTriangle } from "@tabler/icons-react";

type ExpiryWarningBannerProps = {
  /** Proofs proved and expiring within the warning window. */
  expiringCount: number;
  /** Proofs whose expiry has passed. */
  expiredCount: number;
};

/**
 * Summarises proofs that need re-proving before they stop verifying. Extracted
 * from HolderPageClient (#441) so the page shell stays under its size cap.
 */
export function ExpiryWarningBanner({ expiringCount, expiredCount }: ExpiryWarningBannerProps) {
  const expired = expiredCount > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="card"
      style={{
        padding: "0.85rem 1.15rem",
        backgroundColor: expired ? "rgba(239,68,68,0.08)" : "rgba(234,179,8,0.08)",
        borderColor: expired ? "rgba(239,68,68,0.3)" : "rgba(234,179,8,0.3)",
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
          style={{ color: expired ? "var(--danger)" : "var(--warn)", flexShrink: 0 }}
        />
        <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
          {expired
            ? `${expiredCount} proof${expiredCount > 1 ? "s have" : " has"} expired and ${
                expiredCount > 1 ? "need" : "needs"
              } re-proving.`
            : `${expiringCount} proof${expiringCount > 1 ? "s are" : " is"} expiring within 7 days.`}
        </span>
      </div>
      <span className="mono faint" style={{ fontSize: "0.75rem" }}>
        One-click re-prove available below
      </span>
    </div>
  );
}

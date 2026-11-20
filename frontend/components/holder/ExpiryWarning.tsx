import { IconAlertTriangle } from "@tabler/icons-react";

type ExpiryWarningProps = {
  expiredCount: number;
  expiringSoonCount: number;
};

export function ExpiryWarning({
  expiredCount,
  expiringSoonCount,
}: ExpiryWarningProps) {
  if (expiredCount === 0 && expiringSoonCount === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="card"
      style={{
        padding: "0.85rem 1.15rem",
        backgroundColor:
          expiredCount > 0 ? "rgba(239, 68, 68, 0.08)" : "rgba(234, 179, 8, 0.08)",
        borderColor:
          expiredCount > 0 ? "rgba(239, 68, 68, 0.3)" : "rgba(234, 179, 8, 0.3)",
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
            color: expiredCount > 0 ? "var(--danger)" : "var(--warn)",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
          {expiredCount > 0
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

"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { useWallet, WALLET_SESSION_GRACE_PERIOD_MS } from "@/lib/wallet-context";

export function WalletReconnectBanner() {
  const { address, sessionLostAt, connecting, connect } = useWallet();
  const t = useTranslations("wallet");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (sessionLostAt === null) return;
    const update = () => setNow(Date.now());
    update();
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [sessionLostAt]);

  if (!address || sessionLostAt === null) return null;

  const secondsRemaining = Math.max(
    0,
    Math.ceil((sessionLostAt + WALLET_SESSION_GRACE_PERIOD_MS - now) / 1_000),
  );
  const expired = secondsRemaining === 0;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="row"
      style={{
        gap: "0.75rem",
        padding: "0.7rem 1.5rem",
        borderBottom: "1px solid rgba(227, 179, 65, 0.3)",
        background: "rgba(227, 179, 65, 0.08)",
        fontSize: "0.8125rem",
        justifyContent: "center",
        flexWrap: "wrap",
      }}
    >
      <IconAlertTriangle
        size={16}
        style={{ color: "var(--warn)", flexShrink: 0 }}
        aria-hidden="true"
      />
      <span style={{ color: "var(--text)" }}>
        {expired ? t("sessionExpired") : t("sessionLost")}
      </span>
      {!expired && (
        <span className="mono faint" aria-live="off">
          {t("sessionCountdown", { seconds: secondsRemaining })}
        </span>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => void connect()}
        disabled={connecting}
        aria-label={connecting ? t("reconnecting") : t("reconnect")}
        style={{ fontSize: "0.75rem" }}
      >
        <IconRefresh size={13} aria-hidden="true" />
        {connecting ? t("reconnecting") : t("reconnect")}
      </button>
    </div>
  );
}

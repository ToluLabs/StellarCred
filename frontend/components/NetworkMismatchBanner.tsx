"use client";

import { useTranslations } from "next-intl";
import { IconAlertTriangle } from "@tabler/icons-react";
import { NETWORK } from "@/lib/stellar";

// Shown when the connected wallet's selected network doesn't match this app's
// configured network (testnet vs mainnet passphrase mismatch). The kit's
// `network` option only configures which network we sign/submit for — it
// can't switch the wallet extension's own selected network — so this is a
// user action, not something we can silently fix. `wallet-context.tsx` polls
// live so this clears itself the moment the user switches (Issue #214).
export function NetworkMismatchBanner() {
  const t = useTranslations();

  const networkLabel =
    NETWORK === "mainnet"
      ? t("network.mainnet")
      : NETWORK === "futurenet"
      ? t("network.futurenet")
      : t("network.testnet");

  return (
    <div
      className="row"
      role="alert"
      aria-live="polite"
      style={{
        gap: "0.6rem",
        padding: "0.7rem 1rem",
        marginBottom: "1.25rem",
        borderRadius: "var(--radius)",
        border: "1px solid rgba(240,96,77,0.3)",
        background: "rgba(240,96,77,0.06)",
        fontSize: "0.8125rem",
      }}
    >
      <IconAlertTriangle size={16} style={{ color: "var(--danger)", flexShrink: 0 }} aria-hidden="true" />
      <span>
        {t("network.mismatchBanner", { network: networkLabel })}
      </span>
    </div>
  );
}

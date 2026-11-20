"use client";

// Contextual re-entry nudge for /holder (#899).
// Shown when the user has a connected wallet but hasn't finished onboarding
// (generate-proof step or earlier). Dismisses persistently via localStorage.

import { useEffect, useState } from "react";
import { IconX, IconArrowRight } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { useOnboarding, ONBOARDING_STEPS } from "@/lib/onboarding";
import { useWallet } from "@/lib/wallet-context";
import { STORAGE_KEYS } from "@/lib/storage-keys";

export function OnboardingNudge() {
  const t = useTranslations("onboarding.nudge");
  const { state, mounted, resumeAt, currentStep } = useOnboarding();
  const { address } = useWallet();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED)) {
        setDismissed(true);
      }
    } catch {
      // storage unavailable
    }
  }, []);

  const stepIndex = ONBOARDING_STEPS.indexOf(currentStep);

  // Show when: mounted, onboarding not complete, wallet connected,
  // not dismissed, and user is on generate-proof step (index 4) or earlier.
  if (!mounted || state.completed || !address || dismissed || stepIndex > 4) {
    return null;
  }

  function handleDismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED, "1");
    } catch {
      // storage unavailable
    }
  }

  return (
    <div
      role="status"
      className="card between"
      style={{
        padding: "0.75rem 1rem",
        marginBottom: "1.25rem",
        borderColor: "rgba(232, 176, 75, 0.35)",
        background: "rgba(232, 176, 75, 0.07)",
        gap: "0.75rem",
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>
        {t("message")}
      </span>
      <div className="row" style={{ gap: "0.5rem" }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => resumeAt(4)}
        >
          {t("continueSetup")}
          <IconArrowRight size={13} />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleDismiss}
          aria-label={t("dismiss")}
        >
          <IconX size={13} />
        </button>
      </div>
    </div>
  );
}

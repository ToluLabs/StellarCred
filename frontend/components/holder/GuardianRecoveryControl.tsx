"use client";

import dynamic from "next/dynamic";
import { IconShieldLock } from "@tabler/icons-react";
import type { Credential } from "@/lib/credential";
import { useGuardianRecovery } from "@/lib/hooks/useGuardianRecovery";

const GuardianRecoveryModal = dynamic(
  () => import("./GuardianRecoveryModal").then((m) => m.GuardianRecoveryModal),
  { ssr: false },
);

export function GuardianRecoveryControl({
  hasCredentials,
  onRestored,
}: {
  hasCredentials: boolean;
  onRestored?: (credentials: Credential[]) => void;
}) {
  const { activeTab, open, close, handleRestored } = useGuardianRecovery(onRestored);

  return (
    <>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => open(hasCredentials ? "setup" : "recover")}
        title="Split encryption key among guardians with Shamir secret sharing, or recover credentials"
      >
        <IconShieldLock size={14} />
        Guardian recovery
      </button>
      {activeTab && (
        <GuardianRecoveryModal
          initialTab={activeTab}
          onClose={close}
          onRestored={handleRestored}
        />
      )}
    </>
  );
}

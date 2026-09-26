"use client";

import { useCallback, useState } from "react";
import type { Credential } from "../credential";

export type GuardianRecoveryTab = "setup" | "recover";

/**
 * Owns the holder-page lifecycle for the guardian recovery modal.
 * Recovery itself remains in the modal and lib/guardian; this hook only
 * coordinates opening, closing, and notifying the credential store owner.
 */
export function useGuardianRecovery(
  onRestored?: (credentials: Credential[]) => void,
) {
  const [activeTab, setActiveTab] = useState<GuardianRecoveryTab | null>(null);

  const open = useCallback((tab: GuardianRecoveryTab) => {
    setActiveTab(tab);
  }, []);

  const close = useCallback(() => {
    setActiveTab(null);
  }, []);

  const handleRestored = useCallback(
    (credentials: Credential[]) => {
      onRestored?.(credentials);
      close();
    },
    [close, onRestored],
  );

  return {
    activeTab,
    open,
    close,
    handleRestored,
  };
}

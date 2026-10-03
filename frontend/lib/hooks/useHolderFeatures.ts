import { useState, useCallback } from 'react';

export function useHolderFeatures() {
  const [expiryRemindersEnabled, setExpiryRemindersEnabled] = useState(true);
  const [isSimulatingPreflight, setIsSimulatingPreflight] = useState(false);
  const [proofCacheStatus, setProofCacheStatus] = useState<'idle' | 'cached' | 'syncing'>('idle');

  // Expiry reminders logic
  const toggleExpiryReminders = useCallback(() => {
    setExpiryRemindersEnabled((prev) => !prev);
  }, []);

  // Preflight simulation logic
  const runPreflightSimulation = useCallback(async () => {
    setIsSimulatingPreflight(true);
    try {
      // Simulate transaction preflight check
      await new Promise((resolve) => setTimeout(resolve, 800));
    } finally {
      setIsSimulatingPreflight(false);
    }
  }, []);

  return {
    expiryRemindersEnabled,
    toggleExpiryReminders,
    isSimulatingPreflight,
    runPreflightSimulation,
    proofCacheStatus,
    setProofCacheStatus,
  };
}
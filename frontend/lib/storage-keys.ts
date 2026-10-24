/**
 * Central enumeration of all StellarCred localStorage keys.
 * 
 * Every feature that persists state should be listed here so that:
 * 1. The data wipe flow (#558) can remove everything without orphaning keys
 * 2. New storage features are caught at review time
 * 3. Cross-tab sync and migration logic can discover all keys in one place
 * 
 * Rules:
 * - Add new storage keys here when adding features that persist to localStorage
 * - Update the JSDoc when keys are deprecated or change semantics
 * - Never remove an entry — mark it deprecated instead, so old data can still be cleaned
 */

/**
 * All localStorage keys used by StellarCred, organized by category.
 */
export const STORAGE_KEYS = {
  /** Encrypted credential wallet (lib/credential.ts) */
  CREDENTIALS: "stellarcred:credentials",

  /** Per-field PII visibility preferences for credential exports */
  EXPORT_VISIBILITY: "stellarcred:export-visibility",

  /** Local proof cache for performance optimization (lib/proof-cache.ts) */
  PROOF_CACHE: "stellarcred:proof-cache",

  /** 
   * Proof timeline events per credential (lib/useProofTimeline.ts).
   * Actual keys are `proofTimeline:{commitment}` — use {@link getTimelineKeys} 
   * to enumerate them dynamically.
   */
  PROOF_TIMELINE_PREFIX: "proofTimeline:",

  /** Onboarding wizard state (lib/onboarding.ts) */
  ONBOARDING: "stellarcred:onboarding",

  /** Legacy onboarding flag (lib/onboarding.ts) — migrated to ONBOARDING */
  ONBOARDING_LEGACY: "stellarcred_onboarding_seen",

  /** Connected wallet identifier for session restore (lib/wallet-context.tsx) */
  WALLET_ID: "stellarcred:wallet-id",

  /** User theme preference: "light" | "dark" (lib/theme.ts) */
  THEME: "theme",
} as const;

/**
 * Enumerate all timeline keys currently in localStorage.
 * Timeline keys are per-credential: `proofTimeline:{commitment}`.
 */
export function getTimelineKeys(): string[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_KEYS.PROOF_TIMELINE_PREFIX)) {
        keys.push(key);
      }
    }
  } catch {
    // localStorage unavailable (private mode) — return empty
  }
  return keys;
}

/**
 * Get all storage keys currently in use (including dynamic timeline keys).
 * Use this to iterate over everything StellarCred has written to localStorage.
 */
export function getAllStorageKeys(): string[] {
  return [
    STORAGE_KEYS.CREDENTIALS,
    STORAGE_KEYS.EXPORT_VISIBILITY,
    STORAGE_KEYS.PROOF_CACHE,
    STORAGE_KEYS.ONBOARDING,
    STORAGE_KEYS.ONBOARDING_LEGACY,
    STORAGE_KEYS.WALLET_ID,
    STORAGE_KEYS.THEME,
    ...getTimelineKeys(),
  ];
}

/**
 * Type-safe check for whether a key is managed by StellarCred.
 */
export function isStellarCredKey(key: string): boolean {
  return (
    Object.values(STORAGE_KEYS).some((k) => k === key) ||
    key.startsWith(STORAGE_KEYS.PROOF_TIMELINE_PREFIX)
  );
}

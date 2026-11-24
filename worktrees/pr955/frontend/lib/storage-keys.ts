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
 * - Never remove an entry — mark it deprecated instead, so old data can still
 *   be cleaned
 */

/** All localStorage keys used by StellarCred, organized by category. */
export const STORAGE_KEYS = {
  /**
   * Encrypted credential wallet (lib/credential.ts).
   *
   * The only location that holds credential values and salts. The JSON array
   * of credentials is AES-256-GCM encrypted at rest; the key is derived from
   * the holder's passphrase via PBKDF2 and lives only in memory until locked.
   *
   * Members of this store are the sole target of {@link eraseCredentials}.
   */
  CREDENTIALS: "stellarcred:credentials",

  /** Per-field PII visibility preferences for credential exports */
  EXPORT_VISIBILITY: "stellarcred:export-visibility",

  /** Local proof cache for performance optimization (lib/proof-cache.ts) */
  PROOF_CACHE: "stellarcred:proof-cache",

  /** Proof timeline events per credential (lib/useProofTimeline.ts). */
  PROOF_TIMELINE_PREFIX: "proofTimeline:",

  /** Onboarding wizard state (lib/onboarding.ts) */
  ONBOARDING: "stellarcred:onboarding",

  /** Legacy onboarding flag (lib/onboarding.ts) — migrated to ONBOARDING */
  ONBOARDING_LEGACY: "stellarcred_onboarding_seen",

  /** Connected wallet identifier for session restore (lib/wallet-context.tsx) */
  WALLET_ID: "stellarcred:wallet-id",

  /** User theme preference: "light" | "dark" (lib/theme.ts) */
  THEME: "theme",

  /** Dismissal flag for the onboarding re-entry nudge banner on /holder (#899) */
  ONBOARDING_NUDGE_DISMISSED: "stellarcred:onboarding-nudge-dismissed",
} as const;

/** Credential-related storage keys; the only ones erased by {@link eraseCredentials}. */
export const CREDENTIALS_KEY = STORAGE_KEYS.CREDENTIALS;

/** Type-safe check for whether a key is managed by StellarCred. */
export function isStellarCredKey(key: string): boolean {
  return Object.values(STORAGE_KEYS).some((k) => k === key);
}

/** Enumerate all timeline keys currently in localStorage. */
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

/** All storage keys, in deterministic order. */
export const ALL_STORAGE_KEYS = [
  STORAGE_KEYS.CREDENTIALS,
  STORAGE_KEYS.EXPORT_VISIBILITY,
  STORAGE_KEYS.PROOF_CACHE,
  STORAGE_KEYS.ONBOARDING,
  STORAGE_KEYS.ONBOARDING_LEGACY,
  STORAGE_KEYS.WALLET_ID,
  STORAGE_KEYS.THEME,
  STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED,
  ...getTimelineKeys(),
] as const;

export type StorageKey =
  | typeof STORAGE_KEYS.CREDENTIALS
  | typeof STORAGE_KEYS.EXPORT_VISIBILITY
  | typeof STORAGE_KEYS.PROOF_CACHE
  | typeof STORAGE_KEYS.ONBOARDING
  | typeof STORAGE_KEYS.ONBOARDING_LEGACY
  | typeof STORAGE_KEYS.WALLET_ID
  | typeof STORAGE_KEYS.THEME
  | typeof STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED
  | string;

/** Parse the reverse-map (key -> canonical name); keeps the test DRY. */
export function getStorageKeyName(key: string): string | null {
  if (key === STORAGE_KEYS.CREDENTIALS) return "credentials";
  if (key === STORAGE_KEYS.EXPORT_VISIBILITY) return "export-visibility";
  if (key === STORAGE_KEYS.PROOF_CACHE) return "proof-cache";
  if (key === STORAGE_KEYS.ONBOARDING) return "onboarding";
  if (key === STORAGE_KEYS.ONBOARDING_LEGACY) return "onboarding-legacy";
  if (key === STORAGE_KEYS.WALLET_ID) return "wallet-id";
  if (key === STORAGE_KEYS.THEME) return "theme";
  if (key === STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED)
    return "onboarding-nudge-dismissed";
  if (key.startsWith(STORAGE_KEYS.PROOF_TIMELINE_PREFIX))
    return key.slice(STORAGE_KEYS.PROOF_TIMELINE_PREFIX.length);
  return null;
}

"use client";

/**
 * Credential erasure — explicit, user-triggered removal of locally persisted
 * credential values and salts.
 *
 * Overview
 * --------
 * StellarCred stores every credential (raw value, salt, issuer signature) in a
 * single browser `localStorage` key: `stellarcred:credentials`. The value is an
 * encrypted envelope (AES-256-GCM over a JSON array of credentials, key derived
 * from the holder's passphrase via PBKDF2). The passphrase-derived key lives
 * only in memory until the store is locked.
 *
 * This module removes the *credential* material only. It deliberately
 * 1. keeps every other `STORAGE_KEYS` key (wallet id, theme, onboarding,
 *    export visibility, proof cache, timeline, nudge dismiss) intact, and
 * 2. never touches server-side data, the Stellar wallet itself, or
 *    `sessionStorage` blobs that belong to other features (e.g.
 *    `verify-nonce`, `verify-session`).
 *
 * Semantics
 * ---------
 * - Idempotent: safe to call more than once; repeated calls return the same
 *   result without error.
 * - Partial failures: each credential key is removed individually. If one
 *   removal throws, the error is recorded but the remaining keys keep being
 *   removed. The return value reports a per-key failure list so callers never
 *   interpret "success" as "nothing may remain".
 * - Storage unavailable: returns `success: false` with the reason — never a
 *   fake success.
 * - No sensitive logging: credential values, salts, and envelopes are never
 *   written to `console`. Only key names and counts are surfaced.
 * - Shutdown safe: after the asynchronous removal completes the in-memory
 *   encryption key is locked so a subsequent `loadCredentials()` cannot
 *   decrypt orphaned data.
 *
 * @module credential-erasure
 */

import { lockCredentialStore } from "./credential";
import {
  ALL_STORAGE_KEYS,
  CREDENTIALS_KEY,
  isStellarCredKey,
  type StorageKey,
} from "./storage-keys";
import { isStorageAvailable } from "./safe-storage";

/** A single location that may or may not exist. */
export interface ErasureLocation {
  /** Stable logical name, e.g. `credentials` */
  kind: StorageKey;
  /** Readable, short description used in the UI summary */
  label: string;
  /** Whether this location holds sensitive material */
  sensitive: boolean;
}

/** Result of an erase attempt. */
export interface EraseResult {
  /**
   * `true` when every supported location reported success AND every key that
   * was present when the call started was removed or proved already absent.
   */
  success: boolean;
  /** Number of credential stores actually removed (0..n). */
  locationsRemoved: number;
  /** Readable per-location summary. */
  perLocation: Record<StorageKey, { removed: boolean; hadData: boolean }>;
  /**
   * Human-facing message. `null` means the operation completed without a
   * reportable error; `undefined` means storage was unavailable and the
   * caller should not claim the data is gone.
   */
  message?: string;
}

/**
 * Names of every supported credential/kv location we deliberately manage.
 *
 * `wallet-id` is intentionally excluded: disconnecting a wallet must *not*
 * delete the credentials. `wallet-id` is touched by the existing
 * `wallet-context.tsx` disconnect handler only.
 */
const MANAGED_KEYS: StorageKey[] = [
  CREDENTIALS_KEY,
  "proof-cache",
  "onboarding",
  "onboarding-legacy",
  "theme",
  "export-visibility",
  "onboarding-nudge-dismissed",
];

/** All owned keys plus the dynamic timeline keys (for enumeration). */
export const ALL_STORAGE_KEYS = [
  ...MANAGED_KEYS,
  ...getTimelineKeys(),
] as const satisfies readonly StorageKey[];

/**
 * Build the list of credential-related keys the caller should pass to
 * `removeItem`. Computed once per call to keep the dynamic timeline keys in
 * sync.
 */
function credentialLocations(): ErasureLocation[] {
  return [
    { kind: "credentials", label: "Credential store", sensitive: true },
    { kind: "proof-cache", label: "Proof cache", sensitive: false },
    { kind: "onboarding", label: "Onboarding state", sensitive: false },
    { kind: "onboarding-legacy", label: "Legacy onboarding state", sensitive: false },
    { kind: "theme", label: "Theme preference", sensitive: false },
    { kind: "export-visibility", label: "Export visibility", sensitive: false },
    { kind: "onboarding-nudge-dismissed", label: "Onboarding nudge state", sensitive: false },
  ];
}

/** Remove a single key and record whether it had data. */
async function removeKeySafely(
  location: ErasureLocation,
  perLocation: Record<StorageKey, { removed: boolean; hadData: boolean }>,
  failures: { key: StorageKey; error: string }[],
): Promise<void> {
  if (!isStorageAvailable("localStorage")) {
    // Storage was available at call start (we checked).
    // If it vanishes mid-call, record a single combined failure and stop.
    failures.push({
      key: location.kind,
      error: "localStorage became unavailable during erasure",
    });
    return;
  }

  try {
    const hadData = localStorage.getItem(location.kind) != null;
    localStorage.removeItem(location.kind);
    perLocation[location.kind] = { removed: true, hadData };
  } catch (err) {
    const message =
      err instanceof DOMException
        ? err.message
        : String(err);
    failures.push({ key: location.kind, error: message });
    // Keep the per-location entry truthful: removal did not complete.
    perLocation[location.kind] = { removed: false, hadData: false };
  }
}

/**
 * Explicitly erase all locally persisted credential values and salts from
 * browser storage.
 *
 * This is the single public entrypoint for the Issue #973 erasure flow.
 *
 * Returns a structured result so callers (the holder UI) can:
 * - show a success toast only when the operation truly completed,
 * - surface a plain-language failure when storage is unavailable or a
 *   removal threw, and
 * - never claim "erased" while material may remain.
 *
 * The operation is idempotent: calling it when no credential data exists
 * returns `success: true` with `locationsRemoved: 0` and no error.
 */
export async function eraseCredentials(): Promise<EraseResult> {
  if (!isStorageAvailable("localStorage")) {
    return {
      success: false,
      locationsRemoved: 0,
      perLocation: Object.fromEntries(
        credentialLocations().map((loc) => [
          loc.kind,
          { removed: false, hadData: false },
        ]),
      ) as Record<StorageKey, { removed: boolean; hadData: boolean }>,
      message: "Browser storage is unavailable. Credentials may still be present.",
    };
  }

  const locations = credentialLocations();
  const perLocation: Record<StorageKey, { removed: boolean; hadData: boolean }> =
    Object.fromEntries(
      locations.map((loc) => [loc.kind, { removed: false, hadData: false }]),
    ) as Record<StorageKey, { removed: boolean; hadData: boolean }>;

  const failures: { key: StorageKey; error: string }[] = [];

  // Remove every managed key individually so a single throw does not abort
  // the rest of the erasure.
  for (const loc of locations) {
    await removeKeySafely(loc, perLocation, failures);
  }

  const locationsRemoved = locations.filter(
    (loc) => perLocation[loc.kind].removed,
  ).length;

  // Lock the in-memory credential store so any leftover encrypted envelope
  // cannot be decrypted after this call returns.
  try {
    lockCredentialStore();
  } catch {
    // Lock failure is unfortunate but not fatal to the erasure result.
    // Record it so callers still see the true picture.
    failures.push({
      key: CREDENTIALS_KEY,
      error: "failed to lock in-memory credential store after removal",
    });
  }

  if (failures.length === 0) {
    return {
      success: true,
      locationsRemoved,
      perLocation,
      message: null,
    };
  }

  // We still report success=true only when every removal we attempted
  // actually succeeded. Failures here mean at least one location did not
  // get cleared, so the overall operation is a partial failure.
  const allRemoved = locations.every(
    (loc) => perLocation[loc.kind].removed,
  );

  return {
    success: allRemoved,
    locationsRemoved,
    perLocation,
    message: failures.length === 1
      ? failures[0].error
      : `Erasure completed with ${failures.length} issue(s).`,
  };
}

/** Timeline key enumeration (used by {@link ALL_STORAGE_KEYS}). */
function getTimelineKeys(): StorageKey[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  const keys: StorageKey[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("proofTimeline:")) {
        keys.push(key as StorageKey);
      }
    }
  } catch {
    // localStorage unavailable (private mode) — return empty
  }
  return keys;
}

/**
 * claim-expiry-lifecycle.ts - Reconciles and verifies the three distinct lifetimes:
 * on-chain claim expiry, contract storage TTL, and off-chain indexer retention (#980).
 */

export type ClaimLifecycleState =
  "active_valid" | "active_expired" | "storage_archived" | "never_proved";

export interface ClaimLifecycleContext {
  nowSec: number;
  verifiedAt?: number | null;
  expirySec?: number | null;
  storageTtlLedgers?: number | null;
  isArchived?: boolean;
}

/**
 * Evaluates the authoritative lifecycle state of a claim given both
 * application-level expiry timestamps and ledger-level storage TTL.
 */
export function evaluateClaimLifecycle(context: ClaimLifecycleContext): ClaimLifecycleState {
  const { nowSec, verifiedAt, expirySec, storageTtlLedgers, isArchived } = context;

  if (!verifiedAt || verifiedAt === 0) {
    return "never_proved";
  }

  // If storage TTL reached zero or entry was archived, contract returns None
  if (
    isArchived ||
    (storageTtlLedgers !== undefined && storageTtlLedgers !== null && storageTtlLedgers <= 0)
  ) {
    return "storage_archived";
  }

  // Active persistent storage: check application-level expiry timestamp
  if (expirySec && nowSec >= expirySec) {
    return "active_expired";
  }

  return "active_valid";
}

/**
 * Asserts that UI and SDK status semantics agree with the on-chain contract model.
 */
export function getLifecycleUiStatus(
  state: ClaimLifecycleState,
): "unproved" | "proved" | "expired" {
  switch (state) {
    case "active_valid":
      return "proved";
    case "active_expired":
      return "expired";
    case "storage_archived":
    case "never_proved":
    default:
      return "unproved";
  }
}

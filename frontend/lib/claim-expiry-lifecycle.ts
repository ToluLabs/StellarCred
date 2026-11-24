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

/**
 * Maps the raw on-chain ProofRegistry is_verified response tuple (valid, verified_at, expiry)
 * into a definitive ClaimLifecycleState (#1006).
 *
 * Contract semantics:
 * - Active Valid:   (true, verified_at > 0, expiry > now)
 * - Active Expired: (false, verified_at > 0, expiry <= now)
 * - Archived / None:(false, 0, 0)
 */
export function evaluateContractClaimResponse(
  tuple: [boolean, number, number],
  nowSec: number = Math.floor(Date.now() / 1000),
  isArchived: boolean = false,
): ClaimLifecycleState {
  const [valid, verifiedAt, expiry] = tuple;
  if (!verifiedAt || verifiedAt === 0) {
    return isArchived ? "storage_archived" : "never_proved";
  }
  if (isArchived) {
    return "storage_archived";
  }
  if (!valid && expiry > 0 && nowSec >= expiry) {
    return "active_expired";
  }
  if (valid) {
    return "active_valid";
  }
  return "never_proved";
}

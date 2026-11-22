/**
 * Offline (air-gapped) proof verification.
 *
 * Verifies a zero-knowledge presentation using only locally cached material:
 * a verifier key and a registry state snapshot exported while online. No
 * network access (RPC, indexer, fetch) is ever performed by this module.
 *
 * The SDK ships no proving-system backend, so the caller supplies the
 * cryptographic `verifyProof` function (e.g. a bundled WASM verifier). The
 * helper binds that check to the cached verifier key (SHA-256 pinned) and to
 * the snapshot's on-chain state (existence, revocation, expiry, issuer,
 * threshold, nullifier reuse, snapshot freshness).
 */

import type { ClaimType } from "./claims";
import { isValidClaimType } from "./claims";

/** One cached ProofRegistry record. Times are unix seconds. */
export interface OfflineSnapshotRecord {
  verifiedAt: number;
  /** 0 means the record never expires. */
  expiry: number;
  revoked: boolean;
  issuer?: string;
  threshold?: number;
  vkVersion?: number;
}

/** Registry state exported while online and carried to the offline terminal. */
export interface OfflineSnapshot {
  /** Unix seconds when the snapshot was taken. */
  takenAt: number;
  ledger?: number;
  registryId?: string;
  /** wallet -> claim type -> record */
  records: Record<string, Partial<Record<ClaimType, OfflineSnapshotRecord>>>;
  /** Optional pinned verifier-key SHA-256 (hex) per claim type. */
  verifierKeyHashes?: Partial<Record<ClaimType, string>>;
  /** Nullifiers already consumed as of the snapshot. */
  usedNullifiers?: string[];
}

/** A locally cached verifier key. */
export interface OfflineVerifierKey {
  /** Serialized key material (opaque to the SDK), e.g. base64 or hex. */
  key: string;
  /** Expected lowercase hex SHA-256 of the UTF-8 bytes of `key`. */
  hash: string;
}

/** A zero-knowledge presentation received by the terminal. */
export interface OfflinePresentation {
  wallet: string;
  claim: ClaimType;
  proof: string | Uint8Array;
  publicInputs: string[];
  nullifier?: string;
}

export type OfflineVerifyFailureReason =
  | "malformed_input"
  | "snapshot_stale"
  | "snapshot_from_future"
  | "verifier_key_mismatch"
  | "not_verified"
  | "revoked"
  | "expired"
  | "wrong_issuer"
  | "unmet_threshold"
  | "nullifier_used"
  | "invalid_proof";

export type OfflineProofVerifier = (args: {
  verifierKey: string;
  proof: string | Uint8Array;
  publicInputs: string[];
  claim: ClaimType;
}) => boolean | Promise<boolean>;

export interface OfflineVerifyParams {
  presentation: OfflinePresentation;
  verifierKey: OfflineVerifierKey;
  snapshot: OfflineSnapshot;
  /** Cryptographic proof check; runs only after all state checks pass. */
  verifyProof: OfflineProofVerifier;
  /** Unix seconds "now" (the terminal's clock). Defaults to the system clock. */
  now?: number;
  /** Max snapshot age in seconds. Defaults to 24 hours. */
  maxSnapshotAgeSec?: number;
  /** Allowed forward clock skew in seconds. Defaults to 300. */
  clockSkewSec?: number;
  trustedIssuers?: string[];
  minThreshold?: number;
}

export interface OfflineVerifyResult {
  ok: boolean;
  failureReason?: OfflineVerifyFailureReason;
  error?: string;
  /** Age of the snapshot in seconds at verification time. */
  snapshotAgeSec?: number;
  record?: OfflineSnapshotRecord;
}

export const DEFAULT_MAX_SNAPSHOT_AGE_SEC = 24 * 60 * 60;
export const DEFAULT_CLOCK_SKEW_SEC = 300;

function fail(
  failureReason: OfflineVerifyFailureReason,
  error: string,
  extra: Partial<OfflineVerifyResult> = {},
): OfflineVerifyResult {
  return { ok: false, failureReason, error, ...extra };
}

/** Lowercase hex SHA-256 of a UTF-8 string, using only local Web Crypto. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto (crypto.subtle) is unavailable");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Verify a ZK presentation with no network access. Never throws for bad
 * input or verifier failures; always returns a typed result (fail closed).
 */
export async function verifyOfflinePresentation(
  params: OfflineVerifyParams,
): Promise<OfflineVerifyResult> {
  const { presentation, verifierKey, snapshot, verifyProof } = params;

  if (
    !presentation ||
    typeof presentation.wallet !== "string" ||
    !presentation.wallet ||
    typeof presentation.claim !== "string" ||
    !isValidClaimType(presentation.claim) ||
    !presentation.proof ||
    !Array.isArray(presentation.publicInputs) ||
    !verifierKey ||
    typeof verifierKey.key !== "string" ||
    typeof verifierKey.hash !== "string" ||
    !snapshot ||
    !isFiniteNumber(snapshot.takenAt) ||
    typeof snapshot.records !== "object" ||
    snapshot.records === null ||
    typeof verifyProof !== "function"
  ) {
    return fail("malformed_input", "Presentation, verifier key, or snapshot is malformed.");
  }

  const now = params.now ?? Math.floor(Date.now() / 1000);
  const maxAge = params.maxSnapshotAgeSec ?? DEFAULT_MAX_SNAPSHOT_AGE_SEC;
  const skew = params.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;
  const snapshotAgeSec = now - snapshot.takenAt;

  if (snapshotAgeSec < -skew) {
    return fail("snapshot_from_future", "Snapshot is dated in the future; check terminal clock.", {
      snapshotAgeSec,
    });
  }
  if (snapshotAgeSec > maxAge) {
    return fail("snapshot_stale", `Snapshot is ${snapshotAgeSec}s old (max ${maxAge}s).`, {
      snapshotAgeSec,
    });
  }

  // Pin the verifier key to its hash (and to the snapshot's pinned hash).
  let actualHash: string;
  try {
    actualHash = await sha256Hex(verifierKey.key);
  } catch (e) {
    return fail("verifier_key_mismatch", `Cannot hash verifier key: ${(e as Error).message}`);
  }
  const expected = verifierKey.hash.toLowerCase();
  const pinned = snapshot.verifierKeyHashes?.[presentation.claim]?.toLowerCase();
  if (actualHash !== expected || (pinned !== undefined && pinned !== actualHash)) {
    return fail("verifier_key_mismatch", "Cached verifier key does not match its pinned hash.", {
      snapshotAgeSec,
    });
  }

  const own = Object.prototype.hasOwnProperty;
  const byClaim = own.call(snapshot.records, presentation.wallet)
    ? snapshot.records[presentation.wallet]
    : undefined;
  const record = byClaim && own.call(byClaim, presentation.claim) ? byClaim[presentation.claim] : undefined;
  const base = { snapshotAgeSec };
  if (!record) return fail("not_verified", "No record for this wallet and claim in snapshot.", base);
  if (record.revoked) return fail("revoked", "Credential is revoked.", base);
  if (record.expiry !== 0 && now > record.expiry) {
    return fail("expired", "Credential has expired.", base);
  }
  if (params.trustedIssuers && (!record.issuer || !params.trustedIssuers.includes(record.issuer))) {
    return fail("wrong_issuer", "Credential issuer is not trusted.", base);
  }
  if (params.minThreshold !== undefined && (record.threshold ?? 0) < params.minThreshold) {
    return fail("unmet_threshold", "Credential does not meet the required threshold.", base);
  }
  if (presentation.nullifier && snapshot.usedNullifiers?.includes(presentation.nullifier)) {
    return fail("nullifier_used", "Nullifier has already been used.", base);
  }

  let valid = false;
  try {
    valid = (await verifyProof({
      verifierKey: verifierKey.key,
      proof: presentation.proof,
      publicInputs: presentation.publicInputs,
      claim: presentation.claim,
    })) === true;
  } catch {
    valid = false;
  }
  if (!valid) return fail("invalid_proof", "Zero-knowledge proof failed verification.", base);

  return { ok: true, snapshotAgeSec, record };
}

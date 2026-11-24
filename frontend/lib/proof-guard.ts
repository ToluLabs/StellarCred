// Resource guardrails for proof requests (GitHub #943).
//
// Proving cost is driven by the size of the job: how many credentials an
// aggregate proof packs, how much private input a credential carries, and how
// many proofs a batch asks for. Everything here is checked *before* a witness
// is requested or a backend is constructed, so an oversized request fails in
// milliseconds with an explanation instead of burning minutes of proving —
// or exhausting the tab's memory and dying with an opaque wasm error.
//
// This module is deliberately dependency-free (types only, no runtime imports)
// because both the dedicated prover worker and the main-thread fallback import
// it. The limits mirror real constraints elsewhere in the stack; each one names
// its source so a future change can be made in one place:
//   • maxAggregateCredentials — circuits/aggregate_proof/src/main.nr asserts
//     `num_credentials == 2` (the PoC packs KYC + age).
//   • maxBatchProofs — MAX_BATCH_SIZE in lib/contract-transactions.ts, which
//     mirrors the ProofRegistry contract's batch cap of 5.
//   • maxCredentialBytes / maxBatchBytes — the witness payload the browser
//     POSTs to /api/witness. Real credentials serialize to ~1–2 kB; these caps
//     are generous headroom, not a tighter contract.
//   • deadlines — derived from the proving perf baselines
//     (perf/proving-baselines.json) and the payload-tier ceilings in
//     perf/payloads-baselines.json.
//
// Raising a limit is a deliberate change: it must be paired with a matching
// circuit/contract change where the limit comes from one, and the perf
// baselines must be refreshed so CI still measures the workload the guard
// allows. See docs/PROOF_RESOURCE_LIMITS.md.

import type { ProofJobRequest } from "./proof-protocol";

export const PROOF_RESOURCE_LIMITS = {
  /** Aggregate proofs may pack at most this many credentials. */
  maxAggregateCredentials: 2,
  /** One batch may prove at most this many credentials. */
  maxBatchProofs: 5,
  /** Serialized private inputs for a single proof, in UTF-8 bytes. */
  maxCredentialBytes: 16 * 1024,
  /** Serialized private inputs across one batch, in UTF-8 bytes. */
  maxBatchBytes: 64 * 1024,
  /** Deadline for a single-credential proof. */
  baseDeadlineMs: 120_000,
  /** Deadline for a multi-credential (aggregate) proof. */
  aggregateDeadlineMs: 180_000,
  /** Hard ceiling: no proof request is ever given more than this. */
  maxDeadlineMs: 300_000,
} as const;

/** Which limit a request tripped. Stable, safe to log and to show in telemetry. */
export type ProofLimitName =
  "aggregate_credentials" | "batch_size" | "credential_bytes" | "batch_bytes";

/** Machine-readable error code carried by every guard rejection. */
export const PROOF_RESOURCE_ERROR_CODE = "proof_request_too_large";

/**
 * Thrown (or rejected) when a proof request exceeds a resource limit.
 *
 * The message is actionable on purpose: it names the limit that was exceeded,
 * the value that was received, and what to do about it. It never includes the
 * credential's private fields — only sizes and counts — so it is safe to log
 * and to surface in the UI.
 */
export class ProofResourceError extends Error {
  readonly code = PROOF_RESOURCE_ERROR_CODE;
  readonly limitName: ProofLimitName;
  /** The limit that was exceeded (credentials, proofs, or bytes). */
  readonly limit: number;
  /** What the request actually asked for. */
  readonly actual: number;
  /** One sentence the holder can act on. */
  readonly friendly: string;

  constructor(limitName: ProofLimitName, limit: number, actual: number, friendly: string) {
    super(
      `Proof request refused: ${limitName} exceeds its limit of ${limit} (received ${actual}). ${friendly}`,
    );
    this.name = "ProofResourceError";
    this.limitName = limitName;
    this.limit = limit;
    this.actual = actual;
    this.friendly = friendly;
  }
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Approximate on-the-wire size of a proof request, in bytes.
 *
 * Returns 0 for a payload that cannot be serialized (circular references,
 * BigInt): such a request would fail when the witness route JSON-encodes it
 * anyway, so the size guard must not be the thing that reports it.
 */
export function proofRequestBytes(request: ProofJobRequest): number {
  try {
    return utf8Bytes(JSON.stringify(request));
  } catch {
    return 0;
  }
}

/** True when this request packs more than one credential. */
function isAggregateRequest(request: ProofJobRequest): boolean {
  return request.credentialType === "aggregate" || Boolean(request.aggregate);
}

/**
 * How many credentials an aggregate input packs.
 *
 * Counted structurally (a nested object carrying `commitment` or `sig`) rather
 * than from `num_credentials`, because the declared count is part of the
 * witness and must not be able to talk the guard down. `{ kyc, age }` is 2.
 */
export function aggregateCredentialCount(inputs: object): number {
  return Object.values(inputs as Record<string, unknown>).filter(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ("commitment" in (value as Record<string, unknown>) ||
        "sig" in (value as Record<string, unknown>)),
  ).length;
}

function credentialCount(request: ProofJobRequest): number {
  if (!isAggregateRequest(request)) return 1;
  return request.aggregate ? aggregateCredentialCount(request.aggregate) : 0;
}

/**
 * Returns the first limit `request` exceeds, or `null` when it is within all of
 * them. Pure: no side effects, so callers can use it for preflight UI checks.
 */
export function checkProofRequest(request: ProofJobRequest): ProofResourceError | null {
  const limits = PROOF_RESOURCE_LIMITS;
  const credentials = credentialCount(request);

  if (credentials > limits.maxAggregateCredentials) {
    return new ProofResourceError(
      "aggregate_credentials",
      limits.maxAggregateCredentials,
      credentials,
      `An aggregate proof covers at most ${limits.maxAggregateCredentials} credentials. Prove them separately, or in a batch.`,
    );
  }

  const bytes = proofRequestBytes(request);
  if (bytes > limits.maxCredentialBytes) {
    return new ProofResourceError(
      "credential_bytes",
      limits.maxCredentialBytes,
      bytes,
      `A single proof accepts at most ${Math.round(limits.maxCredentialBytes / 1024)} kB of private input. Large documents should be represented by a derived claim (a threshold, a hash commitment) rather than embedded in the credential.`,
    );
  }

  return null;
}

/** Throws {@link ProofResourceError} when `request` exceeds a resource limit. */
export function assertProofRequestWithinLimits(request: ProofJobRequest): void {
  const error = checkProofRequest(request);
  if (error) throw error;
}

/**
 * Throws {@link ProofResourceError} when a batch is too large, when any single
 * proof in it is, or when the batch's combined private input exceeds the batch
 * byte cap. Checked as a whole before the first proof starts, so a batch cannot
 * spend N−1 proofs and then fail on the last one.
 */
export function assertProofBatchWithinLimits(requests: ProofJobRequest[]): void {
  const limits = PROOF_RESOURCE_LIMITS;

  if (requests.length > limits.maxBatchProofs) {
    throw new ProofResourceError(
      "batch_size",
      limits.maxBatchProofs,
      requests.length,
      `A batch proves at most ${limits.maxBatchProofs} credentials at once. Split the selection into multiple batches.`,
    );
  }

  let total = 0;
  for (const request of requests) {
    assertProofRequestWithinLimits(request);
    total += proofRequestBytes(request);
  }

  if (total > limits.maxBatchBytes) {
    throw new ProofResourceError(
      "batch_bytes",
      limits.maxBatchBytes,
      total,
      `This batch carries ${Math.round(total / 1024)} kB of private input, above the ${Math.round(
        limits.maxBatchBytes / 1024,
      )} kB cap. Prove fewer credentials per batch.`,
    );
  }
}

/**
 * How long a proof request may take before the deadline guard aborts it.
 *
 * Scaled by workload (an aggregate proof is given longer than a single one)
 * but always clamped to {@link PROOF_RESOURCE_LIMITS.maxDeadlineMs}. The
 * return value feeds `withTimeout` in lib/proof-timeout.ts, so a stalled prover
 * surfaces as `ProofTimeoutError` rather than spinning forever.
 */
export function proofDeadlineMs(request: ProofJobRequest, overrideMs?: number): number {
  const limits = PROOF_RESOURCE_LIMITS;
  const base = isAggregateRequest(request) ? limits.aggregateDeadlineMs : limits.baseDeadlineMs;
  const chosen =
    typeof overrideMs === "number" && Number.isFinite(overrideMs) ? Math.max(1, overrideMs) : base;
  return Math.min(chosen, limits.maxDeadlineMs);
}

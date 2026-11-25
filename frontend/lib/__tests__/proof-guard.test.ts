// Coverage for the proof-request resource guard (GitHub #943).
//
// These checks run before any witness is requested, so they are pure: the tests
// exercise the limits, the error shape (which the UI renders), and the
// workload-scaled proof deadline.

import { describe, it, expect } from "vitest";
import {
  PROOF_RESOURCE_ERROR_CODE,
  PROOF_RESOURCE_LIMITS,
  ProofResourceError,
  aggregateCredentialCount,
  assertProofBatchWithinLimits,
  assertProofRequestWithinLimits,
  checkProofRequest,
  proofDeadlineMs,
  proofRequestBytes,
} from "../proof-guard";
import type { ProofJobRequest } from "../proof-protocol";

/** A credential whose serialized form is comfortably under the byte cap. */
function credential(overrides: Record<string, unknown> = {}) {
  return {
    type: "kyc",
    value: "42",
    salt: "7",
    commitment: "9",
    sig: Array.from({ length: 64 }, (_, i) => i % 256),
    issuerPubX: Array.from({ length: 32 }, () => 1),
    issuerPubY: Array.from({ length: 32 }, () => 2),
    ...overrides,
  };
}

const single = (overrides: Record<string, unknown> = {}): ProofJobRequest => ({
  credentialType: "kyc",
  credential: credential(overrides),
});

const aggregate = (extra: Record<string, unknown> = {}): ProofJobRequest => ({
  credentialType: "aggregate",
  aggregate: { kyc: credential(), age: credential({ value: "1990-01-01" }), ...extra } as never,
});

describe("checkProofRequest", () => {
  it("allows a normal single-credential proof", () => {
    expect(checkProofRequest(single())).toBeNull();
    expect(() => assertProofRequestWithinLimits(single())).not.toThrow();
  });

  it("allows the two-credential aggregate proof the circuit supports", () => {
    expect(checkProofRequest(aggregate())).toBeNull();
  });

  it("refuses an aggregate proof packing more credentials than the circuit can", () => {
    const request = aggregate({ income: credential() });
    const error = checkProofRequest(request);

    expect(error).toBeInstanceOf(ProofResourceError);
    expect(error?.code).toBe(PROOF_RESOURCE_ERROR_CODE);
    expect(error?.limitName).toBe("aggregate_credentials");
    expect(error?.limit).toBe(PROOF_RESOURCE_LIMITS.maxAggregateCredentials);
    expect(error?.actual).toBe(3);
    // Actionable: says what to do, and never echoes credential values.
    expect(error?.friendly).toMatch(/at most 2 credentials/i);
    expect(error?.friendly).toMatch(/separately|batch/i);
    expect(error?.message).not.toContain("1990-01-01");
  });

  it("refuses a credential whose private payload exceeds the per-proof cap", () => {
    const oversized = single({ pad: "x".repeat(PROOF_RESOURCE_LIMITS.maxCredentialBytes + 1) });
    const error = checkProofRequest(oversized);

    expect(error?.limitName).toBe("credential_bytes");
    expect(error?.actual).toBeGreaterThan(PROOF_RESOURCE_LIMITS.maxCredentialBytes);
    expect(error?.friendly).toMatch(/private input/i);
    expect(error?.friendly).toMatch(/derived claim|threshold|hash/i);
  });

  it("reports bytes as a positive number for a serializable request", () => {
    expect(proofRequestBytes(single())).toBeGreaterThan(0);
  });
});

describe("assertProofBatchWithinLimits", () => {
  it("allows a batch at the contract's batch limit", () => {
    const batch = Array.from({ length: PROOF_RESOURCE_LIMITS.maxBatchProofs }, () => single());
    expect(() => assertProofBatchWithinLimits(batch)).not.toThrow();
  });

  it("refuses a batch above the batch limit before any proof starts", () => {
    const batch = Array.from({ length: PROOF_RESOURCE_LIMITS.maxBatchProofs + 1 }, () => single());
    let caught: unknown;
    try {
      assertProofBatchWithinLimits(batch);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ProofResourceError);
    const error = caught as ProofResourceError;
    expect(error.limitName).toBe("batch_size");
    expect(error.actual).toBe(PROOF_RESOURCE_LIMITS.maxBatchProofs + 1);
    expect(error.friendly).toMatch(/split/i);
  });

  it("refuses a batch whose combined private input exceeds the batch cap", () => {
    // Five credentials each ~14 kB: individually under the 16 kB cap, together
    // over the 64 kB batch cap.
    const heavy = Array.from({ length: PROOF_RESOURCE_LIMITS.maxBatchProofs }, () =>
      single({ pad: "y".repeat(14 * 1024) }),
    );
    let caught: unknown;
    try {
      assertProofBatchWithinLimits(heavy);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ProofResourceError);
    expect((caught as ProofResourceError).limitName).toBe("batch_bytes");
  });
});

describe("proofDeadlineMs", () => {
  it("gives a single-credential proof the base deadline", () => {
    expect(proofDeadlineMs(single())).toBe(PROOF_RESOURCE_LIMITS.baseDeadlineMs);
  });

  it("gives an aggregate proof the longer aggregate deadline", () => {
    expect(proofDeadlineMs(aggregate())).toBe(PROOF_RESOURCE_LIMITS.aggregateDeadlineMs);
    expect(proofDeadlineMs({ credentialType: "aggregate" })).toBe(
      PROOF_RESOURCE_LIMITS.aggregateDeadlineMs,
    );
  });

  it("respects a smaller caller override", () => {
    expect(proofDeadlineMs(single(), 5_000)).toBe(5_000);
  });

  it("clamps any override to the hard ceiling", () => {
    expect(proofDeadlineMs(single(), 10 * 60_000)).toBe(PROOF_RESOURCE_LIMITS.maxDeadlineMs);
  });
});

describe("aggregateCredentialCount", () => {
  it("counts credential-shaped entries and ignores metadata", () => {
    expect(aggregateCredentialCount({ kyc: credential(), age: credential() })).toBe(2);
    expect(
      aggregateCredentialCount({ kyc: credential(), age: credential(), note: "x", list: [1, 2] }),
    ).toBe(2);
  });
});

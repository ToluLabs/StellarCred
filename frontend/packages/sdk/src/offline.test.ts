// @vitest-environment node

import { describe, it, expect, vi } from "vitest";

import {
  createBbJsProofVerifier,
  createOfflineVerifier,
  verifyOfflinePresentation,
  DEFAULT_MAX_CLOCK_SKEW_SECONDS,
  DEFAULT_MAX_SNAPSHOT_AGE_SECONDS,
  OFFLINE_FIELD_BYTES,
  OFFLINE_SNAPSHOT_VERSION,
  OfflineVerificationError,
  ULTRAHONK_PROOF_BYTES,
  type BbJsModuleLike,
  type CachedVerifierKey,
  type OfflinePresentation,
  type OfflineProofVerificationInput,
  type OfflineSnapshotClaim,
  type OfflineStateSnapshot,
  type OfflineVerificationResult,
} from "./offline";
import { StellarCred } from "./index";

describe("offline verification exports", () => {
  it("is reachable from the package entry point and the namespace", () => {
    expect(StellarCred.createOfflineVerifier).toBe(createOfflineVerifier);
    expect(StellarCred.verifyOfflinePresentation).toBe(verifyOfflinePresentation);
    expect(StellarCred.createBbJsProofVerifier).toBe(createBbJsProofVerifier);
    expect(StellarCred.OfflineVerificationError).toBe(OfflineVerificationError);
    expect(StellarCred.ULTRAHONK_PROOF_BYTES).toBe(ULTRAHONK_PROOF_BYTES);
    expect(StellarCred.OFFLINE_SNAPSHOT_VERSION).toBe(OFFLINE_SNAPSHOT_VERSION);
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OTHER_WALLET = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC2V";
const ISSUER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";
const OTHER_ISSUER = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDQZ";

const COMMITMENT = "11".repeat(32);
const OTHER_COMMITMENT = "12".repeat(32);
const ISSUER_X = "22".repeat(32);
const ISSUER_Y = "33".repeat(32);
const ISSUER_PUB = ISSUER_X + ISSUER_Y;
const OTHER_ISSUER_X = "44".repeat(32);
const OTHER_ISSUER_Y = "55".repeat(32);
const OTHER_ISSUER_PUB = OTHER_ISSUER_X + OTHER_ISSUER_Y;
const MERKLE_ROOT = "66".repeat(32);
const OTHER_ROOT = "67".repeat(32);
const APP_CONTEXT = "77".repeat(32);
const NULLIFIER = "88".repeat(32);
const OTHER_NULLIFIER = "89".repeat(32);

const VK = "aa".repeat(32);
const OTHER_VK = "ab".repeat(32);

const CAPTURED_AT = 1_000;
const NOW = 1_100;

const PROOF = new Uint8Array(ULTRAHONK_PROOF_BYTES).fill(7);

const PUBLIC_INPUTS = `0x${COMMITMENT}${ISSUER_X}${ISSUER_Y}${MERKLE_ROOT}`;

function claim(overrides: Partial<OfflineSnapshotClaim> = {}): OfflineSnapshotClaim {
  return {
    wallet: WALLET,
    credential_type: "age",
    issuer: ISSUER,
    verified_at: 900,
    expiry: 2_000,
    ledger_sequence: 99,
    threshold: 18,
    revoked: 0,
    commitment: COMMITMENT,
    issuer_pub_key: ISSUER_PUB,
    vk_version: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<OfflineStateSnapshot> = {}): OfflineStateSnapshot {
  return {
    snapshotVersion: OFFLINE_SNAPSHOT_VERSION,
    capturedAt: CAPTURED_AT,
    ledgerSequence: 100,
    claims: [claim()],
    ...overrides,
  };
}

function keys(overrides: Partial<CachedVerifierKey> = {}): CachedVerifierKey[] {
  return [
    {
      credential_type: "age",
      vk_version: 1,
      vk: `0x${VK}`,
      ...overrides,
    },
  ];
}

function presentation(overrides: Partial<OfflinePresentation> = {}): OfflinePresentation {
  return {
    credential_type: "age",
    holder: WALLET,
    proof: PROOF,
    public_inputs: PUBLIC_INPUTS,
    vk_version: 1,
    issuer_id: ISSUER,
    issuer_pub_key: ISSUER_PUB,
    commitment: COMMITMENT,
    min_threshold: 18,
    ...overrides,
  };
}

function verifier(
  snapshotOverrides: Partial<OfflineStateSnapshot> = {},
  keyOverrides: Partial<CachedVerifierKey> = {},
  options: Partial<Parameters<typeof createOfflineVerifier>[0]> = {},
) {
  const proofVerifier = vi.fn(async (_input: OfflineProofVerificationInput) => true);
  const instance = createOfflineVerifier({
    verifierKeys: keys(keyOverrides),
    stateSnapshot: snapshot(snapshotOverrides),
    now: NOW,
    proofVerifier,
    ...options,
  });
  return { instance, proofVerifier };
}

async function expectFailure(result: OfflineVerificationResult, code: string): Promise<void> {
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.code).toBe(code);
  expect(result.message.length).toBeGreaterThan(0);
  expect(result.checks.length === 0 || result.checks.some((check) => !check.ok)).toBe(true);
}

// ── Success path ────────────────────────────────────────────────────────────

describe("offline verification — success", () => {
  it("verifies a fully bound presentation using only cached material", async () => {
    const { instance, proofVerifier } = verifier();

    const result = await instance.verify(presentation());

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.code).toBe("valid");
    expect(result.credentialType).toBe("age");
    expect(result.vkVersion).toBe(1);
    expect(result.holder).toBe(WALLET);
    expect(result.issuerId).toBe(ISSUER);
    expect(result.commitment).toBe(COMMITMENT);
    expect(result.verifiedAt).toBe(900);
    expect(result.expiry).toBe(2_000);
    expect(result.snapshotLedgerSequence).toBe(100);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.checks.map((check) => check.name)).toContain("proof");

    expect(proofVerifier).toHaveBeenCalledTimes(1);
    const input = proofVerifier.mock.calls[0][0];
    expect(input.credentialType).toBe("age");
    expect(input.vkVersion).toBe(1);
    expect(Array.from(input.verifierKey)).toEqual(Array(32).fill(0xaa));
    expect(input.proof).toBeInstanceOf(Uint8Array);
    expect(input.proof.length).toBe(ULTRAHONK_PROOF_BYTES);
  });

  it("accepts bytes as hex, number arrays and Uint8Array", async () => {
    const { instance } = verifier({}, { vk: Array.from({ length: 32 }, () => 0xaa) });

    await expect(
      instance.verify(
        presentation({
          proof: Array.from(PROOF),
          public_inputs: PUBLIC_INPUTS.replace(/^0x/, ""),
          commitment: Array.from({ length: 32 }, () => 0x11),
          issuer_pub_key: Uint8Array.from([...Array(32).fill(0x22), ...Array(32).fill(0x33)]),
        }),
      ),
    ).resolves.toMatchObject({ valid: true });
  });

  it("accepts a record with no expiry", async () => {
    const { instance } = verifier({ claims: [claim({ expiry: 0 })] });

    const result = await instance.verify(presentation());

    expect(result).toMatchObject({ valid: true, expiry: 0 });
  });

  it("accepts a holder whose record has no optional binding fields", async () => {
    const { instance } = verifier({
      claims: [
        {
          wallet: WALLET,
          credential_type: "age",
          verified_at: 900,
          expiry: 2_000,
          revoked: false,
        },
      ],
    });

    const result = await instance.verify(
      presentation({
        commitment: undefined,
        issuer_pub_key: undefined,
        issuer_id: undefined,
        min_threshold: undefined,
      }),
    );

    expect(result).toMatchObject({ valid: true, issuerId: undefined });
  });

  it("uses the newest duplicate claim record deterministically", async () => {
    const { instance } = verifier({
      claims: [
        claim({ verified_at: 500, revoked: true }),
        claim({ verified_at: 950, revoked: false }),
      ],
    });

    await expect(instance.verify(presentation())).resolves.toMatchObject({
      valid: true,
      verifiedAt: 950,
    });
  });

  it("re-evaluates the clock between verifications", async () => {
    let now = NOW;
    const { instance } = verifier({}, {}, { now: () => now });
    await expect(instance.verify(presentation())).resolves.toMatchObject({ valid: true });

    now = 2_000; // record expiry is inclusive
    const expired = await instance.verify(presentation());
    await expectFailure(expired, "expired");
  });

  it("verifies several presentations against one cached snapshot", async () => {
    const { instance } = verifier();

    const results = await instance.verifyAll([
      presentation(),
      presentation({ holder: OTHER_WALLET }),
      presentation({ holder: OTHER_WALLET }),
    ]);

    expect(results.map((result) => result.valid)).toEqual([true, false, false]);
    expect(results[1].valid ? null : results[1].code).toBe("no_proof_record");
    expect(results[2].valid ? null : results[2].code).toBe("no_proof_record");
  });

  it("exposes a one-shot wrapper", async () => {
    const result = await verifyOfflinePresentation(presentation(), {
      verifierKeys: keys(),
      stateSnapshot: snapshot(),
      now: NOW,
      proofVerifier: async () => true,
    });

    expect(result.valid).toBe(true);
  });
});

// ── Snapshot freshness and network ──────────────────────────────────────────

describe("offline verification — snapshot freshness", () => {
  it("rejects a snapshot older than the default maximum age", async () => {
    const lateNow = 1_000_000;
    const { instance } = verifier(
      { capturedAt: lateNow - DEFAULT_MAX_SNAPSHOT_AGE_SECONDS - 1 },
      {},
      { now: lateNow },
    );

    await expectFailure(await instance.verify(presentation()), "stale_state_snapshot");
  });

  it("honours a custom maximum snapshot age", async () => {
    const { instance } = verifier({ capturedAt: NOW - 61 }, {}, { maxSnapshotAgeSeconds: 60 });

    await expectFailure(await instance.verify(presentation()), "stale_state_snapshot");
  });

  it("accepts a snapshot exactly at the age boundary", async () => {
    const { instance } = verifier({ capturedAt: NOW - 60 }, {}, { maxSnapshotAgeSeconds: 60 });

    await expect(instance.verify(presentation())).resolves.toMatchObject({ valid: true });
  });

  it("rejects a snapshot dated beyond the allowed clock skew", async () => {
    const { instance } = verifier(
      { capturedAt: NOW + DEFAULT_MAX_CLOCK_SKEW_SECONDS + 1 },
      {},
      { now: NOW },
    );

    await expectFailure(await instance.verify(presentation()), "stale_state_snapshot");
  });

  it("accepts a snapshot within the allowed clock skew", async () => {
    const { instance } = verifier(
      { capturedAt: NOW + DEFAULT_MAX_CLOCK_SKEW_SECONDS },
      {},
      { now: NOW },
    );

    await expect(instance.verify(presentation())).resolves.toMatchObject({ valid: true });
  });

  it("rejects a snapshot captured for another network", async () => {
    const { instance } = verifier(
      { networkPassphrase: "Test SDF Network ; September 2015" },
      {},
      { networkPassphrase: "Public Global Stellar Network ; September 2015" },
    );

    await expectFailure(await instance.verify(presentation()), "network_mismatch");
  });

  it("accepts a matching network passphrase", async () => {
    const { instance } = verifier(
      { networkPassphrase: "Test SDF Network ; September 2015" },
      {},
      { networkPassphrase: "Test SDF Network ; September 2015" },
    );

    await expect(instance.verify(presentation())).resolves.toMatchObject({ valid: true });
  });
});

// ── Verifier keys ───────────────────────────────────────────────────────────

describe("offline verification — cached verifier keys", () => {
  it("rejects a presentation for a VK version that is not cached", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ vk_version: 2 })),
      "missing_verifier_key",
    );
  });

  it("selects the newest cached version when the presentation omits one", async () => {
    const { instance, proofVerifier } = verifier(
      { claims: [claim({ vk_version: 2 })] },
      { vk_version: 1 },
      {
        verifierKeys: [
          { credential_type: "age", vk_version: 1, vk: VK },
          { credential_type: "age", vk_version: 2, vk: OTHER_VK },
        ],
        stateSnapshot: snapshot({ claims: [claim({ vk_version: 2 })] }),
      },
    );

    const result = await instance.verify(presentation({ vk_version: undefined }));

    expect(result).toMatchObject({ valid: true, vkVersion: 2 });
    expect(Array.from(proofVerifier.mock.calls[0][0].verifierKey)[0]).toBe(0xab);
  });

  it("rejects a deprecated cached key by default", async () => {
    const { instance } = verifier({}, { deprecated: true });

    await expectFailure(await instance.verify(presentation()), "deprecated_verifier_key");
  });

  it("allows a deprecated key when explicitly configured", async () => {
    const { instance } = verifier({}, { deprecated: true }, { allowDeprecatedKeys: true });

    await expect(instance.verify(presentation())).resolves.toMatchObject({ valid: true });
  });

  it("skips deprecated keys when auto-selecting the newest version", async () => {
    const { instance } = verifier(
      {},
      {},
      {
        verifierKeys: [
          { credential_type: "age", vk_version: 1, vk: VK },
          { credential_type: "age", vk_version: 2, vk: OTHER_VK, deprecated: true },
        ],
        stateSnapshot: snapshot({ claims: [claim({ vk_version: 1 })] }),
      },
    );

    await expect(instance.verify(presentation({ vk_version: undefined }))).resolves.toMatchObject({
      valid: true,
      vkVersion: 1,
    });
  });
});

// ── Cached claim record checks ──────────────────────────────────────────────

describe("offline verification — cached claim record", () => {
  it("rejects a holder with no cached record", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ holder: OTHER_WALLET })),
      "no_proof_record",
    );
  });

  it("rejects a revoked record", async () => {
    const { instance } = verifier({
      claims: [claim({ revoked: true, reason_code: "fraud" })],
    });

    const result = await instance.verify(presentation());

    await expectFailure(result, "revoked");
    expect(result.valid ? "" : result.message).toContain("fraud");
  });

  it("treats the indexer's revoked encoding (1) as revoked", async () => {
    const { instance } = verifier({ claims: [claim({ revoked: 1 })] });

    await expectFailure(await instance.verify(presentation()), "revoked");
  });

  it("rejects an expired record", async () => {
    const { instance } = verifier({ claims: [claim({ expiry: NOW })] });

    await expectFailure(await instance.verify(presentation()), "expired");
  });

  it("rejects a record verified with another VK version", async () => {
    const { instance } = verifier({ claims: [claim({ vk_version: 2 })] });

    await expectFailure(await instance.verify(presentation()), "vk_version_mismatch");
  });

  it("rejects a commitment that disagrees with the cached record", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ commitment: OTHER_COMMITMENT })),
      "commitment_mismatch",
    );
  });

  it("rejects a commitment that is absent from the public inputs", async () => {
    const { instance } = verifier({
      claims: [claim({ commitment: OTHER_COMMITMENT })],
    });

    await expectFailure(
      await instance.verify(presentation({ commitment: undefined })),
      "public_inputs_mismatch",
    );
  });

  it("rejects a commitment in the snapshot's revocation list", async () => {
    const { instance } = verifier({ revokedCommitments: [COMMITMENT] });

    await expectFailure(await instance.verify(presentation()), "revoked");
  });

  it("accepts a commitment revocation list that does not mention this holder", async () => {
    const { instance } = verifier({ revokedCommitments: [OTHER_COMMITMENT] });

    await expect(instance.verify(presentation())).resolves.toMatchObject({ valid: true });
  });
});

// ── Issuer checks ───────────────────────────────────────────────────────────

describe("offline verification — issuer binding", () => {
  it("rejects an issuer outside the trusted set", async () => {
    const { instance } = verifier({}, {}, { trustedIssuers: [OTHER_ISSUER] });

    await expectFailure(await instance.verify(presentation()), "issuer_untrusted");
  });

  it("rejects a presentation that claims a different issuer than the record", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ issuer_id: OTHER_ISSUER })),
      "issuer_untrusted",
    );
  });

  it("rejects an issuer key that disagrees with the cached record", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ issuer_pub_key: OTHER_ISSUER_PUB })),
      "issuer_key_mismatch",
    );
  });

  it("rejects an issuer the snapshot has no key for", async () => {
    const { instance } = verifier({
      issuerKeys: { [OTHER_ISSUER]: [OTHER_ISSUER_PUB] },
    });

    await expectFailure(await instance.verify(presentation()), "issuer_key_missing");
  });

  it("rejects a key that is not accepted for the issuer", async () => {
    const { instance } = verifier({
      issuerKeys: { [ISSUER]: [`0x${"cc".repeat(64)}`] },
      claims: [claim({ issuer_pub_key: OTHER_ISSUER_PUB })],
    });

    await expectFailure(
      await instance.verify(presentation({ issuer_pub_key: OTHER_ISSUER_PUB })),
      "issuer_key_mismatch",
    );
  });

  it("requires an issuer key when the snapshot carries accepted keys", async () => {
    const { instance } = verifier({
      issuerKeys: { [ISSUER]: [ISSUER_PUB] },
      claims: [claim({ issuer_pub_key: undefined })],
    });

    await expectFailure(
      await instance.verify(presentation({ issuer_pub_key: undefined })),
      "issuer_key_missing",
    );
  });

  it("rejects an issuer key that is absent from the public inputs", async () => {
    const { instance } = verifier({
      issuerKeys: { [ISSUER]: [OTHER_ISSUER_PUB] },
      claims: [claim({ issuer_pub_key: OTHER_ISSUER_PUB })],
    });

    await expectFailure(
      await instance.verify(presentation({ issuer_pub_key: OTHER_ISSUER_PUB })),
      "public_inputs_mismatch",
    );
  });

  it("accepts an issuer key that is accepted and bound in the public inputs", async () => {
    const { instance } = verifier({ issuerKeys: { [ISSUER]: [ISSUER_PUB] } });

    await expect(instance.verify(presentation())).resolves.toMatchObject({
      valid: true,
      issuerId: ISSUER,
    });
  });

  it("binds an issuer key in the byte-expanded layout bb.js emits", async () => {
    // @aztec/bb.js flattens a Noir `[u8; 32]` public input into 32 single-byte
    // fields, so issuer_x and issuer_y never appear as two packed 32-byte
    // fields in a real proof. Regression guard for the offline verifier
    // rejecting every genuinely valid presentation.
    const expanded = (hex: string) =>
      (hex.match(/.{2}/g) ?? []).map((byte) => byte.padStart(64, "0"));
    const { instance } = verifier({ issuerKeys: { [ISSUER]: [ISSUER_PUB] } });

    const result = await instance.verify(
      presentation({
        public_inputs: `0x${[
          COMMITMENT,
          ...expanded(ISSUER_X),
          ...expanded(ISSUER_Y),
          (19).toString(16).padStart(64, "0"),
        ].join("")}`,
      }),
    );

    expect(result).toMatchObject({ valid: true, issuerId: ISSUER });
  });

  it("requires a bound issuer key when trustedIssuers is configured without a snapshot key set", async () => {
    const { instance } = verifier(
      { claims: [claim({ issuer_pub_key: undefined })] },
      {},
      { trustedIssuers: [ISSUER] },
    );

    await expectFailure(
      await instance.verify(presentation({ issuer_pub_key: undefined })),
      "issuer_key_missing",
    );
  });
});

// ── Merkle root, threshold, nullifier ───────────────────────────────────────

describe("offline verification — Merkle root", () => {
  it("rejects a root that disagrees with the snapshot", async () => {
    const { instance } = verifier({ merkleRoot: MERKLE_ROOT });

    await expectFailure(
      await instance.verify(presentation({ merkle_root: OTHER_ROOT })),
      "merkle_root_mismatch",
    );
  });

  it("rejects a root absent from the public inputs", async () => {
    const { instance } = verifier({ merkleRoot: OTHER_ROOT });

    await expectFailure(
      await instance.verify(presentation({ merkle_root: OTHER_ROOT })),
      "public_inputs_mismatch",
    );
  });

  it("accepts a matching root that is bound in the public inputs", async () => {
    const { instance } = verifier({ merkleRoot: MERKLE_ROOT });

    await expect(
      instance.verify(presentation({ merkle_root: MERKLE_ROOT })),
    ).resolves.toMatchObject({ valid: true });
  });
});

describe("offline verification — thresholds", () => {
  it("rejects a record below the presentation threshold", async () => {
    const { instance } = verifier({ claims: [claim({ threshold: 16 })] });

    await expectFailure(await instance.verify(presentation()), "threshold_not_met");
  });

  it("rejects a record with no threshold when one is required", async () => {
    const { instance } = verifier({ claims: [claim({ threshold: null })] });

    await expectFailure(await instance.verify(presentation()), "threshold_not_met");
  });

  it("falls back to the per-type minimum threshold", async () => {
    const { instance } = verifier(
      { claims: [claim({ threshold: 17 })] },
      {},
      { minThresholds: { age: 18 } },
    );

    await expectFailure(
      await instance.verify(presentation({ min_threshold: undefined })),
      "threshold_not_met",
    );
  });

  it("accepts a threshold equal to the record's", async () => {
    const { instance } = verifier({ claims: [claim({ threshold: 18 })] });

    await expect(instance.verify(presentation())).resolves.toMatchObject({ valid: true });
  });
});

describe("offline verification — nullifiers", () => {
  it("rejects a nullifier already consumed in the application context", async () => {
    const { instance } = verifier({
      nullifiers: [{ app_context: APP_CONTEXT, nullifier: NULLIFIER }],
    });

    await expectFailure(
      await instance.verify(presentation({ app_context: APP_CONTEXT, nullifier: NULLIFIER })),
      "nullifier_reused",
    );
  });

  it("accepts an unused nullifier", async () => {
    const { instance } = verifier({
      nullifiers: [{ app_context: APP_CONTEXT, nullifier: NULLIFIER }],
    });

    await expect(
      instance.verify(presentation({ app_context: APP_CONTEXT, nullifier: OTHER_NULLIFIER })),
    ).resolves.toMatchObject({ valid: true });
  });

  it("treats the same nullifier in another app context as unused", async () => {
    const { instance } = verifier({
      nullifiers: [{ app_context: APP_CONTEXT, nullifier: NULLIFIER }],
    });

    await expect(
      instance.verify(presentation({ app_context: OTHER_ROOT, nullifier: NULLIFIER })),
    ).resolves.toMatchObject({ valid: true });
  });

  it("requires app_context and nullifier together", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ app_context: APP_CONTEXT })),
      "invalid_presentation",
    );
    await expectFailure(
      await instance.verify(presentation({ nullifier: NULLIFIER })),
      "invalid_presentation",
    );
  });

  it("rejects a malformed application context", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ app_context: "not-hex", nullifier: NULLIFIER })),
      "invalid_presentation",
    );
  });
});

// ── Malformed presentations ─────────────────────────────────────────────────

describe("offline verification — malformed presentations", () => {
  it("rejects a proof of the wrong length", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ proof: new Uint8Array(10) })),
      "invalid_presentation",
    );
  });

  it("rejects public inputs that are not whole field elements", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ public_inputs: "0x1234" })),
      "invalid_presentation",
    );
  });

  it("rejects an empty holder", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ holder: "" })),
      "invalid_presentation",
    );
  });

  it("rejects a missing credential type", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ credential_type: "" })),
      "invalid_presentation",
    );
  });

  it("rejects vk_version 0, the contract's 'no version' sentinel", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ vk_version: 0 })),
      "invalid_presentation",
    );
  });

  it("rejects a negative threshold", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ min_threshold: -1 })),
      "invalid_presentation",
    );
  });

  it("rejects a commitment of the wrong size", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ commitment: "0x1234" })),
      "invalid_presentation",
    );
  });

  it("rejects a non-octet in a number-array proof", async () => {
    const { instance } = verifier();

    const badProof = Array.from(PROOF);
    badProof[0] = 999;

    await expectFailure(
      await instance.verify(presentation({ proof: badProof })),
      "invalid_presentation",
    );
  });

  it("rejects an odd-length hex proof", async () => {
    const { instance } = verifier();

    await expectFailure(
      await instance.verify(presentation({ proof: "0xabc" })),
      "invalid_presentation",
    );
  });
});

// ── Local proof backend ─────────────────────────────────────────────────────

describe("offline verification — local proof backend", () => {
  it("rejects an invalid proof", async () => {
    const { instance } = verifier({}, {}, { proofVerifier: async () => false });

    await expectFailure(await instance.verify(presentation()), "proof_invalid");
  });

  it("maps a backend crash to proof_backend_error", async () => {
    const { instance } = verifier(
      {},
      {},
      {
        proofVerifier: async () => {
          throw new Error("wasm trap");
        },
      },
    );

    const result = await instance.verify(presentation());

    await expectFailure(result, "proof_backend_error");
    expect(result.valid ? "" : result.message).toContain("wasm trap");
  });

  it("preserves a typed backend error code", async () => {
    const { instance } = verifier(
      {},
      {},
      {
        proofVerifier: async () => {
          throw new OfflineVerificationError("proof_backend_missing", "no verifier");
        },
      },
    );

    await expectFailure(await instance.verify(presentation()), "proof_backend_missing");
  });

  it("fails closed when the built-in verifier has no circuit bytecode", async () => {
    const instance = createOfflineVerifier({
      verifierKeys: keys(),
      stateSnapshot: snapshot(),
      now: NOW,
    });

    const result = await instance.verify(presentation());

    await expectFailure(result, "proof_backend_missing");
    expect(result.valid ? "" : result.message).toContain("circuit_bytecode");
  });
});

describe("createBbJsProofVerifier", () => {
  it("passes the cached key, proof and hex public inputs to bb.js", async () => {
    const calls: Array<{
      bytecode: string;
      proof: Uint8Array;
      publicInputs: string[];
      options: Record<string, unknown> | undefined;
    }> = [];
    let destroyed = 0;

    class UltraHonkBackend {
      constructor(private readonly bytecode: string) {}

      async verifyProof(
        proofData: { proof: Uint8Array; publicInputs: string[] },
        options?: Record<string, unknown>,
      ): Promise<boolean> {
        calls.push({
          bytecode: this.bytecode,
          proof: proofData.proof,
          publicInputs: proofData.publicInputs,
          options,
        });
        return true;
      }

      async destroy(): Promise<void> {
        destroyed += 1;
      }
    }

    const verifier = createBbJsProofVerifier(
      async () =>
        ({
          UltraHonkBackend,
        }) as unknown as BbJsModuleLike,
    );

    const ok = await verifier({
      verifierKey: new Uint8Array(32),
      proof: PROOF,
      publicInputs: Uint8Array.from(
        (PUBLIC_INPUTS.replace(/^0x/, "").match(/.{64}/g) ?? []).flatMap((field) =>
          Array.from({ length: 32 }, (_, index) =>
            parseInt(field.slice(index * 2, index * 2 + 2), 16),
          ),
        ),
      ),
      credentialType: "age",
      vkVersion: 1,
      circuitBytecode: "base64-circuit-bytecode",
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].bytecode).toBe("base64-circuit-bytecode");
    expect(calls[0].publicInputs).toEqual([
      `0x${COMMITMENT}`,
      `0x${ISSUER_X}`,
      `0x${ISSUER_Y}`,
      `0x${MERKLE_ROOT}`,
    ]);
    expect(calls[0].options).toEqual({ keccak: true });
    expect(destroyed).toBe(1);
  });

  it("fails with proof_backend_missing when bb.js cannot be loaded", async () => {
    const verifier = createBbJsProofVerifier(async () => {
      throw new Error("module not found");
    });

    await expect(
      verifier({
        verifierKey: new Uint8Array(32),
        proof: PROOF,
        publicInputs: new Uint8Array(OFFLINE_FIELD_BYTES),
        credentialType: "age",
        vkVersion: 1,
        circuitBytecode: "bytecode",
      }),
    ).rejects.toMatchObject({ code: "proof_backend_missing" });
  });

  it("fails with proof_backend_missing when no circuit bytecode is cached", async () => {
    const verifier = createBbJsProofVerifier(async () => ({}) as BbJsModuleLike);

    await expect(
      verifier({
        verifierKey: new Uint8Array(32),
        proof: PROOF,
        publicInputs: new Uint8Array(OFFLINE_FIELD_BYTES),
        credentialType: "age",
        vkVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "proof_backend_missing" });
  });

  it("destroys the backend even when verification throws", async () => {
    let destroyed = 0;

    class UltraHonkBackend {
      async verifyProof(): Promise<boolean> {
        throw new Error("verify failed");
      }

      async destroy(): Promise<void> {
        destroyed += 1;
      }
    }

    const verifier = createBbJsProofVerifier(
      async () =>
        ({
          UltraHonkBackend,
        }) as unknown as BbJsModuleLike,
    );

    await expect(
      verifier({
        verifierKey: new Uint8Array(32),
        proof: PROOF,
        publicInputs: new Uint8Array(OFFLINE_FIELD_BYTES),
        credentialType: "age",
        vkVersion: 1,
        circuitBytecode: "bytecode",
      }),
    ).rejects.toThrow("verify failed");
    expect(destroyed).toBe(1);
  });
});

// ── Cache validation ────────────────────────────────────────────────────────

describe("offline verifier — cache validation", () => {
  function expectConfigError(build: () => unknown, code = "invalid_state_snapshot"): void {
    try {
      build();
      throw new Error("expected createOfflineVerifier to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfflineVerificationError);
      expect((err as OfflineVerificationError).code).toBe(code);
    }
  }

  it("rejects an unsupported snapshot version", () => {
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot({ snapshotVersion: 2 }),
      }),
    );
  });

  it("rejects a missing capture time", () => {
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot({ capturedAt: undefined as unknown as number }),
      }),
    );
  });

  it("rejects a non-array claims collection", () => {
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot({ claims: "nope" as unknown as [] }),
      }),
    );
  });

  it.each([
    ["wallet", { wallet: "" }],
    ["credential_type", { credential_type: "" }],
    ["verified_at", { verified_at: undefined as unknown as number }],
    ["expiry", { expiry: undefined as unknown as number }],
    ["revoked", { revoked: 2 }],
    ["threshold", { threshold: -5 }],
    ["commitment", { commitment: "zz" }],
    ["issuer_pub_key", { issuer_pub_key: "0x1234" }],
    ["vk_version", { vk_version: 0 }],
  ])("rejects a malformed claim field: %s", (_field, overrides) => {
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot({
          claims: [claim(overrides as Partial<OfflineSnapshotClaim>)],
        }),
      }),
    );
  });

  it("rejects malformed nullifier entries", () => {
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot({
          nullifiers: [{ app_context: "0x12", nullifier: NULLIFIER }],
        }),
      }),
    );
  });

  it("rejects malformed issuer key sets", () => {
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot({
          issuerKeys: { [ISSUER]: ["0x1234"] },
        }),
      }),
    );
  });

  it("rejects malformed revocation entries", () => {
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot({ revokedCommitments: ["0x12"] }),
      }),
    );
  });

  it("rejects malformed verifier keys", () => {
    expectConfigError(
      () =>
        createOfflineVerifier({
          verifierKeys: [{ credential_type: "age", vk_version: 0, vk: VK }],
          stateSnapshot: snapshot(),
        }),
      "invalid_verifier_key",
    );
    expectConfigError(
      () =>
        createOfflineVerifier({
          verifierKeys: [],
          stateSnapshot: snapshot(),
        }),
      "invalid_verifier_key",
    );
    expectConfigError(
      () =>
        createOfflineVerifier({
          verifierKeys: [
            { credential_type: "age", vk_version: 1, vk: VK },
            { credential_type: "age", vk_version: 1, vk: OTHER_VK },
          ],
          stateSnapshot: snapshot(),
        }),
      "invalid_verifier_key",
    );
  });

  it("rejects invalid option values", () => {
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot(),
        maxSnapshotAgeSeconds: 0,
      }),
    );
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot(),
        minThresholds: { age: -1 },
      }),
    );
    expectConfigError(() =>
      createOfflineVerifier({
        verifierKeys: keys(),
        stateSnapshot: snapshot(),
        trustedIssuers: "GBBB" as unknown as string[],
      }),
    );
  });

  it("returns an invalid_presentation result when verifyAll receives a non-array", async () => {
    const { instance } = verifier();

    const results = await instance.verifyAll(undefined as unknown as OfflinePresentation[]);

    await expectFailure(results[0], "invalid_presentation");
  });
});

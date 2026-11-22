import { describe, it, expect, vi } from "vitest";
import {
  verifyOfflinePresentation,
  sha256Hex,
  type OfflineVerifyParams,
} from "./offline";

const NOW = 1_700_000_000;
const WALLET = "GABC";

async function build(overrides: Partial<OfflineVerifyParams> = {}): Promise<OfflineVerifyParams> {
  const key = "vk-bytes";
  return {
    presentation: { wallet: WALLET, claim: "kyc", proof: "proof", publicInputs: ["1"], nullifier: "n1" },
    verifierKey: { key, hash: await sha256Hex(key) },
    snapshot: {
      takenAt: NOW - 60,
      records: { [WALLET]: { kyc: { verifiedAt: NOW - 1000, expiry: NOW + 1000, revoked: false, issuer: "I1", threshold: 5 } } },
      usedNullifiers: [],
    },
    verifyProof: vi.fn().mockResolvedValue(true),
    now: NOW,
    ...overrides,
  };
}

describe("verifyOfflinePresentation (#1059)", () => {
  it("accepts a valid presentation without touching the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const p = await build();
    const r = await verifyOfflinePresentation(p);
    expect(r.ok).toBe(true);
    expect(r.snapshotAgeSec).toBe(60);
    expect(p.verifyProof).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects malformed input", async () => {
    const p = await build();
    const r = await verifyOfflinePresentation({ ...p, presentation: { ...p.presentation, claim: "bogus" as never } });
    expect(r.failureReason).toBe("malformed_input");
  });

  it("rejects stale and future snapshots", async () => {
    const p = await build();
    const stale = await verifyOfflinePresentation({ ...p, snapshot: { ...p.snapshot, takenAt: NOW - 100_000 } });
    expect(stale.failureReason).toBe("snapshot_stale");
    const future = await verifyOfflinePresentation({ ...p, snapshot: { ...p.snapshot, takenAt: NOW + 10_000 } });
    expect(future.failureReason).toBe("snapshot_from_future");
  });

  it("rejects a tampered verifier key or snapshot-pinned hash mismatch", async () => {
    const p = await build();
    const tampered = await verifyOfflinePresentation({ ...p, verifierKey: { ...p.verifierKey, key: "evil" } });
    expect(tampered.failureReason).toBe("verifier_key_mismatch");
    const pinned = await verifyOfflinePresentation({
      ...p,
      snapshot: { ...p.snapshot, verifierKeyHashes: { kyc: "00" } },
    });
    expect(pinned.failureReason).toBe("verifier_key_mismatch");
    expect(p.verifyProof).not.toHaveBeenCalled();
  });

  it("rejects missing, revoked and expired records", async () => {
    const p = await build();
    const rec = p.snapshot.records[WALLET]!.kyc!;
    const missing = await verifyOfflinePresentation({ ...p, presentation: { ...p.presentation, wallet: "GXYZ" } });
    expect(missing.failureReason).toBe("not_verified");
    const proto = await verifyOfflinePresentation({ ...p, presentation: { ...p.presentation, wallet: "constructor" } });
    expect(proto.failureReason).toBe("not_verified");
    const revoked = await verifyOfflinePresentation({
      ...p,
      snapshot: { ...p.snapshot, records: { [WALLET]: { kyc: { ...rec, revoked: true } } } },
    });
    expect(revoked.failureReason).toBe("revoked");
    const expired = await verifyOfflinePresentation({ ...p, now: NOW + 5000, maxSnapshotAgeSec: 10_000 });
    expect(expired.failureReason).toBe("expired");
  });

  it("enforces issuer, threshold and nullifier policy", async () => {
    const p = await build();
    expect((await verifyOfflinePresentation({ ...p, trustedIssuers: ["other"] })).failureReason).toBe("wrong_issuer");
    expect((await verifyOfflinePresentation({ ...p, trustedIssuers: ["I1"], minThreshold: 5 })).ok).toBe(true);
    expect((await verifyOfflinePresentation({ ...p, minThreshold: 10 })).failureReason).toBe("unmet_threshold");
    const used = await verifyOfflinePresentation({ ...p, snapshot: { ...p.snapshot, usedNullifiers: ["n1"] } });
    expect(used.failureReason).toBe("nullifier_used");
  });

  it("fails closed when the proof is invalid or the verifier throws", async () => {
    const bad = await verifyOfflinePresentation(await build({ verifyProof: () => false }));
    expect(bad.failureReason).toBe("invalid_proof");
    const boom = await verifyOfflinePresentation(
      await build({ verifyProof: () => { throw new Error("wasm"); } }),
    );
    expect(boom.failureReason).toBe("invalid_proof");
  });
});

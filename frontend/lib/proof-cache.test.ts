import { describe, it, expect, beforeEach } from "vitest";
import {
  buildProofKey,
  loadProofCache,
  saveProof,
  getCachedProof,
  markProofProved,
  invalidateProof,
  cacheEntryUsable,
  entryToGeneratedProof,
} from "./proof-cache";
import type { Credential } from "./credential";

// In-memory storage so tests never touch the real localStorage.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  } as Storage;
}

const CLAIM_PARAMS: Credential["claimParams"] = { threshold: "50000" };
const KEY = buildProofKey({ type: "funds", commitment: "0xcommit", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v1" });

const PROOF = { proof: new Uint8Array([1, 2, 3, 4]), publicInputs: new Uint8Array([5, 6, 7, 8]) };

describe("buildProofKey", () => {
  it("is stable regardless of claim-param ordering", () => {
    const a = buildProofKey({ type: "jurisdiction", commitment: "c", claimParams: { restricted: ["840", "364"] }, vkVersion: "circuit-v1" });
    const b = buildProofKey({ type: "jurisdiction", commitment: "c", claimParams: { restricted: ["364", "840"] }, vkVersion: "circuit-v1" });
    expect(a).toBe(b);
  });

  it("changes when the VK version changes", () => {
    const a = buildProofKey({ type: "funds", commitment: "c", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v1" });
    const b = buildProofKey({ type: "funds", commitment: "c", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v2" });
    expect(a).not.toBe(b);
  });

  it("changes when a claim parameter changes", () => {
    const a = buildProofKey({ type: "funds", commitment: "c", claimParams: { threshold: "10000" }, vkVersion: "circuit-v1" });
    const b = buildProofKey({ type: "funds", commitment: "c", claimParams: { threshold: "50000" }, vkVersion: "circuit-v1" });
    expect(a).not.toBe(b);
  });
});

describe("proof cache reuse + invalidation", () => {
  let storage: Storage;

  beforeEach(() => { storage = memoryStorage(); });

  it("reuses a matching, valid cached proof instead of regenerating", () => {
    saveProof(KEY, { type: "funds", commitment: "0xcommit", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v1", proof: PROOF.proof, publicInputs: PROOF.publicInputs }, storage);
    const hit = getCachedProof(KEY, {}, storage);
    expect(hit).not.toBeNull();
    expect(entryToGeneratedProof(hit!)).toEqual(PROOF);
  });

  it("returns null (invalidated) when a param on the credential changes", () => {
    saveProof(KEY, { type: "funds", commitment: "0xcommit", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v1", proof: PROOF.proof, publicInputs: PROOF.publicInputs }, storage);
    const otherKey = buildProofKey({ type: "funds", commitment: "0xcommit", claimParams: { threshold: "99999" }, vkVersion: "circuit-v1" });
    expect(getCachedProof(otherKey, {}, storage)).toBeNull();
    expect(getCachedProof(KEY, {}, storage)).not.toBeNull();
  });

  it("returns null (invalidated) when the VK version changes", () => {
    saveProof(KEY, { type: "funds", commitment: "0xcommit", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v1", proof: PROOF.proof, publicInputs: PROOF.publicInputs }, storage);
    const newVk = buildProofKey({ type: "funds", commitment: "0xcommit", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v2" });
    expect(getCachedProof(newVk, {}, storage)).toBeNull();
  });

  it("refuses reuse once the on-chain record expires", () => {
    saveProof(KEY, { type: "funds", commitment: "0xcommit", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v1", proof: PROOF.proof, publicInputs: PROOF.publicInputs }, storage);
    const now = Math.floor(Date.now() / 1000);
    markProofProved(KEY, { ttlSecs: 90 * 86400 }, storage);
    const entry = loadProofCache(storage)[0];
    // Still valid the moment it was confirmed (now < provedAt + 90d).
    expect(cacheEntryUsable(entry, { now })).toBe(true);
    // Invalidated once the clock passes the on-chain expiry.
    expect(cacheEntryUsable(entry, { now: now + 91 * 86400 })).toBe(false);
  });

  it("refuses reuse when the on-chain record is revoked / no longer valid", () => {
    saveProof(KEY, { type: "funds", commitment: "0xcommit", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v1", proof: PROOF.proof, publicInputs: PROOF.publicInputs }, storage);
    expect(getCachedProof(KEY, { onChainStillValid: false }, storage)).toBeNull();
  });

  it("still reuses when on-chain is confirmed valid", () => {
    saveProof(KEY, { type: "funds", commitment: "0xcommit", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v1", proof: PROOF.proof, publicInputs: PROOF.publicInputs }, storage);
    expect(getCachedProof(KEY, { onChainStillValid: true }, storage)).not.toBeNull();
  });

  it("invalidates a proof on demand (revocation path)", () => {
    saveProof(KEY, { type: "funds", commitment: "0xcommit", claimParams: CLAIM_PARAMS, vkVersion: "circuit-v1", proof: PROOF.proof, publicInputs: PROOF.publicInputs }, storage);
    invalidateProof(KEY, storage);
    expect(getCachedProof(KEY, {}, storage)).toBeNull();
  });

  it("keeps proofs for multiple credentials independent", () => {
    const keyA = buildProofKey({ type: "kyc", commitment: "0xA", vkVersion: "circuit-v1" });
    const keyB = buildProofKey({ type: "income", commitment: "0xB", claimParams: { threshold: "200000" }, vkVersion: "circuit-v1" });
    saveProof(keyA, { type: "kyc", commitment: "0xA", vkVersion: "circuit-v1", proof: PROOF.proof, publicInputs: PROOF.publicInputs }, storage);
    saveProof(keyB, { type: "income", commitment: "0xB", claimParams: { threshold: "200000" }, vkVersion: "circuit-v1", proof: PROOF.proof, publicInputs: PROOF.publicInputs }, storage);
    expect(getCachedProof(keyA, {}, storage)?.commitment).toBe("0xA");
    expect(getCachedProof(keyB, {}, storage)?.commitment).toBe("0xB");
  });
});
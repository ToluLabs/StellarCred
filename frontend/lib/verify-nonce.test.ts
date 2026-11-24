import { describe, it, expect, beforeEach } from "vitest";
import {
  consumeVerifyNonce,
  isVerifyNonceConsumed,
  pruneConsumed,
  __clearVerifyNoncesForTesting,
} from "./verify-nonce";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

beforeEach(() => {
  (globalThis as any).window = { sessionStorage: new MemStorage() };
  __clearVerifyNoncesForTesting();
});

describe("pruneConsumed", () => {
  it("keeps never-expiring entries and drops past ones", () => {
    const map = {
      a: { consumedAt: 1, expiresAt: 0 },
      b: { consumedAt: 1, expiresAt: 100 },
      c: { consumedAt: 1, expiresAt: 50 },
    };
    const out = pruneConsumed(map, 200);
    expect(Object.keys(out).sort()).toEqual(["a"]);
  });
});

describe("consumeVerifyNonce", () => {
  it("first consume succeeds, second is rejected", () => {
    expect(consumeVerifyNonce("tok_abcdefgh", 0)).toBe(true);
    expect(consumeVerifyNonce("tok_abcdefgh", 0)).toBe(false);
  });

  it("links without a jti are always reusable", () => {
    expect(consumeVerifyNonce("", 0)).toBe(true);
    expect(consumeVerifyNonce("", 0)).toBe(true);
  });

  it("an expired jti is pruned and no longer blocks", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(consumeVerifyNonce("tok_abcdefgh", now - 10, now - 20)).toBe(true);
    expect(isVerifyNonceConsumed("tok_abcdefgh", now + 100)).toBe(false);
  });
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  eraseCredentials,
  type EraseResult,
} from "../credential-erasure";
import { CREDENTIALS_KEY, STORAGE_KEYS } from "../storage-keys";

describe("credential-erasure", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("eraseCredentials", () => {
    it("removes every managed credential-related key", () => {
      // Seed every managed key so the erasure has something to remove.
      const seed: Record<string, string> = {
        [STORAGE_KEYS.CREDENTIALS]: JSON.stringify([
          { id: "cred-1", value: "enc", salt: "salt" },
        ]),
        [STORAGE_KEYS.PROOF_CACHE]: "{}",
        [STORAGE_KEYS.ONBOARDING]: "step=2",
        [STORAGE_KEYS.ONBOARDING_LEGACY]: "true",
        [STORAGE_KEYS.THEME]: "dark",
        [STORAGE_KEYS.EXPORT_VISIBILITY]: "[]",
        [STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED]: "true",
      };

      for (const [key, value] of Object.entries(seed)) {
        localStorage.setItem(key, value);
      }

      const result = eraseCredentials();

      expect(result.success).toBe(true);
      expect(result.locationsRemoved).toBeGreaterThan(0);
      for (const key of Object.keys(seed)) {
        expect(localStorage.getItem(key)).toBeNull();
      }
    });

    it("is idempotent when no credential data exists", async () => {
      const result = await eraseCredentials();
      expect(result.success).toBe(true);
      expect(result.locationsRemoved).toBe(0);
      expect(result.perLocation[CREDENTIALS_KEY]).toEqual({
        removed: false,
        hadData: false,
      });
    });

    it("reports partial failure when a removal throws", async () => {
      // Make one of the managed keys throw on removal. We do this by
      // replacing removeItem with a failing version for a single key.
      const originalRemoveItem = localStorage.removeItem.bind(localStorage);
      let threw = false;
      localStorage.removeItem = function (key: string) {
        if (key === STORAGE_KEYS.ONBOARDING) {
          threw = true;
          throw new DOMException("QuotaExceededError");
        }
        return originalRemoveItem(key);
      };

      try {
        const result = await eraseCredentials();
        expect(result.success).toBe(false);
        expect(result.perLocation[STORAGE_KEYS.ONBOARDING]).toEqual({
          removed: false,
          hadData: false,
        });
        // Other keys should have been removed despite the failure.
        expect(result.perLocation[STORAGE_KEYS.CREDENTIALS]).toEqual({
          removed: true,
          hadData: true,
        });
        expect(threw).toBe(true);
      } finally {
        localStorage.removeItem = originalRemoveItem;
      }
    });

    it("returns a failure when localStorage is unavailable", async () => {
      const originalLocalStorage = globalThis.localStorage;
      // @ts-expect-error — simulating unavailable storage for the test.
      delete (globalThis as { localStorage?: Storage }).localStorage;

      try {
        const result = await eraseCredentials();
        expect(result.success).toBe(false);
        expect(result.message).toContain("unavailable");
        expect(result.locationsRemoved).toBe(0);
      } finally {
        globalThis.localStorage = originalLocalStorage;
      }
    });
  });
});

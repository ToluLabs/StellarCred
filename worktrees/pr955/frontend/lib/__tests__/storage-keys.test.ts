import { describe, expect, it } from "vitest";
import {
  CREDENTIALS_KEY,
  ALL_STORAGE_KEYS,
  getStorageKeyName,
  isStellarCredKey,
  STORAGE_KEYS,
} from "../storage-keys";

describe("storage-keys", () => {
  describe("CREDENTIALS_KEY", () => {
    it("points at the private credential envelope", () => {
      expect(CREDENTIALS_KEY).toBe(STORAGE_KEYS.CREDENTIALS);
    });
  });

  describe("ALL_STORAGE_KEYS", () => {
    it("includes a deterministic, ordered list", () => {
      const expected = [
        STORAGE_KEYS.CREDENTIALS,
        STORAGE_KEYS.EXPORT_VISIBILITY,
        STORAGE_KEYS.PROOF_CACHE,
        STORAGE_KEYS.ONBOARDING,
        STORAGE_KEYS.ONBOARDING_LEGACY,
        STORAGE_KEYS.WALLET_ID,
        STORAGE_KEYS.THEME,
        STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED,
        "proofTimeline:commitment1",
        "proofTimeline:commitment2",
      ] as const;

      expect(ALL_STORAGE_KEYS).toEqual(expected);
    });
  });

  describe("isStellarCredKey", () => {
    it("recognises owned keys", () => {
      expect(isStellarCredKey(STORAGE_KEYS.CREDENTIALS)).toBe(true);
      expect(isStellarCredKey(STORAGE_KEYS.EXPORT_VISIBILITY)).toBe(true);
      expect(isStellarCredKey(STORAGE_KEYS.PROOF_CACHE)).toBe(true);
      expect(isStellarCredKey(STORAGE_KEYS.ONBOARDING)).toBe(true);
      expect(isStellarCredKey(STORAGE_KEYS.ONBOARDING_LEGACY)).toBe(true);
      expect(isStellarCredKey(STORAGE_KEYS.WALLET_ID)).toBe(true);
      expect(isStellarCredKey(STORAGE_KEYS.THEME)).toBe(true);
      expect(isStellarCredKey(STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED)).toBe(true);
    });

    it("rejects unknown keys", () => {
      expect(isStellarCredKey("random-key")).toBe(false);
      expect(isStellarCredKey("other-app:data")).toBe(false);
      expect(isStellarCredKey("")).toBe(false);
    });
  });

  describe("getStorageKeyName", () => {
    it("maps owned keys to their display names", () => {
      expect(getStorageKeyName(STORAGE_KEYS.CREDENTIALS)).toBe("credentials");
      expect(getStorageKeyName(STORAGE_KEYS.EXPORT_VISIBILITY)).toBe(
        "export-visibility",
      );
      expect(getStorageKeyName(STORAGE_KEYS.PROOF_CACHE)).toBe("proof-cache");
      expect(getStorageKeyName(STORAGE_KEYS.ONBOARDING)).toBe("onboarding");
      expect(getStorageKeyName(STORAGE_KEYS.ONBOARDING_LEGACY)).toBe(
        "onboarding-legacy",
      );
      expect(getStorageKeyName(STORAGE_KEYS.WALLET_ID)).toBe("wallet-id");
      expect(getStorageKeyName(STORAGE_KEYS.THEME)).toBe("theme");
      expect(
        getStorageKeyName(STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED),
      ).toBe("onboarding-nudge-dismissed");
    });

    it("maps timeline keys by prefix", () => {
      expect(getStorageKeyName("proofTimeline:abc")).toBe("abc");
      expect(getStorageKeyName("proofTimeline:def-ghi")).toBe("def-ghi");
    });

    it("returns null for non-owned keys", () => {
      expect(getStorageKeyName("other-app:data")).toBeNull();
      expect(getStorageKeyName("")).toBeNull();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wipeAllData, getWipeSummary } from "@/lib/data-wipe";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { unlockCredentialStore, saveCredential, type Credential } from "@/lib/credential";

describe("data-wipe", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("getWipeSummary", () => {
    it("returns false for all categories when storage is empty", () => {
      const summary = getWipeSummary();
      expect(summary.credentials).toBe(false);
      expect(summary.proofCache).toBe(false);
      expect(summary.timelines).toBe(0);
      expect(summary.onboarding).toBe(false);
      expect(summary.wallet).toBe(false);
      expect(summary.theme).toBe(false);
    });

    it("detects credentials", () => {
      localStorage.setItem(STORAGE_KEYS.CREDENTIALS, "encrypted-data");
      const summary = getWipeSummary();
      expect(summary.credentials).toBe(true);
    });

    it("detects proof cache", () => {
      localStorage.setItem(STORAGE_KEYS.PROOF_CACHE, "[]");
      const summary = getWipeSummary();
      expect(summary.proofCache).toBe(true);
    });

    it("counts timeline keys", () => {
      localStorage.setItem("proofTimeline:c1", "{}");
      localStorage.setItem("proofTimeline:c2", "{}");
      localStorage.setItem("proofTimeline:c3", "{}");
      const summary = getWipeSummary();
      expect(summary.timelines).toBe(3);
    });

    it("detects onboarding state (current and legacy)", () => {
      localStorage.setItem(STORAGE_KEYS.ONBOARDING, "{}");
      let summary = getWipeSummary();
      expect(summary.onboarding).toBe(true);

      localStorage.clear();
      localStorage.setItem(STORAGE_KEYS.ONBOARDING_LEGACY, "1");
      summary = getWipeSummary();
      expect(summary.onboarding).toBe(true);
    });

    it("detects wallet connection", () => {
      localStorage.setItem(STORAGE_KEYS.WALLET_ID, "freighter");
      const summary = getWipeSummary();
      expect(summary.wallet).toBe(true);
    });

    it("detects theme preference", () => {
      localStorage.setItem(STORAGE_KEYS.THEME, "dark");
      const summary = getWipeSummary();
      expect(summary.theme).toBe(true);
    });

    it("reports comprehensive summary with mixed data", () => {
      localStorage.setItem(STORAGE_KEYS.CREDENTIALS, "encrypted");
      localStorage.setItem(STORAGE_KEYS.PROOF_CACHE, "[]");
      localStorage.setItem("proofTimeline:c1", "{}");
      localStorage.setItem("proofTimeline:c2", "{}");
      localStorage.setItem(STORAGE_KEYS.ONBOARDING, "{}");
      localStorage.setItem(STORAGE_KEYS.WALLET_ID, "freighter");
      localStorage.setItem(STORAGE_KEYS.THEME, "light");

      const summary = getWipeSummary();
      expect(summary.credentials).toBe(true);
      expect(summary.proofCache).toBe(true);
      expect(summary.timelines).toBe(2);
      expect(summary.onboarding).toBe(true);
      expect(summary.wallet).toBe(true);
      expect(summary.theme).toBe(true);
    });
  });

  describe("wipeAllData", () => {
    it("removes all StellarCred storage keys", async () => {
      // Populate storage with StellarCred data
      localStorage.setItem(STORAGE_KEYS.CREDENTIALS, "encrypted");
      localStorage.setItem(STORAGE_KEYS.PROOF_CACHE, "[]");
      localStorage.setItem("proofTimeline:c1", "{}");
      localStorage.setItem("proofTimeline:c2", "{}");
      localStorage.setItem(STORAGE_KEYS.ONBOARDING, "{}");
      localStorage.setItem(STORAGE_KEYS.WALLET_ID, "freighter");
      localStorage.setItem(STORAGE_KEYS.THEME, "dark");
      localStorage.setItem("unrelated-key", "should-remain");

      const result = await wipeAllData({ skipBackupPrompt: true });

      expect(result.success).toBe(true);
      expect(result.keysRemoved).toBeGreaterThan(0);
      
      // StellarCred keys should be removed
      expect(localStorage.getItem(STORAGE_KEYS.CREDENTIALS)).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.PROOF_CACHE)).toBeNull();
      expect(localStorage.getItem("proofTimeline:c1")).toBeNull();
      expect(localStorage.getItem("proofTimeline:c2")).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.ONBOARDING)).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.WALLET_ID)).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.THEME)).toBeNull();
      
      // Unrelated keys should remain
      expect(localStorage.getItem("unrelated-key")).toBe("should-remain");
    });

    it("reports correct number of keys removed", async () => {
      localStorage.setItem(STORAGE_KEYS.CREDENTIALS, "data");
      localStorage.setItem(STORAGE_KEYS.PROOF_CACHE, "[]");
      localStorage.setItem("proofTimeline:c1", "{}");
      localStorage.setItem(STORAGE_KEYS.THEME, "dark");

      const result = await wipeAllData({ skipBackupPrompt: true });

      expect(result.success).toBe(true);
      // Should remove: credentials, proof_cache, timeline:c1, onboarding (even if empty),
      // onboarding_legacy, wallet_id, theme = 7 keys enumerated, 4 actually present
      expect(result.keysRemoved).toBe(4);
    });

    it("handles empty storage gracefully", async () => {
      const result = await wipeAllData({ skipBackupPrompt: true });
      
      expect(result.success).toBe(true);
      expect(result.keysRemoved).toBe(0);
    });

    it("clears credentials and locks store even without backup", async () => {
      await unlockCredentialStore("test-pass");
      
      const cred: Credential = {
        type: "kyc",
        title: "Test",
        claim: "test",
        issuer: "Test",
        issuerId: "test",
        holder: "TEST",
        value: "123",
        salt: "0x123",
        commitment: "0xabc",
        sig: [1, 2, 3],
        issuerPubX: [4, 5, 6],
        issuerPubY: [7, 8, 9],
        issuedAt: 1700000000,
        expiry: "30 days",
      };
      
      await saveCredential(cred);
      
      // Verify credential was saved
      expect(localStorage.getItem(STORAGE_KEYS.CREDENTIALS)).toBeTruthy();
      
      const result = await wipeAllData({ skipBackupPrompt: true });
      
      expect(result.success).toBe(true);
      expect(localStorage.getItem(STORAGE_KEYS.CREDENTIALS)).toBeNull();
    });

    it("only removes enumerated StellarCred keys, not all localStorage", async () => {
      // Add StellarCred keys
      localStorage.setItem(STORAGE_KEYS.CREDENTIALS, "data");
      localStorage.setItem(STORAGE_KEYS.THEME, "dark");
      
      // Add keys from other apps/features
      localStorage.setItem("other-app-data", "preserve-me");
      localStorage.setItem("random-key", "keep-this");
      
      await wipeAllData({ skipBackupPrompt: true });
      
      // StellarCred keys removed
      expect(localStorage.getItem(STORAGE_KEYS.CREDENTIALS)).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.THEME)).toBeNull();
      
      // Other keys preserved
      expect(localStorage.getItem("other-app-data")).toBe("preserve-me");
      expect(localStorage.getItem("random-key")).toBe("keep-this");
    });

    it("continues removing keys even if one fails", async () => {
      localStorage.setItem(STORAGE_KEYS.CREDENTIALS, "data1");
      localStorage.setItem(STORAGE_KEYS.THEME, "dark");
      localStorage.setItem(STORAGE_KEYS.WALLET_ID, "freighter");

      // Mock removeItem to fail for one key
      const originalRemoveItem = localStorage.removeItem;
      vi.spyOn(localStorage, "removeItem").mockImplementation((key: string) => {
        if (key === STORAGE_KEYS.CREDENTIALS) {
          throw new Error("Simulated removal failure");
        }
        originalRemoveItem.call(localStorage, key);
      });

      const result = await wipeAllData({ skipBackupPrompt: true });

      // Should still succeed and report keys that were removed
      expect(result.success).toBe(true);
      expect(result.keysRemoved).toBeGreaterThan(0);

      vi.restoreAllMocks();
    });
  });
});

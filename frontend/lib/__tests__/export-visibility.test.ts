import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportHistoryAsCsv, exportHistoryAsJson } from "@/lib/export-history";
import { exportCredentials, type Credential } from "@/lib/credential";
import {
  DEFAULT_EXPORT_VISIBILITY_PREFERENCES,
  getExportVisibilityPreferences,
  saveExportVisibilityPreferences,
} from "@/lib/export-visibility";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { buildTransferUrl } from "@/lib/transfer";
import { decryptWithPassphrase } from "@/lib/credential-crypto";

const PASSPHRASE = "transfer-test-passphrase";

function credential(commitment: string, value: string, holder: string): Credential {
  return {
    type: "kyc",
    title: "KYC Complete",
    claim: "identity verified",
    issuer: "Test Issuer",
    issuerId: "issuer-1",
    holder,
    value,
    salt: "0xabc123",
    commitment,
    sig: Array(64).fill(1),
    issuerPubX: Array(32).fill(2),
    issuerPubY: Array(32).fill(3),
    issuedAt: 1700000000,
    expiry: "30 days",
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("export visibility preferences", () => {
  it("defaults existing profiles to including every field", () => {
    expect(getExportVisibilityPreferences()).toEqual({
      value: true,
      holder: true,
    });
    expect(DEFAULT_EXPORT_VISIBILITY_PREFERENCES).toEqual({
      value: true,
      holder: true,
    });
  });

  it("includes opted-in PII fields in credential JSON exports by default", async () => {
    const item = credential("commitment-1", "sensitive-value", "holder-1");
    localStorage.setItem("stellarcred:credentials", JSON.stringify([item]));

    const exported = JSON.parse(await exportCredentials()) as Record<string, unknown>[];
    expect(exported[0]).toHaveProperty("value", item.value);
    expect(exported[0]).toHaveProperty("holder", item.holder);
  });

  it("reads and validates saved per-field settings", () => {
    saveExportVisibilityPreferences({ value: false, holder: true });
    expect(getExportVisibilityPreferences()).toEqual({ value: false, holder: true });

    localStorage.setItem(STORAGE_KEYS.EXPORT_VISIBILITY, JSON.stringify({ value: "no" }));
    expect(() => getExportVisibilityPreferences()).toThrow(/must be a boolean/);
  });

  it("omits only opted-out fields for every credential in the local JSON export", async () => {
    const credentials = [
      credential("commitment-1", "sensitive-value-1", "holder-1"),
      credential("commitment-2", "sensitive-value-2", "holder-2"),
    ];
    localStorage.setItem("stellarcred:credentials", JSON.stringify(credentials));
    saveExportVisibilityPreferences({ value: false, holder: true });

    const exported = JSON.parse(await exportCredentials()) as Record<string, unknown>[];
    expect(exported).toHaveLength(2);
    for (const item of exported) {
      expect(item).not.toHaveProperty("value");
      expect(item).toHaveProperty("holder");
      expect(item).toHaveProperty("commitment");
    }
  });

  it("omits opted-out fields from encrypted single-credential transfers", async () => {
    saveExportVisibilityPreferences({ value: true, holder: false });
    const url = await buildTransferUrl(
      credential("commitment-1", "sensitive-value", "holder-1"),
      PASSPHRASE,
      "https://stellarcred.test",
    );
    const payload = new URL(url).searchParams.get("import");
    expect(payload).toBeTruthy();

    const exported = JSON.parse(await decryptWithPassphrase(payload!, PASSPHRASE)) as Record<
      string,
      unknown
    >;
    expect(exported).toHaveProperty("value", "sensitive-value");
    expect(exported).not.toHaveProperty("holder");
  });

  it("keeps proof-history JSON and CSV free of credential PII fields", () => {
    const item = credential("commitment-1", "sensitive-value", "holder-1");
    localStorage.setItem(
      `proofTimeline:${item.commitment}`,
      JSON.stringify({
        events: [{ stage: "verified", timestamp: 1700000000, txHash: "tx-test" }],
      }),
    );

    const json = exportHistoryAsJson([item]);
    const csv = exportHistoryAsCsv([item]);
    for (const output of [json, csv]) {
      expect(output).not.toContain("sensitive-value");
      expect(output).not.toContain("holder-1");
      expect(output).toContain("tx-test");
    }
  });
});

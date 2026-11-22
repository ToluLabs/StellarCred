import { describe, it, expect, vi } from "vitest";
import {
  MAX_IMPORT_FILE_SIZE_BYTES,
  MAX_IMPORT_NESTING_DEPTH,
  MAX_IMPORT_RECORD_COUNT,
  MAX_IMPORT_STRING_LENGTH,
  validateImportPayload,
  validateJsonNestingDepth,
  validateStringLengths,
  deduplicateCredentials,
} from "../credential-import-bounds";
import { mergeCredentials } from "../backup";
import * as credentialModule from "../credential";
import type { Credential } from "../credential";

describe("credential-import-bounds (#977)", () => {
  const sampleCredential: Credential = {
    type: "kyc",
    title: "KYC Verified",
    claim: "Identity check passed",
    issuer: "Test Authority",
    issuerId: "GAAABBBCCCDDDEEEFFF111222333444555",
    holder: "GBBBCCCDDDEEEFFF111222333444555666",
    value: "1",
    salt: "1234567890",
    commitment: "0x1234567890abcdef",
    sig: new Array(64).fill(1),
    issuerPubX: new Array(32).fill(2),
    issuerPubY: new Array(32).fill(3),
    issuedAt: 1700000000,
    expiry: "90 days",
  };

  it("accepts a well-formed credential payload within limits", () => {
    const raw = JSON.stringify([sampleCredential]);
    const parsed = validateImportPayload(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as Credential[]).length).toBe(1);
  });

  it("rejects import payload exceeding maximum file size", () => {
    const hugePayload = "x".repeat(MAX_IMPORT_FILE_SIZE_BYTES + 10);
    expect(() => validateImportPayload(hugePayload)).toThrow(/exceeds maximum limit/);
  });

  it("rejects import payload exceeding maximum nesting depth", () => {
    // 6 levels of nesting exceeds MAX_IMPORT_NESTING_DEPTH (5)
    const deeplyNested = '{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}';
    expect(() => validateJsonNestingDepth(deeplyNested, MAX_IMPORT_NESTING_DEPTH)).toThrow(
      /exceeds maximum nesting depth/,
    );
    expect(() => validateImportPayload(deeplyNested)).toThrow(/exceeds maximum nesting depth/);
  });

  it("accepts nesting within the allowed maximum depth", () => {
    const acceptable = '{"a":{"b":{"c":1}}}';
    expect(() => validateJsonNestingDepth(acceptable, MAX_IMPORT_NESTING_DEPTH)).not.toThrow();
  });

  it("rejects record count exceeding MAX_IMPORT_RECORD_COUNT", () => {
    const items = [];
    for (let i = 0; i < MAX_IMPORT_RECORD_COUNT + 1; i++) {
      items.push({ ...sampleCredential, commitment: `0x${i}` });
    }
    const raw = JSON.stringify(items);
    expect(() => validateImportPayload(raw)).toThrow(/exceeds maximum limit of 50/);
  });

  it("rejects strings exceeding MAX_IMPORT_STRING_LENGTH", () => {
    const oversizedString = "a".repeat(MAX_IMPORT_STRING_LENGTH + 1);
    const item = { ...sampleCredential, claim: oversizedString };
    expect(() => validateStringLengths(item)).toThrow(/exceeds maximum length/);
    expect(() => validateImportPayload(JSON.stringify(item))).toThrow(/exceeds maximum length/);
  });

  it("rejects empty or whitespace payloads", () => {
    expect(() => validateImportPayload("")).toThrow(/non-empty/);
    expect(() => validateImportPayload("   ")).toThrow(/non-empty/);
  });

  it("rejects malformed JSON", () => {
    expect(() => validateImportPayload("{not valid json")).toThrow(/Malformed JSON/);
  });

  it("rejects empty arrays", () => {
    expect(() => validateImportPayload("[]")).toThrow(/must not be empty/);
  });

  it("deduplicates credentials deterministically by commitment, favoring newer issuedAt", () => {
    const cred1: Credential = {
      ...sampleCredential,
      commitment: "0xrepeat",
      issuedAt: 1000,
      title: "Older Version",
    };
    const cred2: Credential = {
      ...sampleCredential,
      commitment: "0xrepeat",
      issuedAt: 2000,
      title: "Newer Version",
    };
    const cred3: Credential = {
      ...sampleCredential,
      commitment: "0xunique",
      issuedAt: 1500,
      title: "Unique Cred",
    };

    const deduplicated = deduplicateCredentials([cred1, cred2, cred3]);
    expect(deduplicated.length).toBe(2);
    const kept = deduplicated.find((c) => c.commitment === "0xrepeat");
    expect(kept?.title).toBe("Newer Version");
  });

  it("atomic merge leaves existing data unchanged if any credential in batch fails validation", async () => {
    const existingCred: Credential = {
      ...sampleCredential,
      commitment: "0xexisting",
    };
    const saveSpy = vi.spyOn(credentialModule, "saveCredential");
    vi.spyOn(credentialModule, "loadCredentials").mockResolvedValue([existingCred]);

    const validNewCred: Credential = {
      ...sampleCredential,
      commitment: "0xvalid_new",
    };
    const invalidCred: Credential = {
      ...sampleCredential,
      commitment: "0xforeign",
      deployment: {
        network: "mainnet",
        networkPassphrase: "Public Global Stellar Network ; September 2015",
        contracts: {
          credentialVerifier: "C1",
          issuerRegistry: "C2",
          proofRegistry: "C3",
          gatedPool: "C4",
        },
      },
    };

    // Attempting to merge a batch containing an invalid deployment should throw
    await expect(mergeCredentials([validNewCred, invalidCred])).rejects.toThrow(
      /another deployment/,
    );

    // saveCredential should NOT have been called for validNewCred
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

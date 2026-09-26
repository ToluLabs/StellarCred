import { describe, it, expect } from "vitest";
import type { Credential } from "../credential";
import {
  createGuardianRecoverySetup,
  recoverCredentialsFromShares,
  parseGuardianShare,
  parseGuardianBackup,
  formatShareArmored,
  parseRecoveryKit,
  GuardianRecoveryError,
} from "../guardian";

const SAMPLE_CREDENTIALS: Credential[] = [
  {
    type: "kyc",
    title: "KYC Complete",
    claim: "identity verified",
    issuer: "Demo KYC Issuer",
    issuerId: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    holder: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF",
    value: "1",
    salt: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    commitment: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    sig: new Array(64).fill(1),
    issuerPubX: new Array(32).fill(2),
    issuerPubY: new Array(32).fill(3),
    issuedAt: 1700000000,
    expiry: "90 days",
  },
  {
    type: "age",
    title: "Age Verified",
    claim: "age ≥ 18",
    issuer: "Demo Age Issuer",
    issuerId: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF",
    holder: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF",
    value: "25",
    salt: "0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    commitment: "0xbbcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    sig: new Array(64).fill(4),
    issuerPubX: new Array(32).fill(5),
    issuerPubY: new Array(32).fill(6),
    issuedAt: 1700000100,
    expiry: "30 days",
  },
];

describe("lib/guardian.ts - Guardian Recovery Setup & Restoration", () => {
  it("creates a recovery setup and restores credentials using a threshold of shares (2-of-3)", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
      guardianLabels: ["Alice (Sister)", "Bob (Colleague)", "Backup Device"],
    });

    expect(setup.shares).toHaveLength(3);
    expect(setup.backup.threshold).toBe(2);
    expect(setup.backup.totalShares).toBe(3);
    expect(setup.backup.credentialCount).toBe(2);
    expect(setup.backup.guardianLabels).toEqual([
      "Alice (Sister)",
      "Bob (Colleague)",
      "Backup Device",
    ]);

    // Test restoration with shares (1, 2)
    const recovered12 = await recoverCredentialsFromShares(setup.backup, [
      setup.shares[0],
      setup.shares[1],
    ]);
    expect(recovered12).toEqual(SAMPLE_CREDENTIALS);

    // Test restoration with shares (2, 3)
    const recovered23 = await recoverCredentialsFromShares(setup.backup, [
      setup.shares[1],
      setup.shares[2],
    ]);
    expect(recovered23).toEqual(SAMPLE_CREDENTIALS);

    // Test restoration with shares (1, 3)
    const recovered13 = await recoverCredentialsFromShares(setup.backup, [
      setup.shares[0],
      setup.shares[2],
    ]);
    expect(recovered13).toEqual(SAMPLE_CREDENTIALS);

    // Test restoration with all 3 shares
    const recoveredAll = await recoverCredentialsFromShares(setup.backup, setup.shares);
    expect(recoveredAll).toEqual(SAMPLE_CREDENTIALS);
  });

  it("works with 3-of-5 threshold setup", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 5,
      threshold: 3,
    });

    expect(setup.shares).toHaveLength(5);
    expect(setup.backup.threshold).toBe(3);

    // Any 3 shares
    const recovered = await recoverCredentialsFromShares(setup.backup, [
      setup.shares[0],
      setup.shares[2],
      setup.shares[4],
    ]);
    expect(recovered).toEqual(SAMPLE_CREDENTIALS);
  });

  it("handles empty credentials list safely", async () => {
    const setup = await createGuardianRecoverySetup([], {
      totalShares: 3,
      threshold: 2,
    });

    const recovered = await recoverCredentialsFromShares(setup.backup, [
      setup.shares[0],
      setup.shares[1],
    ]);
    expect(recovered).toEqual([]);
  });

  it("verifies guardians never receive credential data in their shares", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
    });

    for (const share of setup.shares) {
      const shareJson = JSON.stringify(share);
      expect(shareJson).not.toContain("KYC Complete");
      expect(shareJson).not.toContain("Age Verified");
      expect(shareJson).not.toContain("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF");
      expect(shareJson).not.toContain("0x1234567890abcdef");
    }
  });

  it("rejects recovery when fewer than threshold shares are provided", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
    });

    await expect(
      recoverCredentialsFromShares(setup.backup, [setup.shares[0]]),
    ).rejects.toThrow(GuardianRecoveryError);
  });

  it("rejects duplicate shares for the same guardian index", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
    });

    await expect(
      recoverCredentialsFromShares(setup.backup, [setup.shares[0], setup.shares[0]]),
    ).rejects.toThrow(/Duplicate share detected/);
  });

  it("rejects a share from a different recovery set", async () => {
    const setupA = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
    });
    const setupB = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
    });

    // Provide one share from set A and one share from set B
    await expect(
      recoverCredentialsFromShares(setupA.backup, [setupA.shares[0], setupB.shares[1]]),
    ).rejects.toThrow(/belongs to recovery set/);
  });

  it("rejects corrupted ciphertext in backup", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
    });

    // Modify ciphertext
    const tamperedBackup = {
      ...setup.backup,
      ciphertext: setup.backup.ciphertext.slice(0, -4) + "AAAA",
    };

    await expect(
      recoverCredentialsFromShares(tamperedBackup, [setup.shares[0], setup.shares[1]]),
    ).rejects.toThrow(GuardianRecoveryError);
  });

  it("rejects corrupted share data", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
    });

    const corruptedShare = {
      ...setup.shares[1],
      shareData: "AA" + setup.shares[1].shareData.slice(2),
    };

    await expect(
      recoverCredentialsFromShares(setup.backup, [setup.shares[0], corruptedShare]),
    ).rejects.toThrow(GuardianRecoveryError);
  });
});

describe("lib/guardian.ts - Parsing and Serialization", () => {
  it("serializes and parses shares in JSON format", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
      guardianLabels: ["Alice", "Bob", "Charlie"],
    });

    const share = setup.shares[0];
    const json = JSON.stringify(share);
    const parsed = parseGuardianShare(json);

    expect(parsed.recoveryId).toBe(share.recoveryId);
    expect(parsed.guardianIndex).toBe(share.guardianIndex);
    expect(parsed.guardianLabel).toBe("Alice");
    expect(parsed.threshold).toBe(share.threshold);
    expect(parsed.shareData).toBe(share.shareData);
    expect(parsed.keyFingerprint).toBe(share.keyFingerprint);
  });

  it("serializes and parses shares in armored string format (SC-SHARE:...)", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
      guardianLabels: ["Alice (Sister)"],
    });

    const share = setup.shares[0];
    const armored = formatShareArmored(share);
    expect(armored.startsWith("SC-SHARE:1:")).toBe(true);

    const parsed = parseGuardianShare(armored);
    expect(parsed.recoveryId).toBe(share.recoveryId);
    expect(parsed.guardianIndex).toBe(1);
    expect(parsed.guardianLabel).toBe("Alice (Sister)");
    expect(parsed.threshold).toBe(2);
    expect(parsed.shareData).toBe(share.shareData);
    expect(parsed.keyFingerprint).toBe(share.keyFingerprint);
  });

  it("parses backup JSON and full recovery kit JSON", async () => {
    const setup = await createGuardianRecoverySetup(SAMPLE_CREDENTIALS, {
      totalShares: 3,
      threshold: 2,
    });

    // Parse direct backup JSON
    const parsedBackup = parseGuardianBackup(JSON.stringify(setup.backup));
    expect(parsedBackup.recoveryId).toBe(setup.backup.recoveryId);
    expect(parsedBackup.threshold).toBe(2);

    // Parse backup from a complete recovery kit JSON
    const parsedFromKit = parseGuardianBackup(JSON.stringify(setup.recoveryKit));
    expect(parsedFromKit.recoveryId).toBe(setup.backup.recoveryId);

    // Parse full kit
    const parsedKit = parseRecoveryKit(JSON.stringify(setup.recoveryKit));
    expect(parsedKit.shares).toHaveLength(3);
    expect(parsedKit.backup.recoveryId).toBe(setup.backup.recoveryId);
  });

  it("throws descriptive errors on malformed backup or share strings", () => {
    expect(() => parseGuardianShare("invalid-json")).toThrow("Share input must be valid JSON or an SC-SHARE code");
    expect(() => parseGuardianShare("{}")).toThrow("Invalid Guardian Share structure");
    expect(() => parseGuardianBackup("not-json")).toThrow("Backup input must be valid JSON");
    expect(() => parseGuardianBackup(JSON.stringify({ type: "wrong" }))).toThrow("Invalid Guardian Encrypted Backup");
  });
});

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function makeTestCredential(overrides = {}) {
  return {
    type: "kyc",
    title: "KYC Complete",
    claim: "identity verified",
    issuer: "Test Issuer",
    issuerId: "issuer-123",
    holder: "GBZXN7PIRZGNMHGA7282KKLG",
    value: "1",
    salt: "0x1a2b3c4d5e6f7a8b9c0d1e2f",
    commitment: "0x0987654321fedcba0987654321fedcba",
    sig: Array(64).fill(7),
    issuerPubX: Array(32).fill(8),
    issuerPubY: Array(32).fill(9),
    issuedAt: 1700000000,
    expiry: "90 days",
    deployment: { network: "testnet", contractId: "C123" },
    circuitVersion: "v1.0.0",
    circuitVkVersion: 1,
    ...overrides,
  };
}

describe("Offline Credential Export/Import CLI Helper (#811)", () => {
  const cliScript = path.resolve(__dirname, "../scripts/credential-cli.ts");
  const tmpDir = path.resolve(__dirname, "../tmp-test-cli");

  function runCli(args) {
    return execFileSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", cliScript, ...args],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
  }

  // Setup / teardown temp directory
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  after(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exports plain credentials and imports them without altering underlying structure", () => {
    const cred1 = makeTestCredential();
    const cred2 = makeTestCredential({
      type: "age",
      title: "Age Verified",
      claim: "age ≥ 18",
      commitment: "0xabcdef1234567890abcdef1234567890",
      value: "21",
    });

    const sourceFile = path.join(tmpDir, "source.json");
    const exportedFile = path.join(tmpDir, "exported-plain.json");
    const importedFile = path.join(tmpDir, "imported-plain.json");

    fs.writeFileSync(sourceFile, JSON.stringify([cred1, cred2], null, 2));

    // Export via CLI
    const exportOutput = runCli(["export", "-i", sourceFile, "-o", exportedFile, "--force"]);
    assert.match(exportOutput, /Exported 2 credential\(s\) in plain format/);
    assert.ok(fs.existsSync(exportedFile));

    // Import via CLI
    const importOutput = runCli(["import", "-i", exportedFile, "-o", importedFile, "--force"]);
    assert.match(importOutput, /Imported 2 credential\(s\)/);
    assert.ok(fs.existsSync(importedFile));

    // Verify raw data matches exactly
    const importedData = JSON.parse(fs.readFileSync(importedFile, "utf-8"));
    assert.deepStrictEqual(importedData, [cred1, cred2]);

    // Clean up
    fs.unlinkSync(sourceFile);
    fs.unlinkSync(exportedFile);
    fs.unlinkSync(importedFile);
  });

  it("exports encrypted backup envelope and imports with passphrase", () => {
    const cred = makeTestCredential();
    const passphrase = "stellar-secret-passphrase-42";

    const sourceFile = path.join(tmpDir, "source-enc.json");
    const exportedFile = path.join(tmpDir, "exported.enc.json");
    const importedFile = path.join(tmpDir, "imported-dec.json");

    fs.writeFileSync(sourceFile, JSON.stringify([cred], null, 2));

    // Export encrypted
    const exportOutput = runCli([
      "export",
      "-i",
      sourceFile,
      "-o",
      exportedFile,
      "-p",
      passphrase,
      "--force",
    ]);
    assert.match(exportOutput, /Exported 1 credential\(s\) in encrypted format/);

    // Verify envelope fields
    const envelope = JSON.parse(fs.readFileSync(exportedFile, "utf-8"));
    assert.strictEqual(envelope.version, 3);
    assert.strictEqual(envelope.kdf, "PBKDF2-SHA256");
    assert.strictEqual(envelope.iterations, 600000);
    assert.ok(envelope.salt);
    assert.ok(envelope.iv);
    assert.ok(envelope.ciphertext);

    // Import decrypted
    const importOutput = runCli([
      "import",
      "-i",
      exportedFile,
      "-o",
      importedFile,
      "-p",
      passphrase,
      "--force",
    ]);
    assert.match(importOutput, /Imported 1 credential\(s\)/);

    const restored = JSON.parse(fs.readFileSync(importedFile, "utf-8"));
    assert.deepStrictEqual(restored, [cred]);

    // Clean up
    fs.unlinkSync(sourceFile);
    fs.unlinkSync(exportedFile);
    fs.unlinkSync(importedFile);
  });

  it("fails to import encrypted backup with wrong passphrase", () => {
    const cred = makeTestCredential();
    const sourceFile = path.join(tmpDir, "source-wrong.json");
    const exportedFile = path.join(tmpDir, "exported-wrong.enc.json");
    const targetFile = path.join(tmpDir, "target-wrong.json");

    fs.writeFileSync(sourceFile, JSON.stringify([cred]));
    runCli(["export", "-i", sourceFile, "-o", exportedFile, "-p", "correct-key", "--force"]);

    assert.throws(
      () => {
        runCli(["import", "-i", exportedFile, "-o", targetFile, "-p", "wrong-key", "--force"]);
      },
      (err) => {
        return err.message.includes("Decryption failed") || err.stderr?.includes("Decryption failed");
      }
    );

    // Clean up
    fs.unlinkSync(sourceFile);
    fs.unlinkSync(exportedFile);
  });

  it("supports type filtering during export and import", () => {
    const credKyc = makeTestCredential({ type: "kyc" });
    const credAge = makeTestCredential({
      type: "age",
      commitment: "0x1111222233334444",
      claim: "age ≥ 18",
    });

    const sourceFile = path.join(tmpDir, "filter-source.json");
    const exportKycOnly = path.join(tmpDir, "export-kyc.json");
    const importAgeOnly = path.join(tmpDir, "import-age.json");

    fs.writeFileSync(sourceFile, JSON.stringify([credKyc, credAge]));

    // Export filter
    runCli(["export", "-i", sourceFile, "-o", exportKycOnly, "-t", "kyc", "--force"]);
    const exportedKyc = JSON.parse(fs.readFileSync(exportKycOnly, "utf-8"));
    assert.strictEqual(exportedKyc.length, 1);
    assert.strictEqual(exportedKyc[0].type, "kyc");

    // Import filter
    runCli(["import", "-i", sourceFile, "-o", importAgeOnly, "-t", "age", "--force"]);
    const importedAge = JSON.parse(fs.readFileSync(importAgeOnly, "utf-8"));
    assert.strictEqual(importedAge.length, 1);
    assert.strictEqual(importedAge[0].type, "age");

    // Clean up
    fs.unlinkSync(sourceFile);
    fs.unlinkSync(exportKycOnly);
    fs.unlinkSync(importAgeOnly);
  });

  it("merges imported credentials into an existing credentials store", () => {
    const cred1 = makeTestCredential({ commitment: "0x111" });
    const cred2 = makeTestCredential({ commitment: "0x222", type: "income" });
    const cred1Updated = makeTestCredential({ commitment: "0x111", provedAt: 1700000999 });

    const existingFile = path.join(tmpDir, "store.json");
    const backupFile = path.join(tmpDir, "update-backup.json");

    fs.writeFileSync(existingFile, JSON.stringify([cred1]));
    fs.writeFileSync(backupFile, JSON.stringify([cred1Updated, cred2]));

    runCli(["import", "-i", backupFile, "-o", existingFile, "--merge"]);

    const merged = JSON.parse(fs.readFileSync(existingFile, "utf-8"));
    assert.strictEqual(merged.length, 2);
    // Verified cred1 was updated and cred2 was merged
    const updated = merged.find((c) => c.commitment === "0x111");
    assert.strictEqual(updated.provedAt, 1700000999);
    assert.ok(merged.some((c) => c.commitment === "0x222"));

    // Clean up
    fs.unlinkSync(existingFile);
    fs.unlinkSync(backupFile);
  });

  it("validates credential files and identifies corrupted entries", () => {
    const validCred = makeTestCredential();
    const corruptedCred = {
      type: "kyc",
      value: "not-a-valid-field",
      salt: "",
      commitment: "0x123",
      sig: [1, 2, 3], // invalid byte count
      issuerPubX: Array(32).fill(0),
      issuerPubY: Array(32).fill(0),
      expiry: "invalid",
    };

    const validFile = path.join(tmpDir, "valid.json");
    const corruptedFile = path.join(tmpDir, "corrupted.json");

    fs.writeFileSync(validFile, JSON.stringify([validCred]));
    fs.writeFileSync(corruptedFile, JSON.stringify([corruptedCred]));

    // Valid check succeeds
    const validOut = runCli(["validate", "-i", validFile]);
    assert.match(validOut, /1 valid, 0 invalid/);

    // Corrupted check exits with code 1
    assert.throws(() => {
      runCli(["validate", "-i", corruptedFile]);
    });

    // Clean up
    fs.unlinkSync(validFile);
    fs.unlinkSync(corruptedFile);
  });

  it("inspects credentials with sensitive fields redacted by default", () => {
    const cred = makeTestCredential({ salt: "0xSECRET_SALT_12345", value: "99999" });
    const inspectFile = path.join(tmpDir, "inspect.json");
    fs.writeFileSync(inspectFile, JSON.stringify([cred]));

    // Default inspect redacts sensitive fields
    const defaultInspect = runCli(["inspect", "-i", inspectFile]);
    assert.match(defaultInspect, /<redacted - use --show-sensitive to view>/);
    assert.ok(!defaultInspect.includes("0xSECRET_SALT_12345"));

    // With --show-sensitive
    const sensitiveInspect = runCli(["inspect", "-i", inspectFile, "--show-sensitive"]);
    assert.match(sensitiveInspect, /0xSECRET_SALT_12345/);
    assert.match(sensitiveInspect, /99999/);

    fs.unlinkSync(inspectFile);
  });

  it("supports --dry-run for safe import verification", () => {
    const cred = makeTestCredential();
    const backupFile = path.join(tmpDir, "dryrun-backup.json");
    const targetFile = path.join(tmpDir, "dryrun-target.json");

    fs.writeFileSync(backupFile, JSON.stringify([cred]));

    const output = runCli(["import", "-i", backupFile, "-o", targetFile, "--dry-run"]);
    assert.match(output, /\[Dry Run\] Successfully validated 1 credential\(s\)/);
    assert.ok(!fs.existsSync(targetFile));

    fs.unlinkSync(backupFile);
  });
});

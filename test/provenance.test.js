const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("Verifiable Release Build Provenance (#968)", () => {
  const rootDir = path.resolve(__dirname, "..");
  let tempDir;
  let artifact1;
  let artifact2;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stellarcred-provenance-test-"));
    artifact1 = path.join(tempDir, "credential_verifier.wasm");
    artifact2 = path.join(tempDir, "proof_registry.wasm");

    fs.writeFileSync(artifact1, Buffer.from("mock-wasm-binary-verifier-bytes"));
    fs.writeFileSync(artifact2, Buffer.from("mock-wasm-binary-registry-bytes"));
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("generates SLSA v1.0 in-toto statement and companion files", async () => {
    const { generateReleaseProvenance } = await import(
      "../scripts/generate-release-provenance.mjs"
    );

    const result = generateReleaseProvenance({
      artifacts: [artifact1, artifact2],
      outDir: tempDir,
      rootDir,
      env: {
        GITHUB_SHA: "abcdef1234567890abcdef1234567890abcdef12",
        GITHUB_REF: "refs/tags/v1.0.0",
        GITHUB_REPOSITORY: "ToluLabs/StellarCred",
        GITHUB_RUN_ID: "99887766",
        GITHUB_ACTOR: "release-bot",
      },
    });

    assert.ok(fs.existsSync(result.provenancePath));
    assert.ok(fs.existsSync(result.provenanceDigestPath));
    assert.ok(fs.existsSync(result.checksumsPath));

    const statement = JSON.parse(fs.readFileSync(result.provenancePath, "utf8"));
    assert.strictEqual(statement._type, "https://in-toto.io/Statement/v1");
    assert.strictEqual(statement.predicateType, "https://slsa.dev/provenance/v1");
    assert.strictEqual(statement.subject.length, 2);

    const checksums = fs.readFileSync(result.checksumsPath, "utf8");
    assert.ok(checksums.includes("credential_verifier.wasm"));
    assert.ok(checksums.includes("proof_registry.wasm"));
  });

  it("verifies provenance and succeeds for untampered artifacts", async () => {
    const { verifyProvenance } = await import("../scripts/verify-provenance.mjs");
    const provenancePath = path.join(tempDir, "build-provenance.json");

    const result = verifyProvenance({
      provenancePath,
      artifactsDir: tempDir,
      rootDir,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.verifiedArtifacts.length, 2);
    assert.strictEqual(result.commit, "abcdef1234567890abcdef1234567890abcdef12");
  });

  it("detects tampering when an artifact has been modified", async () => {
    const { verifyProvenance } = await import("../scripts/verify-provenance.mjs");
    const provenancePath = path.join(tempDir, "build-provenance.json");

    // Tamper with artifact1
    fs.appendFileSync(artifact1, Buffer.from("-tampered-extra-byte"));

    const result = verifyProvenance({
      provenancePath,
      artifactsDir: tempDir,
      rootDir,
    });

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors.some((e) => e.includes("TAMPER DETECTED")),
      "Must report TAMPER DETECTED",
    );

    // Restore artifact1
    fs.writeFileSync(artifact1, Buffer.from("mock-wasm-binary-verifier-bytes"));
  });

  it("reports error when an artifact is missing", async () => {
    const { verifyProvenance } = await import("../scripts/verify-provenance.mjs");
    const provenancePath = path.join(tempDir, "build-provenance.json");

    fs.unlinkSync(artifact2);

    const result = verifyProvenance({
      provenancePath,
      artifactsDir: tempDir,
      rootDir,
    });

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Artifact file not found")));

    // Recreate artifact2
    fs.writeFileSync(artifact2, Buffer.from("mock-wasm-binary-registry-bytes"));
  });

  it("CLI verify-provenance.mjs runs and verifies successfully", () => {
    const { execFileSync } = require("node:child_process");
    const scriptPath = path.join(rootDir, "scripts", "verify-provenance.mjs");
    const provenancePath = path.join(tempDir, "build-provenance.json");

    const output = execFileSync(
      process.execPath,
      [scriptPath, "--provenance", provenancePath, "--artifacts-dir", tempDir],
      { encoding: "utf8" },
    );

    assert.ok(output.includes("[OK] Provenance verification passed"));
  });
});

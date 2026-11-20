const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("Contract Error Codes & Manifest Parity (#967)", () => {
  const rootDir = path.resolve(__dirname, "..");
  const manifestPath = path.join(rootDir, "contracts", "error-codes.json");
  const schemaPath = path.join(rootDir, "contracts", "error-codes.schema.json");
  const docsPath = path.join(rootDir, "docs", "contract-error-codes.md");

  it("canonical error-codes.json exists and conforms to schema structure", () => {
    assert.ok(fs.existsSync(manifestPath), "contracts/error-codes.json must exist");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.strictEqual(typeof manifest.version, "string");
    assert.ok(manifest.contracts, "contracts object must exist");
    assert.ok(manifest.contracts.proof_registry);
    assert.ok(manifest.contracts.issuer_registry);
    assert.ok(manifest.contracts.credential_verifier);
    assert.ok(manifest.contracts.gated_pool);
  });

  it("error-codes.schema.json defines JSON Schema for contract errors", () => {
    assert.ok(fs.existsSync(schemaPath), "contracts/error-codes.schema.json must exist");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    assert.strictEqual(schema.title, "StellarCredContractErrorCodes");
  });

  it("verifies all 4 contracts have sequential, monotonically increasing error codes", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const [key, contract] of Object.entries(manifest.contracts)) {
      const codes = Object.keys(contract.errors)
        .map(Number)
        .sort((a, b) => a - b);
      assert.ok(codes.length > 0, `${key} must have at least one error code`);
      for (let i = 0; i < codes.length; i++) {
        assert.strictEqual(codes[i], i + 1, `${key} code must be ${i + 1}`);
      }
    }
  });

  it("verifies docs/contract-error-codes.md documents all contracts and codes", () => {
    assert.ok(fs.existsSync(docsPath), "docs/contract-error-codes.md must exist");
    const doc = fs.readFileSync(docsPath, "utf8");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const contract of Object.values(manifest.contracts)) {
      assert.ok(doc.includes(contract.name), `Docs must mention ${contract.name}`);
      for (const err of Object.values(contract.errors)) {
        assert.ok(doc.includes(err.name), `Docs must mention error ${err.name}`);
      }
    }
  });

  it("executes scripts/verify-contract-errors.mjs and passes with exit code 0", () => {
    const { execFileSync } = require("node:child_process");
    const scriptPath = path.join(rootDir, "scripts", "verify-contract-errors.mjs");
    const output = execFileSync(process.execPath, [scriptPath], { encoding: "utf8" });
    assert.ok(output.includes("SUCCESS"), "Script must output SUCCESS");
  });
});

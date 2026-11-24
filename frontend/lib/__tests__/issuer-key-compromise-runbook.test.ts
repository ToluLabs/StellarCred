import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// docs/ISSUER_KEY_COMPROMISE_RUNBOOK.md (#1090) gives operators exact commands,
// field offsets and limits to use during an incident. These checks pin each of
// those facts to the source they describe, so a contract or route change that
// would make the runbook wrong fails here instead of during an incident.

const rootDir = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.resolve(rootDir, rel), "utf8");

const runbook = read("docs/ISSUER_KEY_COMPROMISE_RUNBOOK.md");
const issuerRegistry = read("contracts/issuer_registry/src/lib.rs");
const proofRegistry = read("contracts/proof_registry/src/lib.rs");
const batchRoute = read("frontend/app/api/issue/batch/route.ts");

/** Source of a `pub fn` from its signature to its matching closing brace. */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`pub fn ${name}(`);
  expect(start, `pub fn ${name} not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated body for ${name}`);
}

function rustConst(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name}: u32 = (\\d+);`));
  expect(match, `const ${name} not found`).not.toBeNull();
  return Number(match![1]);
}

describe("issuer key compromise runbook (#1090)", () => {
  it("only invokes contract entrypoints that exist", () => {
    const invoked = [...runbook.matchAll(/^\s*-- (\w+)/gm)].map((m) => m[1]);
    expect(invoked).toEqual(["revoke_issuer_key", "revoke"]);

    expect(issuerRegistry).toContain("pub fn revoke_issuer_key(");
    expect(proofRegistry).toContain("pub fn revoke(");
    for (const name of [
      "rotate_issuer_key",
      "get_issuer_pubkey",
      "get_issuer_keys",
      "is_valid_issuer_key",
    ]) {
      expect(runbook).toContain(name);
      expect(issuerRegistry).toContain(`pub fn ${name}(`);
    }
    for (const name of ["is_verified", "check_claim", "pause", "unpause"]) {
      expect(proofRegistry).toContain(`pub fn ${name}(`);
    }
  });

  it("cached proofs are read without re-checking the signing key", () => {
    for (const name of ["is_verified", "check_claim"]) {
      const body = fnBody(proofRegistry, name);
      expect(body).not.toContain("is_valid_issuer_key");
      expect(body).not.toContain("IssuerClient");
    }
    const record = proofRegistry.slice(
      proofRegistry.indexOf("pub struct ProofRecord"),
      proofRegistry.indexOf("}", proofRegistry.indexOf("pub struct ProofRecord")),
    );
    expect(record).not.toMatch(/pubkey|commitment/);
  });

  it("issuer revocation needs a trusted issuer, so rotation must come first", () => {
    expect(fnBody(proofRegistry, "revoke")).toContain("is_valid_issuer(");
    expect(runbook).toContain("Phase 2 must come before Phase 4");
  });

  it("documents the public-input offsets the contract reads", () => {
    expect(rustConst(proofRegistry, "PUBKEY_START_FIELD")).toBe(1);
    expect(rustConst(proofRegistry, "AGG_FIELD_KYC_START")).toBe(0);
    expect(rustConst(proofRegistry, "AGG_FIELD_KYC_PUBKEY")).toBe(1);
    expect(rustConst(proofRegistry, "AGG_FIELD_AGE_START")).toBe(65);
    expect(rustConst(proofRegistry, "AGG_FIELD_AGE_PUBKEY")).toBe(66);
    expect(runbook).toContain("| field 0 | fields 1 to 64 |");
    expect(runbook).toContain("| field 65 | fields 66 to 129 |");
  });

  it("uses the RevocationReason codes the contract defines", () => {
    expect(proofRegistry).toMatch(/Superseded = 1,/);
    expect(proofRegistry).toMatch(/Fraud = 2,/);
    expect(runbook).toContain("`2` is `Fraud`, `1` is `Superseded`");
  });

  it("states the batch issuance limit the route enforces", () => {
    expect(batchRoute).toContain("const MAX_BATCH_SIZE = 50;");
    expect(runbook).toContain("at most **50\n  items**");
  });
});

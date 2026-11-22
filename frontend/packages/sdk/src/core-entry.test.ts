// core-entry.test.ts
//
// Regression guard for issue #1066: the `@stellarcred/sdk/core` entry point
// must stay a zero-dependency, minimal-footprint build target for serverless
// and embedded environments.
//
// These tests assert three things:
//   1. The core entry point exposes the pure claim/error/validation surface.
//   2. It does NOT expose UI helpers, the React hook, or the claim gate.
//   3. Its module graph never reaches React, `@stellar/stellar-sdk`, or the
//      registry clients — i.e. importing it pulls in no runtime dependency.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "./core-entry";
import * as full from "./index";
import * as fromClaims from "./claims";
import * as fromErrors from "./errors";
import * as fromVersion from "./version";
import * as fromValidate from "./validateCredential";
import pkg from "../package.json";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// ── 1. Public surface ────────────────────────────────────────────────────────

describe("@stellarcred/sdk/core — public surface (#1066)", () => {
  it("re-exports the same references as the source modules", () => {
    expect(core.CLAIM_TYPES).toBe(fromClaims.CLAIM_TYPES);

    expect(core.RpcError).toBe(fromErrors.RpcError);
    expect(core.IndexerError).toBe(full.IndexerError);
    expect(core.ContractError).toBe(fromErrors.ContractError);
    expect(core.ContractErrorCode).toBe(fromErrors.ContractErrorCode);
    expect(core.TransactionSubmissionError).toBe(fromErrors.TransactionSubmissionError);
    expect(core.parseContractError).toBe(fromErrors.parseContractError);
    expect(core.PROOF_REGISTRY_ERROR_MESSAGES).toBe(fromErrors.PROOF_REGISTRY_ERROR_MESSAGES);

    expect(core.validateCredential).toBe(fromValidate.validateCredential);
    expect(core.parseCredentialJson).toBe(fromValidate.parseCredentialJson);
    expect(core.assertValidCredential).toBe(fromValidate.assertValidCredential);
    expect(core.CredentialValidationError).toBe(fromValidate.CredentialValidationError);

    expect(core.getCredentialCircuitVersion).toBe(fromVersion.getCredentialCircuitVersion);
    expect(core.isCompatibleCredential).toBe(fromVersion.isCompatibleCredential);
    expect(core.getCredentialVersionStatus).toBe(fromVersion.getCredentialVersionStatus);
    expect(core.getDeploymentCircuitVersion).toBe(fromVersion.getDeploymentCircuitVersion);
    expect(core.KNOWN_CIRCUIT_VERSIONS).toBe(fromVersion.KNOWN_CIRCUIT_VERSIONS);
  });

  it("exposes the same references as the full entry point", () => {
    expect(core.CLAIM_TYPES).toBe(full.CLAIM_TYPES);
    expect(core.RpcError).toBe(full.RpcError);
    expect(core.validateCredential).toBe(full.validateCredential);
    expect(core.isCompatibleCredential).toBe(full.isCompatibleCredential);
  });

  it("works without any configuration or network access", () => {
    expect(core.CLAIM_TYPES).toContain("kyc");
    expect(core.CLAIM_TYPES).toContain("age");

    const err = new core.RpcError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RpcError");

    const result = core.validateCredential({});
    expect(result.valid).toBe(false);
  });
});

// ── 2. Excluded surface ──────────────────────────────────────────────────────

describe("@stellarcred/sdk/core — excludes UI helpers and non-essential deps (#1066)", () => {
  const EXCLUDED = [
    // UI helpers
    "buildVerifyUrl",
    "buildBadgeUrl",
    "buildBadgeEmbedCode",
    "parseReturnParams",
    // React
    "useStellarCred",
    // Framework-agnostic gate
    "createClaimGate",
    // Network / RPC surface
    "configure",
    "hasClaim",
    "hasClaims",
    "getClaim",
    "getClaims",
    "getClaimRecord",
    "checkClaimStatus",
    "verifyPreset",
    "watchClaim",
    "submitTransaction",
    "subscribeClaims",
    "createWalletChallenge",
    "verifyWalletSignature",
    "verifyWalletClaim",
    "bootstrap",
    "fetchCapabilities",
    "validateCapabilitiesDescriptor",
    "StellarCred",
    "default",
  ] as const;

  for (const name of EXCLUDED) {
    it(`does not export ${name}`, () => {
      expect((core as Record<string, unknown>)[name]).toBeUndefined();
    });
  }
});

// ── 3. Zero-dependency module graph ──────────────────────────────────────────

/**
 * Collects the transitive set of local modules reachable from `entry` by
 * following relative `import` / `export … from` specifiers. Bare specifiers
 * (npm packages) are returned separately so we can assert there are none.
 */
function collectModuleGraph(entry: string): { local: Set<string>; bare: Set<string> } {
  const local = new Set<string>();
  const bare = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (local.has(file)) continue;
    local.add(file);

    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g),
      ...source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g),
    ].map((m) => m[1]);

    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        bare.add(specifier);
        continue;
      }
      queue.push(resolve(dirname(file), `${specifier}.ts`));
    }
  }

  return { local, bare };
}

describe("@stellarcred/sdk/core — zero-dependency module graph (#1066)", () => {
  const graph = collectModuleGraph(join(SRC_DIR, "core-entry.ts"));

  it("imports no npm packages at all", () => {
    expect([...graph.bare]).toEqual([]);
  });

  it("never reaches React, the Stellar SDK, or the registry clients", () => {
    const forbidden = ["react.ts", "index.ts", "server.ts", "core.ts", "submit.ts"];
    const reached = [...graph.local].map((f) => f.slice(SRC_DIR.length + 1));

    for (const file of forbidden) {
      expect(reached).not.toContain(file);
    }
    expect(reached.some((f) => f.includes("proof-registry"))).toBe(false);
    expect(reached.some((f) => f.includes("issuer-registry"))).toBe(false);
  });

  it("stays small — the whole core module graph is well under 100KB", () => {
    const bytes = [...graph.local].reduce((sum, file) => sum + statSync(file).size, 0);
    expect(bytes).toBeLessThan(100 * 1024);
  });
});

// ── 4. Packaging ─────────────────────────────────────────────────────────────

describe("@stellarcred/sdk/core — packaging (#1066)", () => {
  it("declares a ./core subpath export", () => {
    const exportsMap = pkg.exports as Record<string, Record<string, string>>;
    expect(exportsMap["./core"]).toBeDefined();
    expect(exportsMap["./core"].types).toBe("./dist/core-entry.d.ts");
    expect(exportsMap["./core"].import).toBe("./dist/core-entry.mjs");
    expect(exportsMap["./core"].require).toBe("./dist/core-entry.js");
  });

  it("builds the core entry point", () => {
    expect(pkg.scripts.build).toContain("src/core-entry.ts");
  });

  it("keeps the package side-effect free", () => {
    expect(pkg.sideEffects).toBe(false);
  });
});

// ── 5. Sanity: source directory is readable (guards the graph walker) ────────

describe("core module graph walker", () => {
  it("finds the source files it walks", () => {
    expect(readdirSync(SRC_DIR)).toContain("core-entry.ts");
  });
});

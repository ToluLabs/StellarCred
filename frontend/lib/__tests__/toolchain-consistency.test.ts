import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

describe("ZK Toolchain Consistency (#971)", () => {
  const rootDir = path.resolve(__dirname, "../../..");

  it("package.json declares pinned versions for Noir and Barretenberg", () => {
    const pkgPath = path.resolve(rootDir, "frontend/package.json");
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    const bbVersion = pkg.dependencies["@aztec/bb.js"];
    const noirVersion = pkg.dependencies["@noir-lang/noir_js"];

    expect(bbVersion).toBe("0.87.0");
    expect(noirVersion).toBe("1.0.0-beta.9");
  });

  it("circuits/supported-circuits.v1.json exists and defines v1 release", () => {
    const manifestPath = path.resolve(rootDir, "circuits/supported-circuits.v1.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest.manifestVersion).toBe("1.0.0");
    expect(manifest.release).toBe("v1.0.0");
    expect(Array.isArray(manifest.circuits)).toBe(true);
  });

  it("docs/ZK_TOOLCHAIN_UPGRADE_POLICY.md documents upgrade procedure and version pins", () => {
    const policyPath = path.resolve(rootDir, "docs/ZK_TOOLCHAIN_UPGRADE_POLICY.md");
    expect(existsSync(policyPath)).toBe(true);
    const policy = readFileSync(policyPath, "utf8");

    expect(policy).toContain("0.87.0");
    expect(policy).toContain("1.0.0-beta.9");
    expect(policy).toContain("Verification Key (VK) Review");
  });
});

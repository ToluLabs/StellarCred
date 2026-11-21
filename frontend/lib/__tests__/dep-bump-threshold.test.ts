import { describe, it, expect } from "vitest";
import {
  parseSemver,
  parseVersionBump,
  evaluateDepBumpSafety,
  areFilesManifestOnly,
} from "../../../.github/scripts/check-dep-bump-threshold.mjs";

describe("check-dep-bump-threshold", () => {
  describe("parseSemver", () => {
    it("parses valid semver versions", () => {
      expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, raw: "1.2.3" });
      expect(parseSemver("v2.0.1")).toEqual({ major: 2, minor: 0, patch: 1, raw: "v2.0.1" });
      expect(parseSemver("0.87.0-beta.1")).toEqual({ major: 0, minor: 87, patch: 0, raw: "0.87.0-beta.1" });
    });

    it("returns null on invalid input", () => {
      expect(parseSemver("")).toBeNull();
      expect(parseSemver("not-a-version")).toBeNull();
    });
  });

  describe("parseVersionBump", () => {
    it("parses Dependabot / conventional bump PR titles", () => {
      const res1 = parseVersionBump("npm(deps): bump @tabler/icons-react from 3.45.0 to 3.46.0");
      expect(res1).toEqual({
        package: "@tabler/icons-react",
        from: "3.45.0",
        to: "3.46.0",
      });

      const res2 = parseVersionBump("cargo(deps): bump soroban-sdk from 21.0.0 to 22.0.0");
      expect(res2).toEqual({
        package: "soroban-sdk",
        from: "21.0.0",
        to: "22.0.0",
      });

      const res3 = parseVersionBump("ci(deps): bump actions/checkout from 4 to 5");
      expect(res3).toEqual({
        package: "actions/checkout",
        from: "4",
        to: "5",
      });
    });
  });

  describe("areFilesManifestOnly", () => {
    it("allows package.json and lockfile modifications", () => {
      expect(
        areFilesManifestOnly(["frontend/package.json", "frontend/pnpm-lock.yaml"]),
      ).toBe(true);
      expect(areFilesManifestOnly(["Cargo.toml", "Cargo.lock"])).toBe(true);
      expect(areFilesManifestOnly([".github/workflows/ci.yml"])).toBe(true);
    });

    it("rejects application source code changes", () => {
      expect(
        areFilesManifestOnly(["frontend/package.json", "frontend/lib/stellar.ts"]),
      ).toBe(false);
      expect(areFilesManifestOnly(["contracts/proof_registry/src/lib.rs"])).toBe(false);
    });
  });

  describe("evaluateDepBumpSafety", () => {
    it("allows minor dependency updates with label deps", () => {
      const result = evaluateDepBumpSafety({
        title: "npm(deps): bump next from 14.1.0 to 14.2.0",
        labels: ["deps"],
        changedFiles: ["frontend/package.json", "frontend/pnpm-lock.yaml"],
      });

      expect(result.eligible).toBe(true);
      expect(result.bumpType).toBe("minor");
      expect(result.reason).toContain("Safe minor update");
    });

    it("allows patch dependency updates with label dependencies", () => {
      const result = evaluateDepBumpSafety({
        title: "npm(deps): bump zod from 3.22.4 to 3.22.5",
        labels: ["dependencies"],
        changedFiles: ["frontend/package.json"],
      });

      expect(result.eligible).toBe(true);
      expect(result.bumpType).toBe("patch");
    });

    it("blocks major version bumps", () => {
      const result = evaluateDepBumpSafety({
        title: "npm(deps): bump next from 14.2.0 to 15.0.0",
        labels: ["deps"],
        changedFiles: ["frontend/package.json"],
      });

      expect(result.eligible).toBe(false);
      expect(result.bumpType).toBe("major");
      expect(result.reason).toContain("Blocked major version bump");
    });

    it("blocks 0.x breaking minor bumps", () => {
      const result = evaluateDepBumpSafety({
        title: "npm(deps): bump @aztec/bb.js from 0.87.0 to 0.88.0",
        labels: ["deps"],
        changedFiles: ["frontend/package.json"],
      });

      expect(result.eligible).toBe(false);
      expect(result.bumpType).toBe("major");
      expect(result.reason).toContain("Blocked 0.x breaking minor bump");
    });

    it("rejects PRs without the configured deps label", () => {
      const result = evaluateDepBumpSafety({
        title: "npm(deps): bump next from 14.1.0 to 14.2.0",
        labels: ["frontend"],
        changedFiles: ["frontend/package.json"],
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("does not have required auto-merge label");
    });

    it("rejects PRs with blocked labels", () => {
      const result = evaluateDepBumpSafety({
        title: "npm(deps): bump next from 14.1.0 to 14.2.0",
        labels: ["deps", "do-not-merge"],
        changedFiles: ["frontend/package.json"],
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("contains blocked label");
    });

    it("rejects PRs touching non-manifest files", () => {
      const result = evaluateDepBumpSafety({
        title: "npm(deps): bump next from 14.1.0 to 14.2.0",
        labels: ["deps"],
        changedFiles: ["frontend/package.json", "frontend/app/page.tsx"],
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("modifies files outside dependency manifests");
    });
  });
});

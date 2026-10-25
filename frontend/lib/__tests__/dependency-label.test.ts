import { describe, it, expect } from "vitest";
import {
  DEFAULT_DEPENDENCY_LABEL,
  DEPENDENCY_REASONS,
  classifyDependencyPr,
  isDependencyManifest,
  resolveDependencyLabel,
} from "../../../.github/scripts/label-deps.mjs";

const ORDINARY_PR = {
  author: "octocat",
  branch: "feat/add-dark-mode",
  title: "Add dark mode",
  changedFiles: ["frontend/app/page.tsx"],
};

describe("classifyDependencyPr", () => {
  it("detects Dependabot by author alone", () => {
    expect(
      classifyDependencyPr({
        ...ORDINARY_PR,
        author: "dependabot[bot]",
      }),
    ).toEqual({
      isDependency: true,
      reasons: [DEPENDENCY_REASONS.AUTHOR],
    });
  });

  it("detects Renovate by author case-insensitively", () => {
    expect(
      classifyDependencyPr({
        ...ORDINARY_PR,
        author: "Renovate[Bot]",
      }),
    ).toEqual({
      isDependency: true,
      reasons: [DEPENDENCY_REASONS.AUTHOR],
    });
  });

  it("detects Dependabot and Renovate branch prefixes", () => {
    expect(
      classifyDependencyPr({
        ...ORDINARY_PR,
        branch: "dependabot/npm_and_yarn/next-16.2.0",
      }).reasons,
    ).toContain(DEPENDENCY_REASONS.BRANCH);
    expect(
      classifyDependencyPr({
        ...ORDINARY_PR,
        branch: "renovate/lock-file-maintenance",
      }).reasons,
    ).toContain(DEPENDENCY_REASONS.BRANCH);
  });

  it.each([
    "chore(deps): bump typescript from 5.9.2 to 5.9.3",
    "build(deps-dev): bump eslint from 9.38.0 to 9.39.0",
    "Bump next from 16.1.0 to 16.2.0",
    "Update dependency next to v16.2.0",
    "Update all non-major dependencies",
    "Dependency bump for the pnpm workspace",
  ])("detects the dependency title %j", (title) => {
    expect(classifyDependencyPr({ ...ORDINARY_PR, title }).reasons).toContain(
      DEPENDENCY_REASONS.TITLE,
    );
  });

  it("detects a manual dependency PR from its changed manifests", () => {
    expect(
      classifyDependencyPr({
        ...ORDINARY_PR,
        title: "Refresh the lockfile",
        changedFiles: ["frontend/package.json", "frontend/pnpm-lock.yaml"],
      }),
    ).toEqual({
      isDependency: true,
      reasons: [DEPENDENCY_REASONS.CHANGED_FILES],
    });
  });

  it("reports every matching reason", () => {
    expect(
      classifyDependencyPr({
        author: "dependabot[bot]",
        branch: "dependabot/npm_and_yarn/next-16.2.0",
        title: "Bump next from 16.1.0 to 16.2.0",
        changedFiles: ["frontend/package.json"],
      }).reasons,
    ).toEqual([
      DEPENDENCY_REASONS.AUTHOR,
      DEPENDENCY_REASONS.BRANCH,
      DEPENDENCY_REASONS.TITLE,
      DEPENDENCY_REASONS.CHANGED_FILES,
    ]);
  });

  it("does not label an ordinary application PR", () => {
    expect(classifyDependencyPr(ORDINARY_PR)).toEqual({
      isDependency: false,
      reasons: [],
    });
  });

  it("does not label a docs PR that merely mentions dependency injection", () => {
    expect(
      classifyDependencyPr({
        ...ORDINARY_PR,
        title: "Document dependency injection",
      }),
    ).toEqual({ isDependency: false, reasons: [] });
  });

  it("does not label an unrelated workflow edit via changed files", () => {
    expect(
      classifyDependencyPr({
        ...ORDINARY_PR,
        changedFiles: [".github/ISSUE_TEMPLATE/bug_report.yml"],
      }),
    ).toEqual({ isDependency: false, reasons: [] });
  });

  it("does not throw when the PR payload is incomplete", () => {
    expect(classifyDependencyPr()).toEqual({
      isDependency: false,
      reasons: [],
    });
    expect(classifyDependencyPr({ author: undefined, title: undefined })).toEqual({
      isDependency: false,
      reasons: [],
    });
  });
});

describe("isDependencyManifest", () => {
  it.each([
    "package.json",
    "frontend/package.json",
    "frontend/packages/sdk/package.json",
    "frontend/pnpm-lock.yaml",
    "services/indexer/package-lock.json",
    "Cargo.toml",
    "contracts/credential_verifier/Cargo.toml",
    ".github/workflows/ci.yml",
  ])("recognizes %s", (filePath) => {
    expect(isDependencyManifest(filePath)).toBe(true);
  });

  it.each([
    "",
    "README.md",
    "frontend/app/page.tsx",
    "docs/package.json.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
  ])("rejects %j", (filePath) => {
    expect(isDependencyManifest(filePath)).toBe(false);
  });

  it("normalizes leading ./ and backslashes", () => {
    expect(isDependencyManifest("./frontend/package.json")).toBe(true);
    expect(isDependencyManifest("frontend\\pnpm-lock.yaml")).toBe(true);
  });
});

describe("resolveDependencyLabel", () => {
  it("defaults to deps when unset, empty, or whitespace", () => {
    expect(DEFAULT_DEPENDENCY_LABEL).toBe("deps");
    expect(resolveDependencyLabel(undefined)).toBe("deps");
    expect(resolveDependencyLabel(null)).toBe("deps");
    expect(resolveDependencyLabel("")).toBe("deps");
    expect(resolveDependencyLabel("   ")).toBe("deps");
  });

  it("uses a configured label and trims surrounding whitespace", () => {
    expect(resolveDependencyLabel("dependencies")).toBe("dependencies");
    expect(resolveDependencyLabel("  deps  ")).toBe("deps");
  });

  it("ignores non-string configuration values", () => {
    expect(resolveDependencyLabel(42 as unknown as string)).toBe("deps");
  });
});

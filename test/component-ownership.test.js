#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, ".github/scripts/check-component-ownership.mjs");

const COMPONENTS = [
  ["Contracts", "contracts/"],
  ["Circuits and VKs", "circuits/"],
  ["SDK and client bindings", "frontend/packages/sdk/"],
  ["Frontend", "frontend/app/"],
  ["Issuer", "frontend/packages/issuer/"],
  ["Indexer", "services/indexer/"],
];

function matrix(rows = COMPONENTS) {
  const body = rows
    .map(
      ([name, scope]) =>
        `| **${name}** | \`${scope}\` | \`@alice\` | \`/${scope}\` | A reviewer checks it. |`,
    )
    .join("\n");
  return `# Ownership\n\n<!-- ownership-matrix:start -->\n| Component | Scope | Owner | CODEOWNERS rule | Review path |\n|---|---|---|---|---|\n${body}\n<!-- ownership-matrix:end -->\n`;
}

function fixture(rows) {
  const root = mkdtempSync(join(tmpdir(), "ownership-check-"));
  mkdirSync(join(root, ".github"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });

  const patterns = [`/* @alice`, ...rows.map(([, scope]) => `/${scope} @alice`)];
  writeFileSync(join(root, ".github/CODEOWNERS"), `${patterns.join("\n")}\n`);
  writeFileSync(join(root, "docs/COMPONENT_OWNERSHIP.md"), matrix(rows));

  for (const [, scope] of rows) {
    mkdirSync(join(root, scope), { recursive: true });
    writeFileSync(join(root, scope, "placeholder.ts"), "export {};\n");
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script, "--root", root], { encoding: "utf-8" });
}

test("the repository's own ownership matrix passes", () => {
  const result = run(repoRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check-component-ownership: OK/);
});

test("a consistent fixture passes", () => {
  const root = fixture(COMPONENTS);
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing component row fails", () => {
  const root = fixture(COMPONENTS.filter(([name]) => name !== "Indexer"));
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing component row: Indexer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a documented path that does not exist fails", () => {
  const rows = COMPONENTS.map(([name, scope]) =>
    name === "Indexer" ? [name, "services/does-not-exist/"] : [name, scope],
  );
  const root = fixture(rows);
  rmSync(join(root, "services/does-not-exist"), { recursive: true, force: true });
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /documented path does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, ".github/scripts/check-sdk-layout.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sdk-layout-check-"));
  const sdk = join(root, "frontend/packages/sdk");
  mkdirSync(join(sdk, "src"), { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@stellarcred/sdk" }));
  writeFileSync(join(sdk, "src/index.ts"), "export {};\n");
  mkdirSync(join(root, "sdk"));
  writeFileSync(join(root, "sdk/README.md"), "Deprecated location.\n");
  return root;
}

function manifest(root, path, name) {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify({ name }));
}

function run(root) {
  return spawnSync(process.execPath, [script, "--root", root], { encoding: "utf-8" });
}

test("the repository's own SDK layout passes", () => {
  const result = run(repoRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check-sdk-layout: OK/);
});

test("a canonical package with a deprecation pointer passes", () => {
  const root = fixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restored root SDK package fails", () => {
  const root = fixture();
  try {
    manifest(root, "sdk/package.json", "@sdk/core");
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /recreates the retired root SDK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a source-only duplicate in the retired root SDK fails", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "sdk/src"), { recursive: true });
    writeFileSync(join(root, "sdk/src/index.ts"), "export {};\n");
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unexpected entries in the retired root SDK: src/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second package using the canonical name fails", () => {
  const root = fixture();
  try {
    manifest(root, "packages/other-sdk/package.json", "@stellarcred/sdk");
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Duplicate @stellarcred\/sdk manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the retired package name cannot return in another location", () => {
  const root = fixture();
  try {
    manifest(root, "packages/legacy/package.json", "@sdk/core");
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Retired SDK package @sdk\/core/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, ".github/scripts/check-sdk-runtime-support.mjs");

const matrix = () => ({
  schemaVersion: 1,
  releaseLines: {
    "0.1.x": {
      node: { minimum: "20.0.0", tested: ["20", "22", "24"] },
      browsers: { chrome: "103", edge: "103", firefox: "100", safari: "16.0" },
      runtimes: ["node", "browser", "edge"],
      nodeOnlyExport: "./server",
    },
  },
});

const doc = () => `# SDK Runtime Support Policy

<!-- sdk-runtime-matrix:start -->
| Runtime family | Entry point | Supported versions | CI verification |
| :--- | :--- | :--- | :--- |
| **Node.js** | \`@stellarcred/sdk\` | \`20.0.0\` minimum; tests run on Node \`20\`, \`22\`, \`24\` | CI |
| **Browsers** | \`@stellarcred/sdk\` | Chrome \`103\`+, Edge \`103\`+, Firefox \`100\`+, Safari \`16.0\`+ | jsdom |
| **Edge runtimes** | \`@stellarcred/sdk\` | fetch, AbortSignal.timeout | Static check |
| **Node.js server** | \`@stellarcred/sdk/server\` | Node \`20.0.0\`+ | CI |
<!-- sdk-runtime-matrix:end -->
`;

const ci = () => `name: CI

on:
  pull_request:
    branches: [main]

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - run: echo frontend

  sdk-runtime-matrix:
    name: SDK runtime matrix (Node \${{ matrix.node }})
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ["20", "22", "24"]
    steps:
      - run: echo sdk

  a11y:
    runs-on: ubuntu-latest
    steps:
      - run: echo a11y
`;

function fixture({
  pkg = {},
  support = matrix(),
  docs = doc(),
  workflow = ci(),
  extraSources = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "sdk-runtime-support-"));
  const sdk = join(root, "frontend/packages/sdk");
  mkdirSync(join(sdk, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".github/workflows"), { recursive: true });

  writeFileSync(
    join(sdk, "package.json"),
    `${JSON.stringify(
      { name: "@stellarcred/sdk", version: "0.1.1", engines: { node: ">=20.0.0" }, ...pkg },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(sdk, "runtime-support.json"), `${JSON.stringify(support, null, 2)}\n`);
  writeFileSync(join(sdk, "src/index.ts"), 'export const read = () => fetch("/rpc");\n');
  writeFileSync(
    join(sdk, "src/batch-verify.ts"),
    'import { cpus } from "node:os";\nexport const cores = () => cpus().length;\n',
  );
  for (const [name, content] of Object.entries(extraSources)) {
    writeFileSync(join(sdk, "src", name), content);
  }
  writeFileSync(join(root, "docs/SDK_RUNTIME_SUPPORT.md"), docs);
  writeFileSync(join(root, ".github/workflows/ci.yml"), workflow);
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script, "--root", root], { encoding: "utf-8" });
}

function withFixture(options, assertion) {
  const root = fixture(options);
  try {
    assertion(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts a declared, verified and browser-safe matrix", () => {
  withFixture({}, (root) => {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SDK runtime support matrix OK \(0\.1\.x/);
  });
});

test("rejects an engines floor that disagrees with the matrix", () => {
  withFixture({ pkg: { engines: { node: ">=22.0.0" } } }, (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /engines\.node is ">=22\.0\.0"; the matrix declares ">=20\.0\.0"/);
  });
});

test("rejects a CI matrix that does not test every declared Node version", () => {
  const workflow = ci().replace('node: ["20", "22", "24"]', 'node: ["20", "22"]');
  withFixture({ workflow }, (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /sdk-runtime-matrix tests Node 20, 22; the matrix declares 20, 22, 24/,
    );
  });
});

test("rejects a missing sdk-runtime-matrix CI job", () => {
  const workflow = ci().replace(/  sdk-runtime-matrix:[\s\S]*?(?=  a11y:)/, "");
  withFixture({ workflow }, (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no "sdk-runtime-matrix" job/);
  });
});

test("rejects browser-reachable source that imports a node: built-in", () => {
  const extraSources = {
    "browser-storage.ts":
      'import { readFileSync } from "node:fs";\nexport const cache = () => readFileSync("/tmp/x");\n',
  };
  withFixture({ extraSources }, (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /browser-storage\.ts: imports a node: built-in/);
  });
});

test("rejects docs that do not name a declared runtime version", () => {
  const docs = doc().replace("Safari `16.0`+", "Safari `15.0`+");
  withFixture({ docs }, (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /matrix does not mention "16\.0"/);
  });
});

test("rejects docs without the matrix markers", () => {
  const docs = doc()
    .replace("<!-- sdk-runtime-matrix:start -->", "")
    .replace("<!-- sdk-runtime-matrix:end -->", "");
  withFixture({ docs }, (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing <!-- sdk-runtime-matrix:start -->/);
  });
});

test("rejects a package version with no matching release line", () => {
  withFixture({ pkg: { version: "0.2.0" } }, (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no release line "0\.2\.x" for package version 0\.2\.0/);
  });
});

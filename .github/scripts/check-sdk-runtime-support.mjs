#!/usr/bin/env node

/**
 * Keep the published SDK's runtime support contract honest (issue #990).
 *
 * `@stellarcred/sdk` is an integration boundary. Integrators plan upgrades
 * around a documented support matrix, so an undeclared drift — a bumped
 * `engines` floor, a dropped CI version, a browser entry that starts importing
 * `node:fs`, or a docs table that no longer matches the release — silently
 * breaks that promise.
 *
 * This check verifies the relationships, not arbitrary wording:
 *
 *   - frontend/packages/sdk/runtime-support.json parses and has a release line
 *     for the package's current major.minor version;
 *   - package.json `engines.node` equals `>=<minimum>` from the matrix;
 *   - docs/SDK_RUNTIME_SUPPORT.md contains a matrix row (between the markers)
 *     naming every supported runtime and each declared version;
 *   - the `sdk-runtime-matrix` CI job tests exactly the declared Node versions;
 *   - only Node-only source files import `node:` built-ins, keeping the
 *     declared browser entry point browser-safe.
 *
 * Usage:
 *   node .github/scripts/check-sdk-runtime-support.mjs
 *   node .github/scripts/check-sdk-runtime-support.mjs --root <dir>
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MATRIX_PATH = "frontend/packages/sdk/runtime-support.json";
const PACKAGE_PATH = "frontend/packages/sdk/package.json";
const DOC_PATH = "docs/SDK_RUNTIME_SUPPORT.md";
const CI_PATH = ".github/workflows/ci.yml";
const SDK_SRC = "frontend/packages/sdk/src";
const CI_JOB = "sdk-runtime-matrix";
const DOC_START = "<!-- sdk-runtime-matrix:start -->";
const DOC_END = "<!-- sdk-runtime-matrix:end -->";

/** Source files allowed to import Node built-ins (the `./server` entry only). */
const NODE_ONLY_SOURCES = new Set(["batch-verify.ts"]);

const BROWSER_NAMES = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", safari: "Safari" };

function fail(message) {
  console.error(`::error::${message}`);
  return 1;
}

function parseArgs(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return { root: resolve(dirname(fileURLToPath(import.meta.url)), "../..") };
  const value = argv[rootIndex + 1];
  if (!value) throw new Error("--root requires a directory");
  return { root: resolve(value) };
}

function readJson(root, path) {
  try {
    return JSON.parse(readFileSync(join(root, path), "utf-8"));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
}

function readText(root, path) {
  try {
    return readFileSync(join(root, path), "utf-8");
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
}

/** The docs matrix table, between its markers, or null when markers are absent. */
function docsMatrix(doc) {
  const start = doc.indexOf(DOC_START);
  const end = doc.indexOf(DOC_END);
  if (start === -1 || end === -1 || end < start) return null;
  return doc.slice(start + DOC_START.length, end);
}

/** The body of the sdk-runtime-matrix job in ci.yml. */
function ciJobBlock(ci) {
  const start = ci.indexOf(`\n  ${CI_JOB}:`);
  if (start === -1) return null;
  const rest = ci.slice(start + 1);
  const bodyStart = rest.indexOf("\n") + 1;
  const nextJob = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(rest.slice(bodyStart));
  return nextJob ? rest.slice(0, bodyStart + nextJob.index) : rest;
}

function listedNodeVersions(job) {
  const match = /node:\s*\[([^\]]*)\]/.exec(job);
  if (!match) return null;
  return match[1]
    .split(",")
    .map((value) => value.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function nodeImports(file) {
  const source = readFileSync(file, "utf-8");
  return /(?:from\s*|require\(\s*)["']node:/.test(source);
}

function check(root) {
  const errors = [];
  const matrix = readJson(root, MATRIX_PATH);
  const pkg = readJson(root, PACKAGE_PATH);

  if (matrix.schemaVersion !== 1) errors.push(`${MATRIX_PATH}: schemaVersion must be 1`);

  const [major, minor] = String(pkg.version).split(".");
  const releaseKey = `${major}.${minor}.x`;
  const release = matrix.releaseLines?.[releaseKey];
  if (!release) {
    errors.push(
      `${MATRIX_PATH}: no release line "${releaseKey}" for package version ${pkg.version}`,
    );
  }

  if (release) {
    const minimum = release.node?.minimum;
    const tested = release.node?.tested;
    if (!minimum) errors.push(`${MATRIX_PATH}: ${releaseKey}.node.minimum is required`);
    else if (pkg.engines?.node !== `>=${minimum}`) {
      errors.push(
        `${PACKAGE_PATH}: engines.node is ${JSON.stringify(pkg.engines?.node)}; the matrix declares ">=${minimum}"`,
      );
    }
    if (!Array.isArray(tested) || tested.length === 0) {
      errors.push(`${MATRIX_PATH}: ${releaseKey}.node.tested must list the Node versions CI runs`);
    }
    for (const runtime of release.runtimes ?? []) {
      if (!["node", "browser", "edge"].includes(runtime)) {
        errors.push(
          `${MATRIX_PATH}: unknown runtime "${runtime}" (expected node, browser or edge)`,
        );
      }
    }

    // ── docs matrix ────────────────────────────────────────────────────────
    const doc = readText(root, DOC_PATH);
    const table = docsMatrix(doc);
    if (table === null) {
      errors.push(`${DOC_PATH}: missing ${DOC_START} / ${DOC_END} markers`);
    } else {
      const expected = [
        "Node.js",
        minimum,
        ...(tested ?? []),
        ...Object.entries(release.browsers ?? {}).flatMap(([name, version]) => [
          BROWSER_NAMES[name] ?? name,
          version,
        ]),
      ];
      for (const token of expected) {
        if (!new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(table)) {
          errors.push(`${DOC_PATH}: matrix does not mention "${token}"`);
        }
      }
    }

    // ── CI job ─────────────────────────────────────────────────────────────
    const ci = readText(root, CI_PATH);
    const job = ciJobBlock(ci);
    if (job === null) {
      errors.push(`${CI_PATH}: no "${CI_JOB}" job`);
    } else {
      const versions = listedNodeVersions(job);
      const declared = [...(tested ?? [])].sort();
      if (versions === null) {
        errors.push(`${CI_PATH}: ${CI_JOB} has no node matrix (expected node: ["20", ...])`);
      } else if (JSON.stringify([...versions].sort()) !== JSON.stringify(declared)) {
        errors.push(
          `${CI_PATH}: ${CI_JOB} tests Node ${versions.join(", ")}; the matrix declares ${declared.join(", ")}`,
        );
      }
    }

    // ── browser boundary ───────────────────────────────────────────────────
    const srcDir = join(root, SDK_SRC);
    try {
      if (!statSync(srcDir).isDirectory()) throw new Error("not a directory");
      for (const file of walk(srcDir)) {
        const name = relative(srcDir, file).split(sep).join("/");
        if (nodeImports(file) && !NODE_ONLY_SOURCES.has(name)) {
          errors.push(
            `${SDK_SRC}/${name}: imports a node: built-in but is not a declared Node-only module. ` +
              `Move it behind ./server or add it to NODE_ONLY_SOURCES in this check.`,
          );
        }
      }
    } catch (err) {
      errors.push(`${SDK_SRC}: cannot scan browser entry sources: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) fail(error);
    return 1;
  }

  console.log(
    `SDK runtime support matrix OK (${releaseKey}: Node ${release.node.tested.join(", ")}; ` +
      `browsers ${Object.values(release.browsers ?? {}).join(", ")}).`,
  );
  return 0;
}

process.exitCode = check(parseArgs(process.argv).root);

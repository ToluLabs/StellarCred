#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_MANIFEST = "frontend/packages/sdk/package.json";
const RETIRED_PACKAGE_NAMES = new Set(["@sdk/core"]);
const IGNORED_DIRS = new Set([".git", "node_modules", "target", "dist", "build", "coverage"]);

function parseArgs(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) {
    return { root: resolve(dirname(fileURLToPath(import.meta.url)), "../..") };
  }
  const value = argv[rootIndex + 1];
  if (!value) throw new Error("--root requires a directory");
  return { root: resolve(value) };
}

function listFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf-8",
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else if (entry.isFile()) {
          files.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
        }
      }
    };
    walk(root);
    return files;
  }
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const errors = [];
  const canonicalPath = join(root, CANONICAL_MANIFEST);

  if (!existsSync(canonicalPath)) {
    errors.push(`Missing canonical SDK manifest at ${CANONICAL_MANIFEST}.`);
  } else {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(canonicalPath, "utf-8"));
    } catch (error) {
      errors.push(`${CANONICAL_MANIFEST} is not valid JSON: ${error.message}`);
    }
    if (manifest && manifest.name !== "@stellarcred/sdk") {
      errors.push(
        `${CANONICAL_MANIFEST} must declare name "@stellarcred/sdk"; found ${JSON.stringify(manifest.name)}.`,
      );
    }
    if (!existsSync(join(root, "frontend/packages/sdk/src/index.ts"))) {
      errors.push("Missing canonical SDK entry point at frontend/packages/sdk/src/index.ts.");
    }
  }

  if (existsSync(join(root, "sdk/package.json"))) {
    errors.push(
      "sdk/package.json recreates the retired root SDK. Keep SDK code and tests in frontend/packages/sdk/ and retain only the deprecation README at the repository root.",
    );
  }
  if (existsSync(join(root, "sdk"))) {
    const unexpected = readdirSync(join(root, "sdk")).filter((entry) => entry !== "README.md");
    if (unexpected.length > 0) {
      errors.push(
        `Unexpected entries in the retired root SDK: ${unexpected.join(", ")}. Retain only sdk/README.md and keep SDK code and tests in frontend/packages/sdk/.`,
      );
    }
  }

  for (const file of listFiles(root).filter(
    (path) => path.endsWith("/package.json") || path === "package.json",
  )) {
    if (file === CANONICAL_MANIFEST || file === "sdk/package.json") continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, file), "utf-8"));
    } catch {
      continue;
    }
    if (manifest.name === "@stellarcred/sdk") {
      errors.push(
        `Duplicate @stellarcred/sdk manifest at ${file}. ${CANONICAL_MANIFEST} is the only supported SDK package location.`,
      );
    }
    if (RETIRED_PACKAGE_NAMES.has(manifest.name)) {
      errors.push(
        `Retired SDK package ${manifest.name} found at ${file}. Migrate consumers to @stellarcred/sdk instead of restoring the duplicate.`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`check-sdk-layout: ${errors.length} problem(s) found.`);
    for (const error of errors) console.error(`::error::${error}`);
    return 1;
  }

  console.log("check-sdk-layout: OK — frontend/packages/sdk is the canonical SDK.");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`::error::check-sdk-layout failed: ${error.message}`);
  process.exit(1);
}

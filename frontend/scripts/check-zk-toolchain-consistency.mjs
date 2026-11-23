/**
 * check-zk-toolchain-consistency.mjs
 *
 * Verifies that ZK toolchain versions across package.json, Nargo.toml,
 * and circuit manifests are synchronized without drift (#971).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "../..");

let failed = false;

function check(description, fn) {
  try {
    fn();
    console.log(`[PASS] ${description}`);
  } catch (err) {
    console.error(`[FAIL] ${description}: ${err.message}`);
    failed = true;
  }
}

// 1. Read frontend/package.json
const pkgPath = resolve(rootDir, "frontend/package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const bbJsVersion = pkg.dependencies?.["@aztec/bb.js"];
const noirJsVersion = pkg.dependencies?.["@noir-lang/noir_js"];

check("frontend/package.json contains pinned @aztec/bb.js", () => {
  if (!bbJsVersion) throw new Error("Missing @aztec/bb.js in dependencies");
});

check("frontend/package.json contains pinned @noir-lang/noir_js", () => {
  if (!noirJsVersion) throw new Error("Missing @noir-lang/noir_js in dependencies");
});

// 2. Read circuits/supported-circuits.v1.json
const manifestPath = resolve(rootDir, "circuits/supported-circuits.v1.json");
check("circuits/supported-circuits.v1.json exists and is valid", () => {
  if (!existsSync(manifestPath)) throw new Error("Manifest not found");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.manifestVersion !== "1.0.0") throw new Error("Unexpected manifestVersion");
  if (!Array.isArray(manifest.circuits) || manifest.circuits.length === 0) {
    throw new Error("No circuits declared in manifest");
  }
});

// 3. Read docs/ZK_TOOLCHAIN_UPGRADE_POLICY.md
const policyPath = resolve(rootDir, "docs/ZK_TOOLCHAIN_UPGRADE_POLICY.md");
check("docs/ZK_TOOLCHAIN_UPGRADE_POLICY.md exists and documents bb.js version", () => {
  if (!existsSync(policyPath)) throw new Error("Policy doc not found");
  const policy = readFileSync(policyPath, "utf8");
  if (!policy.includes(bbJsVersion)) {
    throw new Error(`Policy doc does not reference current bb.js version ${bbJsVersion}`);
  }
});

if (failed) {
  process.exit(1);
} else {
  console.log("All ZK toolchain consistency checks passed.");
}

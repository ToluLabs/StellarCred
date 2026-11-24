#!/usr/bin/env node
// Stamp declared circuit version identity into a compiled Noir artifact.
//
// A compiled circuit is otherwise anonymous: it is a bag of ACIR plus an ABI,
// and nothing in it says which *version* of the circuit it is. The VK derived
// from it is versioned on-chain, but that only happens after deployment — so a
// credential minted against circuit v1 carries nothing that distinguishes it
// from one minted against v2, and a layout change only shows up as a failed
// proof (issue #633).
//
// This script writes the declared version from circuits/circuit-versions.json
// into the artifact as two extra top-level fields:
//
//   circuit_version     "1.0.0"  — the declared circuit version
//   circuit_vk_version      1    — the CredentialVerifier VK counter for it
//
// They are appended last so the nargo-emitted fields keep their original order
// and the diff stays a pure addition. Output is minified to match the format
// nargo emits, so re-stamping a build without a version bump is a no-op.
//
// Usage:
//   node circuits/scripts/stamp-circuit-version.js stamp <circuit> <artifact.json>
//   node circuits/scripts/stamp-circuit-version.js check <artifact.json> <circuit>
//   node circuits/scripts/stamp-circuit-version.js check-all
//
// `check`/`check-all` verify an already-stamped artifact rather than rewriting
// it, so CI can assert the committed frontend/public/circuits/*.json still
// match the manifest.

"use strict";

const fs = require("fs");
const { typeOfCircuit, versionOf } = require("./circuit-versions");

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Read + parse an artifact, failing with a clear message rather than a stack. */
function readArtifact(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    fail(`Cannot read compiled artifact ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${file} is not valid JSON: ${e.message}`);
  }
}

function declared(circuit) {
  const v = versionOf(circuit);
  if (!v) {
    fail(
      `Circuit "${circuit}" has no entry in circuits/circuit-versions.json. ` +
        `Add its version and vkVersion before building it.`,
    );
  }
  return v;
}

/** Write `circuit_version` / `circuit_vk_version` into the parsed artifact. */
function applyStamp(artifact, circuit) {
  const { version, vkVersion } = declared(circuit);
  return { ...artifact, circuit_version: version, circuit_vk_version: vkVersion };
}

function stamp(circuit, file) {
  const stamped = applyStamp(readArtifact(file), circuit);
  fs.writeFileSync(file, JSON.stringify(stamped));
  console.log(
    `  -> ${file} (${typeOfCircuit(circuit)} circuit v${stamped.circuit_version}, vk v${stamped.circuit_vk_version})`,
  );
}

/** Returns true when the artifact already carries the declared version. */
function check(circuit, file) {
  const { version, vkVersion } = declared(circuit);
  const artifact = readArtifact(file);
  const problems = [];

  for (const [field, expected] of [
    ["circuit_version", version],
    ["circuit_vk_version", vkVersion],
  ]) {
    if (artifact[field] === undefined) {
      problems.push(`${field} is missing (expected ${JSON.stringify(expected)})`);
    } else if (artifact[field] !== expected) {
      problems.push(
        `${field} is ${JSON.stringify(artifact[field])}, manifest says ${JSON.stringify(expected)}`,
      );
    }
  }
  // A stale stamp is worse than none: it would let a credential claim
  // compatibility with a circuit that is no longer the one being served.
  return { ok: problems.length === 0, problems };
}

function checkOne(circuit, file) {
  const result = check(circuit, file);
  if (result.ok) {
    console.log(`  ok   ${file}`);
    return true;
  }
  console.error(`  FAIL ${file}: ${result.problems.join("; ")}`);
  return false;
}

function checkAll(frontendCircuitsDir) {
  const { circuitNames } = require("./circuit-versions");
  let ok = true;
  for (const circuit of circuitNames()) {
    const file = `${frontendCircuitsDir}/${typeOfCircuit(circuit)}.json`;
    if (!fs.existsSync(file)) {
      // Not every declared circuit is served to the browser (e.g. a helper
      // circuit that is only ever compiled). Only assert on the ones that are.
      console.log(`  skip ${file} (not built)`);
      continue;
    }
    ok = checkOne(circuit, file) && ok;
  }
  return ok;
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  switch (mode) {
    case "stamp": {
      const [circuit, file] = rest;
      if (!circuit || !file) fail("usage: stamp-circuit-version.js stamp <circuit> <artifact.json>");
      stamp(circuit, file);
      return;
    }
    case "check": {
      const [file, circuit] = rest;
      if (!file || !circuit) fail("usage: stamp-circuit-version.js check <artifact.json> <circuit>");
      process.exit(checkOne(circuit, file) ? 0 : 1);
    }
    case "check-all": {
      const dir = rest[0] || "frontend/public/circuits";
      if (!checkAll(dir)) {
        fail(
          `\nCompiled circuit artifacts in ${dir} are not stamped with the versions in ` +
            `circuits/circuit-versions.json.\n` +
            `Either the version was bumped without rebuilding, or the artifact was edited by hand. ` +
            `Rebuild with: bash circuits/scripts/build.sh`,
        );
      }
      console.log("All compiled circuit artifacts carry the declared circuit version.");
      return;
    }
    default:
      fail(
        "usage: stamp-circuit-version.js [stamp <circuit> <artifact.json> | " +
          "check <artifact.json> <circuit> | check-all [dir]]",
      );
  }
}

main();

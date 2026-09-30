"use strict";

// Shared accessor for circuits/circuit-versions.json (issue #633).
//
// The manifest is the single source of truth for circuit version identity. It
// is read by three callers that must never disagree about what version a
// circuit is:
//
//   • circuits/scripts/stamp-circuit-version.js — stamps the version into the
//     compiled artifact served to the browser,
//   • circuits/scripts/testvectors.js — fails CI when a circuit changed but
//     its declared version was not bumped,
//   • circuits/scripts/build.sh — resolves the frontend artifact filename.
//
// The frontend mirrors this table in frontend/lib/circuit-versions.ts; a unit
// test there asserts the two agree, so a bump in one place cannot silently
// drift from the other.

const fs = require("fs");
const path = require("path");

const MANIFEST_PATH = path.join(__dirname, "..", "circuit-versions.json");

/** MAJOR.MINOR.PATCH — the same shape the rest of the repo encodes as a u32. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * The frontend credential-type name for a circuit package. The mapping is the
 * one build.sh has always used: `kyc_proof` → `kyc`, `set_membership` →
 * `set_membership`, `commit3` → `commit3`.
 */
function typeOfCircuit(name) {
  return name.replace(/_proof$/, "");
}

/** Read + validate the manifest. Throws on anything malformed. */
function loadManifest() {
  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const circuits = raw && raw.circuits;
  if (!circuits || typeof circuits !== "object") {
    throw new Error(`${MANIFEST_PATH} is missing a "circuits" object.`);
  }
  for (const [name, entry] of Object.entries(circuits)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${MANIFEST_PATH}: "${name}" must be an object.`);
    }
    if (typeof entry.version !== "string" || !VERSION_RE.test(entry.version)) {
      throw new Error(
        `${MANIFEST_PATH}: "${name}".version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(entry.version)}.`,
      );
    }
    // 0 is reserved on-chain as the "version not stored" sentinel, so a VK
    // version below 1 could never be registered in CredentialVerifier.
    if (!Number.isInteger(entry.vkVersion) || entry.vkVersion < 1) {
      throw new Error(
        `${MANIFEST_PATH}: "${name}".vkVersion must be an integer >= 1, got ${JSON.stringify(entry.vkVersion)}.`,
      );
    }
  }
  return raw;
}

/** Every circuit package name in the manifest, in declaration order. */
function circuitNames() {
  return Object.keys(loadManifest().circuits);
}

/** `{ version, vkVersion }` for a circuit package, or null when undeclared. */
function versionOf(name) {
  const entry = loadManifest().circuits[name];
  if (!entry) return null;
  return { version: entry.version, vkVersion: entry.vkVersion };
}

/**
 * Look a circuit up by its frontend credential-type name, so callers holding a
 * `kyc` / `age` / `aggregate` string do not have to know the package naming.
 * Returns null for a type with no declared circuit.
 */
function versionOfType(type) {
  for (const name of circuitNames()) {
    if (typeOfCircuit(name) === type) return versionOf(name);
  }
  return null;
}

module.exports = {
  MANIFEST_PATH,
  typeOfCircuit,
  loadManifest,
  circuitNames,
  versionOf,
  versionOfType,
};

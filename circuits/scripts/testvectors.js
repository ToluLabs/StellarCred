#!/usr/bin/env node
// Deterministic proof-generation regression harness.
//
// For each credential circuit, re-derives (witness -> public inputs, VK hash)
// from the committed Prover.toml using the pinned Noir/Barretenberg toolchain
// and compares the result against circuits/testvectors/<name>.json. A mismatch
// means the circuit, the toolchain, or the committed witness changed and the
// on-chain VK / proof format may no longer agree with what's deployed.
//
// See circuits/README.md ("Test Vectors") for how to regenerate on purpose.
//
// Usage:
//   node circuits/scripts/testvectors.js check    # default; exit 1 on drift
//   node circuits/scripts/testvectors.js update   # regenerate committed vectors

"use strict";

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { versionOf } = require("./circuit-versions");

const NOIR_VERSION = "1.0.0-beta.9";
const BB_VERSION = "0.87.0";

const ROOT = path.join(__dirname, ".."); // circuits/
const VECTORS_DIR = path.join(ROOT, "testvectors");

// Circuits with a committed Prover.toml witness and a deployed VK. (Extend
// this list if a new circuit gains fixtures/build.sh wiring.)
const CIRCUITS = [
  "kyc_proof",
  "age_proof",
  "income_proof",
  "jurisdiction_proof",
  "funds_proof",
  "set_membership",
];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" });
}

function toolVersions() {
  const nargoOut = run("nargo", ["--version"]);
  const bbOut = run("bb", ["--version"]);
  const nargoVersion = (nargoOut.match(/nargo version = (\S+)/) || [])[1] || nargoOut.trim();
  return { nargoVersion, bbVersion: bbOut.trim() };
}

// Minimal parser for the flat Prover.toml files used in this repo: lines of
// `key = "string"` or `key = [elem, elem, ...]` with quoted-string or
// bare-number elements. Not a general TOML parser.
function parseProverToml(text) {
  const witness = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value.startsWith("[")) {
      witness[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.startsWith('"') ? s.slice(1, -1) : Number(s)));
    } else {
      witness[key] = value.startsWith('"') ? value.slice(1, -1) : Number(value);
    }
  }
  return witness;
}

function buildVector(name, toolchain) {
  const dir = path.join(ROOT, name);
  const target = path.join(ROOT, "target"); // shared Nargo workspace target dir
  fs.mkdirSync(target, { recursive: true });

  run("nargo", ["compile", "--package", name], ROOT);
  run("nargo", ["execute", "--package", name], ROOT);

  const bytecodePath = path.join(target, `${name}.json`);
  const witnessPath = path.join(target, `${name}.gz`);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-testvector-`));

  try {
    run(
      "bb",
      [
        "write_vk", "--scheme", "ultra_honk", "--oracle_hash", "keccak",
        "--bytecode_path", bytecodePath, "--output_path", outDir,
        "--output_format", "bytes_and_fields",
      ],
      ROOT,
    );
    run(
      "bb",
      [
        "prove", "--scheme", "ultra_honk", "--oracle_hash", "keccak",
        "--bytecode_path", bytecodePath, "--witness_path", witnessPath,
        "--output_path", outDir, "--output_format", "bytes_and_fields",
      ],
      ROOT,
    );

    const vkBytes = fs.readFileSync(path.join(outDir, "vk"));
    const publicInputs = JSON.parse(
      fs.readFileSync(path.join(outDir, "public_inputs_fields.json"), "utf8"),
    );
    const witness = parseProverToml(fs.readFileSync(path.join(dir, "Prover.toml"), "utf8"));
    // The declared circuit version is part of what these vectors pin. A VK hash
    // change alone cannot tell you *which* circuit a credential was issued
    // against, so the version is pinned alongside it and a circuit edit that
    // forgets to bump circuits/circuit-versions.json fails here (#633).
    const declared = versionOf(name);
    if (!declared) {
      throw new Error(
        `Circuit "${name}" has no entry in circuits/circuit-versions.json — add its ` +
          `version and vkVersion so credentials can record what they were issued against.`,
      );
    }

    return {
      circuit: name,
      circuit_version: declared.version,
      circuit_vk_version: declared.vkVersion,
      noir_version: toolchain.nargoVersion,
      bb_version: toolchain.bbVersion,
      witness,
      public_inputs: publicInputs,
      vk_hash_algo: "sha256",
      vk_hash: crypto.createHash("sha256").update(vkBytes).digest("hex"),
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function loadCommitted(name) {
  const file = path.join(VECTORS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const mode = process.argv[2] || "check";
  const targetCircuit = process.argv[3];

  if (!["check", "update"].includes(mode)) {
    console.error(`usage: node ${path.basename(__filename)} [check|update] [circuit_name]`);
    process.exit(2);
  }

  const circuits = targetCircuit ? [targetCircuit] : CIRCUITS;
  if (targetCircuit && !CIRCUITS.includes(targetCircuit)) {
    console.error(`Unknown circuit "${targetCircuit}". Available circuits: ${CIRCUITS.join(", ")}`);
    process.exit(2);
  }

  const toolchain = toolVersions();
  if (toolchain.nargoVersion !== NOIR_VERSION || toolchain.bbVersion !== BB_VERSION) {
    const errorMsg =
      `\n[TOOLCHAIN MISMATCH] Installed Noir/Barretenberg toolchain has drifted:\n` +
      `  - Installed: nargo ${toolchain.nargoVersion}, bb ${toolchain.bbVersion}\n` +
      `  - Pinned:    nargo ${NOIR_VERSION}, bb ${BB_VERSION}\n\n` +
      `This check enforces the pinned toolchain. To fix toolchain mismatch:\n` +
      `  noirup -v ${NOIR_VERSION}\n` +
      `  bbup -v ${BB_VERSION}\n\n` +
      `If this toolchain upgrade was intentional, update NOIR_VERSION and BB_VERSION in:\n` +
      `  - circuits/scripts/testvectors.js\n` +
      `  - circuits/scripts/build.sh\n` +
      `  - circuits/README.md\n` +
      `then regenerate test vectors with: node circuits/scripts/testvectors.js update\n`;

    if (mode === "check") {
      console.error(errorMsg);
      process.exit(1);
    } else {
      console.warn(errorMsg);
    }
  }

  const drifted = [];
  for (const name of circuits) {
    process.stdout.write(`${name}... `);
    const fresh = buildVector(name, toolchain);

    if (mode === "update") {
      fs.mkdirSync(VECTORS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(VECTORS_DIR, `${name}.json`),
        JSON.stringify(fresh, null, 2) + "\n",
      );
      console.log("updated");
      continue;
    }

    const committed = loadCommitted(name);
    if (!committed) {
      drifted.push({ name, reason: "no committed test vector found" });
      console.log("MISSING");
      continue;
    }

    const mismatches = [];
    if (committed.vk_hash !== fresh.vk_hash) mismatches.push("vk_hash");
    // A version bump that is not reflected in the committed vector means the
    // vector was regenerated (or hand-edited) without the version being
    // declared consistently — the credential <-> circuit <-> VK chain would
    // then be ambiguous.
    if (committed.circuit_version !== fresh.circuit_version) {
      mismatches.push(
        `circuit_version (committed ${committed.circuit_version ?? "none"} != ` +
          `circuits/circuit-versions.json ${fresh.circuit_version})`,
      );
    }
    if (committed.circuit_vk_version !== fresh.circuit_vk_version) {
      mismatches.push(
        `circuit_vk_version (committed ${committed.circuit_vk_version ?? "none"} != ` +
          `circuits/circuit-versions.json ${fresh.circuit_vk_version})`,
      );
    }
    if (JSON.stringify(committed.public_inputs) !== JSON.stringify(fresh.public_inputs)) {
      mismatches.push("public_inputs");
    }
    if (JSON.stringify(committed.witness) !== JSON.stringify(fresh.witness)) {
      mismatches.push("witness (Prover.toml changed without regenerating vectors)");
    }

    if (mismatches.length) {
      drifted.push({ name, reason: mismatches.join(", ") });
      console.log(`DRIFT (${mismatches.join(", ")})`);
    } else {
      console.log("ok");
    }
  }

  if (mode === "check" && drifted.length) {
    console.error("\n[CIRCUIT DRIFT] Deterministic proof-generation test vectors drifted from circuits/testvectors/*.json:");
    for (const d of drifted) console.error(`  - ${d.name}: ${d.reason}`);
    console.error(
      `\nToolchain verified as pinned: nargo ${NOIR_VERSION} / bb ${BB_VERSION}.\n` +
        `Because the toolchain matches, this drift indicates circuit code or witness changes.\n` +
        `If you made a deliberate circuit update:\n` +
        `  1. Bump its entry in circuits/circuit-versions.json\n` +
        `  2. Regenerate the vectors with: node circuits/scripts/testvectors.js update ${circuits.length === 1 ? circuits[0] : ""}\n` +
        `  3. Stage and commit the updated fixtures and test vectors.\n` +
        `Otherwise, this is an unintended circuit regression — do not update vectors to hide it.\n`,
    );
    process.exit(1);
  }

  console.log(mode === "check" ? "\nAll test vectors match." : "\nAll test vectors regenerated.");
}

if (require.main === module) {
  main();
}

module.exports = {
  NOIR_VERSION,
  BB_VERSION,
  CIRCUITS,
  toolVersions,
  parseProverToml,
  buildVector,
  loadCommitted,
  main,
};

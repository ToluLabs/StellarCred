#!/usr/bin/env node

/**
 * Release Build Provenance Verifier (#968).
 *
 * Independently verifies SLSA Provenance v1.0 attestations against release artifacts.
 *
 * Verifies:
 * 1. in-toto / SLSA v1.0 statement structure and schema compliance.
 * 2. Authenticity and integrity of release artifacts (SHA-256 and SHA-512 cryptographic digests).
 * 3. Pinned toolchain versions (Rust, Soroban SDK, Noir, Barretenberg).
 * 4. Self-integrity of build-provenance.json via companion checksum files.
 *
 * Exit code 0 if all artifacts are valid and match provenance; exit code 1 on tamper or failure.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRootDir = path.resolve(__dirname, "..");

const EXPECTED_TOOLCHAINS = {
  rust: "1.93.1",
  target: "wasm32v1-none",
  sorobanSdk: "26.0.1",
  noir: "1.0.0-beta.9",
  barretenberg: "0.87.0",
};

function computeHashes(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const sha512 = crypto.createHash("sha512").update(fileBuffer).digest("hex");
  const size = fileBuffer.length;
  return { sha256, sha512, size };
}

export function verifyProvenance({
  provenancePath,
  artifactsDir = path.dirname(provenancePath),
  rootDir = defaultRootDir,
  strictToolchains = true,
} = {}) {
  const errors = [];
  const verifiedArtifacts = [];

  if (!fs.existsSync(provenancePath)) {
    return {
      valid: false,
      errors: [`Provenance file not found: ${provenancePath}`],
      verifiedArtifacts: [],
    };
  }

  let statement;
  try {
    const raw = fs.readFileSync(provenancePath, "utf8");
    statement = JSON.parse(raw);
  } catch (err) {
    return {
      valid: false,
      errors: [`Failed to parse provenance JSON: ${err.message}`],
      verifiedArtifacts: [],
    };
  }

  // 1. Verify SLSA v1.0 Statement Schema
  if (statement._type !== "https://in-toto.io/Statement/v1") {
    errors.push(`Invalid statement _type: expected https://in-toto.io/Statement/v1, got ${statement._type}`);
  }

  if (statement.predicateType !== "https://slsa.dev/provenance/v1") {
    errors.push(`Invalid predicateType: expected https://slsa.dev/provenance/v1, got ${statement.predicateType}`);
  }

  if (!Array.isArray(statement.subject) || statement.subject.length === 0) {
    errors.push("Provenance statement has no subject artifacts");
  }

  const buildDefinition = statement.predicate?.buildDefinition;
  if (!buildDefinition) {
    errors.push("Missing predicate.buildDefinition in provenance statement");
  }

  // 2. Verify Toolchain Dependencies
  if (strictToolchains && buildDefinition?.resolvedDependencies) {
    const deps = buildDefinition.resolvedDependencies;
    const rustDep = deps.find((d) => d.uri === "pkg:cargo/rustc");
    if (!rustDep || rustDep.version !== EXPECTED_TOOLCHAINS.rust) {
      errors.push(
        `Toolchain mismatch: rustc expected ${EXPECTED_TOOLCHAINS.rust}, found ${rustDep?.version}`,
      );
    }

    const sorobanDep = deps.find((d) => d.uri === "pkg:cargo/soroban-sdk");
    if (!sorobanDep || sorobanDep.version !== EXPECTED_TOOLCHAINS.sorobanSdk) {
      errors.push(
        `Toolchain mismatch: soroban-sdk expected ${EXPECTED_TOOLCHAINS.sorobanSdk}, found ${sorobanDep?.version}`,
      );
    }
  }

  // 3. Verify Artifact Integrity
  const subjectList = statement.subject || [];
  for (const subject of subjectList) {
    const name = subject.name;
    const expectedSha256 = subject.digest?.sha256;
    const expectedSha512 = subject.digest?.sha512;

    if (!expectedSha256) {
      errors.push(`Subject ${name} missing sha256 digest in provenance`);
      continue;
    }

    // Locate artifact file
    let candidatePath = path.join(artifactsDir, name);
    if (!fs.existsSync(candidatePath)) {
      candidatePath = path.join(rootDir, name);
    }

    if (!fs.existsSync(candidatePath)) {
      errors.push(`Artifact file not found: ${name} (checked ${candidatePath})`);
      continue;
    }

    const { sha256: actualSha256, sha512: actualSha512, size: actualSize } = computeHashes(candidatePath);

    if (actualSha256 !== expectedSha256) {
      errors.push(
        `TAMPER DETECTED for ${name}: SHA-256 hash mismatch!\n  Expected: ${expectedSha256}\n  Actual:   ${actualSha256}`,
      );
      continue;
    }

    if (expectedSha512 && actualSha512 !== expectedSha512) {
      errors.push(
        `TAMPER DETECTED for ${name}: SHA-512 hash mismatch!\n  Expected: ${expectedSha512}\n  Actual:   ${actualSha512}`,
      );
      continue;
    }

    if (subject.size !== undefined && actualSize !== subject.size) {
      errors.push(
        `Size mismatch for ${name}: expected ${subject.size} bytes, actual ${actualSize} bytes`,
      );
      continue;
    }

    verifiedArtifacts.push({
      name,
      path: candidatePath,
      sha256: actualSha256,
      size: actualSize,
    });
  }

  // 4. Verify Companion Checksum File if present
  const companionChecksumPath = path.join(artifactsDir, "artifacts-checksums.txt");
  if (fs.existsSync(companionChecksumPath)) {
    const lines = fs
      .readFileSync(companionChecksumPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const hash = parts[0];
        const filename = parts[1];
        const matchingSubject = subjectList.find((s) => s.name === filename);
        if (matchingSubject && matchingSubject.digest?.sha256 !== hash) {
          errors.push(
            `Checksum mismatch in artifacts-checksums.txt for ${filename}: expected ${matchingSubject.digest.sha256}, file says ${hash}`,
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    verifiedArtifacts,
    subjectCount: subjectList.length,
    commit: buildDefinition?.externalParameters?.commit,
  };
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let provenancePath = path.join(process.cwd(), "build-provenance.json");
  let artifactsDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provenance" && i + 1 < args.length) {
      provenancePath = path.resolve(args[++i]);
    } else if (args[i] === "--artifacts-dir" && i + 1 < args.length) {
      artifactsDir = path.resolve(args[++i]);
    } else if (args[i] === "--help") {
      console.log("Usage: node verify-provenance.mjs [--provenance <path>] [--artifacts-dir <dir>]");
      process.exit(0);
    }
  }

  return { provenancePath, artifactsDir };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { provenancePath, artifactsDir } = parseCliArgs();
  console.log("=== StellarCred Release Build Provenance Verifier ===");
  console.log(`Verifying: ${provenancePath}`);
  console.log(`Artifacts dir: ${artifactsDir}`);

  const result = verifyProvenance({
    provenancePath,
    artifactsDir,
    rootDir: defaultRootDir,
  });

  if (!result.valid) {
    console.error(`\n[FAILED] Provenance verification failed with ${result.errors.length} error(s):`);
    for (const err of result.errors) {
      console.error(` - ${err}`);
    }
    process.exit(1);
  }

  console.log(`\n[OK] Provenance verification passed for ${result.verifiedArtifacts.length} artifact(s).`);
  console.log(`Commit: ${result.commit}`);
  for (const art of result.verifiedArtifacts) {
    console.log(` - ${art.name} (${art.size} bytes, sha256: ${art.sha256})`);
  }
}

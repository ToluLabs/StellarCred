#!/usr/bin/env node

/**
 * Release Build Provenance Generator (#968).
 *
 * Generates verifiable in-toto / SLSA Provenance v1.0 attestations for release
 * artifacts (Soroban smart contract WASMs, circuit verification keys, and SDK packages).
 *
 * Records:
 * - Source commit SHA, repository, and git ref/tag.
 * - Pinned compiler and toolchain versions (Rust, Soroban SDK, Noir, Barretenberg, Node, Pnpm).
 * - Cryptographic checksums (SHA-256, SHA-512) and byte sizes of all release artifacts.
 * - Workflow invocation identity and reproducibility settings.
 *
 * Emits:
 * 1. build-provenance.json (SLSA v1.0 in-toto statement)
 * 2. build-provenance.json.sha256 (SHA-256 digest of the provenance statement)
 * 3. artifacts-checksums.txt (GNU sha256sum compatible format for easy verification)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRootDir = path.resolve(__dirname, "..");

const PINNED_TOOLCHAINS = {
  rust: "1.93.1",
  target: "wasm32v1-none",
  sorobanSdk: "26.0.1",
  noir: "1.0.0-beta.9",
  barretenberg: "0.87.0",
  node: "20",
  pnpm: "9",
};

function getGitCommit(rootDir) {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
  } catch {
    return "0000000000000000000000000000000000000000";
  }
}

function getGitRef(rootDir) {
  if (process.env.GITHUB_REF) {
    return process.env.GITHUB_REF;
  }
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
  } catch {
    return "refs/heads/main";
  }
}

function computeHashes(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const sha512 = crypto.createHash("sha512").update(fileBuffer).digest("hex");
  const size = fileBuffer.length;
  return { sha256, sha512, size };
}

export function buildProvenanceStatement({
  artifacts = [],
  rootDir = defaultRootDir,
  env = process.env,
  startedOn = new Date().toISOString(),
  finishedOn = new Date().toISOString(),
} = {}) {
  const commitSha = env.GITHUB_SHA || getGitCommit(rootDir);
  const refName = env.GITHUB_REF || getGitRef(rootDir);
  const repo = env.GITHUB_REPOSITORY || "ToluLabs/StellarCred";
  const runId = env.GITHUB_RUN_ID || "local-build";
  const runAttempt = env.GITHUB_RUN_ATTEMPT || "1";
  const actor = env.GITHUB_ACTOR || "local";

  const subjects = [];
  const checksumEntries = [];

  for (const item of artifacts) {
    const filePath = typeof item === "string" ? item : item.path;
    const customName = typeof item === "object" && item.name ? item.name : path.basename(filePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Artifact not found: ${filePath}`);
    }

    const { sha256, sha512, size } = computeHashes(filePath);

    subjects.push({
      name: customName,
      digest: {
        sha256,
        sha512,
      },
      size,
    });

    checksumEntries.push(`${sha256}  ${customName}`);
  }

  // in-toto / SLSA v1.0 Provenance structure
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: subjects,
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://stellarcred.network/attestations/release-build/v1",
        externalParameters: {
          repository: `https://github.com/${repo}`,
          ref: refName,
          commit: commitSha,
          sourceUri: `git+https://github.com/${repo}.git@${commitSha}`,
          workflow: ".github/workflows/release.yml",
        },
        internalParameters: {
          reproducibleContainer: "stellarcred-build:ci",
          baseImage: "rust:1.93.1-slim-bookworm",
          sourceDateEpoch: "0",
          rustflags:
            "--remap-path-prefix=/workspace=/workspace --remap-path-prefix=/usr/local/cargo=/usr/local/cargo --remap-path-prefix=/usr/local/rustup=/usr/local/rustup",
          cargoFlags: "--release --target wasm32v1-none --locked",
        },
        resolvedDependencies: [
          {
            uri: "pkg:cargo/rustc",
            version: PINNED_TOOLCHAINS.rust,
            annotations: { target: PINNED_TOOLCHAINS.target },
          },
          {
            uri: "pkg:cargo/soroban-sdk",
            version: PINNED_TOOLCHAINS.sorobanSdk,
          },
          {
            uri: "pkg:generic/noir",
            version: PINNED_TOOLCHAINS.noir,
          },
          {
            uri: "pkg:generic/barretenberg",
            version: PINNED_TOOLCHAINS.barretenberg,
          },
          {
            uri: "pkg:generic/node",
            version: PINNED_TOOLCHAINS.node,
          },
          {
            uri: "pkg:generic/pnpm",
            version: PINNED_TOOLCHAINS.pnpm,
          },
        ],
      },
      runDetails: {
        builder: {
          id: `https://github.com/${repo}/.github/workflows/release.yml@${refName}`,
          version: "1.0.0",
        },
        metadata: {
          invocationId: `https://github.com/${repo}/actions/runs/${runId}/attempts/${runAttempt}`,
          startedOn,
          finishedOn,
        },
        byproducts: [
          {
            name: "reproducible-build-log",
            uri: `https://github.com/${repo}/actions/runs/${runId}`,
          },
        ],
      },
    },
  };

  const checksumsText = checksumEntries.join("\n") + (checksumEntries.length > 0 ? "\n" : "");

  return { statement, checksumsText };
}

export function generateReleaseProvenance({
  artifacts = [],
  outDir = defaultRootDir,
  rootDir = defaultRootDir,
  env = process.env,
} = {}) {
  const startedOn = new Date().toISOString();

  // If no artifacts were explicitly provided, probe default release locations
  let targetArtifacts = [...artifacts];
  if (targetArtifacts.length === 0) {
    const defaultCandidates = [
      path.join(rootDir, "target", "wasm32v1-none", "release", "credential_verifier.wasm"),
      path.join(rootDir, "target", "wasm32v1-none", "release", "issuer_registry.wasm"),
      path.join(rootDir, "target", "wasm32v1-none", "release", "proof_registry.wasm"),
      path.join(rootDir, "target", "wasm32v1-none", "release", "gated_pool.wasm"),
      path.join(rootDir, "build-1", "credential_verifier.wasm"),
      path.join(rootDir, "build-1", "issuer_registry.wasm"),
      path.join(rootDir, "build-1", "proof_registry.wasm"),
      path.join(rootDir, "build-1", "gated_pool.wasm"),
      path.join(rootDir, "circuits", "circuit-versions.json"),
    ];

    for (const candidate of defaultCandidates) {
      if (fs.existsSync(candidate)) {
        targetArtifacts.push(candidate);
      }
    }
  }

  const finishedOn = new Date().toISOString();

  const { statement, checksumsText } = buildProvenanceStatement({
    artifacts: targetArtifacts,
    rootDir,
    env,
    startedOn,
    finishedOn,
  });

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const provenancePath = path.join(outDir, "build-provenance.json");
  const provenanceDigestPath = path.join(outDir, "build-provenance.json.sha256");
  const checksumsPath = path.join(outDir, "artifacts-checksums.txt");

  const statementJson = JSON.stringify(statement, null, 2) + "\n";
  fs.writeFileSync(provenancePath, statementJson, "utf8");

  const provenanceSha256 = crypto
    .createHash("sha256")
    .update(Buffer.from(statementJson, "utf8"))
    .digest("hex");
  fs.writeFileSync(
    provenanceDigestPath,
    `${provenanceSha256}  build-provenance.json\n`,
    "utf8",
  );

  fs.writeFileSync(checksumsPath, checksumsText, "utf8");

  return {
    provenancePath,
    provenanceDigestPath,
    checksumsPath,
    statement,
    artifactCount: targetArtifacts.length,
  };
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    outDir: process.cwd(),
    artifacts: [],
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir" && i + 1 < args.length) {
      options.outDir = path.resolve(args[++i]);
    } else if (args[i] === "--artifacts") {
      i++;
      while (i < args.length && !args[i].startsWith("--")) {
        options.artifacts.push(path.resolve(args[i++]));
      }
      i--;
    } else if (args[i] === "--help") {
      console.log("Usage: node generate-release-provenance.mjs [--out-dir <dir>] [--artifacts <file1> <file2>...]");
      process.exit(0);
    }
  }

  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const { outDir, artifacts } = parseCliArgs();
    console.log("=== StellarCred Release Build Provenance Generator ===");
    console.log(`Output directory: ${outDir}`);

    const result = generateReleaseProvenance({
      artifacts,
      outDir,
      rootDir: defaultRootDir,
    });

    console.log(`[OK] Generated build provenance for ${result.artifactCount} artifact(s)`);
    console.log(` - Provenance Statement: ${result.provenancePath}`);
    console.log(` - Provenance Checksum:  ${result.provenanceDigestPath}`);
    console.log(` - Artifact Checksums:   ${result.checksumsPath}`);
  } catch (err) {
    console.error(`[ERROR] Failed to generate provenance: ${err.message}`);
    process.exit(1);
  }
}

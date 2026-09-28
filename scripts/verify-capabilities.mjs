#!/usr/bin/env node
/**
 * Capability-descriptor ↔ deployments-registry agreement check (issue #639).
 *
 * A published deployment record (DEPLOYMENTS.md, machine-readable manifests in
 * deployment-manifests/ written by scripts/deploy.sh) and the live capability
 * descriptor a deployment serves at GET /api/capabilities must agree.
 *
 * Compares, per contract: the contract ID recorded in the manifest against the
 * ID the live descriptor reports, and — when both sides have a version — that
 * the versions match too. A null descriptor version means the chain read was
 * unavailable at descriptor build time; this is reported as a warning, never
 * a mismatch.
 *
 * Usage:
 *   node scripts/verify-capabilities.mjs --url https://app.example.com \
 *        --manifest deployment-manifests/deployment-<timestamp>.json
 *
 *   --url       Deployment base URL (or the full /api/capabilities URL).
 *   --manifest  Path to a deployment-*.json manifest from scripts/deploy.sh.
 *
 * Exit codes: 0 = agreement, 1 = mismatch or fetch/validation failure.
 * Requires Node 18+ (global fetch). No dependencies.
 */

import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--url" || flag === "--manifest") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`Missing value for ${flag}`);
        exit(1);
      }
      parsed[flag.slice(2)] = value;
      i++;
    }
  }
  return parsed;
}

const args = parseArgs(argv.slice(2));
if (!args.url || !args.manifest) {
  console.error(
    "Usage: node scripts/verify-capabilities.mjs --url <deployment URL> --manifest <deployment-*.json>",
  );
  exit(1);
}

function fail(msg) {
  console.error(`::error::${msg}`);
  exit(1);
}

// ── Load the published record ──────────────────────────────────────────────────

let manifest;
try {
  manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
} catch (e) {
  fail(`Cannot read deployment manifest ${args.manifest}: ${e.message}`);
}

if (!manifest.network || typeof manifest.contracts !== "object" || !manifest.contracts) {
  fail(
    `Manifest ${args.manifest} is not a deploy.sh deployment manifest (expected "network" + "contracts").`,
  );
}

// ── Fetch the live descriptor ──────────────────────────────────────────────────

const baseUrl = args.url.replace(/\/+$/, "");
const descriptorUrl = baseUrl.endsWith("/api/capabilities")
  ? baseUrl
  : `${baseUrl}/api/capabilities`;

let descriptor;
try {
  const res = await fetch(descriptorUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) fail(`GET ${descriptorUrl} returned HTTP ${res.status}`);
  descriptor = await res.json();
} catch (e) {
  fail(`Failed to fetch capability descriptor at ${descriptorUrl}: ${e.message}`);
}

if (typeof descriptor.descriptor_version !== "number" || !descriptor.network) {
  fail(
    `${descriptorUrl} did not return a capability descriptor (missing descriptor_version/network). Is this a StellarCred deployment?`,
  );
}

// ── Compare ────────────────────────────────────────────────────────────────────

const problems = [];
const warnings = [];

if (descriptor.network.id !== manifest.network) {
  problems.push(
    `network: descriptor reports "${descriptor.network.id}" but the manifest records "${manifest.network}".`,
  );
}

const manifestContracts = Object.entries(manifest.contracts);
if (manifestContracts.length === 0) {
  fail(`Manifest ${args.manifest} has no contracts recorded.`);
}

for (const [name, record] of manifestContracts) {
  if (!record || typeof record !== "object" || typeof record.id !== "string") {
    problems.push(`${name}: manifest record is malformed.`);
    continue;
  }
  const live = descriptor.contracts?.[name];

  if (!live || typeof live.id !== "string" || live.id === "") {
    problems.push(
      `${name}: the live descriptor does not report this contract, but the manifest records ${record.id}.`,
    );
    continue;
  }
  if (live.id !== record.id) {
    problems.push(
      `${name}: contract ID mismatch — descriptor reports ${live.id}, registry records ${record.id}.`,
    );
    continue;
  }

  if (record.version && live.version) {
    if (String(live.version) !== String(record.version)) {
      problems.push(
        `${name}: version mismatch — descriptor reports ${live.version}, registry records ${record.version}. ` +
          `Was the contract upgraded without updating DEPLOYMENTS.md?`,
      );
    }
  } else if (live.version === null || live.version === undefined) {
    warnings.push(
      `${name}: descriptor version is unknown (chain read unavailable at descriptor build time) — ID agreement verified only.`,
    );
  }
}

if (warnings.length > 0) {
  for (const w of warnings) console.warn(`warning: ${w}`);
}

if (problems.length > 0) {
  console.error(
    `\nCapability descriptor at ${descriptorUrl} does NOT agree with ${args.manifest}:\n`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nUpdate DEPLOYMENTS.md / the deployment manifest, or redeploy, so the published record and the live descriptor agree.",
  );
  exit(1);
}

console.log(
  `Agreement verified: ${descriptorUrl} matches ${args.manifest} ` +
    `(${manifestContracts.length} contracts, network ${manifest.network}).`,
);

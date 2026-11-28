#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_REPORT = "circuits/release-consistency-report.json";
const SOURCES = {
  declared: "circuits/circuit-versions.json",
  supported: "circuits/supported-circuits.v1.json",
  registrations: "deployment/circuit-registrations.json",
  artifacts: "frontend/public/circuits",
  fixtures: "fixtures",
  testVectors: "circuits/testvectors",
};

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, report: DEFAULT_REPORT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--root" || arg === "--report") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/check-circuit-release-consistency.mjs [options]",
    "",
    "Options:",
    "  --root <dir>     Repository root to check (default: repository containing this script)",
    "  --report <file>  JSON report path relative to --root",
    `                   (default: ${DEFAULT_REPORT})`,
    "  --help, -h       Show this message",
  ].join("\n");
}

function loadJson(root, rel, errors) {
  try {
    return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
  } catch (error) {
    errors.push(`${rel}: ${error.message}`);
    return null;
  }
}

function expectEqual(mismatches, source, label, actual, expected) {
  if (actual !== expected) {
    mismatches.push(
      `${source}: ${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

function collect(root) {
  const globalMismatches = [];
  const declared = loadJson(root, SOURCES.declared, globalMismatches);
  const supported = loadJson(root, SOURCES.supported, globalMismatches);
  const registrations = loadJson(root, SOURCES.registrations, globalMismatches);

  if (supported && !Array.isArray(supported.circuits)) {
    globalMismatches.push(`${SOURCES.supported}: missing "circuits" array`);
  }
  if (registrations && !registrations.circuits) {
    globalMismatches.push(`${SOURCES.registrations}: missing "circuits" object`);
  }
  if (supported && registrations) {
    expectEqual(globalMismatches, "release", "in supported manifest", supported.release, registrations.release);
  }

  const supportedEntries = Array.isArray(supported?.circuits)
    ? supported.circuits.filter((entry) => entry && entry.status === "supported")
    : [];
  if (supported && supportedEntries.length === 0) {
    globalMismatches.push(`${SOURCES.supported}: no circuits with status "supported"`);
  }

  const circuits = supportedEntries.map((entry) => {
    const id = typeof entry.id === "string" ? entry.id : "<unknown>";
    const credentialType = typeof entry.credentialType === "string" ? entry.credentialType : "";
    const mismatches = [];
    if (!credentialType) {
      mismatches.push('release manifest: "credentialType" is missing');
    }

    const declaredEntry = declared?.circuits?.[id] ?? null;
    if (!declaredEntry) {
      mismatches.push(`declared: no entry for "${id}" in ${SOURCES.declared}`);
    } else {
      expectEqual(
        mismatches,
        "declared",
        "version in circuit-versions.json",
        declaredEntry.version,
        entry.version,
      );
      expectEqual(
        mismatches,
        "declared",
        "vkVersion in circuit-versions.json",
        declaredEntry.vkVersion,
        entry.vkVersion,
      );
    }

    let artifact = null;
    let artifactRel = null;
    if (credentialType) {
      artifactRel = `${SOURCES.artifacts}/${credentialType}.json`;
      const artifactFile = path.join(root, artifactRel);
      if (!existsSync(artifactFile)) {
        mismatches.push(`artifact: missing ${artifactRel}`);
      } else {
        try {
          artifact = JSON.parse(readFileSync(artifactFile, "utf8"));
        } catch (error) {
          mismatches.push(`artifact: ${artifactRel} is not valid JSON (${error.message})`);
        }
        if (artifact) {
          expectEqual(mismatches, "artifact", "circuit_version", artifact.circuit_version, entry.version);
          expectEqual(mismatches, "artifact", "circuit_vk_version", artifact.circuit_vk_version, entry.vkVersion);
        }
      }
    }

    let fixtureVkHash = null;
    let fixtureRel = null;
    if (credentialType) {
      fixtureRel = `${SOURCES.fixtures}/${credentialType}/vk`;
      const fixtureFile = path.join(root, fixtureRel);
      if (!existsSync(fixtureFile)) {
        mismatches.push(`fixture: missing ${fixtureRel}`);
      } else {
        fixtureVkHash = createHash("sha256").update(readFileSync(fixtureFile)).digest("hex");
      }
    }

    const testVectorRel = `${SOURCES.testVectors}/${id}.json`;
    const testVectorFile = path.join(root, testVectorRel);
    if (existsSync(testVectorFile)) {
      let vector = null;
      try {
        vector = JSON.parse(readFileSync(testVectorFile, "utf8"));
      } catch (error) {
        mismatches.push(`testVector: ${testVectorRel} is not valid JSON (${error.message})`);
      }
      if (vector) {
        expectEqual(mismatches, "testVector", "circuit_version", vector.circuit_version, entry.version);
        expectEqual(mismatches, "testVector", "circuit_vk_version", vector.circuit_vk_version, entry.vkVersion);
        expectEqual(mismatches, "testVector", "vk_hash", vector.vk_hash, fixtureVkHash);
      }
    }

    const registration = credentialType ? registrations?.circuits?.[credentialType] ?? null : null;
    if (!registration) {
      mismatches.push(`registration: no entry for "${credentialType}" in ${SOURCES.registrations}`);
    } else {
      expectEqual(mismatches, "registration", "circuit", registration.circuit, id);
      expectEqual(mismatches, "registration", "version", registration.version, entry.version);
      expectEqual(mismatches, "registration", "vkVersion", registration.vkVersion, entry.vkVersion);
      expectEqual(mismatches, "registration", "vkHash", registration.vkHash, fixtureVkHash);
    }

    return {
      id,
      credentialType,
      declaredVersion: declaredEntry?.version ?? null,
      artifactVersion: artifact?.circuit_version ?? null,
      fixtureVkHash,
      registeredVersion: registration?.version ?? null,
      registeredVkVersion: registration?.vkVersion ?? null,
      artifact: artifactRel,
      fixture: fixtureRel,
      status: mismatches.length === 0 ? "ok" : "mismatch",
      mismatches,
    };
  });

  return { globalMismatches, circuits };
}

function annotation(message) {
  return message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(options.root);
  const reportPath = path.resolve(root, options.report);
  const { globalMismatches, circuits } = collect(root);
  const mismatchCount =
    globalMismatches.length + circuits.reduce((total, circuit) => total + circuit.mismatches.length, 0);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: mismatchCount === 0 ? "pass" : "fail",
    sources: {
      declared: SOURCES.declared,
      supported: SOURCES.supported,
      registrations: SOURCES.registrations,
      artifacts: SOURCES.artifacts,
      fixtures: SOURCES.fixtures,
      testVectors: SOURCES.testVectors,
    },
    summary: {
      supportedCircuits: circuits.length,
      circuitsChecked: circuits.length,
      mismatches: mismatchCount,
    },
    globalMismatches,
    circuits,
  };

  try {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`Cannot write report ${options.report}: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  console.log(`Circuit release consistency: ${circuits.length} supported circuit(s)`);
  for (const mismatch of globalMismatches) {
    console.error(`  FAIL global: ${mismatch}`);
    console.error(`::error::${annotation(mismatch)}`);
  }
  for (const circuit of circuits) {
    if (circuit.status === "ok") {
      console.log(`  ok   ${circuit.id} (${circuit.credentialType})`);
      continue;
    }
    console.error(`  FAIL ${circuit.id} (${circuit.credentialType})`);
    for (const mismatch of circuit.mismatches) {
      console.error(`    - ${mismatch}`);
      console.error(`::error::${circuit.id}: ${annotation(mismatch)}`);
    }
  }
  console.log(`Report: ${options.report}`);
  if (mismatchCount === 0) {
    console.log("RESULT: PASS");
    return;
  }
  console.error(`RESULT: FAIL (${mismatchCount} mismatch(es))`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

#!/usr/bin/env node
// Payload-size proving benchmarks + size guardrails (GitHub #943).
//
// What this does
// ──────────────
//   1. Runs the existing proving measurement harness
//      (scripts/perf/measure-proving.mjs) once per representative payload tier:
//        small  — kyc_proof:            one credential, the smallest full
//                                        pipeline (Poseidon2 + secp256k1)
//        medium — jurisdiction_proof:   one credential plus a fixed 8-entry
//                                        allowlist (wider private input)
//        large  — aggregate_proof:      two credentials packed into one proof
//                                        (largest job the app can ask for)
//      These are the sizes the client resource guard allows
//      (frontend/lib/proof-guard.ts), so the benchmark measures exactly the
//      workloads users can request.
//   2. Records witness/prove medians (CPU ms), peak RSS where GNU time is
//      available, and ACIR gate counts per tier.
//   3. Compares the tiers against perf/payloads-baselines.json: per-tier time
//      ceilings (the "expected limits" oversized requests fail against) and a
//      scaling ratio between the largest and smallest payload. Memory is a
//      warn-only indicator.
//   4. Writes perf/proving-payloads-report.json and, on GitHub Actions, a job
//      summary table plus ::warning::/::error:: annotations.
//
// Reproducibility
// ───────────────
// Every number comes from the pinned toolchain (NOIR_VERSION/BB_VERSION in
// .github/workflows/proving-perf.yml), the committed Prover.toml inputs under
// circuits/, and the median of multiple runs — no network, no RPC, no random
// data. The same command runs locally and in CI:
//
//   node scripts/perf/measure-payloads.mjs --runs 3 \
//     --compare perf/payloads-baselines.json
//
// Exit codes: 0 within limits, 1 a tier or the scaling ratio regressed beyond
// its ceiling, 2 measurement failed (missing toolchain, failed run) — never
// confused with "slow".

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const RUNS = Math.max(1, parseInt(argValue("--runs", "3"), 10));
const BASELINE_PATH = argValue("--compare", "");
const TIER_FILTER = argValue("--tiers", "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const MEASURE = join(REPO, "scripts", "perf", "measure-proving.mjs");
const TIER_REPORT = join(REPO, "perf", "proving-perf-report.json");
const REPORT_PATH = join(REPO, "perf", "proving-payloads-report.json");

/**
 * Representative payload tiers, smallest to largest. `circuit` must exist under
 * circuits/ with a committed Prover.toml; `expected` documents what the size
 * guard allows for that shape.
 */
const TIERS = [
  {
    tier: "small",
    circuit: "kyc_proof",
    note: "one KYC credential (smallest full pipeline)",
  },
  {
    tier: "medium",
    circuit: "jurisdiction_proof",
    note: "one credential plus a fixed 8-entry jurisdiction allowlist",
  },
  {
    tier: "large",
    circuit: "aggregate_proof",
    note: "two credentials packed into one aggregate proof (largest job)",
  },
];

const SELECTED = TIER_FILTER.length > 0 ? TIERS.filter((t) => TIER_FILTER.includes(t.tier)) : TIERS;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function die(code, msg) {
  process.stderr.write(`measure-payloads: ${msg}\n`);
  process.exit(code);
}

if (SELECTED.length === 0) {
  die(2, `no tiers matched --tiers "${TIER_FILTER.join(",")}" (known: ${TIERS.map((t) => t.tier).join(", ")})`);
}
if (!existsSync(MEASURE)) {
  die(2, `measurement harness not found: ${MEASURE}`);
}

// ── Measure each tier ────────────────────────────────────────────────────────

/** Run the single-circuit harness and return its parsed report. */
function measureTier(tier) {
  log(`\n=== ${tier.tier}: ${tier.circuit} (${tier.note}) ===`);
  const res = spawnSync(
    process.execPath,
    [MEASURE, "--runs", String(RUNS), "--circuit", tier.circuit],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  if (res.status !== 0) {
    return {
      error: `measure-proving exited ${res.status}`,
      stderr: (res.stderr ?? "").trim().split("\n").slice(-8).join("\n"),
    };
  }
  if (!existsSync(TIER_REPORT)) {
    return { error: `missing report: ${TIER_REPORT}`, stderr: "" };
  }

  const report = JSON.parse(readFileSync(TIER_REPORT, "utf8"));
  if (report.circuit !== tier.circuit) {
    return {
      error: `report is for "${report.circuit}", expected "${tier.circuit}"`,
      stderr: "",
    };
  }

  log(
    `  witness ${report.medians.witness ?? "—"}ms · prove ${report.medians.prove ?? "—"}ms · ` +
      `gates ${report.gateCounts.totalAcirOpcodes} · failed runs ${report.failedRuns}`,
  );
  return report;
}

const measured = {};
const failures = [];

for (const tier of SELECTED) {
  const report = measureTier(tier);
  if (report.error) {
    failures.push({ tier: tier.tier, circuit: tier.circuit, ...report });
    measured[tier.tier] = { tier: tier.tier, circuit: tier.circuit, note: tier.note, error: report.error };
    continue;
  }
  measured[tier.tier] = {
    tier: tier.tier,
    circuit: tier.circuit,
    note: tier.note,
    medians: report.medians,
    mediansWall: report.mediansWall,
    mediansRssKb: report.mediansRssKb ?? null,
    gateCounts: report.gateCounts,
    failedRuns: report.failedRuns,
    runs: report.runs,
  };
}

if (failures.length > 0) {
  for (const f of failures) {
    process.stderr.write(`::error::payload tier ${f.tier} (${f.circuit}) could not be measured: ${f.error}\n`);
    if (f.stderr) process.stderr.write(`${f.stderr}\n`);
  }
  writeReport({ verdict: "measurement-failed" });
  die(2, `${failures.length} of ${SELECTED.length} tier(s) could not be measured`);
}

// ── Scaling ratios (the "larger payload costs more" signal) ──────────────────

const small = measured.small;
const large = measured.large;
const ratio = (a, b) =>
  a !== null && a !== undefined && b !== null && b !== undefined && b > 0
    ? Number((a / b).toFixed(2))
    : null;

const scaling = {
  largeToSmallProve: ratio(large?.medians?.prove, small?.medians?.prove),
  largeToSmallWitness: ratio(large?.medians?.witness, small?.medians?.witness),
};

// ── Compare against the size ceilings ───────────────────────────────────────

const findings = []; // { level: "error"|"warn"|"info", text }
const rows = [];
let exitCode = 0;

if (BASELINE_PATH) {
  const baselineAbs = existsSync(resolve(process.cwd(), BASELINE_PATH))
    ? resolve(process.cwd(), BASELINE_PATH)
    : resolve(REPO, BASELINE_PATH);
  if (!existsSync(baselineAbs)) die(2, `baseline file not found: ${BASELINE_PATH}`);

  const baseline = JSON.parse(readFileSync(baselineAbs, "utf8"));

  for (const [tierName, limits] of Object.entries(baseline.tiers ?? {})) {
    const tier = measured[tierName];
    if (!tier) continue;

    for (const [stage, capField] of [
      ["witness", "maxWitnessMs"],
      ["prove", "maxProveMs"],
    ]) {
      const cap = limits[capField];
      const now = tier.medians?.[stage];
      if (typeof cap !== "number" || now === null || now === undefined) {
        rows.push([tierName, stage, cap ?? "—", now ?? "—", "warn"]);
        findings.push({
          level: "warn",
          text: `${tierName}/${stage}: no measurement or no ceiling recorded`,
        });
        continue;
      }
      if (now > cap) {
        rows.push([tierName, stage, `${cap}ms`, `${now}ms`, "FAIL"]);
        findings.push({
          level: "error",
          text: `${tierName} (${tier.circuit}) ${stage} took ${now}ms, above the ${cap}ms ceiling for an allowed payload — the prover now exceeds the workload the client guard lets through. Investigate the circuit/prover change, or raise the ceiling together with the guard (frontend/lib/proof-guard.ts) deliberately.`,
        });
        exitCode = 1;
      } else if (now > cap * 0.8) {
        rows.push([tierName, stage, `${cap}ms`, `${now}ms`, "warn"]);
        findings.push({
          level: "warn",
          text: `${tierName}/${stage} is within 20% of its ${cap}ms ceiling`,
        });
      } else {
        rows.push([tierName, stage, `${cap}ms`, `${now}ms`, "ok"]);
      }
    }

    // Memory: indicator only, never gates (runner RSS is noisy).
    const rss = tier.mediansRssKb?.prove ?? null;
    if (typeof limits.maxProveRssMb === "number" && rss !== null) {
      const mb = Math.round(rss / 1024);
      if (mb > limits.maxProveRssMb) {
        findings.push({
          level: "warn",
          text: `${tierName}/prove peaked at ~${mb} MB RSS, above the ${limits.maxProveRssMb} MB indicator (warn-only)`,
        });
      }
    }
  }

  const scalingCaps = baseline.scaling ?? {};
  const cap = scalingCaps.largeToSmallProveRatio;
  if (typeof cap === "number" && scaling.largeToSmallProve !== null) {
    if (scaling.largeToSmallProve > cap) {
      findings.push({
        level: "error",
        text: `aggregate proving costs ${scaling.largeToSmallProve}x the smallest credential, above the ${cap}x scaling ceiling — cost is growing faster than the payload. Check the aggregate circuit's gate count before bumping any limit.`,
      });
      exitCode = 1;
    } else if (scaling.largeToSmallProve > 1 + (cap - 1) / 2.5) {
      findings.push({
        level: "warn",
        text: `aggregate/small proving ratio is ${scaling.largeToSmallProve}x (within the ${cap}x ceiling)`,
      });
    }
  }
} else {
  log("\n(no --compare baseline given — measurement only)");
}

// ── Report + summary ────────────────────────────────────────────────────────

function writeReport(extra = {}) {
  const report = {
    measuredAt: new Date().toISOString(),
    runs: RUNS,
    tiers: measured,
    scaling,
    ...extra,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`\nreport: ${REPORT_PATH}`);
  return report;
}

function summaryTable() {
  return [
    `### Proving cost by payload size (median of ${RUNS} runs, CPU ms)`,
    "",
    "| Tier | Circuit | Witness | Prove | Peak RSS | ACIR gates | vs ceiling |",
    "|---|---|---|---|---|---|---|",
    ...SELECTED.map((t) => {
      const m = measured[t.tier];
      const rss = m?.mediansRssKb?.prove ? `${Math.round(m.mediansRssKb.prove / 1024)} MB` : "—";
      const statuses = rows.filter((r) => r[0] === t.tier).map((r) => r[4]);
      const status = statuses.includes("FAIL") ? "FAIL" : statuses.length > 0 ? "ok" : "—";
      return `| ${t.tier} | ${t.circuit} | ${m?.medians?.witness ?? "—"} | ${m?.medians?.prove ?? "—"} | ${rss} | ${m?.gateCounts?.totalAcirOpcodes ?? "—"} | ${status} |`;
    }),
    "",
    `Scaling: aggregate/small prove ${scaling.largeToSmallProve ?? "—"}x, witness ${scaling.largeToSmallWitness ?? "—"}x. Ceilings live in \`perf/payloads-baselines.json\`.`,
  ];
}

writeReport({ verdict: exitCode === 0 ? "PASS" : "FAIL" });

const summaryLines = summaryTable();
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryLines.join("\n")}\n`, { flag: "a" });
}
for (const line of summaryLines) log(line);
for (const f of findings) {
  const tag = f.level === "error" ? "error" : "warning";
  process.stdout.write(`::${tag}::${f.text.replace(/%/g, "%25")}\n`);
}

log(`\nverdict: ${exitCode === 0 ? "PASS" : "FAIL"}`);
process.exit(exitCode);

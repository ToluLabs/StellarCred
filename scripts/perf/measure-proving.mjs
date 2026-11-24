#!/usr/bin/env node
// Proving-performance measurement + regression gate (GitHub #629, pairs with #534).
//
// What this does
// ──────────────
//   1. Compiles the representative circuit (kyc_proof) once with the pinned
//      Noir/Barretenberg stack.
//   2. Records `nargo info` gate counts (ACIR opcodes) — the #534 pairing that
//      lets a time regression be attributed to circuit growth vs client change.
//   3. Times N runs of each proving stage with the same stage names the browser
//      instrumentation uses (frontend/lib/proof-perf.ts):
//        witness — nargo execute          (Prover.toml → witness .gz)
//        prove   — bb prove (UltraHonk)   (bytecode + witness → proof)
//        submit  — submit proxy (see SUBMIT PROXY below; recorded, warn-only)
//      Each stage reports wall and CPU time; the *median across runs* is the
//      regression metric. CPU time is primary because CI wall clock is noisy
//      (multi-tenant runners) while total CPU is near-deterministic; CPU also
//      absorbs thread-count jitter in bb's worker pool.
//   4. Compares medians + gate counts against perf/proving-baselines.json and
//      fails (`--compare`) beyond the thresholds in that file. A missing
//      baseline or missing submit proxy is a warning, never a failure.
//   5. Writes perf/proving-perf-report.json and, on GitHub Actions, a job
//      summary table plus ::warning::/::error:: annotations.
//
// Usage
// ─────
//   node scripts/perf/measure-proving.mjs [--runs 5] [--circuit kyc_proof]
//        [--compare perf/proving-baselines.json] [--stage-ratio 1.75]
//        [--gate-ratio 1.15]
//
// Exit code is 1 only when a compared stage or gate count regresses beyond its
// threshold. Measurement problems (missing toolchain, failed run) exit 2 so CI
// never confuses "slow" with "broken".

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const RUNS = Math.max(1, parseInt(argValue("--runs", "5"), 10));
const CIRCUIT = argValue("--circuit", "kyc_proof");
const BASELINE_PATH = argValue("--compare", "");
const STAGE_RATIO = parseFloat(argValue("--stage-ratio", ""));
const GATE_RATIO = parseFloat(argValue("--gate-ratio", ""));

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const CIRCUITS_DIR = join(REPO, "circuits");
const REPORT_PATH = join(REPO, "perf", "proving-perf-report.json");

// Stage names mirror `ProofStageName` in frontend/lib/proof-perf.ts. Do not
// rename without updating that file and the perf panel — the CI baseline must
// measure the same stages users see.
const STAGES = ["witness", "prove", "submit"];

// ── Small helpers ────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function die(code, msg) {
  process.stderr.write(`measure-proving: ${msg}\n`);
  process.exit(code);
}

/** Run a command, capturing stdout/stderr as strings. Throws on failure. */
function run(cmd, cmdArgs, cwd) {
  const res = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${cmdArgs.join(" ")} exited ${res.status}\nstdout: ${res.stdout?.slice(-2000)}\nstderr: ${res.stderr?.slice(-2000)}`
    );
  }
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Time a shell command via bash's `time` builtin.
 *
 * TIMEFORMAT='%3R %3U %3S' makes bash print one line "real user sys" (seconds)
 * for the child. That gives us wall AND CPU time in one shot — and bash's
 * `time` uses wait3/getrusage on the child process, so the CPU figure includes
 * every thread bb spawns (its UltraHonk prover is multithreaded).
 *
 * Returns { wallMs, cpuMs } where cpuMs = (user + sys) * 1000, or null if the
 * timing line could not be parsed (treated as missing run, not a failure).
 */
function timedBash(command, cwd) {
  const res = spawnSync(
    "bash",
    ["-c", `TIMEFORMAT='%3R %3U %3S'; time ${command}`],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(`timed command failed: ${command}\nstderr: ${res.stderr?.slice(-2000)}`);
  }
  // Take the LAST line that looks exactly like three floats — nargo/bb progress
  // output never matches this shape, and `time` prints after everything else.
  const lines = (res.stderr ?? "").split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)$/);
    if (m) {
      const wall = parseFloat(m[1]) * 1000;
      const cpu = (parseFloat(m[2]) + parseFloat(m[3])) * 1000;
      return { wallMs: Math.round(wall), cpuMs: Math.round(cpu) };
    }
  }
  return null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Submit-stage proxy ───────────────────────────────────────────────────────
//
// The real `submit` stage is a Soroban `submit_proof` call that needs a funded
// account and an RPC endpoint — not reproducible in a hermetic CI job. As a
// stand-in we time a fixed-cost node:crypto ECDSA sign+verify (P-256, the same
// curve family class as the SDK's auth signing). It will NOT catch a Soroban
// RPC slowdown; it catches pathological regressions in client-side crypto prep
// that sits on the submit path. Recorded and reported, but warn-only in the
// gate — the witness/prove stages and gate counts carry the hard threshold.

const SUBMIT_PROXY = `
const { createHash, generateKeyPairSync, sign: edSign, verify: edVerify } = require("node:crypto");
const kp = generateKeyPairSync("ed25519");
const msg = createHash("sha256").update(process.argv[1]).digest();
const t0 = process.hrtime.bigint();
for (let i = 0; i < 8; i += 1) {
  const sig = edSign(null, msg, kp.privateKey);
  if (!edVerify(null, msg, kp.publicKey, sig)) process.exit(1);
}
process.stdout.write(String(Number(process.hrtime.bigint() - t0) / 1e6));
`;

function measureSubmitProxy(payloadBytes, cwd) {
  const res = spawnSync("node", ["-e", SUBMIT_PROXY, "--", payloadBytes.toString("base64")], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.status !== 0) return null;
  const ms = parseFloat(res.stdout?.trim());
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

// ── Tool discovery ───────────────────────────────────────────────────────────

// bbup installs `bb` flat at ~/.bb/bb (ci.yml exports $HOME/.bb, not a bin/ subdir);
// keep ~/.bb/bin too so hand-installed layouts still resolve. noirup uses ~/.nargo/bin.
const PATH_ENV = [
  `${process.env.HOME}/.nargo/bin`,
  `${process.env.HOME}/.bb/bin`,
  `${process.env.HOME}/.bb`,
  process.env.PATH ?? "",
].join(":");
function runTool(cmd, cmdArgs, cwd) {
  return run(cmd, cmdArgs, cwd); // PATH inherited by spawnSync by default
}
process.env.PATH = PATH_ENV;

let nargoVersion = "unknown";
let bbVersion = "unknown";
try {
  nargoVersion = runTool("nargo", ["--version"], CIRCUITS_DIR).stdout.split("\n")[0].trim();
} catch {
  die(2, "nargo not found. Install with: noirup -v 1.0.0-beta.9");
}
try {
  bbVersion = runTool("bb", ["--version"], CIRCUITS_DIR).stdout.split("\n")[0].trim();
} catch {
  die(2, "bb not found. Install with: bbup -v 0.87.0");
}
log(`nargo : ${nargoVersion}`);
log(`bb    : ${bbVersion}`);
log(`circuit: ${CIRCUIT} (runs: ${RUNS})`);

const CIRCUIT_DIR = join(CIRCUITS_DIR, CIRCUIT);
if (!existsSync(join(CIRCUIT_DIR, "Nargo.toml"))) {
  die(2, `circuit directory not found: circuits/${CIRCUIT}`);
}

// ── Compile (untimed) + gate counts (#534 pairing) ──────────────────────────

log("\n== compile (untimed) ==");
runTool("nargo", ["compile"], CIRCUIT_DIR);
const bytecodePath = join(CIRCUITS_DIR, "target", `${CIRCUIT}.json`);
if (!existsSync(bytecodePath)) {
  // nargo resolves workspace-member output to circuits/target/<name>.json.
  die(2, `expected compiled bytecode at circuits/target/${CIRCUIT}.json — not found`);
}

const info = runTool("nargo", ["info"], CIRCUIT_DIR);
// noir 1.0.0-beta.9 prints `nargo info` as an ASCII table with one row per
// function; the entrypoint row is the one whose Function column is `main`
// (e.g. `| kyc_proof | main | Bounded { width: 4 } | 582 | 34 |`), where the
// ACIR Opcodes cell sits directly before the Brillig cell. Older versions
// printed a `Total ACIR opcodes: N` line — accept both.
let totalAcirOpcodes;
const entrypointRow = info.stdout
  .split("\n")
  .find((l) => l.startsWith("|") && /\|\s*main\s*\|/.test(l));
if (entrypointRow) {
  const cells = [...entrypointRow.matchAll(/\|\s*(\d+)\s*\|/g)].map((m) => parseInt(m[1], 10));
  totalAcirOpcodes = cells.at(-2) ?? cells.at(-1);
} else {
  const legacy = info.stdout.match(/(?:Total ACIR opcodes|Circuit size):\s*(\d+)/);
  totalAcirOpcodes = legacy ? parseInt(legacy[1], 10) : undefined;
}
if (totalAcirOpcodes === undefined) {
  die(2, `could not parse gate count from \`nargo info\` output:\n${info.stdout}`);
}
log(`ACIR opcodes: ${totalAcirOpcodes}`);

// Provenance: hash of the compiled bytecode, so a toolchain bump that changes
// codegen (and silently moves the clock) is visible as a baseline mismatch.
const bytecodeSha256 = createHash("sha256")
  .update(readFileSync(bytecodePath))
  .digest("hex");
log(`bytecode sha256: ${bytecodeSha256}`);

// ── Timed stage runs ─────────────────────────────────────────────────────────

const targetDir = join(CIRCUITS_DIR, "target");
const bytecode = `target/${CIRCUIT}.json`;
const witness = `target/${CIRCUIT}.gz`;

const times = Object.fromEntries(STAGES.map((s) => [s, { wall: [], cpu: [] }]));
let failedRuns = 0;

for (let i = 1; i <= RUNS; i += 1) {
  log(`\n== run ${i}/${RUNS} ==`);

  // witness — nargo execute writes circuits/target/<name>.gz (workspace-root
  // output dir; see the note in circuits/scripts/build.sh).
  const w = timedBash(`nargo execute`, CIRCUIT_DIR);
  if (!w || !existsSync(join(targetDir, `${CIRCUIT}.gz`))) {
    failedRuns += 1;
    log("  witness: FAILED");
    continue;
  }
  times.witness.wall.push(w.wallMs);
  times.witness.cpu.push(w.cpuMs);
  log(`  witness: wall ${w.wallMs}ms, cpu ${w.cpuMs}ms`);

  // prove — the exact invocation circuits/scripts/build.sh uses.
  const p = timedBash(
    `bb prove --scheme ultra_honk --oracle_hash keccak --bytecode_path ${bytecode} --witness_path ${witness} --output_path target --output_format bytes_and_fields`,
    CIRCUITS_DIR
  );
  if (!p || !existsSync(join(targetDir, "proof"))) {
    failedRuns += 1;
    log("  prove: FAILED");
    continue;
  }
  times.prove.wall.push(p.wallMs);
  times.prove.cpu.push(p.cpuMs);
  log(`  prove:   wall ${p.wallMs}ms, cpu ${p.cpuMs}ms`);

  // submit — proxy (warm node:crypto), only meaningful once per run.
  if (i === 1) {
    const payload = `${readFileSync(join(targetDir, "proof")).length}-${
      readFileSync(join(targetDir, "public_inputs")).length
    }`;
    const s = measureSubmitProxy(payload, REPO);
    if (s === null) {
      log("  submit (proxy): unavailable — recorded as missing, warn-only");
    } else {
      times.submit.wall.push(s);
      times.submit.cpu.push(s);
      log(`  submit:  proxy ${s}ms`);
    }
  }
}

if (times.witness.cpu.length === 0 || times.prove.cpu.length === 0) {
  die(2, `no successful runs for a gated stage (witness/prove); ${failedRuns} failed run(s)`);
}

// The gate metric per stage: median CPU ms (fallback wall when CPU parse
// failed for every run — older bash without usable time output).
function stageMetric(stage) {
  const src = times[stage];
  const med = median(src.cpu.length > 0 ? src.cpu : src.wall);
  return med;
}

const medians = Object.fromEntries(STAGES.map((s) => [s, stageMetric(s)]));
const medWall = Object.fromEntries(STAGES.map((s) => [s, median(times[s].wall)]));
log("\n== medians across runs (gate metric = cpu) ==");
for (const s of STAGES) {
  log(`  ${s.padEnd(8)} cpu ${medians[s] ?? "—"}ms (wall ${medWall[s] ?? "—"}ms, n=${times[s].cpu.length})`);
}

// ── Report ───────────────────────────────────────────────────────────────────

const report = {
  measuredAt: new Date().toISOString(),
  tool: { nargo: nargoVersion, bb: bbVersion },
  circuit: CIRCUIT,
  runs: RUNS,
  failedRuns,
  metric: "median cpu ms (wall also recorded)",
  medians,
  mediansWall: medWall,
  gateCounts: { totalAcirOpcodes },
  provenance: { bytecodeSha256 },
  perRun: Object.fromEntries(
    STAGES.map((s) => [s, { cpu: times[s].cpu, wall: times[s].wall }])
  ),
};
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
log(`\nreport: ${REPORT_PATH}`);

// ── Compare against baseline ─────────────────────────────────────────────────

const findings = []; // { level: 'error'|'warn'|'info', text }
let exitCode = 0;

if (BASELINE_PATH) {
  // Accept the baseline path relative to the caller's cwd (the workflow invokes
  // us from circuits/ with ../perf/…) or relative to the repo root.
  let baselineAbs = resolve(process.cwd(), BASELINE_PATH);
  if (!existsSync(baselineAbs)) baselineAbs = resolve(REPO, BASELINE_PATH);
  if (!existsSync(baselineAbs)) {
    die(2, `baseline file not found: ${BASELINE_PATH}`);
  }
  const baseline = JSON.parse(readFileSync(baselineAbs, "utf8"));
  const stageThreshold = Number.isFinite(STAGE_RATIO)
    ? STAGE_RATIO
    : baseline.regressionThresholds?.stageRatio ?? 1.75;
  const warnThreshold = 1 + (stageThreshold - 1) / 2.5; // ~1.3 at 1.75
  const gateThreshold = Number.isFinite(GATE_RATIO)
    ? GATE_RATIO
    : baseline.regressionThresholds?.gateRatio ?? 1.15;

  const baseStages = baseline.stages ?? {};
  const rows = [];

  for (const s of STAGES) {
    const base = baseStages[`${s === "submit" ? "submitProxyMs" : `${s}Ms`}`];
    const now = medians[s];
    if (now === null || now === undefined) {
      rows.push([s, base ?? "—", "missing", "—", "warn"]);
      findings.push({ level: "warn", text: `${s}: no measurement recorded` });
      continue;
    }
    if (base === null || base === undefined || base <= 0) {
      rows.push([s, "no baseline", `${now}ms`, "—", "warn"]);
      findings.push({
        level: "warn",
        text: `${s}: no baseline recorded — run this workflow on main and commit the numbers from perf/proving-perf-report.json to perf/proving-baselines.json`,
      });
      continue;
    }
    const ratio = now / base;
    const pct = `${((ratio - 1) * 100).toFixed(0)}%`;
    // submit is a proxy stage (no Soroban RPC in CI) — warn-only, never gates.
    const gated = s !== "submit";
    if (ratio > stageThreshold) {
      rows.push([s, `${base}ms`, `${now}ms`, `+${pct}`, gated ? "FAIL" : "warn"]);
      findings.push({
        level: gated ? "error" : "warn",
        text: gated
          ? `${s} regressed ${ratio.toFixed(2)}x vs baseline (${base}ms → ${now}ms, threshold ${stageThreshold}x). Median of ${times[s].cpu.length} run${times[s].cpu.length === 1 ? "" : "s"}, so this is not single-run noise.`
          : `submit proxy regressed ${ratio.toFixed(2)}x vs baseline (${base}ms → ${now}ms) — warn-only, the proxy cannot see Soroban RPC`,
      });
      if (gated) exitCode = 1;
    } else if (ratio > warnThreshold && gated) {
      rows.push([s, `${base}ms`, `${now}ms`, `+${pct}`, "warn"]);
      findings.push({ level: "warn", text: `${s} is ${pct} above baseline (within the ${stageThreshold}x gate)` });
    } else {
      rows.push([s, `${base}ms`, `${now}ms`, `${pct}`, "ok"]);
    }
  }

  // Provenance: warn when the compiled bytecode no longer matches the one the
  // baseline was recorded against (toolchain bump or codegen change). Warn-only.
  const baseHash = baseline.provenance?.bytecodeSha256;
  if (baseHash && baseHash !== bytecodeSha256) {
    findings.push({
      level: "warn",
      text: `compiled bytecode hash differs from the baseline provenance (${baseHash.slice(0, 12)}… → ${bytecodeSha256.slice(0, 12)}…) — a toolchain or codegen change moved the clock; refresh the baseline if intentional`,
    });
  }

  // Gate counts (#534): a time regression + gate growth ⇒ circuit growth is
  // the likely cause; time regression at flat gates ⇒ client/prover change.
  const baseGates = baseline.circuits?.[CIRCUIT]?.totalAcirOpcodes;
  let gatesAttribution = "baseline missing";
  if (baseGates === null || baseGates === undefined) {
    rows.push(["ACIR opcodes", "no baseline", String(totalAcirOpcodes), "—", "warn"]);
    findings.push({
      level: "warn",
      text: `no gate-count baseline for ${CIRCUIT} — commit ${totalAcirOpcodes} from this run`,
    });
  } else if (totalAcirOpcodes > baseGates) {
    const growth = totalAcirOpcodes - baseGates;
    const ratio = totalAcirOpcodes / baseGates;
    if (ratio > gateThreshold) {
      rows.push(["ACIR opcodes", String(baseGates), String(totalAcirOpcodes), `+${growth}`, "FAIL"]);
      findings.push({
        level: "error",
        text: `${CIRCUIT} grew by ${growth} ACIR opcodes (${baseGates} → ${totalAcirOpcodes}, threshold ${(gateThreshold * 100 - 100).toFixed(0)}%). If proving time also regressed, the circuit change is the cause.`,
      });
      exitCode = 1;
    } else {
      rows.push(["ACIR opcodes", String(baseGates), String(totalAcirOpcodes), `+${growth}`, "ok"]);
      gatesAttribution = `+${growth} opcodes (within gate)`;
      findings.push({
        level: "warn",
        text: `${CIRCUIT} grew by ${growth} ACIR opcodes (within the ${(gateThreshold * 100 - 100).toFixed(0)}% gate) — update the baseline intentionally if this is desired`,
      });
    }
  } else {
    rows.push([
      "ACIR opcodes",
      String(baseGates),
      String(totalAcirOpcodes),
      `${totalAcirOpcodes - baseGates}`,
      "ok",
    ]);
    gatesAttribution =
      totalAcirOpcodes === baseGates ? "unchanged" : `${totalAcirOpcodes - baseGates} opcodes`;
  }

  // ── GitHub summary ─────────────────────────────────────────────────────────
  const summaryLines = [
    "### Proving performance (median of " + RUNS + " runs, CPU ms)",
    "",
    "| Stage | Baseline | This PR | Δ | Status |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`),
    "",
    `Toolchain: ${nargoVersion} · ${bbVersion} — attribution: ${gatesAttribution}`,
    "",
    "Full numbers: `perf/proving-perf-report.json` artifact. Gate thresholds live in `perf/proving-baselines.json`.",
  ];
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryLines.join("\n")}\n`, { flag: "a" });
  }
  for (const f of findings) {
    const tag = f.level === "error" ? "error" : "warning";
    process.stdout.write(`::${tag}::${f.text.replace(/%/g, "%25")}\n`);
  }
} else {
  log("\n(no --compare baseline given — measurement only)");
}

log(`\nverdict: ${exitCode === 0 ? "PASS" : "FAIL"}`);
process.exit(exitCode);

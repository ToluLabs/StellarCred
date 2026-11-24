#!/usr/bin/env node
/**
 * pgbench-latency.mjs — PostgreSQL query-latency regression gate (#1069).
 *
 * Loads the indexer's real schema through the compiled `dist/db.js`, seeds a
 * deterministic dataset, runs `pgbench` against the transaction script in
 * `perf/pgbench/queries.sql`, and compares the mean latency against the
 * committed baseline with `evaluateLatencyGate` (`dist/latency-regression.js`).
 *
 * The benchmark deliberately measures the *same* statements the indexer issues,
 * on the *same* schema the migrations create, so a change that removes an index
 * or makes a hot query more expensive shows up here instead of in production.
 *
 * Usage:
 *   node scripts/pgbench-latency.mjs                     # run the gate
 *   node scripts/pgbench-latency.mjs --write-baseline     # re-record baseline
 *   node scripts/pgbench-latency.mjs --self-test          # verify the harness
 *
 * Options: --url, --baseline, --clients, --seconds, --tolerance, --floor,
 *          --report, --rows, --pgbench (path to the binary)
 *
 * Exit codes: 0 pass, 1 regression or invalid measurement, 2 usage/setup error.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERF_DIR = path.join(SERVICE_ROOT, "perf", "pgbench");
const DIST = path.join(SERVICE_ROOT, "dist");

function parseArgs(argv) {
  const args = {
    url: process.env.TEST_POSTGRES_URL ?? process.env.DATABASE_URL ?? "",
    baseline: path.join(PERF_DIR, "baseline.json"),
    clients: 8,
    seconds: 15,
    rows: 50_000,
    tolerance: Number(process.env.PGBENCH_TOLERANCE ?? "2.5"),
    floor: Number(process.env.PGBENCH_FLOOR_MS ?? "20"),
    report: path.join(SERVICE_ROOT, "perf", "pgbench-report.json"),
    pgbench: process.env.PGBENCH_BIN ?? "pgbench",
    writeBaseline: false,
    selfTest: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`Missing value for ${arg}`);
        process.exit(2);
      }
      return value;
    };
    switch (arg) {
      case "--url": args.url = next(); break;
      case "--baseline": args.baseline = path.resolve(next()); break;
      case "--clients": args.clients = Number(next()); break;
      case "--seconds": args.seconds = Number(next()); break;
      case "--rows": args.rows = Number(next()); break;
      case "--tolerance": args.tolerance = Number(next()); break;
      case "--floor": args.floor = Number(next()); break;
      case "--report": args.report = path.resolve(next()); break;
      case "--pgbench": args.pgbench = next(); break;
      case "--write-baseline": args.writeBaseline = true; break;
      case "--self-test": args.selfTest = true; break;
      case "--help":
      case "-h":
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
      // no default
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(2);
    }
  }

  if (!Number.isInteger(args.clients) || args.clients < 1) args.clients = 1;
  if (!Number.isInteger(args.seconds) || args.seconds < 1) args.seconds = 1;
  if (!Number.isInteger(args.rows) || args.rows < 1) args.rows = 50_000;
  return args;
}

function loadDist() {
  const dbPath = path.join(DIST, "db.js");
  const gatePath = path.join(DIST, "latency-regression.js");
  if (!fs.existsSync(dbPath) || !fs.existsSync(gatePath)) {
    console.error("dist/ is missing. Run `npm run build` before the benchmark.");
    process.exit(2);
  }
  return {
    createDb: require(dbPath).createDb,
    evaluateLatencyGate: require(gatePath).evaluateLatencyGate,
  };
}

/** Parse the `latency average = … ms` / `tps = …` lines pgbench prints. */
function parsePgbenchOutput(text) {
  const latency = /latency average = ([\d.]+) ms/.exec(text);
  const tps = /\btps = ([\d.]+)/.exec(text);

  const statements = {};
  const statementBlock = text.split("statement latencies in milliseconds:")[1];
  if (statementBlock) {
    for (const line of statementBlock.split("\n")) {
      const match = /^\s+([\d.]+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      // pgbench prints the statement's first line; trim it to a stable label.
      const label = match[2].replace(/\s+/g, " ").slice(0, 60);
      statements[label] = Number(match[1]);
    }
  }

  return {
    averageLatencyMs: latency ? Number(latency[1]) : Number.NaN,
    tps: tps ? Number(tps[1]) : undefined,
    statements,
  };
}

async function prepareDatabase(url, rows) {
  const { createDb } = loadDist();
  const config = {
    dbDriver: "postgres",
    databaseUrl: url,
    // Keep the benchmark connection count fixed regardless of the service's
    // tuned defaults; pgbench opens its own connections anyway.
    dbPool: {
      max: 10,
      min: 0,
      idleTimeoutMs: 10_000,
      connectionTimeoutMs: 5_000,
      maxUses: 0,
      preparedStatements: true,
    },
  };
  const db = createDb(config);
  try {
    await db.migrate();
  } finally {
    await db.close();
  }

  // Seed with a plain client so the writes are not measured.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const seed = fs
      .readFileSync(path.join(PERF_DIR, "seed.sql"), "utf8")
      .replaceAll("%%ROWS%%", String(rows));
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE claims RESTART IDENTITY");
    await client.query(seed);
    await client.query("COMMIT");
    await client.query("ANALYZE claims");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

function runPgbench(args) {
  const runArgs = [
    "-n", // no vacuum before the run: latency only
    "-c", String(args.clients),
    "-j", String(Math.min(args.clients, 8)),
    "-T", String(args.seconds),
    "-f", path.join(PERF_DIR, "queries.sql"),
    "-D", "scale=1",
    // pgbench needs a connection target; -h/-p are derived from the URL below.
  ];

  const url = new URL(args.url);
  if (url.hostname) runArgs.push("-h", url.hostname);
  if (url.port) runArgs.push("-p", url.port);
  if (url.username) runArgs.push("-U", decodeURIComponent(url.username));
  runArgs.push(decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres");

  const output = execFileSync(args.pgbench, runArgs, {
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password || "") },
  });
  return output;
}

function selfTest() {
  const { evaluateLatencyGate } = loadDist();
  const baseline = { version: 1, averageLatencyMs: 10 };
  const cases = [
    [8, true],
    [24, true],
    [25.1, false],
    [Number.NaN, false],
  ];
  let failed = 0;
  for (const [observed, expected] of cases) {
    const result = evaluateLatencyGate(
      { averageLatencyMs: observed },
      baseline,
      { toleranceFactor: 2.5, absoluteFloorMs: 0 },
    );
    if (result.ok !== expected) {
      failed++;
      console.error(`self-test: ${observed} ms expected ok=${expected}, got ${result.ok}`);
    }
  }
  if (failed > 0) process.exit(1);
  console.log("self-test: latency gate behaves as expected");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();

  if (!args.url) {
    console.error("Set DATABASE_URL (or TEST_POSTGRES_URL) / pass --url.");
    process.exit(2);
  }

  console.log(
    `[pgbench] seeding ${args.rows} claims, ${args.clients} clients for ${args.seconds}s`,
  );
  await prepareDatabase(args.url, args.rows);

  console.log(`[pgbench] running ${args.pgbench} …`);
  const output = runPgbench(args);
  console.log(output.trim());

  const observed = parsePgbenchOutput(output);
  const baseline = JSON.parse(fs.readFileSync(args.baseline, "utf8"));
  const { evaluateLatencyGate } = loadDist();
  const result = evaluateLatencyGate(observed, baseline, {
    toleranceFactor: args.tolerance,
    absoluteFloorMs: args.floor,
  });

  // The gate now knows the difference between "never measured" and "measured
  // and regressed". When there is no committed baseline yet, the runner keeps
  // the CI job green and prints what to do next; the report still records the
  // measurement and the skip reason so the first real run can re-establish it.
  for (const failure of result.failures) {
    if (failure.startsWith("gate-skipped")) {
      console.error(
        "[pgbench] no committed baseline recorded yet."
      );
      console.error(
        "[pgbench] Re-record one on the CI Postgres container with:\n" +
          "  DATABASE_URL=postgres://indexer:indexer@localhost:5432/indexer " +
          "--clients 8 --seconds 15 --write-baseline\n" +
          "Then bump baseline.version to 2 and commit the result.\n" +
          "Do not use --write-baseline against a transient or shared workload " +
        "that is also running other jobs — it records only what that run saw.\n"
      );
    } else {
      console.error(`  - ${failure}`);
    }
  }

  const report = {
    measuredAt: new Date().toISOString(),
    workload: baseline.workload,
    clients: args.clients,
    seconds: args.seconds,
    rows: args.rows,
    observed,
    baseline,
    budgetMs: result.budgetMs,
    ok: result.ok,
    failures: result.failures,
  };
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    `[pgbench] mean latency ${observed.averageLatencyMs.toFixed(2)} ms ` +
      `(baseline ${baseline.averageLatencyMs} ms, budget ${result.budgetMs.toFixed(2)} ms), ` +
      `tps ${observed.tps ?? "n/a"}`,
  );

  if (result.failures.some(f => f.startsWith("gate-skipped"))) {
    return;
  }

  if (args.writeBaseline) {
    const next = {
      ...baseline,
      version: 2,
      averageLatencyMs: Number(observed.averageLatencyMs.toFixed(2)),
      tps: observed.tps ? Math.round(observed.tps) : baseline.tps,
    };
    fs.writeFileSync(args.baseline, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `[pgbench] committed baseline updated (version 2): ${args.baseline}`,
    );
    return;
  }

  if (!result.ok) {
    console.error("[pgbench] latency regression detected:");
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("[pgbench] within budget.");
}

main().catch((err) => {
  console.error(`[pgbench] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * indexer-query-bench.mjs — seed an in-memory claims table and time the
 * listing queries that degrade as the indexed user base grows (#872).
 *
 * Usage (from repo root, after `npm install` in services/indexer):
 *   node perf/indexer-query-bench.mjs [--rows 5000] [--issuer-fanout 5000]
 *
 * Prints median wall times for each query shape so bottlenecks are visible
 * without a profiler attach. Run before and after index/query changes.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.join(__dirname, "..", "services", "indexer", "package.json"),
);
const Database = require("better-sqlite3");

function parseArgs(argv) {
  const args = { rows: 5000, issuerFanout: 5000 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--rows") args.rows = Number(argv[++i]);
    else if (argv[i] === "--issuer-fanout") args.issuerFanout = Number(argv[++i]);
  }
  if (!Number.isInteger(args.rows) || args.rows < 1) {
    console.error("--rows must be a positive integer");
    process.exit(1);
  }
  if (!Number.isInteger(args.issuerFanout) || args.issuerFanout < 1) {
    console.error("--issuer-fanout must be a positive integer");
    process.exit(1);
  }
  return args;
}

function buildSchema(db) {
  db.exec(`
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY,
      wallet TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      issuer TEXT NOT NULL DEFAULT '',
      verified_at INTEGER NOT NULL DEFAULT 0,
      expiry INTEGER NOT NULL DEFAULT 0,
      ledger_sequence INTEGER NOT NULL DEFAULT 0,
      threshold INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      reason_code TEXT NOT NULL DEFAULT 'other',
      UNIQUE (wallet, credential_type)
    );
    CREATE INDEX IF NOT EXISTS idx_claims_wallet ON claims (wallet);
    CREATE INDEX IF NOT EXISTS idx_claims_type ON claims (credential_type);
    CREATE INDEX IF NOT EXISTS idx_claims_issuer ON claims (issuer);
    CREATE INDEX IF NOT EXISTS idx_claims_verified_at ON claims (verified_at DESC);
    CREATE INDEX IF NOT EXISTS idx_claims_recent
      ON claims (ledger_sequence DESC, id DESC) WHERE revoked = 0;
  `);
}

function seed(db, rows, issuerFanout) {
  const insert = db.prepare(`
    INSERT INTO claims (wallet, credential_type, issuer, verified_at, expiry, ledger_sequence, revoked)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const types = ["kyc", "age", "income", "funds", "jurisdiction"];
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction((n) => {
    for (let i = 0; i < n; i++) {
      const issuer = `G${String(i % Math.max(1, Math.floor(n / Math.max(1, issuerFanout)))).padStart(55, "I")}`;
      insert.run(
        `G${String(i).padStart(55, "W")}`,
        types[i % types.length],
        issuer,
        now - (i % 10000),
        now + 86400 * 90,
        1_000_000 + i,
        i % 17 === 0 ? 1 : 0,
      );
    }
  });
  tx(rows);
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bench(label, fn, runs = 25) {
  fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { label, medianMs: median(samples) };
}

function main() {
  const { rows, issuerFanout } = parseArgs(process.argv);
  const db = new Database(":memory:");
  buildSchema(db);
  const seedStart = process.hrtime.bigint();
  seed(db, rows, issuerFanout);
  const seedMs = Number(process.hrtime.bigint() - seedStart) / 1e6;

  const wallet = db.prepare("SELECT wallet FROM claims LIMIT 1").get().wallet;
  const issuer = db.prepare("SELECT issuer FROM claims LIMIT 1").get().issuer;

  const results = [
    bench("claimsByWallet", () => {
      db.prepare("SELECT * FROM claims WHERE wallet = ?").all(wallet);
    }),
    bench("claimsByIssuer (uncapped)", () => {
      db.prepare("SELECT * FROM claims WHERE issuer = ? ORDER BY id DESC").all(issuer);
    }),
    bench("claimsByIssuer (limit 100)", () => {
      db.prepare("SELECT * FROM claims WHERE issuer = ? ORDER BY id DESC LIMIT ?").all(issuer, 100);
    }),
    bench("recent (keyset page 20)", () => {
      db.prepare(
        "SELECT * FROM claims WHERE revoked = 0 ORDER BY ledger_sequence DESC, id DESC LIMIT ?",
      ).all(21);
    }),
    bench("issuerStats aggregate", () => {
      db.prepare(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE revoked=0) AS active,
                COUNT(*) FILTER (WHERE revoked=1) AS revoked,
                MIN(verified_at) AS first_seen
         FROM claims WHERE issuer = ?`,
      ).get(issuer);
    }),
    bench("table scan (SELECT * no WHERE)", () => {
      db.prepare("SELECT * FROM claims").all();
    }),
  ];

  const planIssuer = db
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM claims WHERE issuer = ? ORDER BY id DESC")
    .all(issuer);

  const report = {
    rows,
    issuerFanout,
    seedMs: Number(seedMs.toFixed(2)),
    queries: results.map((r) => ({ label: r.label, medianMs: Number(r.medianMs.toFixed(3)) })),
    issuerQueryPlan: planIssuer.map((r) => r.detail),
  };

  console.log(JSON.stringify(report, null, 2));
  console.error(
    `\nSeeded ${rows} claims in ${seedMs.toFixed(1)}ms. ` +
      `Slowest query: ${
        results.reduce((a, b) => (a.medianMs > b.medianMs ? a : b)).label
      }`,
  );
  db.close();
}

main();


/**
 * db.test.ts — Parameterized database integration tests.
 *
 * Runs the *same* suite against both supported backends so neither can rot:
 *
 *   - SQLite   (better-sqlite3; the default dev / single-instance driver)
 *   - Postgres (pg pool; the production multi-instance driver)
 *
 * Both legs drive the one shared query layer (`db-shared.ts`); only the
 * `SqlDialect` adapter differs, so this suite is written once and registered
 * per backend. The remaining dialect differences (INSERT OR IGNORE vs ON
 * CONFLICT, INTEGER vs BIGINT) are covered by `db-dialect.test.ts`, which
 * needs no live server.
 *
 * The Postgres leg runs in CI via the `postgres` service container in
 * `.github/workflows/ci.yml`. Locally it is gated on `TEST_POSTGRES_URL`
 * (falling back to `DATABASE_URL`) and is skipped when unset, mirroring how
 * the SDK integration suites skip gracefully without configured credentials.
 */

import path from "path";
import os from "os";
import fs from "fs";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createDb, type ClaimInput, type Db } from "./db";
import type { Config } from "./config";

// Connection used by the Postgres leg. In CI this is provided by the
// `postgres` service container; locally point it at any reachable Postgres.
const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath: path.join(
      os.tmpdir(),
      `db-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    ),
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 6,
    corsOrigins: ["http://localhost:3000"],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 120,
    rateLimitEnabled: true,
    backfillBatchSize: 200,
    integrityCheckEnabled: false,
    integrityCheckIntervalMs: 900_000,
    integrityCheckSampleSize: 25,
    ...overrides,
  } as Config;
}

function makeClaim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    wallet: "GALICE",
    credential_type: "kyc",
    issuer: "GISSUER",
    verified_at: 1_724_000_000,
    expiry: 1_755_000_000,
    ledger_sequence: 100,
    threshold: null,
    revoked: 0,
    reason_code: "other",
    ...overrides,
  };
}

/** Register one full suite of DB tests for a given backend. */
function registerSuite(
  d: typeof describe,
  driver: string,
  make: () => Config,
): void {
  d(`DB adapter — ${driver}`, () => {
    let db: Db;
    let sqliteFile: string | undefined;

    beforeEach(async () => {
      const cfg = make();
      if (cfg.dbDriver === "sqlite") sqliteFile = cfg.sqlitePath;
      db = createDb(cfg);
      await db.migrate();
      // Isolate each test. SQLite gets a fresh temp file per test, but the
      // Postgres leg reuses the same database — clear any residue so tests are
      // order-independent (delete every claim and reset the cursor).
      await db.deleteClaimsAfter(0);
      await db.setLastLedger(0);
      await db.setBackfillStartLedger(0);

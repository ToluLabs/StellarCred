/**
 * backfill.test.ts — Tests for the historical backfill feature (#611).
 *
 * Covers:
 *   1. parseBackfillArgs: valid and invalid CLI argument parsing.
 *   2. Fresh backfill: events within range are indexed, outside are skipped.
 *   3. Resumable checkpoint: re-running with the same fromLedger resumes from
 *      the stored page cursor without re-fetching already-processed pages.
 *   4. Range change: re-running with a different fromLedger resets state and
 *      starts fresh.
 *   5. Multi-page pagination: follows _links.next until exhausted.
 *   6. Termination when highest page ledger exceeds toLedger.
 *   7. Already-complete checkpoint: returns immediately at 100 %.
 *   8. Progress reporting: elapsedSeconds, ledgersPerSecond, etaSeconds, percent.
 *   9. getBackfillStatus via the HTTP API (/backfill/status).
 *  10. backfillBatchSize propagated as Horizon limit query param.
 *
 * The SQLite-backed suites (2–10) require the native better-sqlite3 module.
 * They are skipped gracefully when the module cannot be loaded (e.g. in
 * environments without the C++ build tools required to compile it).
 */

import path from "path";
import os from "os";
import fs from "fs";
import { xdr } from "@stellar/stellar-sdk";
import { buildApp } from "./api";
import { parseBackfillArgs } from "./backfill";
import type { Config } from "./config";
import type { BackfillProgress, Ingester, IngesterHealth, IngesterMetrics } from "./ingester";
import request from "supertest";

// ── Detect whether the SQLite native module is available ───────────────────

let sqliteAvailable = false;
try {
  // Test by actually opening a temporary database — the binding error
  // is lazy and only surfaces when a Database instance is constructed.
  const BetterSqlite3 = require("better-sqlite3");
  const tmpTestDb = require("path").join(require("os").tmpdir(), `__sqlite_probe_${Date.now()}.db`);
  const probe = new BetterSqlite3(tmpTestDb);
  probe.close();
  require("fs").unlinkSync(tmpTestDb);
  sqliteAvailable = true;
} catch {
  // Native module not compiled; SQLite-backed suites will be skipped.
}

// Lazy imports so missing native module doesn't crash the whole file.
type DbModule = typeof import("./db");
type IngesterModule = typeof import("./ingester");
type DbTypes = typeof import("./db-types");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath: path.join(
      os.tmpdir(),
      `backfill-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    ),
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 6,
    backfillBatchSize: 200,
    corsOrigins: ["http://localhost:3000"],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 120,
    rateLimitEnabled: true,
    ...overrides,
  } as Config;
}

/** Encode an XDR ScVal to base64 (the format Horizon returns for topics/values). */
function scValBase64(sc: xdr.ScVal): string {
  return xdr.ScVal.toXDR(sc).toString("base64");
}

/**
 * Build a fake Horizon contract event for a ProofRegistry "verified" event.
 * Topics use real XDR so decodeScVal round-trips correctly.
 */
function fakeVerifiedEvent(opts: {
  ledger: number;
  sourceAccount?: string;
  contractId?: string;
}) {
  return {
    paging_token: String(opts.ledger * 100_000),
    contract_id: opts.contractId ?? "CTEST",
    topic: ["proof", "verified"].map((s) => scValBase64(xdr.ScVal.scvSymbol(s))),
    value: scValBase64(xdr.ScVal.scvU64(xdr.Uint64.fromString("9999999"))),
    ledger: opts.ledger,
    ledger_closed_at: new Date(opts.ledger * 5000).toISOString(),
    transaction_hash: `txhash_${opts.ledger}`,
    source_account: opts.sourceAccount ?? `GHOLDER${opts.ledger}`,
  };
}

/**
 * Build a minimal Horizon events page.
 * Includes _links.next when nextCursor is provided.
 */
function eventsPage(
  records: ReturnType<typeof fakeVerifiedEvent>[],
  nextCursor?: string,
) {
  return {
    _embedded: { records },
    _links: nextCursor
      ? {
          next: {
            href:
              `https://horizon-testnet.stellar.org/contracts/CTEST/events` +
              `?cursor=${nextCursor}&limit=200&order=asc`,
          },
        }
      : undefined,
  };
}

// ── Suite 1: parseBackfillArgs (no native module needed) ──────────────────

describe("parseBackfillArgs", () => {
  it("parses numeric --from and --to", () => {
    const args = parseBackfillArgs(["--from", "100000", "--to", "120000"]);
    expect(args).toEqual({ fromLedger: 100_000, toLedger: 120_000 });
  });

  it("maps 'genesis' to ledger 1", () => {
    const args = parseBackfillArgs(["--from", "genesis", "--to", "50000"]);
    expect(args.fromLedger).toBe(1);
  });

  it("leaves toLedger undefined when --to is 'head'", () => {
    const args = parseBackfillArgs(["--from", "1000", "--to", "head"]);
    expect(args.toLedger).toBeUndefined();
  });

  it("leaves toLedger undefined when --to is omitted", () => {
    const args = parseBackfillArgs(["--from", "1000"]);
    expect(args.toLedger).toBeUndefined();
  });

  it("throws when --from is missing", () => {
    expect(() => parseBackfillArgs([])).toThrow("--from is required");
  });

  it("throws when --from is zero", () => {
    expect(() => parseBackfillArgs(["--from", "0"])).toThrow("Invalid --from");
  });

  it("throws when --to < --from", () => {
    expect(() =>
      parseBackfillArgs(["--from", "200", "--to", "100"]),
    ).toThrow("Invalid --to");
  });

  it("throws on unknown argument", () => {
    expect(() =>
      parseBackfillArgs(["--from", "1", "--unknown", "x"]),
    ).toThrow("Unknown argument");
  });

  it("'genesis' alias is case-insensitive", () => {
    expect(parseBackfillArgs(["--from", "GENESIS"]).fromLedger).toBe(1);
    expect(parseBackfillArgs(["--from", "Genesis"]).fromLedger).toBe(1);
  });

  it("'head' alias for --to is case-insensitive", () => {
    expect(parseBackfillArgs(["--from", "1", "--to", "HEAD"]).toLedger).toBeUndefined();
  });
});

// ── Suite 2+: SQLite-backed tests ──────────────────────────────────────────

const sqlit = sqliteAvailable ? describe : describe.skip;

sqlit("backfill — range filtering", () => {
  let db: import("./db-types").Db;
  let tmpFile: string;
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    const { createSqliteDb } = require("./db") as DbModule;
    tmpFile = path.join(os.tmpdir(), `bf-range-${Date.now()}-${Math.random()}.db`);
    db = createSqliteDb(makeConfig({ sqlitePath: tmpFile }));
    await db.migrate();
    fetchMock = jest.spyOn(global, "fetch");
  });

  afterEach(async () => {
    fetchMock?.mockRestore();
    await db?.close();
    for (const s of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(tmpFile + s); } catch { /* ignore */ }
    }
  });

  it("indexes events within range and skips events outside range", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () =>
        eventsPage([
          fakeVerifiedEvent({ ledger: 99,  sourceAccount: "GBEFORE" }),
          fakeVerifiedEvent({ ledger: 105, sourceAccount: "GALICE" }),
          fakeVerifiedEvent({ ledger: 115, sourceAccount: "GBOB" }),
          fakeVerifiedEvent({ ledger: 125, sourceAccount: "GAFTER" }),
        ]),
    }));

    const ingester = createIngester(makeConfig({ sqlitePath: tmpFile }), db);
    const result = await ingester.backfill(100, 120);

    expect(result.eventsProcessed).toBe(2);
    expect(result.percent).toBe(100);
    expect(result.running).toBe(false);

    expect(await db.claimsByWallet("GALICE")).toHaveLength(1);
    expect(await db.claimsByWallet("GBOB")).toHaveLength(1);
    expect(await db.claimsByWallet("GBEFORE")).toHaveLength(0);
    expect(await db.claimsByWallet("GAFTER")).toHaveLength(0);
  });

  it("returns 0 events when there are no events in the range", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => eventsPage([]),
    }));

    const result = await createIngester(
      makeConfig({ sqlitePath: tmpFile }), db,
    ).backfill(1000, 2000);

    expect(result.eventsProcessed).toBe(0);
    expect(result.percent).toBe(100);
  });
});

sqlit("backfill — resumable checkpoint", () => {
  let db: import("./db-types").Db;
  let tmpFile: string;
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    const { createSqliteDb } = require("./db") as DbModule;
    tmpFile = path.join(os.tmpdir(), `bf-resume-${Date.now()}-${Math.random()}.db`);
    db = createSqliteDb(makeConfig({ sqlitePath: tmpFile }));
    await db.migrate();
    fetchMock = jest.spyOn(global, "fetch");
  });

  afterEach(async () => {
    fetchMock?.mockRestore();
    await db?.close();
    for (const s of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(tmpFile + s); } catch { /* ignore */ }
    }
  });

  it("resumes from stored page cursor when same fromLedger is used", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    await db.setBackfillStartLedger(100);
    await db.setBackfillLedger(110);
    await db.setBackfillCursor("cursor_after_ledger_110");

    let usedCursor: string | null = null;
    fetchMock.mockImplementation(async (url: string) => {
      usedCursor = new URL(String(url)).searchParams.get("cursor");
      return {
        ok: true,
        json: async () =>
          eventsPage([fakeVerifiedEvent({ ledger: 115, sourceAccount: "GRESUMED" })]),
      };
    });

    await createIngester(makeConfig({ sqlitePath: tmpFile }), db).backfill(100, 120);

    // Must have used the stored opaque page cursor, not a ledger-derived one
    expect(usedCursor).toBe("cursor_after_ledger_110");
    expect(await db.claimsByWallet("GRESUMED")).toHaveLength(1);
  });

  it("resets checkpoint when a different fromLedger is used", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    await db.setBackfillStartLedger(100);
    await db.setBackfillLedger(150);
    await db.setBackfillCursor("old_cursor");

    let usedCursor: string | null = null;
    fetchMock.mockImplementation(async (url: string) => {
      usedCursor = new URL(String(url)).searchParams.get("cursor");
      return {
        ok: true,
        json: async () =>
          eventsPage([fakeVerifiedEvent({ ledger: 305, sourceAccount: "GNEW" })]),
      };
    });

    await createIngester(makeConfig({ sqlitePath: tmpFile }), db).backfill(300, 310);

    expect(usedCursor).not.toBe("old_cursor");
    expect(await db.getBackfillStartLedger()).toBe(300);
  });

  it("returns immediately at 100 % when checkpoint already covers the range", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    await db.setBackfillStartLedger(100);
    await db.setBackfillLedger(200); // already at toLedger

    const result = await createIngester(
      makeConfig({ sqlitePath: tmpFile }), db,
    ).backfill(100, 200);

    expect(result.percent).toBe(100);
    expect(result.eventsProcessed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

sqlit("backfill — multi-page pagination", () => {
  let db: import("./db-types").Db;
  let tmpFile: string;
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    const { createSqliteDb } = require("./db") as DbModule;
    tmpFile = path.join(os.tmpdir(), `bf-pages-${Date.now()}-${Math.random()}.db`);
    db = createSqliteDb(makeConfig({ sqlitePath: tmpFile }));
    await db.migrate();
    fetchMock = jest.spyOn(global, "fetch");
  });

  afterEach(async () => {
    fetchMock?.mockRestore();
    await db?.close();
    for (const s of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(tmpFile + s); } catch { /* ignore */ }
    }
  });

  it("follows next page links until exhausted", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    let callCount = 0;
    fetchMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () =>
            eventsPage(
              [101, 102, 103, 104, 105].map((l) =>
                fakeVerifiedEvent({ ledger: l, sourceAccount: `GHOLDER${l}` }),
              ),
              "page2_cursor",
            ),
        };
      }
      return {
        ok: true,
        json: async () =>
          eventsPage(
            [106, 107, 108, 109, 110].map((l) =>
              fakeVerifiedEvent({ ledger: l, sourceAccount: `GHOLDER${l}` }),
            ),
          ),
      };
    });

    const result = await createIngester(
      makeConfig({ sqlitePath: tmpFile }), db,
    ).backfill(100, 115);

    expect(result.eventsProcessed).toBe(10);
    expect(result.pagesProcessed).toBe(2);
    expect(result.percent).toBe(100);
    for (let l = 101; l <= 110; l++) {
      expect(await db.claimsByWallet(`GHOLDER${l}`)).toHaveLength(1);
    }
  });

  it("stops fetching when highest page ledger exceeds toLedger", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () =>
        eventsPage(
          [
            fakeVerifiedEvent({ ledger: 105, sourceAccount: "GIN" }),
            fakeVerifiedEvent({ ledger: 135, sourceAccount: "GOUT" }), // past toLedger=120
          ],
          "would_never_be_used",
        ),
    }));

    const result = await createIngester(
      makeConfig({ sqlitePath: tmpFile }), db,
    ).backfill(100, 120);

    expect(await db.claimsByWallet("GIN")).toHaveLength(1);
    expect(await db.claimsByWallet("GOUT")).toHaveLength(0);
    expect(result.percent).toBe(100);
  });
});

sqlit("backfill — progress reporting", () => {
  let db: import("./db-types").Db;
  let tmpFile: string;
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    const { createSqliteDb } = require("./db") as DbModule;
    tmpFile = path.join(os.tmpdir(), `bf-progress-${Date.now()}-${Math.random()}.db`);
    db = createSqliteDb(makeConfig({ sqlitePath: tmpFile }));
    await db.migrate();
    fetchMock = jest.spyOn(global, "fetch");
  });

  afterEach(async () => {
    fetchMock?.mockRestore();
    await db?.close();
    for (const s of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(tmpFile + s); } catch { /* ignore */ }
    }
  });

  it("calls onProgress with enriched metrics after each page", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () =>
        eventsPage([fakeVerifiedEvent({ ledger: 150, sourceAccount: "GPROGRESS" })]),
    }));

    const snapshots: BackfillProgress[] = [];
    const result = await createIngester(
      makeConfig({ sqlitePath: tmpFile }), db,
    ).backfill(100, 200, (p) => snapshots.push(p));

    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const snap = snapshots[0];
    expect(snap.fromLedger).toBe(100);
    expect(snap.toLedger).toBe(200);
    expect(snap.percent).toBeGreaterThanOrEqual(0);
    expect(snap.percent).toBeLessThanOrEqual(100);
    expect(typeof snap.elapsedSeconds).toBe("number");
    expect(snap.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof snap.ledgersPerSecond).toBe("number");
    expect(snap.etaSeconds === null || snap.etaSeconds >= 0).toBe(true);

    // Final result has completed shape
    expect(result.running).toBe(false);
    expect(result.etaSeconds).toBeNull();
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(0);
  });

  it("getBackfillStatus returns null before any backfill", () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    const ingester = createIngester(makeConfig({ sqlitePath: tmpFile }), db);
    expect(ingester.getBackfillStatus()).toBeNull();
  });

  it("getBackfillStatus reflects the latest completed run", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => eventsPage([]),
    }));

    const ingester = createIngester(makeConfig({ sqlitePath: tmpFile }), db);
    await ingester.backfill(500, 600);

    const status = ingester.getBackfillStatus();
    expect(status).not.toBeNull();
    expect(status!.fromLedger).toBe(500);
    expect(status!.toLedger).toBe(600);
    expect(status!.running).toBe(false);
    expect(status!.percent).toBe(100);
  });
});

sqlit("backfill — batch size config", () => {
  let db: import("./db-types").Db;
  let tmpFile: string;
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    const { createSqliteDb } = require("./db") as DbModule;
    tmpFile = path.join(os.tmpdir(), `bf-batch-${Date.now()}-${Math.random()}.db`);
    db = createSqliteDb(makeConfig({ sqlitePath: tmpFile }));
    await db.migrate();
    fetchMock = jest.spyOn(global, "fetch");
  });

  afterEach(async () => {
    fetchMock?.mockRestore();
    await db?.close();
    for (const s of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(tmpFile + s); } catch { /* ignore */ }
    }
  });

  it("uses backfillBatchSize from config as the Horizon limit param", async () => {
    const { createIngester } = require("./ingester") as IngesterModule;
    let capturedLimit: string | null = null;
    fetchMock.mockImplementation(async (url: string) => {
      capturedLimit = new URL(String(url)).searchParams.get("limit");
      return { ok: true, json: async () => eventsPage([]) };
    });

    await createIngester(
      makeConfig({ sqlitePath: tmpFile, backfillBatchSize: 50 }), db,
    ).backfill(1000, 1100);

    expect(capturedLimit).toBe("50");
  });
});

// ── Suite: HTTP /backfill/status endpoint (no native module needed) ────────

describe("GET /backfill/status", () => {
  let db: import("./db-types").Db;
  let tmpFile: string;

  /** Minimal Ingester stub for API-layer tests — no real DB needed. */
  function makeIngesterStub(backfillStatus: BackfillProgress | null): Ingester {
    const health: IngesterHealth = {
      lastSuccessLedger: 0, headLedger: 0, lag: -1,
      lastError: null, lastErrorTime: null,
      consecutiveErrors: 0, fetchAttempts: 0, fetchFailures: 0,
    };
    const metrics: IngesterMetrics = {
      eventsProcessedTotal: 0, fetchErrorsTotal: 0,
      uptimeSeconds: 0, dbWriteLatencySeconds: 0, lag: -1,
    };
    return {
      tick: async () => 0,
      backfill: async () => backfillStatus!,
      reconcile: async () => 0,
      start: () => {},
      stop: () => {},
      shutdown: async () => {},
      getHealth: () => ({ ...health }),
      getMetrics: () => ({ ...metrics }),
      getBackfillStatus: () => backfillStatus,
    };
  }

  beforeEach(async () => {
    // Use a real (SQLite) db if available, otherwise a minimal stub.
    if (sqliteAvailable) {
      const { createSqliteDb } = require("./db") as DbModule;
      tmpFile = path.join(os.tmpdir(), `bf-api-${Date.now()}-${Math.random()}.db`);
      db = createSqliteDb(makeConfig({ sqlitePath: tmpFile }));
      await db.migrate();
    } else {
      // Minimal in-memory stub for DB — only methods used by buildApp matter.
      db = {
        migrate: async () => {},
        getLastLedger: async () => 0,
        setLastLedger: async () => {},
        getBackfillLedger: async () => 0,
        getBackfillStartLedger: async () => 0,
        setBackfillStartLedger: async () => {},
        setBackfillLedger: async () => {},
        getBackfillCursor: async () => null,
        setBackfillCursor: async () => {},
        deleteClaimsAfter: async () => {},
        getMaxClaimLedger: async () => 0,
        upsertClaim: async () => {},
        revokeClaim: async () => {},
        claimsByWallet: async () => [],
        stats: async () => [],
        issuerStats: async () => ({
          issuer: "", total: 0, active: 0, revoked: 0,
          credential_types: [], first_seen: null,
        }),
        claimsByIssuer: async () => [],
        credentialEvents: async () => ({
          indexed: false, commitment: "", events: [],
          verificationCount: 0, recentVerifications: [],
        }),
        issuerAnalytics: async () => ({
          issuer: "", totalIssued: 0, activeCount: 0, revokedCount: 0,
          revocationRate: 0, totalVerificationAttempts: 0,
          successfulVerifications: 0, failedVerifications: 0,
          verificationSuccessRate: 0, verificationAttemptsOverTime: [],
          topVerifiers: [], events: [],
        }),
        recent: async () => ({ claims: [], nextCursor: null }),
        insertAppSubmission: async () => 1,
        listApprovedApps: async () => [],
        getAppSubmission: async () => undefined,
        updateSubmissionStatus: async () => {},
        close: async () => {},
      } as import("./db-types").Db;
    }
  });

  afterEach(async () => {
    await db?.close();
    if (tmpFile) {
      for (const s of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(tmpFile + s); } catch { /* ignore */ }
      }
    }
  });

  it("returns idle when no backfill has run", async () => {
    const app = buildApp(db, makeIngesterStub(null));
    const res = await request(app).get("/backfill/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "idle" });
  });

  it("returns running status while backfill is in progress", async () => {
    const running: BackfillProgress = {
      fromLedger: 1, toLedger: 1_000_000,
      currentLedger: 50_000, eventsProcessed: 120, pagesProcessed: 1,
      percent: 5,
      elapsedSeconds: 10.0, ledgersPerSecond: 5000.0, etaSeconds: 190,
      running: true,
    };
    const app = buildApp(db, makeIngesterStub(running));
    const res = await request(app).get("/backfill/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.progress.percent).toBe(5);
    expect(res.body.progress.etaSeconds).toBe(190);
    expect(res.body.progress.running).toBe(true);
  });

  it("returns complete status when backfill has finished", async () => {
    const done: BackfillProgress = {
      fromLedger: 100, toLedger: 200,
      currentLedger: 200, eventsProcessed: 42, pagesProcessed: 2,
      percent: 100,
      elapsedSeconds: 3.2, ledgersPerSecond: 31.25, etaSeconds: null,
      running: false,
    };
    const app = buildApp(db, makeIngesterStub(done));
    const res = await request(app).get("/backfill/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("complete");
    expect(res.body.progress.eventsProcessed).toBe(42);
    expect(res.body.progress.running).toBe(false);
  });
});

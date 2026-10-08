/**
 * api.test.ts — Unit tests for the HTTP API layer.
 *
 * Uses an in-memory SQLite database (via the real db adapter) so tests are
 * fully self-contained and require no network access.
 */

import request from "supertest";
import type { Application } from "express";
import { buildApp, serializeClaim } from "./api";
import { createSqliteDb } from "./db";
import type { Db, ClaimRow } from "./db";
import { createIntegrityChecker, MISMATCH_KINDS } from "./integrity";
import type { ChainClaimState, ContractReader } from "./integrity";
import type { Config } from "./config";
import type { Ingester, IngesterHealth, IngesterMetrics } from "./ingester";
import { Keypair } from "@stellar/stellar-sdk";

import os from "os";
import path from "path";
import fs from "fs";

let db: Db;
let app: Application;
let tmpFile: string;

/** Minimal ingester stub that exposes a controllable health snapshot. */
function makeIngester(overrides?: Partial<IngesterHealth>): Ingester {
  const health: IngesterHealth = {
    lastSuccessLedger: 0,
    headLedger: 0,
    lag: -1,
    lastError: null,
    lastErrorTime: null,
    consecutiveErrors: 0,
    fetchAttempts: 0,
    fetchFailures: 0,
    ...overrides,
  };
  const metrics: IngesterMetrics = {
    eventsProcessedTotal: 0,
    fetchErrorsTotal: 0,
    uptimeSeconds: 0,
    dbWriteLatencySeconds: 0,
    lag: -1,
    ...overrides,
  };
  return {
    tick: async () => 0,
    reconcile: async () => 0,
    start: () => {},
    stop: () => {},
    shutdown: async () => {},
    getHealth: () => ({ ...health }),
    getMetrics: () => ({ ...metrics }),
  };
}

function makeConfig(sqlitePath: string): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath,
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 6,
    corsOrigins: ["http://localhost:3000"],
    rateLimitWindowMs: 60000,
    rateLimitMax: 120,
    rateLimitEnabled: true,
    integrityCheckEnabled: false,
    integrityCheckIntervalMs: 900_000,
    integrityCheckSampleSize: 25,
  };
}

beforeEach(async () => {
  // Use a unique temp file per test so each test gets a fresh DB
  tmpFile = path.join(os.tmpdir(), `indexer-test-${Date.now() + "-" + Math.random()}-${Math.random()}.db`);
  db = createSqliteDb(makeConfig(tmpFile));
  await db.migrate();
  app = buildApp(db, makeIngester());
});

afterEach(async () => {
  await db.close();
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpFile + "-wal"); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpFile + "-shm"); } catch { /* ignore */ }
});

// ── /health ─────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with status ok and lastLedger 0 on empty db", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      lastLedger: 0,
      headLedger: 0,
      lag: -1,
      consecutiveErrors: 0,
      lastError: null,
    });
  });

  it("reports degraded when consecutiveErrors is 1-2", async () => {
    app = buildApp(db, makeIngester({ consecutiveErrors: 2, lastError: "timeout" }));
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.consecutiveErrors).toBe(2);
    expect(res.body.lastError).toBe("timeout");
  });

  it("reports error when consecutiveErrors >= 3", async () => {
    app = buildApp(db, makeIngester({ consecutiveErrors: 5, lag: 120 }));
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(res.body.lag).toBe(120);
  });
});

// ── /claims ──────────────────────────────────────────────────────────────────

describe("GET /claims", () => {
  it("returns 400 when wallet param is missing", async () => {
    const res = await request(app).get("/claims");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/wallet/i);
  });

  it("returns empty claims array for unknown wallet", async () => {
    const res = await request(app).get("/claims?wallet=GUNKNOWN");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ wallet: "GUNKNOWN", claims: [] });
  });

  it("returns inserted claim for known wallet", async () => {
    await (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 42,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });

    const res = await request(app).get("/claims?wallet=GALICE");
    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(1);
    expect(res.body.claims[0]).toMatchObject({
      wallet: "GALICE",
      credential_type: "kyc",
      revoked: 0,
    });
  });
});

// ── /stats ────────────────────────────────────────────────────────────────────

describe("GET /stats", () => {
  it("returns empty stats array on empty db", async () => {
    const res = await request(app).get("/stats");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stats: [] });
  });

  it("aggregates counts per credential_type", async () => {
    const base = {
      issuer: "GISSUER",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 1,
      threshold: null,
      revoked: 0,
    };
    await (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      ...base, wallet: "GA1", credential_type: "kyc", reason_code: "other",
    });
    await (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      ...base, wallet: "GA2", credential_type: "kyc", reason_code: "other",
    });
    await (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      ...base, wallet: "GA3", credential_type: "age", reason_code: "other",
    });

    const res = await request(app).get("/stats");
    expect(res.status).toBe(200);
    const kycRow = res.body.stats.find(
      (r: { credential_type: string }) => r.credential_type === "kyc"
    );
    expect(kycRow).toMatchObject({ total: 2, active: 2, revoked: 0 });
  });
});

// ── /recent ───────────────────────────────────────────────────────────────────
// /recent uses keyset (cursor) pagination ordered by (ledger_sequence DESC,
// id DESC): the response carries an opaque nextCursor that must be echoed back
// as ?cursor= for the next page. These tests pin the stability guarantees that
// OFFSET pagination could not provide — no duplicates, no skipped rows, even
// when claims are ingested between page requests.

describe("GET /recent", () => {
  const base = {
    issuer: "GISSUER",
    credential_type: "kyc",
    expiry: 9999999,
    threshold: null,
    revoked: 0,
  };

  async function seed(
    rows: Array<{ wallet: string; verified_at: number; ledger_sequence: number }>
  ) {
    const dbc = db as ReturnType<typeof createSqliteDb>;
    for (const r of rows) {
      await dbc.upsertClaim({ ...base, ...r, reason_code: "other" });
    }
  }

  it("returns an empty page with nextCursor null when db is empty", async () => {
    const res = await request(app).get("/recent");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claims: [], limit: 20, nextCursor: null });
  });

  it("excludes revoked claims", async () => {
    await seed([
      { wallet: "GA1", verified_at: 1000, ledger_sequence: 1 },
      { wallet: "GA2", verified_at: 1000, ledger_sequence: 1 },
    ]);
    await (db as ReturnType<typeof createSqliteDb>).revokeClaim("GA1", "kyc");

    const res = await request(app).get("/recent");
    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(1);
    expect(res.body.claims[0].wallet).toBe("GA2");
  });

  it("clamps limit to MAX_LIMIT and falls back to the default for invalid values", async () => {
    const clamped = await request(app).get("/recent?limit=9999");
    expect(clamped.status).toBe(200);
    expect(clamped.body.limit).toBe(100);

    const invalid = await request(app).get("/recent?limit=abc");
    expect(invalid.status).toBe(200);
    expect(invalid.body.limit).toBe(20);
  });

  it("paginates by cursor: every claim exactly once, newest first", async () => {
    await seed([
      { wallet: "GA1", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA2", verified_at: 2000, ledger_sequence: 20 },
      { wallet: "GA3", verified_at: 3000, ledger_sequence: 30 },
      { wallet: "GA4", verified_at: 4000, ledger_sequence: 40 },
      { wallet: "GA5", verified_at: 5000, ledger_sequence: 50 },
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (pages < 10) {
      const res = await request(app).get(
        cursor ? `/recent?limit=2&cursor=${encodeURIComponent(cursor)}` : "/recent?limit=2"
      );
      expect(res.status).toBe(200);
      expect(res.body.claims.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.claims.map((c: { wallet: string }) => c.wallet));
      cursor = res.body.nextCursor as string | null;
      pages++;
      if (cursor === null) break;
    }

    expect(seen).toEqual(["GA5", "GA4", "GA3", "GA2", "GA1"]);
  });

  it("stays stable when claims are inserted between page requests", async () => {
    await seed([
      { wallet: "GA1", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA2", verified_at: 2000, ledger_sequence: 20 },
      { wallet: "GA3", verified_at: 3000, ledger_sequence: 30 },
    ]);

    const page1 = await request(app).get("/recent?limit=2");
    expect(page1.body.claims.map((c: { wallet: string }) => c.wallet)).toEqual([
      "GA3",
      "GA2",
    ]);

    // A newer claim arrives mid-pagination (belongs on a fresh page 1)…
    await seed([{ wallet: "GANEW", verified_at: 6000, ledger_sequence: 60 }]);
    // …and an older one arrives too (belongs after everything already seen).
    await seed([{ wallet: "GA0", verified_at: 500, ledger_sequence: 5 }]);

    const page2 = await request(app).get(
      `/recent?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`
    );
    // The already-fetched window is untouched: no duplicates, no skipped rows.
    expect(page2.body.claims.map((c: { wallet: string }) => c.wallet)).toEqual([
      "GA1",
      "GA0",
    ]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("uses the id tiebreaker to page through claims that share a ledger", async () => {
    await seed([
      { wallet: "GA1", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA2", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA3", verified_at: 1000, ledger_sequence: 10 },
      { wallet: "GA4", verified_at: 1000, ledger_sequence: 10 },
    ]);

    const page1 = await request(app).get("/recent?limit=2");
    expect(page1.body.claims).toHaveLength(2);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await request(app).get(
      `/recent?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`
    );
    expect(page2.body.claims).toHaveLength(2);
    expect(page2.body.nextCursor).toBeNull();

    const wallets = [...page1.body.claims, ...page2.body.claims].map(
      (c: { wallet: string }) => c.wallet
    );
    expect(new Set(wallets).size).toBe(4);
    expect(wallets.sort()).toEqual(["GA1", "GA2", "GA3", "GA4"]);
  });

  it("rejects a malformed cursor with 400", async () => {
    const res = await request(app).get("/recent?cursor=not-a-real-cursor");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid cursor");
  });
});

// ── /issuers/:issuer/stats ───────────────────────────────────────────────────
// Reputation stats for one issuer, derived entirely from indexed events (#398).

describe("GET /issuers/:issuer/stats", () => {
  it("returns a zeroed row for an issuer with no indexed claims", async () => {
    const res = await request(app).get("/issuers/GUNKNOWN/stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issuer: "GUNKNOWN",
      total: 0,
      active: 0,
      revoked: 0,
      credential_types: [],
      first_seen: null,
    });
  });

  it("aggregates total/active/revoked, credential types, and first_seen across an issuer's claims", async () => {
    const dbc = db as ReturnType<typeof createSqliteDb>;
    await dbc.upsertClaim({
      wallet: "GA1",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 2000,
      expiry: 9999999,
      ledger_sequence: 1,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });
    await dbc.upsertClaim({
      wallet: "GA2",
      credential_type: "age",
      issuer: "GISSUER",
      verified_at: 1000, // earlier than GA1's claim — should win as first_seen
      expiry: 9999999,
      ledger_sequence: 2,
      threshold: 21,
      revoked: 0,
      reason_code: "other",
    });
    await dbc.upsertClaim({
      wallet: "GA3",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 3000,
      expiry: 9999999,
      ledger_sequence: 3,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });
    await dbc.revokeClaim("GA3", "kyc");

    const res = await request(app).get("/issuers/GISSUER/stats");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe("GISSUER");
    expect(res.body.total).toBe(3);
    expect(res.body.active).toBe(2);
    expect(res.body.revoked).toBe(1);
    expect(res.body.credential_types.sort()).toEqual(["age", "kyc"]);
    expect(res.body.first_seen).toBe(1000);
  });

  it("does not mix up claims from a different issuer", async () => {
    const dbc = db as ReturnType<typeof createSqliteDb>;
    await dbc.upsertClaim({
      wallet: "GA1",
      credential_type: "kyc",
      issuer: "GISSUER_A",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 1,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });
    await dbc.upsertClaim({
      wallet: "GA2",
      credential_type: "kyc",
      issuer: "GISSUER_B",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 2,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });

    const res = await request(app).get("/issuers/GISSUER_A/stats");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it("returns 400 for an empty issuer path parameter", async () => {
    const res = await request(app).get("/issuers/%20/stats");
    expect(res.status).toBe(400);
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────

describe("unknown routes", () => {
  it("returns 404 for unknown path", async () => {
    const res = await request(app).get("/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ── CORS & Rate Limiting Integration ─────────────────────────────────────────

describe("CORS & Rate Limiting integration in API", () => {
  it("emits CORS headers for allowed origin and handles preflight", async () => {
    const customConfig = {
      ...makeConfig(tmpFile),
      corsOrigins: ["https://app.stellarcred.xyz"],
    };
    const customApp = buildApp(db, makeIngester(), customConfig);

    // GET request from allowed origin
    const getRes = await request(customApp)
      .get("/health")
      .set("Origin", "https://app.stellarcred.xyz");
    expect(getRes.status).toBe(200);
    expect(getRes.headers["access-control-allow-origin"]).toBe(
      "https://app.stellarcred.xyz"
    );

    // OPTIONS preflight request
    const optRes = await request(customApp)
      .options("/claims")
      .set("Origin", "https://app.stellarcred.xyz")
      .set("Access-Control-Request-Method", "GET");
    expect(optRes.status).toBe(204);
    expect(optRes.headers["access-control-allow-origin"]).toBe(
      "https://app.stellarcred.xyz"
    );
  });

  it("does not emit CORS headers for untrusted origins", async () => {
    const customConfig = {
      ...makeConfig(tmpFile),
      corsOrigins: ["https://app.stellarcred.xyz"],
    };
    const customApp = buildApp(db, makeIngester(), customConfig);

    const res = await request(customApp)
      .get("/stats")
      .set("Origin", "https://evil.site");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("enforces rate limits and returns 429 + Retry-After when exceeded", async () => {
    const customConfig = {
      ...makeConfig(tmpFile),
      rateLimitMax: 3,
      rateLimitWindowMs: 60000,
      rateLimitEnabled: true,
    };
    const customApp = buildApp(db, makeIngester(), customConfig);

    // 3 allowed requests
    for (let i = 1; i <= 3; i++) {
      const res = await request(customApp)
        .get("/stats")
        .set("X-Forwarded-For", "203.0.113.50");
      expect(res.status).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBe("3");
      expect(res.headers["ratelimit-remaining"]).toBe(String(3 - i));
    }

    // 4th request -> 429
    const throttled = await request(customApp)
      .get("/stats")
      .set("X-Forwarded-For", "203.0.113.50");
    expect(throttled.status).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
    expect(throttled.body).toMatchObject({
      error: "too many requests",
      retryAfter: expect.any(Number),
    });

    // Another IP is not throttled
    const otherIpRes = await request(customApp)
      .get("/stats")
      .set("X-Forwarded-For", "203.0.113.99");
    expect(otherIpRes.status).toBe(200);
  });
});

// ── Response schema (#349) ───────────────────────────────────────────────────
// Pins the wire shape /claims and /recent claims are serialized to, and
// specifically covers the cross-backend quirk that motivated it: `pg` parses
// Postgres BIGINT columns as strings, while better-sqlite3 hands back plain
// numbers for the same columns. serializeClaim is the one place that gets
// normalized, so it's tested directly against a string-typed row (simulating
// what the Postgres adapter's `pg.Pool` actually returns) rather than only
// through the SQLite-backed integration tests below, which would never
// exercise the string case at all.

describe("claim response schema", () => {
  it("normalizes a Postgres-shaped row (BIGINT columns as strings) to numbers", () => {
    // Mirrors exactly what `pg` hands back for BIGINT/BIGSERIAL columns —
    // not what ClaimRow's TypeScript type declares, which is the point.
    const pgShapedRow = {
      id: "7",
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: "1700000000",
      expiry: "1999999999",
      ledger_sequence: "123456789",
      threshold: "50000",
      reason_code: "other",
      revoked: 0,
    } as unknown as ClaimRow;

    const serialized = serializeClaim(pgShapedRow);

    expect(serialized).toEqual({
      id: 7,
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1700000000,
      expiry: 1999999999,
      ledger_sequence: 123456789,
      reason_code: "other",
      threshold: 50000,
      revoked: 0,
      expired: false,
      state: "active",
    });
    for (const field of [
      "id",
      "verified_at",
      "expiry",
      "ledger_sequence",
      "threshold",
      "revoked",
    ] as const) {
      expect(typeof serialized[field]).toBe("number");
    }
  });

  it("passes a null threshold through as null, not 0 or NaN", () => {
    const row = {
      id: "1",
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: "1000",
      expiry: "9999999",
      ledger_sequence: "1",
      threshold: null,
      revoked: 0,
    } as unknown as ClaimRow;

    expect(serializeClaim(row).threshold).toBeNull();
  });

  it("produces identical output whether the row's numeric fields arrive as strings or numbers", () => {
    const numeric: ClaimRow = {
      id: 7,
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1700000000,
      expiry: 1999999999,
      ledger_sequence: 123456789,
      reason_code: "other",
      threshold: 50000,
      revoked: 0,
    };
    const stringified = {
      ...numeric,
      id: String(numeric.id),
      verified_at: String(numeric.verified_at),
      expiry: String(numeric.expiry),
      ledger_sequence: String(numeric.ledger_sequence),
      threshold: String(numeric.threshold),
    } as unknown as ClaimRow;

    expect(serializeClaim(stringified)).toEqual(serializeClaim(numeric));
  });

  it("GET /claims and GET /recent both return the exact documented key set — no leaked internal columns", async () => {
    await (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 42,
      threshold: 500,
      revoked: 0,
      reason_code: "other",
    });

    const expectedKeys = [
      "id",
      "wallet",
      "credential_type",
      "issuer",
      "verified_at",
      "expiry",
      "ledger_sequence",
      "reason_code",
      
      "threshold",
      "revoked",
      // Derived, not event-sourced (#612) — see the api.ts module doc comment.
      "expired",
      "state",
    ].sort();

    const claimsRes = await request(app).get("/claims?wallet=GALICE");
    expect(claimsRes.status).toBe(200);
    expect(claimsRes.body.claims).toHaveLength(1);
    expect(Object.keys(claimsRes.body.claims[0]).sort()).toEqual(expectedKeys);
    for (const field of ["id", "verified_at", "expiry", "ledger_sequence", "revoked"]) {
      expect(typeof claimsRes.body.claims[0][field]).toBe("number");
    }

    const recentRes = await request(app).get("/recent");
    expect(recentRes.status).toBe(200);
    expect(recentRes.body.claims).toHaveLength(1);
    expect(Object.keys(recentRes.body.claims[0]).sort()).toEqual(expectedKeys);
  });

  it("GET /issuers/:issuer/credentials returns credentials issued by the given issuer", async () => {
    await (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER_REVOKE",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 42,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });

    const res = await request(app).get("/issuers/GISSUER_REVOKE/credentials");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe("GISSUER_REVOKE");
    expect(res.body.credentials).toHaveLength(1);
    expect(res.body.credentials[0].wallet).toBe("GALICE");
  });

  it("GET /issuers/:issuer/analytics returns aggregated analytics", async () => {
    await (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      wallet: "GBOB",
      credential_type: "income",
      issuer: "GISSUER_ANALYTICS",
      verified_at: 1000,
      expiry: 1999999999,
      ledger_sequence: 50,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });

    const res = await request(app).get("/issuers/GISSUER_ANALYTICS/analytics");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe("GISSUER_ANALYTICS");
    expect(res.body.totalIssued).toBe(1);
    expect(res.body.activeCount).toBe(1);
    expect(res.body.verificationAttemptsOverTime.length).toBeGreaterThan(0);
  });

  it("GET /credentials/:commitment/events returns history for indexed credential", async () => {
    await (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      wallet: "GCHARLIE",
      credential_type: "kyc",
      issuer: "GISSUER_COMM",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 60,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });

    const res = await request(app).get("/credentials/0x123abc/events?wallet=GCHARLIE&type=kyc");
    expect(res.status).toBe(200);
    expect(res.body.indexed).toBe(true);
    expect(res.body.wallet).toBe("GCHARLIE");
    expect(res.body.events.length).toBeGreaterThanOrEqual(2);
  });
});

describe("on-chain data integrity (#612)", () => {
  const WALLET = Keypair.random().publicKey();
  const NOW = Math.floor(Date.now() / 1000);

  /** A checker whose contract reads come from a fixed table, never the network. */
  function buildIntegrityApp(
    chain: Record<string, ChainClaimState | null>,
    opts: { apiKey?: string; failFor?: Set<string> } = {}
  ): { app: Application; checker: ReturnType<typeof createIntegrityChecker> } {
    const reader: ContractReader = {
      async readProofRecord({ wallet, credentialType }) {
        const key = `${wallet}/${credentialType}`;
        if (opts.failFor?.has(key)) throw new Error("simulated RPC failure");
        return chain[key] ?? null;
      },
    };
    const checker = createIntegrityChecker(
      makeConfig(tmpFile),
      db,
      { reader, clock: { now: async () => NOW } },
    );
    const app = buildApp(db, makeIngester(), { apiKey: opts.apiKey }, checker);
    return { app, checker };
  }

  async function seedClaim(overrides: Partial<ClaimRow> = {}) {
    await (db as ReturnType<typeof createSqliteDb>).upsertClaim({
      reason_code: "other",
      wallet: WALLET,
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: NOW - 1000,
      expiry: NOW + 1000,
      ledger_sequence: 500,
      threshold: null,
      revoked: 0,
      ...overrides,
    });
  }

  const onChain: ChainClaimState = {
    revoked: false,
    expiry: 0, // filled per-test where it matters
    verifiedAt: 0,
    threshold: null,
    issuer: "GISSUER",
  };

  it("exposes the mismatch count as an alerting metric", async () => {
    await seedClaim();
    // The chain revoked it; the indexer never saw the event.
    const { app: integrityApp } = buildIntegrityApp({
      [`${WALLET}/kyc`]: { ...onChain, revoked: true, expiry: NOW + 1000, verifiedAt: NOW - 1000 },
    });
    await request(integrityApp).post("/integrity/check").expect(200);

    const res = await request(integrityApp).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("# TYPE indexer_state_mismatches gauge");
    expect(res.text).toMatch(/^indexer_state_mismatches 1$/m);
    expect(res.text).toMatch(
      /^indexer_state_mismatches_by_kind\{kind="revoked_on_chain"\} 1$/m,
    );
    expect(res.text).toMatch(/^indexer_state_checked 1$/m);
  });

  it("publishes every mismatch kind as a labelled series", async () => {
    // No indexed claims, so every per-kind counter is present and flat — the
    // series must exist from startup so an alert rule never goes missing.
    const { app: integrityApp } = buildIntegrityApp({});
    await request(integrityApp).post("/integrity/check").expect(200);
    const res = await request(integrityApp).get("/metrics");
    for (const kind of MISMATCH_KINDS) {
      expect(res.text).toContain(
        `indexer_state_mismatches_by_kind{kind="${kind}"} 0`,
      );
    }
  });

  it("keeps an RPC failure out of the mismatch count", async () => {
    await seedClaim();
    const { app: integrityApp } = buildIntegrityApp({}, {
      failFor: new Set([`${WALLET}/kyc`]),
    });
    const check = await request(integrityApp).post("/integrity/check");
    expect(check.body.unreadable).toBe(1);
    expect(check.body.mismatchCount).toBe(0);
    expect(check.body.complete).toBe(false);

    const metrics = await request(integrityApp).get("/metrics");
    expect(metrics.text).toMatch(/^indexer_state_mismatches 0$/m);
    expect(metrics.text).toMatch(/^indexer_state_check_errors 1$/m);
    expect(metrics.text).toMatch(/^indexer_state_last_success_timestamp_seconds 0$/m);
  });

  it("reports the last run's mismatches on GET /integrity/status", async () => {
    await seedClaim();
    const { app: integrityApp } = buildIntegrityApp({
      [`${WALLET}/kyc`]: { ...onChain, expiry: NOW + 1, verifiedAt: NOW - 1000 },
    });

    const before = await request(integrityApp).get("/integrity/status");
    expect(before.status).toBe(200);
    expect(before.body.lastRunTimestamp).toBeNull();
    expect(before.body.mismatchCount).toBe(0);

    await request(integrityApp).post("/integrity/check").expect(200);

    const after = await request(integrityApp).get("/integrity/status");
    expect(after.body.mismatchCount).toBe(1);
    expect(after.body.mismatches[0].wallet).toBe(WALLET);
    expect(after.body.mismatches[0].kinds).toEqual(["expiry_mismatch"]);
  });

  it("gates POST /integrity/check behind the API key when one is configured", async () => {
    await seedClaim();
    const { app: integrityApp } = buildIntegrityApp({}, { apiKey: "secret" });

    await request(integrityApp).post("/integrity/check").expect(401);
    const res = await request(integrityApp)
      .post("/integrity/check")
      .set("Authorization", "Bearer secret");
    expect(res.status).toBe(200);
  });

  it("rejects a non-positive sampleSize on the on-demand check", async () => {
    await seedClaim();
    const { app: integrityApp } = buildIntegrityApp({});
    await request(integrityApp)
      .post("/integrity/check?sampleSize=0")
      .expect(400);
    await request(integrityApp)
      .post("/integrity/check?sampleSize=abc")
      .expect(400);
  });

  it("404s the integrity endpoints when no checker is wired in", async () => {
    await request(app).get("/integrity/status").expect(404);
    await request(app).post("/integrity/check").expect(404);
  });

  it("returns derived expired/state fields on /claims", async () => {
    await seedClaim({ wallet: WALLET, credential_type: "kyc", expiry: NOW - 1 });
    const res = await request(app).get(`/claims?wallet=${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.claims[0].expired).toBe(true);
    expect(res.body.claims[0].state).toBe("expired");
    // `revoked` keeps its narrow meaning: only an on-chain revocation.
    expect(res.body.claims[0].revoked).toBe(0);
  });
});

describe("claim lifecycle webhook subscriptions", () => {
  const wallet = Keypair.random().publicKey();

  it("requires an API key and signing secret before exposing management", async () => {
    const res = await request(app)
      .post("/webhooks/subscriptions")
      .send({
        url: "https://protocol.example/events",
        wallet,
        claimType: "kyc",
      });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/API_KEY/);
  });

  it("registers an exact wallet/type filter, lists it, and removes it", async () => {
    app = buildApp(db, makeIngester(), {
      ...makeConfig(tmpFile),
      apiKey: "indexer-test-key",
      webhookSigningSecret: "w".repeat(32),
      rateLimitEnabled: false,
    });

    const headers = { Authorization: "Bearer indexer-test-key" };
    const subscription = {
      url: "https://protocol.example/events",
      wallet,
      claimType: "kyc",
    };
    const created = await request(app)
      .post("/webhooks/subscriptions")
      .set(headers)
      .send(subscription);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ wallet, claimType: "kyc" });

    const duplicate = await request(app)
      .post("/webhooks/subscriptions")
      .set(headers)
      .send(subscription);
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.id).toBe(created.body.id);

    const listed = await request(app)
      .get(`/webhooks/subscriptions?wallet=${wallet}`)
      .set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.subscriptions).toHaveLength(1);

    const removed = await request(app)
      .delete(`/webhooks/subscriptions/${created.body.id}`)
      .set(headers);
    expect(removed.status).toBe(204);
  });

  it("rejects insecure URLs and unknown claim types", async () => {
    app = buildApp(db, makeIngester(), {
      ...makeConfig(tmpFile),
      apiKey: "indexer-test-key",
      webhookSigningSecret: "w".repeat(32),
      rateLimitEnabled: false,
    });
    const headers = { Authorization: "Bearer indexer-test-key" };

    const insecure = await request(app)
      .post("/webhooks/subscriptions")
      .set(headers)
      .send({ url: "http://protocol.example/events", wallet, claimType: "kyc" });
    expect(insecure.status).toBe(400);

    const unknownClaim = await request(app)
      .post("/webhooks/subscriptions")
      .set(headers)
      .send({
        url: "https://protocol.example/events",
        wallet,
        claimType: "unknown",
      });
    expect(unknownClaim.status).toBe(400);
  });
});

describe("GraphQL endpoint", () => {
  let graphqlDb: Db;
  let graphqlApp: Application;
  let graphqlTmpFile: string;

  beforeEach(async () => {
    graphqlTmpFile = path.join(os.tmpdir(), `indexer-test-gql-${Date.now() + "-" + Math.random()}.db`);
    graphqlDb = createSqliteDb({ sqlitePath: graphqlTmpFile } as unknown as Config);
    graphqlDb.migrate();

    const wallet1 = Keypair.random().publicKey();
    const wallet2 = Keypair.random().publicKey();
    const issuer1 = Keypair.random().publicKey();
    const issuer2 = Keypair.random().publicKey();

    await graphqlDb.upsertClaim({
      wallet: wallet1,
      credential_type: "kyc",
      issuer: issuer1,
      verified_at: 1000,
      expiry: 2000,
      ledger_sequence: 100,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });
    await graphqlDb.upsertClaim({
      wallet: wallet1,
      credential_type: "age",
      issuer: issuer1,
      verified_at: 1100,
      expiry: 2100,
      ledger_sequence: 101,
      threshold: 18,
      revoked: 0,
      reason_code: "other",
    });
    await graphqlDb.upsertClaim({
      wallet: wallet2,
      credential_type: "kyc",
      issuer: issuer2,
      verified_at: 1200,
      expiry: 2200,
      ledger_sequence: 102,
      threshold: null,
      revoked: 1,
      reason_code: "fraud",
    });

    graphqlApp = buildApp(graphqlDb, makeIngester());
  });

  afterEach(async () => {
    await graphqlDb.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(graphqlTmpFile + suffix); } catch { /* ignore */ }
    }
  });

  it("returns all claims with no filter", async () => {
    const res = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims { edges { wallet credentialType revoked reasonCode } pageInfo { hasNextPage endCursor } } }`,
      });

    expect(res.status).toBe(200);
    const claims = res.body.data.claims.edges;
    expect(claims).toHaveLength(3);
  });

  it("filters by wallet", async () => {
    const wallet = Keypair.random().publicKey();
    await graphqlDb.upsertClaim({
      wallet,
      credential_type: "kyc",
      issuer: Keypair.random().publicKey(),
      verified_at: 1000,
      expiry: 2000,
      ledger_sequence: 100,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });

    const res = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(filter: { wallet: "${wallet}" }) { edges { wallet credentialType } } }`,
      });

    expect(res.status).toBe(200);
    const claims = res.body.data.claims.edges;
    expect(claims).toHaveLength(1);
    expect(claims[0].wallet).toBe(wallet);
  });

  it("filters by credential type", async () => {
    const res = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(filter: { credentialType: "kyc" }) { edges { credentialType } } }`,
      });

    expect(res.status).toBe(200);
    const claims = res.body.data.claims.edges;
    expect(claims).toHaveLength(2);
    claims.forEach((c: any) => expect(c.credentialType).toBe("kyc"));
  });

  it("filters by issuer", async () => {
    const issuer = Keypair.random().publicKey();
    await graphqlDb.upsertClaim({
      wallet: Keypair.random().publicKey(),
      credential_type: "kyc",
      issuer,
      verified_at: 1000,
      expiry: 2000,
      ledger_sequence: 100,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });

    const res = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(filter: { issuer: "${issuer}" }) { edges { issuer } } }`,
      });

    expect(res.status).toBe(200);
    const claims = res.body.data.claims.edges;
    expect(claims).toHaveLength(1);
    expect(claims[0].issuer).toBe(issuer);
  });

  it("filters by active status", async () => {
    const res = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(filter: { active: true }) { edges { revoked } } }`,
      });

    expect(res.status).toBe(200);
    const claims = res.body.data.claims.edges;
    expect(claims).toHaveLength(2);
    claims.forEach((c: any) => expect(c.revoked).toBe(false));
  });

  it("filters by revoked status", async () => {
    const res = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(filter: { revoked: true }) { edges { revoked reasonCode } } }`,
      });

    expect(res.status).toBe(200);
    const claims = res.body.data.claims.edges;
    expect(claims).toHaveLength(1);
    expect(claims[0].revoked).toBe(true);
    expect(claims[0].reasonCode).toBe("fraud");
  });

  it("filters by verifiedAfter", async () => {
    const res = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(filter: { verifiedAfter: 1100 }) { edges { verifiedAt } } }`,
      });

    expect(res.status).toBe(200);
    const claims = res.body.data.claims.edges;
    expect(claims).toHaveLength(2);
  });

  it("filters by verifiedBefore", async () => {
    const res = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(filter: { verifiedBefore: 1100 }) { edges { verifiedAt } } }`,
      });

    expect(res.status).toBe(200);
    const claims = res.body.data.claims.edges;
    expect(claims).toHaveLength(1);
  });

  it("paginates with cursor", async () => {
    const res1 = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(first: 2) { edges { id } pageInfo { hasNextPage endCursor } } }`,
      });

    expect(res1.status).toBe(200);
    expect(res1.body.data.claims.edges).toHaveLength(2);
    expect(res1.body.data.claims.pageInfo.hasNextPage).toBe(true);
    expect(res1.body.data.claims.pageInfo.endCursor).toBeTruthy();

    const res2 = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(first: 2, after: "${res1.body.data.claims.pageInfo.endCursor}") { edges { id } pageInfo { hasNextPage endCursor } } }`,
      });

    expect(res2.status).toBe(200);
    expect(res2.body.data.claims.edges).toHaveLength(1);
    expect(res2.body.data.claims.pageInfo.hasNextPage).toBe(false);
  });

  it("combines multiple filters", async () => {
    const res = await request(graphqlApp)
      .post("/graphql")
      .send({
        query: `{ claims(filter: { credentialType: "kyc", active: true }) { edges { credentialType revoked } } }`,
      });

    expect(res.status).toBe(200);
    const claims = res.body.data.claims.edges;
    expect(claims).toHaveLength(1);
    expect(claims[0].credentialType).toBe("kyc");
    expect(claims[0].revoked).toBe(false);
  });
});

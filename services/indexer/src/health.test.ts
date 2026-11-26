/**
 * health.test.ts — Unit tests for the indexer health payload builder.
 *
 * Pure functions, no DB or network: `db` and `ingester` are minimal stubs so
 * each status branch can be asserted deterministically.
 */

import {
  buildHealthResponse,
  buildUnavailableHealthResponse,
  resolveVersion,
  statusFromHealth,
  DEGRADED_ERROR_THRESHOLD,
  SERVICE_NAME,
} from "./health";
import type { IngesterHealth } from "./ingester";

function makeIngester(overrides?: Partial<IngesterHealth>) {
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
  return { getHealth: () => ({ ...health }) };
}

const db = { getLastLedger: () => 123 } as const;

describe("statusFromHealth", () => {
  it("is ok with no consecutive errors", () => {
    expect(statusFromHealth({ consecutiveErrors: 0 })).toBe("ok");
  });

  it("is degraded below the error threshold", () => {
    expect(statusFromHealth({ consecutiveErrors: 1 })).toBe("degraded");
    expect(statusFromHealth({ consecutiveErrors: DEGRADED_ERROR_THRESHOLD - 1 })).toBe(
      "degraded",
    );
  });

  it("is error at or above the threshold", () => {
    expect(statusFromHealth({ consecutiveErrors: DEGRADED_ERROR_THRESHOLD })).toBe("error");
    expect(statusFromHealth({ consecutiveErrors: 10 })).toBe("error");
  });
});

describe("resolveVersion", () => {
  const original = process.env["npm_package_version"];
  const originalOverride = process.env["INDEXER_VERSION"];

  afterEach(() => {
    if (original === undefined) delete process.env["npm_package_version"];
    else process.env["npm_package_version"] = original;
    if (originalOverride === undefined) delete process.env["INDEXER_VERSION"];
    else process.env["INDEXER_VERSION"] = originalOverride;
  });

  it("prefers the explicit INDEXER_VERSION override", () => {
    process.env["INDEXER_VERSION"] = "2.0.0";
    process.env["npm_package_version"] = "1.2.3";
    expect(resolveVersion()).toBe("2.0.0");
  });

  it("returns npm_package_version when set", () => {
    delete process.env["INDEXER_VERSION"];
    process.env["npm_package_version"] = "1.2.3";
    expect(resolveVersion()).toBe("1.2.3");
  });

  it("falls back to dev when unset", () => {
    delete process.env["INDEXER_VERSION"];
    delete process.env["npm_package_version"];
    expect(resolveVersion()).toBe("dev");
  });

  it("ignores a blank override", () => {
    process.env["INDEXER_VERSION"] = "   ";
    process.env["npm_package_version"] = "1.2.3";
    expect(resolveVersion()).toBe("1.2.3");
  });
});

describe("buildHealthResponse", () => {
  const originalVersion = process.env["npm_package_version"];
  const originalOverride = process.env["INDEXER_VERSION"];

  beforeEach(() => {
    // The payload assertions below expect the "dev" fallback, so the explicit
    // deployment override must not leak in from the ambient environment.
    delete process.env["INDEXER_VERSION"];
  });

  afterEach(() => {
    if (originalVersion === undefined) delete process.env["npm_package_version"];
    else process.env["npm_package_version"] = originalVersion;
    if (originalOverride === undefined) delete process.env["INDEXER_VERSION"];
    else process.env["INDEXER_VERSION"] = originalOverride;
  });

  it("reports ok, ready, service and version metadata", async () => {
    delete process.env["npm_package_version"];
    const payload = await buildHealthResponse(db, makeIngester() as never, {
      now: 1000,
      uptimeSeconds: 5,
    });

    expect(payload).toMatchObject({
      status: "ok",
      ready: true,
      service: SERVICE_NAME,
      version: "dev",
      timestamp: 1000,
      uptimeSeconds: 5,
      lastLedger: 123,
      headLedger: 0,
      lag: -1,
      consecutiveErrors: 0,
      lastError: null,
    });
  });

  it("is degraded but still ready with a few consecutive errors", async () => {
    const payload = await buildHealthResponse(
      db,
      makeIngester({ consecutiveErrors: 2, lastError: "timeout" }) as never,
    );

    expect(payload.status).toBe("degraded");
    expect(payload.ready).toBe(true);
    expect(payload.lastError).toBe("timeout");
  });

  it("is error and not ready at the threshold", async () => {
    const payload = await buildHealthResponse(
      db,
      makeIngester({ consecutiveErrors: DEGRADED_ERROR_THRESHOLD, lag: 120 }) as never,
    );

    expect(payload.status).toBe("error");
    expect(payload.ready).toBe(false);
    expect(payload.lag).toBe(120);
  });

  it("propagates a database error instead of reporting healthy", async () => {
    const failingDb = {
      getLastLedger: () => {
        throw new Error("db down");
      },
    };
    await expect(buildHealthResponse(failingDb as never, makeIngester() as never)).rejects.toThrow(
      "db down",
    );
  });
});

describe("buildUnavailableHealthResponse", () => {
  const originalVersion = process.env["npm_package_version"];
  const originalOverride = process.env["INDEXER_VERSION"];

  beforeEach(() => {
    delete process.env["INDEXER_VERSION"];
  });

  afterEach(() => {
    if (originalVersion === undefined) delete process.env["npm_package_version"];
    else process.env["npm_package_version"] = originalVersion;
    if (originalOverride === undefined) delete process.env["INDEXER_VERSION"];
    else process.env["INDEXER_VERSION"] = originalOverride;
  });

  it("reports error, not ready, and carries the failure message", () => {
    delete process.env["npm_package_version"];
    const payload = buildUnavailableHealthResponse(makeIngester() as never, new Error("db down"), {
      now: 1000,
      uptimeSeconds: 5,
    });

    expect(payload).toMatchObject({
      status: "error",
      ready: false,
      service: SERVICE_NAME,
      version: "dev",
      timestamp: 1000,
      uptimeSeconds: 5,
      lastLedger: 0,
      error: "db down",
    });
  });

  it("keeps the ingester counters so operators can see the wider picture", () => {
    const payload = buildUnavailableHealthResponse(
      makeIngester({ headLedger: 900, lag: 42, consecutiveErrors: 4, lastError: "timeout" }) as never,
      "boom",
    );

    expect(payload.headLedger).toBe(900);
    expect(payload.lag).toBe(42);
    expect(payload.consecutiveErrors).toBe(4);
    expect(payload.lastError).toBe("timeout");
  });

  it("stringifies a non-Error failure", () => {
    const payload = buildUnavailableHealthResponse(makeIngester() as never, "plain string");

    expect(payload.error).toBe("plain string");
  });

  it("marks status degraded and ready true when lag exceeds warning threshold", () => {
    const body = buildHealthResponse(10, { ...base, lag: 35 });
    expect(body.status).toBe("degraded");
    expect(body.ready).toBe(true);
    expect(body.lag).toBe(35);
  });

  it("marks status error and ready false when lag exceeds max threshold even with 0 errors", () => {
    const body = buildHealthResponse(10, { ...base, consecutiveErrors: 0, lag: 150 });
    expect(body.status).toBe("error");
    expect(body.ready).toBe(false);
    expect(body.lag).toBe(150);
  });

  it("uses custom thresholds when provided via options object", () => {
    const body = buildHealthResponse(10, { ...base, lag: 20 }, {
      thresholds: { warnLedgerLag: 15, maxLedgerLag: 40 },
    });
    expect(body.status).toBe("degraded");
    expect(body.ready).toBe(true);
    expect(body.warnLedgerLag).toBe(15);
    expect(body.maxLedgerLag).toBe(40);
  });

  it("contains zero credential-level or identity fields in diagnostic payload", () => {
    const body = buildHealthResponse(10, base);
    const keys = Object.keys(body);
    const forbiddenPatterns = [/wallet/i, /claim/i, /credential/i, /proof/i, /secret/i, /token/i, /key/i];
    for (const pattern of forbiddenPatterns) {
      for (const key of keys) {
        expect(key).not.toMatch(pattern);
      }
    }
  });
});

describe("checkDatabase", () => {
  it("returns ok with latency and lastLedger when probe succeeds", async () => {
    const result = await checkDatabase(async () => 42);
    expect(result.status).toBe("ok");
    expect(result.lastLedger).toBe(42);
    expect(result.error).toBeNull();
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("captures Error failures without throwing", async () => {
    const result = await checkDatabase(async () => {
      throw new Error("connection refused");
    });
    expect(result.status).toBe("error");
    expect(result.lastLedger).toBeNull();
    expect(result.error).toBe("connection refused");
  });

  it("captures non-Error throwables", async () => {
    const result = await checkDatabase(async () => {
      throw "socket closed";
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("socket closed");
  });
});

describe("evaluateHorizonHealth", () => {
  it("reports ok and synced when lag is within MAX_READY_LEDGER_LAG (0..5)", () => {
    expect(MAX_READY_LEDGER_LAG).toBe(5);
    expect(evaluateHorizonHealth({ ...base, lag: 0 })).toMatchObject({
      status: "ok",
      synced: true,
      lag: 0,
      maxLag: 5,
    });
    expect(evaluateHorizonHealth({ ...base, lag: 5 })).toMatchObject({
      status: "ok",
      synced: true,
      lag: 5,
    });
  });

  it("reports error when lag exceeds MAX_READY_LEDGER_LAG", () => {
    const res = evaluateHorizonHealth({ ...base, lag: 6 });
    expect(res.status).toBe("error");
    expect(res.synced).toBe(false);
    expect(res.lastError).toContain("exceeds maximum allowed");
  });

  it("reports error when head ledger is not yet synced (lag === -1)", () => {
    const res = evaluateHorizonHealth({ ...base, lag: -1, headLedger: 0 });
    expect(res.status).toBe("error");
    expect(res.synced).toBe(false);
    expect(res.lastError).toContain("not yet synced");
  });

  it("reports degraded when synced with 1-2 consecutive errors", () => {
    const res = evaluateHorizonHealth({ ...base, lag: 2, consecutiveErrors: 2, lastError: "transient" });
    expect(res.status).toBe("degraded");
    expect(res.synced).toBe(true);
    expect(res.lastError).toBe("transient");
  });

  it("reports error when consecutiveErrors >= 3 even if lag <= 5", () => {
    const res = evaluateHorizonHealth({ ...base, lag: 1, consecutiveErrors: 3, lastError: "rpc down" });
    expect(res.status).toBe("error");
    expect(res.synced).toBe(true);
    expect(res.lastError).toBe("rpc down");
  });
});

describe("buildLivenessResponse / buildReadinessResponse / buildHealthzResponse", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("buildLivenessResponse always returns alive: true and status: ok", () => {
    expect(buildLivenessResponse(now)).toMatchObject({
      status: "ok",
      alive: true,
      service: SERVICE_NAME,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });

  it("buildReadinessResponse is ready only when both DB and Horizon are healthy", () => {
    const dbOk = { status: "ok" as const, latencyMs: 1, lastLedger: 10, error: null };
    const dbErr = { status: "error" as const, latencyMs: 2, lastLedger: null, error: "db down" };

    expect(buildReadinessResponse(dbOk, base, now)).toMatchObject({
      status: "ok",
      ready: true,
    });
    expect(buildReadinessResponse(dbErr, base, now)).toMatchObject({
      status: "error",
      ready: false,
    });
    expect(buildReadinessResponse(dbOk, { ...base, lag: 6 }, now)).toMatchObject({
      status: "error",
      ready: false,
    });
  });

  it("buildHealthzResponse combines liveness, readiness checks, and ingester telemetry", () => {
    const dbOk = { status: "ok" as const, latencyMs: 1, lastLedger: 10, error: null };
    const body = buildHealthzResponse(dbOk, base, now);
    expect(body).toMatchObject({
      status: "ok",
      alive: true,
      ready: true,
      lastLedger: 10,
      headLedger: 12,
      lag: 2,
      checks: {
        database: { status: "ok", lastLedger: 10 },
        horizon: { status: "ok", synced: true, lag: 2, maxLag: 5 },
      },
    });
  });
});

describe("HTTP probe endpoints (/livez, /readyz, /healthz)", () => {
  function makeMockIngester(overrides?: Partial<IngesterHealth>): Ingester {
    const health: IngesterHealth = { ...base, ...overrides };
    const metrics: IngesterMetrics = {
      eventsProcessedTotal: 0,
      fetchErrorsTotal: 0,
      uptimeSeconds: 0,
      dbWriteLatencySeconds: 0,
      lag: health.lag,
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

  function makeMockDb(getLastLedger: () => Promise<number>): Db {
    return { getLastLedger } as unknown as Db;
  }

  it("GET /livez returns 200 even when DB is down and ingester is stalled", async () => {
    const db = makeMockDb(async () => {
      throw new Error("DB disconnected");
    });
    const app = buildApp(
      db,
      makeMockIngester({ consecutiveErrors: 10, lag: 500, lastError: "RPC stalled" })
    );

    const res = await request(app).get("/livez");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      alive: true,
      service: SERVICE_NAME,
    });
  });

  it("GET /readyz returns 200 when DB is connected and Horizon is synced within 5 ledgers", async () => {
    const db = makeMockDb(async () => 100);
    const app = buildApp(db, makeMockIngester({ lastSuccessLedger: 100, headLedger: 105, lag: 5 }));

    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      ready: true,
      checks: {
        database: { status: "ok", lastLedger: 100, error: null },
        horizon: { status: "ok", synced: true, lag: 5, maxLag: 5 },
      },
    });
  });

  it("GET /readyz returns 200 degraded when DB is connected, lag <= 5, and consecutiveErrors is 1-2", async () => {
    const db = makeMockDb(async () => 100);
    const app = buildApp(
      db,
      makeMockIngester({ lag: 3, consecutiveErrors: 2, lastError: "timeout" })
    );

    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.ready).toBe(true);
    expect(res.body.checks.horizon.status).toBe("degraded");
  });

  it("GET /readyz returns 503 when DB is disconnected", async () => {
    const db = makeMockDb(async () => {
      throw new Error("ECONNREFUSED");
    });
    const app = buildApp(db, makeMockIngester({ lag: 1 }));

    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "error",
      ready: false,
      checks: {
        database: { status: "error", lastLedger: null, error: "ECONNREFUSED" },
        horizon: { status: "ok", synced: true },
      },
    });
  });

  it("GET /readyz returns 503 when Horizon lag exceeds 5 ledgers", async () => {
    const db = makeMockDb(async () => 100);
    const app = buildApp(db, makeMockIngester({ lastSuccessLedger: 100, headLedger: 106, lag: 6 }));

    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "error",
      ready: false,
      checks: {
        database: { status: "ok", lastLedger: 100 },
        horizon: { status: "error", synced: false, lag: 6, maxLag: 5 },
      },
    });
  });

  it("GET /readyz returns 503 when Horizon is not yet synced (lag === -1)", async () => {
    const db = makeMockDb(async () => 0);
    const app = buildApp(db, makeMockIngester({ lag: -1, headLedger: 0 }));

    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.checks.horizon.synced).toBe(false);
  });

  it("GET /readyz returns 503 when ingester is stalled (consecutiveErrors >= 3)", async () => {
    const db = makeMockDb(async () => 100);
    const app = buildApp(
      db,
      makeMockIngester({ lag: 2, consecutiveErrors: 3, lastError: "Horizon 502" })
    );

    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.checks.horizon.status).toBe("error");
  });

  it("GET /healthz returns 200 with full deep dependency state when healthy", async () => {
    const db = makeMockDb(async () => 100);
    const app = buildApp(db, makeMockIngester({ lastSuccessLedger: 100, headLedger: 102, lag: 2 }));

    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      alive: true,
      ready: true,
      lastLedger: 100,
      headLedger: 102,
      lag: 2,
      checks: {
        database: { status: "ok", lastLedger: 100 },
        horizon: { status: "ok", synced: true, lag: 2, maxLag: 5 },
      },
    });
  });

  it("GET /healthz returns 503 when DB is down or Horizon is lagging", async () => {
    const db = makeMockDb(async () => {
      throw new Error("DB lost");
    });
    const app = buildApp(db, makeMockIngester({ lag: 12 }));

    const res = await request(app).get("/healthz");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "error",
      alive: true,
      ready: false,
      lastLedger: null,
      checks: {
        database: { status: "error", error: "DB lost" },
        horizon: { status: "error", synced: false, lag: 12 },
      },
    });
  });
});

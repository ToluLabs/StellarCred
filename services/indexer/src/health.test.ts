import request from "supertest";
import {
  buildHealthResponse,
  buildHealthzResponse,
  buildLivenessResponse,
  buildReadinessResponse,
  checkDatabase,
  evaluateHorizonHealth,
  MAX_READY_LEDGER_LAG,
  resolveVersion,
  statusFromHealth,
  SERVICE_NAME,
} from "./health";
import { buildApp } from "./api";
import type { Db } from "./db";
import type { Ingester, IngesterHealth, IngesterMetrics } from "./ingester";

const base: IngesterHealth = {
  lastSuccessLedger: 10,
  headLedger: 12,
  lag: 2,
  lastError: null,
  lastErrorTime: null,
  consecutiveErrors: 0,
  fetchAttempts: 5,
  fetchFailures: 0,
};

describe("statusFromHealth", () => {
  it("maps consecutive errors to ok / degraded / error", () => {
    expect(statusFromHealth({ consecutiveErrors: 0 })).toBe("ok");
    expect(statusFromHealth({ consecutiveErrors: 2 })).toBe("degraded");
    expect(statusFromHealth({ consecutiveErrors: 3 })).toBe("error");
  });
});

describe("resolveVersion", () => {
  it("prefers INDEXER_VERSION, then npm_package_version, then dev", () => {
    expect(resolveVersion({ INDEXER_VERSION: "2.0.0", npm_package_version: "1.0.0" })).toBe("2.0.0");
    expect(resolveVersion({ npm_package_version: "1.0.0" })).toBe("1.0.0");
    expect(resolveVersion({})).toBe("dev");
  });
});

describe("buildHealthResponse", () => {
  it("includes status, readiness and service metadata", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const body = buildHealthResponse(10, base, now);
    expect(body).toMatchObject({
      status: "ok",
      ready: true,
      service: SERVICE_NAME,
      timestamp: "2026-01-01T00:00:00.000Z",
      lastLedger: 10,
      lag: 2,
    });
    expect(typeof body.version).toBe("string");
  });

  it("is not ready when the ingester is in the error state", () => {
    const body = buildHealthResponse(10, { ...base, consecutiveErrors: 3, lastError: "boom" });
    expect(body.status).toBe("error");
    expect(body.ready).toBe(false);
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

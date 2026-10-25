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
});

import { buildHealthResponse, resolveVersion, statusFromHealth, SERVICE_NAME } from "./health";
import type { IngesterHealth } from "./ingester";

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

// @vitest-environment node
//
// Coverage for GET /api/health — the frontend liveness check polled by
// deployment and monitoring tooling (docs/HEALTHCHECKS.md).

import { describe, it, expect, afterEach, vi } from "vitest";
import { GET } from "../route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("returns 200 with status, service and version metadata", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.2.3");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      ready: true,
      service: "stellarcred-frontend",
      version: "1.2.3",
    });
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(body.outboundSink).toBeDefined();
  });

  it("falls back to version 'dev' when NEXT_PUBLIC_APP_VERSION is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", undefined);
    const body = await (await GET()).json();
    expect(body.version).toBe("dev");
  });
});

// @vitest-environment node
//
// Coverage for GET /api/health — the frontend liveness/readiness probe.
//
// The route reads NEXT_PUBLIC_APP_VERSION at request time, so a single import
// is enough; version assertions set/restore the env var per test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET } from "../route";

describe("GET /api/health", () => {
  const originalVersion = process.env.NEXT_PUBLIC_APP_VERSION;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
  });

  afterEach(() => {
    if (originalVersion === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
    else process.env.NEXT_PUBLIC_APP_VERSION = originalVersion;
  });

  it("returns 200 with status, service, and version metadata", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      ready: true,
      service: "stellarcred-frontend",
      version: "dev",
      app_version: "dev",
    });
    expect(typeof body.timestamp).toBe("number");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(body.outboundSink).toBeDefined();
  });

  it("reflects NEXT_PUBLIC_APP_VERSION when set", async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";

    const body = await (await GET()).json();

    expect(body.version).toBe("1.2.3");
    expect(body.app_version).toBe("1.2.3");
  });

  it("falls back to dev when NEXT_PUBLIC_APP_VERSION is blank", async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "   ";

    const body = await (await GET()).json();

    expect(body.version).toBe("dev");
  });
});

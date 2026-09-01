// @vitest-environment node
//
// Coverage for GET /api/issuer-stats (#398) — a thin server-side proxy to
// the indexer's GET /issuers/:issuer/stats, kept server-side so INDEXER_URL
// never needs a NEXT_PUBLIC_ prefix (see route.ts's doc comment).
//
// lib/env.ts validates process.env at *import* time, so — same as
// app/api/issue's own test — every test that needs a different INDEXER_URL
// resets the module registry and re-imports fresh via loadRoute().

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const ENV_KEYS = ["INDEXER_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadRoute() {
  vi.resetModules();
  return import("../route");
}

function getRequest(query: string) {
  return new NextRequest(`http://localhost/api/issuer-stats${query}`);
}

describe("GET /api/issuer-stats", () => {
  it("returns 400 without calling the indexer when issuer is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await loadRoute();

    const res = await GET(getRequest(""));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies to the default indexer URL and returns its JSON as-is", async () => {
    delete process.env.INDEXER_URL;
    const stats = {
      issuer: "GISSUER",
      total: 3,
      active: 2,
      revoked: 1,
      credential_types: ["age", "kyc"],
      first_seen: 1000,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(stats), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await loadRoute();

    const res = await GET(getRequest("?issuer=GISSUER"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(stats);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/issuers/GISSUER/stats",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("respects a configured INDEXER_URL and URL-encodes the issuer", async () => {
    process.env.INDEXER_URL = "http://indexer.internal:9999";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          issuer: "G WITH SPACE",
          total: 0,
          active: 0,
          revoked: 0,
          credential_types: [],
          first_seen: null,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await loadRoute();

    await GET(getRequest("?issuer=" + encodeURIComponent("G WITH SPACE")));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://indexer.internal:9999/issuers/G%20WITH%20SPACE/stats",
      expect.anything(),
    );
  });

  it("returns 502 when the indexer responds with a non-2xx status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await loadRoute();

    const res = await GET(getRequest("?issuer=GISSUER"));
    expect(res.status).toBe(502);
  });

  it("returns 502 when the indexer is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await loadRoute();

    const res = await GET(getRequest("?issuer=GISSUER"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("ECONNREFUSED");
  });
});

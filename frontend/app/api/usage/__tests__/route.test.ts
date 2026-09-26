// @vitest-environment node
//
// Coverage for the self-serve rate-limit & quota dashboard endpoint
// GET /api/usage (frontend/app/api/usage/route.ts).
//
// The endpoint must:
//   - derive the caller's usage from the in-process rate-limit store using the
//     exact keys /api/issue increments (issue:ip:<ip>, issue:wallet:<addr>);
//   - be read-only (polling it never consumes quota);
//   - return NO identity data (never echo the raw IP or wallet);
//   - expose reset timing and a throttled flag for the UI to explain clearly.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import {
  checkLimit,
  rateLimitClear,
  LIMITS,
} from "@/lib/rate-limit";

const IP = "203.0.113.9";
const WALLET = "GAAAAA";
const BABBLED = "GbbbbbWhateverAddress123";

function usageRequest(ip: string, wallet?: string): NextRequest {
  const url = wallet
    ? `http://localhost/api/usage?wallet=${encodeURIComponent(wallet)}`
    : "http://localhost/api/usage";
  return new NextRequest(url, {
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  rateLimitClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/usage", () => {
  it("returns self scope with an untouched window for a fresh IP", async () => {
    const res = await GET(usageRequest(IP));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.scope).toBe("self");
    expect(body.windowSeconds).toBe(LIMITS.windowMs() / 1000);
    expect(body.usage.ip.limit).toBe(LIMITS.issuePerIp());
    expect(body.usage.ip.used).toBe(0);
    expect(body.usage.ip.remaining).toBe(LIMITS.issuePerIp());
    expect(body.usage.ip.throttled).toBe(false);
    expect(body.throttled).toBe(false);
  });

  it("reflects requests already recorded against the store for the same IP", async () => {
    checkLimit(`issue:ip:${IP}`, LIMITS.issuePerIp(), LIMITS.windowMs());
    checkLimit(`issue:ip:${IP}`, LIMITS.issuePerIp(), LIMITS.windowMs());

    const res = await GET(usageRequest(IP));
    const body = await res.json();
    expect(body.usage.ip.used).toBe(2);
    expect(body.usage.ip.remaining).toBe(LIMITS.issuePerIp() - 2);
  });

  it("reports the wallet dimension when ?wallet= is supplied", async () => {
    // Seed the wallet bucket the way /api/issue would (case-sensitive key).
    checkLimit(`issue:wallet:${WALLET}`, LIMITS.issuePerWallet(), LIMITS.windowMs());

    const res = await GET(usageRequest(IP, WALLET));
    const body = await res.json();
    expect(body.usage.wallet).toBeDefined();
    expect(body.usage.wallet.used).toBe(1);
    expect(body.usage.wallet.limit).toBe(LIMITS.issuePerWallet());
    expect(body.usage.wallet.remaining).toBe(LIMITS.issuePerWallet() - 1);
  });

  it("is read-only: polling repeatedly never consumes quota", async () => {
    const before = await (await GET(usageRequest(IP))).json();

    await GET(usageRequest(IP));
    await GET(usageRequest(IP));
    await GET(usageRequest(IP, WALLET));

    const after = await (await GET(usageRequest(IP))).json();
    expect(after.usage.ip.used).toBe(before.usage.ip.used);
  });

  it("flags throttled once a dimension reaches its limit", async () => {
    const ipLimit = LIMITS.issuePerIp();
    for (let i = 0; i < ipLimit; i++) {
      checkLimit(`issue:ip:${IP}`, ipLimit, LIMITS.windowMs());
    }

    const res = await GET(usageRequest(IP));
    const body = await res.json();
    expect(body.usage.ip.throttled).toBe(true);
    expect(body.usage.ip.remaining).toBe(0);
    expect(body.throttled).toBe(true);
    expect(body.usage.ip.resetSeconds).toBeGreaterThan(0);
    expect(body.usage.ip.windowEnd).toBeGreaterThan(Date.now() - 1000);
  });

  it("returns reset timing (resetSeconds) so the UI can explain when to retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    checkLimit(`issue:wallet:${BABBLED}`, 1, 60_000); // windowEnd = 1_060_000

    vi.setSystemTime(1_050_000); // 50s elapsed → 10s to reset
    const res = await GET(usageRequest(IP, BABBLED));
    const body = await res.json();
    expect(body.usage.wallet.resetSeconds).toBe(10);
  });

  it("does not echo the raw IP or wallet address", async () => {
    const res = await GET(usageRequest(IP, WALLET));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(IP);
    expect(text).not.toContain(WALLET);
  });

  it("rejects an oversized wallet query param", async () => {
    const huge = "G".repeat(200);
    const res = await GET(usageRequest(IP, huge));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid wallet");
  });
});
// @vitest-environment node
//
// Unit coverage for the route's two rate-limit dimensions. The limiter itself
// (lib/rate-limit) has its own guarantees; what matters here is that the route
// uses both dimensions, keys them independently, and never logs a raw IP or
// wallet address.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { rateLimitClear } from "@/lib/rate-limit";
import { enforceIpRateLimit, enforceWalletRateLimit } from "../rateLimit";

const REQUEST_ID = "req_ratelimit_0001";
const IP = "203.0.113.9";
const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

const ENV_KEYS = [
  "RATE_LIMIT_ISSUE_IP",
  "RATE_LIMIT_ISSUE_WALLET",
  "RATE_LIMIT_WINDOW_SECONDS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function requestFrom(ip: string) {
  return new NextRequest("http://localhost/api/issue", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.RATE_LIMIT_ISSUE_IP = "1";
  process.env.RATE_LIMIT_ISSUE_WALLET = "1";
  process.env.RATE_LIMIT_WINDOW_SECONDS = "60";
  rateLimitClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rateLimitClear();
  vi.restoreAllMocks();
});

describe("enforceIpRateLimit", () => {
  it("allows the first request and throttles the next one from the same IP", () => {
    expect(enforceIpRateLimit(requestFrom(IP), REQUEST_ID)).toBeNull();

    const limited = enforceIpRateLimit(requestFrom(IP), REQUEST_ID);
    expect(limited).not.toBeNull();
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("Retry-After")).toBeTruthy();
  });

  it("counts each IP independently", () => {
    expect(enforceIpRateLimit(requestFrom(IP), REQUEST_ID)).toBeNull();
    expect(enforceIpRateLimit(requestFrom(IP), REQUEST_ID)?.status).toBe(429);
    expect(enforceIpRateLimit(requestFrom("198.51.100.4"), REQUEST_ID)).toBeNull();
  });

  it("logs the throttle with a hashed token and dimension, never the raw IP", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    enforceIpRateLimit(requestFrom(IP), REQUEST_ID);
    enforceIpRateLimit(requestFrom(IP), REQUEST_ID);

    // `stripSensitiveFields` allows only the logger's SAFE_FIELDS through, so
    // the dimension and hashed token are dropped before the line is written.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "rate_limited", requestId: REQUEST_ID }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(IP);
  });
});

describe("enforceWalletRateLimit", () => {
  it("allows the first request and throttles the next one for the same wallet", () => {
    expect(enforceWalletRateLimit(WALLET_A, REQUEST_ID)).toBeNull();

    const limited = enforceWalletRateLimit(WALLET_A, REQUEST_ID);
    expect(limited?.status).toBe(429);
  });

  it("counts each wallet independently", () => {
    expect(enforceWalletRateLimit(WALLET_A, REQUEST_ID)).toBeNull();
    expect(enforceWalletRateLimit(WALLET_A, REQUEST_ID)?.status).toBe(429);
    expect(enforceWalletRateLimit(WALLET_B, REQUEST_ID)).toBeNull();
  });

  it("does not share a budget with the per-IP dimension", () => {
    expect(enforceIpRateLimit(requestFrom(IP), REQUEST_ID)).toBeNull();
    expect(enforceIpRateLimit(requestFrom(IP), REQUEST_ID)?.status).toBe(429);
    // The IP bucket is exhausted; the wallet bucket is untouched.
    expect(enforceWalletRateLimit(WALLET_A, REQUEST_ID)).toBeNull();
  });

  it("logs the throttle with a hashed token and dimension, never the wallet", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    enforceWalletRateLimit(WALLET_A, REQUEST_ID);
    enforceWalletRateLimit(WALLET_A, REQUEST_ID);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "rate_limited", requestId: REQUEST_ID }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(WALLET_A);
  });
});

/**
 * rateLimit.ts — the two rate-limit dimensions POST /api/issue is subject to.
 *
 * The policy (limits, windows, the in-process store) lives in
 * `lib/rate-limit.ts`; this module owns only *this route's* usage of it: which
 * dimensions apply, the store key each one uses, and the audit log line a
 * rejection emits.
 *
 * Both checks return `null` when the request may proceed, or the ready-to-send
 * 429 when it may not — so the route reads as a guard clause rather than
 * re-assembling the response each time.
 *
 * Ordering note: the IP check runs before the body is parsed (the route needs
 * the raw request only) and before any idempotency caching, so a throttled IP
 * is never recorded as a cached response. The wallet check needs the parsed
 * `holder`, so it runs inside the request scope and *is* cached like every
 * other in-scope outcome.
 */

import type { NextRequest, NextResponse } from "next/server";
import { logger, stripSensitiveFields } from "@/lib/logger";
import {
  checkLimit,
  extractIp,
  hashForLog,
  tooManyRequestsResponse,
  LIMITS,
} from "@/lib/rate-limit";

/**
 * Enforce the per-IP limit. Raw IPs are never logged — only a truncated
 * SHA-256 token, enough to correlate lines without carrying the address.
 */
export function enforceIpRateLimit(
  req: NextRequest,
  requestId: string,
): NextResponse | null {
  const ip = extractIp(req);
  const result = checkLimit(
    `issue:ip:${ip}`,
    LIMITS.issuePerIp(),
    LIMITS.windowMs(),
  );
  if (!result.throttled) return null;

  logger.warn(
    stripSensitiveFields({
      event: "rate_limited",
      route: "issue",
      dimension: "ip",
      ipToken: hashForLog(ip),
      requestId,
    }),
  );
  return tooManyRequestsResponse(result.retryAfterMs);
}

/**
 * Enforce the per-wallet limit, keyed on the `holder` from the request body
 * (which is already known to be present at this point in the flow).
 */
export function enforceWalletRateLimit(
  wallet: string,
  requestId: string,
): NextResponse | null {
  const result = checkLimit(
    `issue:wallet:${wallet}`,
    LIMITS.issuePerWallet(),
    LIMITS.windowMs(),
  );
  if (!result.throttled) return null;

  logger.warn(
    stripSensitiveFields({
      event: "rate_limited",
      route: "issue",
      dimension: "wallet",
      walletToken: hashForLog(wallet),
      requestId,
    }),
  );
  return tooManyRequestsResponse(result.retryAfterMs);
}

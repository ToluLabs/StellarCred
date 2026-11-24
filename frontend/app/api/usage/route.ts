// frontend/app/api/usage/route.ts
//
// Self-serve rate-limit & quota dashboard for issuers.
//
// Any caller can see where *they* stand against the rate limits protecting
// /api/issue — recent issuance volume (requests used in the current window),
// the remaining quota, and exactly when the window resets. The data is derived
// from the in-process rate-limit store (see lib/rate-limit.ts) using the same
// namespaced keys the issue route increments, so the numbers always agree with
// what a real /api/issue request would be charged.
//
// Privacy & safety:
//   - Self-serve only: this returns nothing but scalar counters for the
//     caller's own IP (and, when a `?wallet=` is supplied, that wallet). No
//     raw IPs, wallet addresses, or any other identity data are ever echoed
//     back.
//   - Read-only: it does NOT touch the store, so polling the dashboard can
//     never consume quota or bump anyone closer to a 429 (see
//     getRateLimitStatus in lib/rate-limit.ts).

import { NextRequest, NextResponse } from "next/server";
import {
  extractIp,
  getRateLimitStatus,
  type RateLimitStatus,
  LIMITS,
} from "../../../lib/rate-limit";

// Upper bound for the optional ?wallet= param. The value is only ever used as
// an in-process Map key, so we don't need strict address/casing validation,
// but we do bound its length so an oversized query string can't be echoed
// around or used to probe arbitrarily long keys.
const MAX_WALLET_LENGTH = 128;

interface Dimension {
  used: number;
  limit: number;
  remaining: number;
  throttled: boolean;
  resetSeconds: number;
  windowEnd: number;
}

function dimension(
  key: string,
  limit: number,
  windowMs: number,
): Dimension {
  const s: RateLimitStatus = getRateLimitStatus(key, limit, windowMs);
  return {
    used: s.used,
    limit: s.limit,
    remaining: s.remaining,
    throttled: s.throttled,
    resetSeconds: s.resetSeconds,
    windowEnd: s.windowEnd,
  };
}

export async function GET(req: NextRequest) {
  const windowMs = LIMITS.windowMs();
  const windowSeconds = Math.round(windowMs / 1000);

  const ip = extractIp(req);

  const rawWallet = req.nextUrl.searchParams.get("wallet");
  let wallet: string | undefined;
  if (rawWallet && rawWallet.trim()) {
    wallet = rawWallet.trim();
    if (wallet.length > MAX_WALLET_LENGTH) {
      return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
    }
  }

  const perIp = LIMITS.issuePerIp();
  const perWallet = LIMITS.issuePerWallet();

  const ipDimension = dimension(`issue:ip:${ip}`, perIp, windowMs);

  const usage: { ip: Dimension; wallet?: Dimension } = { ip: ipDimension };
  if (wallet) {
    usage.wallet = dimension(`issue:wallet:${wallet}`, perWallet, windowMs);
  }

  // A single "are you throttled?" summary so the dashboard can render one
  // prominent banner rather than making the consumer diff every dimension.
  const throttled = ipDimension.throttled || (usage.wallet?.throttled ?? false);

  return NextResponse.json({
    scope: "self",
    windowSeconds,
    limits: { perIp, perWallet },
    usage,
    throttled,
  });
}
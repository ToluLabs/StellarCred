 feat/issues-847-848-820-841
/**
 * _middleware.ts — Shared rate-limit middleware factory for API routes.
 *
 * This module provides a single `withRateLimit` wrapper that API route
 * handlers can call to apply Redis-backed (or in-process fallback) rate
 * limiting without duplicating the boilerplate from the issue routes.
 *
 * ## Usage
 *
 * ```ts
 * // In any app/api/.../route.ts:
 * import { withRateLimit } from "@/app/api/_middleware";
 * import { LIMITS, extractIp } from "@/lib/rate-limit";
 *
 * export async function GET(req: NextRequest) {
 *   return withRateLimit(req, {
 *     key: `myroute:ip:${extractIp(req)}`,
 *     limit: LIMITS.witnessPerIp(),
 *     windowMs: LIMITS.windowMs(),
 *     handler: async () => NextResponse.json({ ok: true }),
 *   });
 * }
 * ```
 *
 * ## Redis vs In-process
 *
 * When `REDIS_URL` is set (and `ioredis` is installed), rate-limit state is
 * stored in Redis so limits are enforced across all application instances.
 * When Redis is unavailable (not configured or connection error), the module
 * transparently falls back to the in-process Map store in `rate-limit.ts`.
 *
 * See `frontend/lib/redis-rate-limit.ts` for connection and fallback details.
 *
 * ## Per-API-key limits
 *
 * Pass `apiKey` from the request (e.g. an `X-Api-Key` header) as part of the
 * `key` string to enforce per-key limits independently of IP limits:
 *
 * ```ts
 * const apiKey = req.headers.get("x-api-key") ?? extractIp(req);
 * return withRateLimit(req, {
 *   key: `issue:apikey:${apiKey}`,
 *   limit: LIMITS.issuePerIp(),
 *   windowMs: LIMITS.windowMs(),
 *   handler,
 * });
 * ```
 *
 * ## Environment variables
 *
 * | Variable          | Default | Meaning                                      |
 * |-------------------|---------|----------------------------------------------|
 * | `REDIS_URL`       | —       | Redis URL; enables shared Redis store        |
 * | `REDIS_KEY_PREFIX`| `sc:rl:`| Key namespace prefix in Redis                |
 * | `REDIS_TLS`       | auto    | Set `"1"` to force TLS                       |
 *
 * All other rate-limit configuration env vars (`RATE_LIMIT_ISSUE_IP`, etc.)
 * are defined in `frontend/lib/rate-limit.ts` and apply to both stores.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { tooManyRequestsResponse } from "@/lib/rate-limit";
import { checkLimitRedis } from "@/lib/redis-rate-limit";
=======
// frontend/app/api/_middleware.ts
//
// Shared error boundary and Sentry observability middleware for API routes (#853),
// plus the route-level auth guards.

import { NextResponse, type NextRequest } from "next/server";
 main
import {
  withSentryRouteHandler,
  captureServerException,
  initSentry,
  getSentryClient,
} from "@/lib/monitoring/sentry";
import { authFailure, checkAdminAuth, UNAUTHORIZED, type AuthResult } from "@/lib/auth";
import { resolveTenant, type Tenant } from "@/lib/tenancy";

export interface RateLimitOptions {
  /** Namespaced key for this limiter bucket (e.g. `"issue:ip:<raw-ip>"`). */
  key: string;
  /** Maximum requests allowed in the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** The actual route handler, called only when the request is not throttled. */
  handler: () => Promise<NextResponse>;
}

/**
 * Apply rate limiting to a route handler.
 *
 * Returns a 429 `NextResponse` when the limit is exceeded; otherwise calls
 * and returns the result of `handler`.
 *
 * Rate-limit state is stored in Redis when `REDIS_URL` is configured, and
 * falls back to the in-process store otherwise — callers are agnostic to
 * which backend is active.
 */
export async function withRateLimit(
  _req: NextRequest,
  { key, limit, windowMs, handler }: RateLimitOptions,
): Promise<NextResponse> {
  const result = await checkLimitRedis(key, limit, windowMs);

  if (result.throttled) {
    return tooManyRequestsResponse(result.retryAfterMs);
  }

  return handler();
}

/**
 * Apply two rate-limit checks in series: first `primary` (e.g. per-IP),
 * then `secondary` (e.g. per-wallet).  Returns a 429 on the first throttled
 * check; calls `handler` only when both pass.
 *
 * This replaces the two sequential `checkLimit` calls in the issue routes
 * with a single wrapper that handles both checks and the 429 response.
 */
export async function withRateLimits(
  _req: NextRequest,
  opts: {
    primary: Omit<RateLimitOptions, "handler">;
    secondary: Omit<RateLimitOptions, "handler">;
    handler: RateLimitOptions["handler"];
  },
): Promise<NextResponse> {
  const primary = await checkLimitRedis(opts.primary.key, opts.primary.limit, opts.primary.windowMs);
  if (primary.throttled) {
    return tooManyRequestsResponse(primary.retryAfterMs);
  }

  const secondary = await checkLimitRedis(opts.secondary.key, opts.secondary.limit, opts.secondary.windowMs);
  if (secondary.throttled) {
    return tooManyRequestsResponse(secondary.retryAfterMs);
  }

  return opts.handler();
}

// ---------------------------------------------------------------------------
// Shared error boundary and Sentry observability middleware (#853)
// ---------------------------------------------------------------------------

export { withSentryRouteHandler, captureServerException, initSentry, getSentryClient };

/**
 * Standard API error boundary wrapper.
 * Use around Next.js route handlers:
 *
 * export const POST = withApiErrorBoundary(async (req) => { ... });
 */
export const withApiErrorBoundary = withSentryRouteHandler;

/**
 * Manually captures and formats unexpected API exceptions.
 */
export async function handleApiError(
  req: NextRequest,
  error: unknown,
  status = 500,
): Promise<NextResponse> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const eventId = await captureServerException(error, {
    requestId,
    method: req.method,
    path: req.nextUrl.pathname,
    status,
  });

  return NextResponse.json(
    {
      error: "Internal Server Error",
      requestId,
      sentryEventId: eventId,
    },
 feat/issues-847-848-820-841
    { status }
  );

    { status },
  ) as unknown as NextResponse;
 main
}

// ── Auth guards ──────────────────────────────────────────────────────────────
//
// Routes call a guard first and return its response verbatim when the caller
// is rejected, so the rejection shape is the same everywhere:
//
//   const denied = requireAdmin(req);
//   if (denied) return denied;
//
// Credential parsing and comparison live in lib/auth.ts.

/** A 401 for admin routes when the request lacks a valid admin API key, else null. */
export function requireAdmin(req: NextRequest): NextResponse | null {
  if (checkAdminAuth(req)) return null;
  return NextResponse.json(UNAUTHORIZED, { status: 401 });
}

/**
 * Authenticate the caller's tenant session. Requests without tenant
 * credentials resolve to `null` (the default single-issuer path); a bad,
 * cross-tenant, suspended or revoked key is rejected.
 */
export async function authenticateTenant(req: NextRequest): Promise<AuthResult<Tenant | null>> {
  const result = await resolveTenant(req);
  if (result.error) return authFailure(result.status ?? 401, result.error);
  return { ok: true, value: result.tenant };
}

/** The JSON error response for a rejected {@link AuthResult}, tagged with the request id. */
export function authErrorResponse(
  failure: { status: number; error: string },
  requestId: string,
): NextResponse {
  const res = NextResponse.json({ error: failure.error }, { status: failure.status });
  res.headers.set("x-request-id", requestId);
  return res;
}

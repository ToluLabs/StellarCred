/**
 * _middleware.ts - Shared rate-limit middleware factory for API routes.
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
 * | `REDIS_URL`       | -       | Redis URL; enables shared Redis store        |
 * | `REDIS_KEY_PREFIX`| `sc:rl:`| Key namespace prefix in Redis                |
 * | `REDIS_TLS`       | auto    | Set `"1"` to force TLS                       |
 *
 * All other rate-limit configuration env vars (`RATE_LIMIT_ISSUE_IP`, etc.)
 * are defined in `frontend/lib/rate-limit.ts` and apply to both stores.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  withSentryRouteHandler,
  captureServerException,
  initSentry,
  getSentryClient,
} from "@/lib/monitoring/sentry";
import { checkAdminAuth, UNAUTHORIZED } from "@/lib/auth";

export { withSentryRouteHandler, captureServerException, initSentry, getSentryClient };

/**
 * Returns a 401 response when the request is not an authorized admin,
 * or null when admin access is allowed.
 */
export function requireAdmin(req: NextRequest): NextResponse | null {
  if (checkAdminAuth(req)) return null;
  return NextResponse.json(UNAUTHORIZED, { status: 401 });
}

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
    { status },
  ) as unknown as NextResponse;
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

/** Require a valid, properly signed session token on protected routes (#945). */
type SessionFailureResponse = NextResponse & { readonly ok: false };

export function requireSession(
  req: NextRequest,
  options?: SessionValidationOptions,
): { ok: true; session: SessionPayload } | SessionFailureResponse {
  const token =
    req.headers.get("x-session-token") ?? extractBearerToken(req.headers.get("authorization"));

  const validated = validateSessionToken(token, options);
  if (!validated.ok) {
    const status = validated.status >= 500 ? 500 : 401;
    return NextResponse.json(UNAUTHORIZED, { status }) as SessionFailureResponse;
  }
  return { ok: true, session: validated.value };
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

// frontend/app/api/_middleware.ts
//
// Shared error boundary, Sentry observability, and authentication middleware
// for API routes (#853).

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  withSentryRouteHandler,
  captureServerException,
  initSentry,
  getSentryClient,
} from "@/lib/monitoring/sentry";
import {
  authenticateRequest,
  type AuthenticateOptions,
  type AuthError,
  type AuthPrincipal,
  type AuthResult,
} from "@/lib/auth";
import { logger, stripSensitiveFields, resolveRequestId } from "@/lib/logger";
import { resolveTenant, type Tenant } from "@/lib/tenancy";

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
  status = 500
): Promise<NextResponse> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const eventId = await captureServerException(error, {
    requestId,
    method: req.method,
    path: req.nextUrl.pathname,
    status,
  });

  return Response.json(
    {
      error: "Internal Server Error",
      requestId,
      sentryEventId: eventId,
    },
    { status }
  ) as unknown as NextResponse;
}

// ---------------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------------

/**
 * The canonical rejection response for a failed credential check.
 *
 * Every route answers a bad credential the same way: the same status code,
 * the same body shape, and the same machine-readable `code`.
 */
export function unauthorizedResponse(error: AuthError): NextResponse {
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: error.status },
  );
}

/**
 * Runs the shared credential check for a request.
 */
export function requireAuth(
  req: NextRequest,
  options: AuthenticateOptions = {},
): AuthResult<AuthPrincipal> {
  return authenticateRequest(req, options);
}

export type AuthenticatedHandler<TContext> = (
  req: NextRequest,
  context: TContext,
  principal: AuthPrincipal,
) => Promise<NextResponse> | NextResponse;

/**
 * Wraps a route handler so it only runs for authenticated requests.
 *
 * The handler receives the resolved principal, so it never has to re-parse a
 * header or re-verify a signature.
 *
 * export const POST = withAuth({ apiKeys: process.env.API_KEYS }, async (req, _ctx, principal) => {
 *   ...
 * });
 */
export function withAuth<TContext = unknown>(
  options: AuthenticateOptions,
  handler: AuthenticatedHandler<TContext>,
): (req: NextRequest, context: TContext) => Promise<NextResponse> {
  return async (req: NextRequest, context: TContext): Promise<NextResponse> => {
    const result = authenticateRequest(req, options);

    if (!result.ok) {
      logger.warn(
        stripSensitiveFields({
          event: "auth_failed",
          status: result.error.status,
          requestId: resolveRequestId(req.headers.get("x-request-id")),
        }),
        `Rejected request: ${result.error.code}`,
      );
      return unauthorizedResponse(result.error);
    }

    return handler(req, context, result.value);
  };
}

export interface TenantAuthResult {
  tenant: Tenant | null;
  error?: string;
  status?: number;
}

/**
 * Resolves the tenant behind a request's API key.
 *
 * Wraps `resolveTenant` (lib/tenancy.ts) so routes can ask for the tenant
 * without repeating the credential plumbing, and so the rejection shape
 * (message + status) stays identical across every route.
 */
export async function requireTenantAuth(req: NextRequest): Promise<TenantAuthResult> {
  const result = await resolveTenant(req);
  return {
    tenant: result.tenant,
    error: result.error,
    status: result.status,
  };
}

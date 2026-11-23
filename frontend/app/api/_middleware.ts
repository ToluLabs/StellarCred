// frontend/app/api/_middleware.ts
//
// Shared error boundary and Sentry observability middleware for API routes (#853).

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


// frontend/app/api/_middleware.ts
//
// Shared error boundary and Sentry observability middleware for API routes (#853).

import type { NextRequest, NextResponse } from "next/server";
import {
  withSentryRouteHandler,
  captureServerException,
  initSentry,
  getSentryClient,
} from "@/lib/monitoring/sentry";

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


import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { getCorsHeaders, isOriginAllowed } from "@/lib/cors";
import { logger, stripSensitiveFields } from "@/lib/logger";
import { reportError } from "@/lib/error-reporting";
import { locales, defaultLocale } from "@/i18n.config";

function resolveRequestId(inbound: string | null | undefined): string {
  const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  if (inbound && REQUEST_ID_RE.test(inbound)) return inbound;
  
  // Use Web Crypto API (available in edge runtime) instead of Node.js crypto
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Create i18n middleware for locale routing
const intlMiddleware = createMiddleware({
  locales: locales as unknown as string[],
  defaultLocale,
  localePrefix: 'as-needed', // Only prefix non-default locales (/es/*, not /en/*)
});

export function middleware(request: NextRequest) {
  // Handle i18n routing first
  if (!request.nextUrl.pathname.startsWith("/api")) {
    return intlMiddleware(request);
  }

  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const startTime = Date.now();

  // Detect demo/mock mode signals
  const isDemoIssuer = !process.env.ISSUER_PRIVATE_KEY;
  const isPlaidMock = !process.env.PLAID_ACCESS_TOKEN;
  const isPersonaDemo = !process.env.PERSONA_API_KEY;

  if (request.method === "OPTIONS") {
    const origin = request.headers.get("origin");
    if (!isOriginAllowed(origin)) {
      logRequest(request, 204, startTime, requestId, isDemoIssuer, isPlaidMock, isPersonaDemo);
      return new NextResponse(null, { status: 204 });
    }
    const response = new NextResponse(null, {
      status: 204,
      headers: getCorsHeaders(),
    });
    logRequest(request, 204, startTime, requestId, isDemoIssuer, isPlaidMock, isPersonaDemo);
    return response;
  }

  const response = NextResponse.next();
  const origin = request.headers.get("origin");
  if (isOriginAllowed(origin)) {
    const corsHeaders = getCorsHeaders();
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }
  }

  // Log the request after response is generated
  response.headers.set("x-request-id", requestId);
  logRequest(request, response.status, startTime, requestId, isDemoIssuer, isPlaidMock, isPersonaDemo);

  // Report unexpected 500 errors to error sink if configured
  if (response.status === 500) {
    reportError({
      method: request.method,
      path: request.nextUrl.pathname,
      requestId,
      status: response.status,
    }).catch((err) => {
      logger.error(
        stripSensitiveFields({
          event: "error_reporting_failed",
          requestId,
          error: (err as Error).message,
        }),
      );
    });
  }

  return response;
}

function logRequest(
  request: NextRequest,
  status: number,
  startTime: number,
  requestId: string,
  isDemoIssuer: boolean,
  isPlaidMock: boolean,
  isPersonaDemo: boolean,
) {
  const durationMs = Date.now() - startTime;
  logger.info(
    stripSensitiveFields({
      event: "api_request",
      method: request.method,
      path: request.nextUrl.pathname,
      status,
      durationMs,
      requestId,
      demoIssuer: isDemoIssuer || undefined,
      plaidMock: isPlaidMock || undefined,
      personaDemo: isPersonaDemo || undefined,
    }),
  );
}

export const config = {
  matcher: [
    // API routes - handle CORS and logging
    "/api/:path*",
    // All pages - handle i18n routing (except static assets)
    "/((?!_next|.*\\..*|public).*)",
  ],
};

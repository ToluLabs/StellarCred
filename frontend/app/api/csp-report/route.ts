import { NextRequest, NextResponse } from "next/server";
import { logger, stripSensitiveFields, resolveRequestId } from "@/lib/logger";
import { readJsonBody, bodyErrorResponse } from "@/lib/request-limits";
import {
  checkLimit,
  extractIp,
  tooManyRequestsResponse,
  LIMITS,
} from "@/lib/rate-limit";
import { normalizeReports } from "@/lib/csp-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const requestId = resolveRequestId(req.headers.get("x-request-id"));

  const sendResponse = (response: NextResponse) => {
    response.headers.set("x-request-id", requestId);
    return response;
  };

  // Rate-limit by IP first
  const ip = extractIp(req);
  const ipResult = checkLimit(
    `csp-report:ip:${ip}`,
    LIMITS.cspReportPerIp(),
    LIMITS.windowMs(),
  );

  if (ipResult.throttled) {
    logger.warn(
      stripSensitiveFields({
        event: "csp_report_rate_limited",
        requestId,
      }),
    );
    return sendResponse(tooManyRequestsResponse(ipResult.retryAfterMs));
  }

  // Size-guarded read (16 KB max)
  const parsed = await readJsonBody<unknown>(req, 16 * 1024);
  if (!parsed.ok) {
    return sendResponse(bodyErrorResponse(parsed.error));
  }

  // Normalize reports and log each sanitized violation
  const violations = normalizeReports(parsed.body);
  for (const cspViolation of violations) {
    logger.warn(
      stripSensitiveFields({
        event: "csp_violation",
        requestId,
        cspViolation,
      }),
    );
  }

  return sendResponse(new NextResponse(null, { status: 204 }));
}

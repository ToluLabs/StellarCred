import { NextRequest, NextResponse } from "next/server";
import { logger, stripSensitiveFields, resolveRequestId } from "../../../lib/logger";
import { checkContentLength, bodyErrorResponse } from "../../../lib/request-limits";
import {
  checkLimit,
  extractIp,
  hashForLog,
  tooManyRequestsResponse,
  LIMITS,
} from "../../../lib/rate-limit";
import { fetchPlaidBalance } from "../../../lib/plaid";

export async function GET(req: NextRequest) {
  const requestId = resolveRequestId(req.headers.get("x-request-id"));

  const sendResponse = (response: NextResponse) => {
    response.headers.set("x-request-id", requestId);
    return response;
  };

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Applied before the Content-Length check: floods are rejected before any
  // header inspection or upstream Plaid call.
  const ip = extractIp(req);
  const ipResult = checkLimit(`plaid:ip:${ip}`, LIMITS.plaidPerIp(), LIMITS.windowMs());
  if (ipResult.throttled) {
    logger.warn(
      stripSensitiveFields({
        event: "rate_limited",
        route: "plaid-balance",
        dimension: "ip",
        ipToken: hashForLog(ip),
        requestId,
      }),
    );
    return sendResponse(tooManyRequestsResponse(ipResult.retryAfterMs));
  }

  // This route reads no body, but it still refuses an oversized one rather
  // than letting the request reach the upstream Plaid call.
  const oversized = checkContentLength(req);
  if (oversized) {
    logger.warn(stripSensitiveFields({
      event: "plaid_balance_request_rejected",
      outcome: oversized.code,
      requestId,
    }));
    return sendResponse(bodyErrorResponse(oversized));
  }

  logger.info(stripSensitiveFields({ event: "plaid_balance_request_received", requestId }));

  const result = await fetchPlaidBalance(requestId);

  if (!result.ok) {
    return sendResponse(
      NextResponse.json({ error: result.error, code: result.code }, { status: result.status }),
    );
  }

  return sendResponse(
    NextResponse.json(
      result.mock
        ? { balance: result.balance, mock: true }
        : { balance: result.balance, sources: result.sources, accounts: result.accounts },
    ),
  );
}

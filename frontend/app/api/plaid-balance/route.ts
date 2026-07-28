import { NextRequest, NextResponse } from "next/server";
import { logger, stripSensitiveFields, resolveRequestId } from "../../../lib/logger";

export async function GET(req: NextRequest) {
  const requestId = resolveRequestId(req.headers.get("x-request-id"));

  const sendResponse = (response: NextResponse) => {
    response.headers.set("x-request-id", requestId);
    return response;
  };

  logger.info(stripSensitiveFields({ event: "plaid_balance_request_received", requestId }));

  if (!process.env.PLAID_ACCESS_TOKEN) {
    logger.warn(
      stripSensitiveFields({ event: "plaid_mock_mode", requestId }),
      "PLAID_ACCESS_TOKEN not set — returning mock balance $50,000",
    );
    return sendResponse(NextResponse.json({ balance: 50000, mock: true }));
  }

  const env = process.env.PLAID_ENV ?? "sandbox";
  const baseUrl =
    env === "production"
      ? "https://production.plaid.com"
      : env === "development"
        ? "https://development.plaid.com"
        : "https://sandbox.plaid.com";

  const response = await fetch(`${baseUrl}/accounts/balance/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      access_token: process.env.PLAID_ACCESS_TOKEN,
    }),
  });

  const result = await response.json();
  logger.info(stripSensitiveFields({
    event: "plaid_response",
    outcome: result.error_code ?? "ok",
    requestId,
  }));
  if (!response.ok || result.error_code) {
    return sendResponse(NextResponse.json(
      { error: result.error_message ?? "Plaid error" },
      { status: 502 },
    ));
  }

  const accounts: Array<{ type: string; name: string; balances: { available: number | null; current: number | null } }> =
    result.accounts ?? [];

  const depository = accounts
    .filter((a) => a.type === "depository")
    .map((a) => ({ name: a.name, available: a.balances.available ?? 0 }))
    .sort((a, b) => b.available - a.available);

  const balance = depository[0]?.available ?? 0;
  return sendResponse(NextResponse.json({ balance, accounts: depository }));
}

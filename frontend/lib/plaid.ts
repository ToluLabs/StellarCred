import { logger, stripSensitiveFields } from "./logger";

// Shared by /api/plaid-balance and the /api/issue issuance flow — both call
// Plaid's balance endpoint the same way, so the timeout/error handling
// lives in one place instead of being duplicated (and drifting) across both.

const PLAID_TIMEOUT_MS = 8_000;

// Fan-out bound for aggregate proof-of-funds: every linked item costs one
// upstream Plaid call per balance fetch, so a misconfigured token list can't
// turn a single request into an unbounded burst. Fails closed rather than
// silently dropping sources — dropping any would understate the aggregate and
// the issuer would attest to a figure that is not the sum of the linked items.
const MAX_PLAID_ITEMS = 25;

export type PlaidBalanceAccount = { name: string; available: number };

export type PlaidBalanceSuccess = {
  ok: true;
  mock?: true;
  /** Aggregate available balance summed across every linked Plaid item. */
  balance: number;
  /** How many linked Plaid items were aggregated into `balance`. */
  sources?: number;
  accounts?: PlaidBalanceAccount[];
};

export type PlaidBalanceFailure = {
  ok: false;
  status: number;
  code: "PLAID_TIMEOUT" | "PLAID_UNAVAILABLE" | "PLAID_ERROR";
  error: string;
};

export type PlaidBalanceResult = PlaidBalanceSuccess | PlaidBalanceFailure;

/**
 * Collects the configured Plaid access tokens — one item each. Sources are
 * PLAID_ACCESS_TOKEN (single item, the original variable) and
 * PLAID_ACCESS_TOKENS (comma-separated list for aggregating several linked
 * items). Duplicates are removed so a token listed in both places is only
 * fetched once.
 */
export function plaidAccessTokens(): string[] {
  const tokens = [
    process.env.PLAID_ACCESS_TOKEN,
    ...(process.env.PLAID_ACCESS_TOKENS ?? "").split(","),
  ]
    .map((token) => token?.trim() ?? "")
    .filter((token) => token.length > 0);
  return Array.from(new Set(tokens));
}

function plaidBaseUrl(): string {
  const env = process.env.PLAID_ENV ?? "sandbox";
  return env === "production"
    ? "https://production.plaid.com"
    : env === "development"
      ? "https://development.plaid.com"
      : "https://sandbox.plaid.com";
}

// One linked Plaid item: sums that item's depository available balances (an
// item can hold several accounts). Every failure mode maps to a structured
// PlaidBalanceFailure instead of throwing, so the aggregator can fail closed
// on the first item error in deterministic token order.
async function fetchPlaidItemBalance(
  accessToken: string,
  itemIndex: number,
  requestId: string,
): Promise<PlaidBalanceResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), PLAID_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${plaidBaseUrl()}/accounts/balance/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        access_token: accessToken,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout = (err as { name?: string }).name === "AbortError";
    logger.error(
      stripSensitiveFields({
        event: isTimeout ? "plaid_timeout" : "plaid_network_error",
        itemIndex,
        requestId,
      }),
    );
    return isTimeout
      ? {
          ok: false,
          status: 504,
          code: "PLAID_TIMEOUT",
          error: "Balance verification timed out. Please try again.",
        }
      : {
          ok: false,
          status: 502,
          code: "PLAID_UNAVAILABLE",
          error: "Balance verification service is unavailable. Please try again.",
        };
  } finally {
    clearTimeout(timeoutHandle);
  }

  let result: { error_code?: string; accounts?: unknown };
  try {
    result = await response.json();
  } catch {
    logger.error(stripSensitiveFields({ event: "plaid_invalid_response", itemIndex, requestId }));
    return {
      ok: false,
      status: 502,
      code: "PLAID_UNAVAILABLE",
      error: "Balance verification service returned an invalid response.",
    };
  }

  // Only the stable error_code enum is logged — never error_message, which
  // can embed more free-form (and potentially sensitive) detail.
  logger.info(
    stripSensitiveFields({
      event: "plaid_response",
      outcome: result.error_code ?? "ok",
      itemIndex,
      requestId,
    }),
  );

  if (!response.ok || result.error_code) {
    return {
      ok: false,
      status: 502,
      code: "PLAID_ERROR",
      error: "Balance verification failed.",
    };
  }

  const accounts: Array<{
    type: string;
    name: string;
    balances: { available: number | null };
  }> = (result.accounts as never) ?? [];

  const depository = accounts
    .filter((a) => a.type === "depository")
    .map((a) => ({ name: a.name, available: a.balances.available ?? 0 }))
    .sort((a, b) => b.available - a.available);

  const itemBalance = depository.reduce((sum, account) => sum + account.available, 0);
  return { ok: true, balance: itemBalance, accounts: depository };
}

/**
 * Fetches the aggregate balance across every linked Plaid item, or returns
 * the mock balance when no access token is configured. Items are fetched in
 * parallel, each bounded by its own timeout; the aggregate fails closed — if
 * any linked item errors, no balance is returned at all, because a partial
 * sum is not the sum the issuer would be attesting to. Never surfaces raw
 * Plaid error text (or credentials) to the caller or the logs — only a
 * stable `code` and a generic message.
 */
export async function fetchPlaidBalance(requestId: string): Promise<PlaidBalanceResult> {
  const tokens = plaidAccessTokens();
  if (tokens.length === 0) {
    const rawMockBalance = process.env.PLAID_MOCK_BALANCE;
    const parsedMockBalance = rawMockBalance !== undefined ? Number(rawMockBalance) : NaN;
    const mockBalance =
      Number.isFinite(parsedMockBalance) && parsedMockBalance >= 0 ? parsedMockBalance : 50000;

    logger.warn(
      stripSensitiveFields({ event: "plaid_mock_mode", requestId }),
      `No Plaid access tokens configured — returning mock balance $${mockBalance.toLocaleString()}`,
    );

    return { ok: true, mock: true, balance: mockBalance };
  }

  if (tokens.length > MAX_PLAID_ITEMS) {
    logger.error(
      stripSensitiveFields({
        event: "plaid_too_many_items",
        itemCount: tokens.length,
        requestId,
      }),
      `PLAID_ACCESS_TOKENS lists ${tokens.length} items — the maximum is ${MAX_PLAID_ITEMS}. Aggregation fails closed rather than dropping sources.`,
    );
    return {
      ok: false,
      status: 502,
      code: "PLAID_ERROR",
      error: "Balance verification failed.",
    };
  }

  // Promise.all preserves token order, so the first failing item (in
  // configuration order) determines the error returned.
  const results = await Promise.all(
    tokens.map((token, itemIndex) => fetchPlaidItemBalance(token, itemIndex, requestId)),
  );

  const failure = results.find((result): result is PlaidBalanceFailure => !result.ok);
  if (failure) return failure;

  const successes = results.filter(
    (result): result is PlaidBalanceSuccess => result.ok,
  );
  const accounts = successes
    .flatMap((result) => result.accounts ?? [])
    .sort((a, b) => b.available - a.available);
  const balance = successes.reduce((sum, result) => sum + result.balance, 0);

  logger.info(
    stripSensitiveFields({
      event: "plaid_aggregate",
      itemCount: successes.length,
      accountCount: accounts.length,
      requestId,
    }),
  );

  return { ok: true, balance, sources: successes.length, accounts };
}

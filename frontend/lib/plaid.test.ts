import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPlaidBalance, plaidAccessTokens } from "./plaid";

function plaidResponse(accounts: unknown[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ accounts }),
  };
}

describe("fetchPlaidBalance", () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PLAID_ACCESS_TOKEN;
    delete process.env.PLAID_ACCESS_TOKENS;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the mock balance when no access token is set", async () => {
    const result = await fetchPlaidBalance("req-1");
    expect(result).toEqual({ ok: true, mock: true, balance: 50000 });
  });

  it("returns the mock balance when PLAID_ACCESS_TOKENS is set to blank entries only", async () => {
    process.env.PLAID_ACCESS_TOKENS = " , ,";
    const result = await fetchPlaidBalance("req-1b");
    expect(result).toEqual({ ok: true, mock: true, balance: 50000 });
  });

  it("returns a structured PLAID_TIMEOUT error when the request is aborted", async () => {
    process.env.PLAID_ACCESS_TOKEN = "token";

    global.fetch = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const result = await fetchPlaidBalance("req-2");
    expect(result).toEqual({
      ok: false,
      status: 504,
      code: "PLAID_TIMEOUT",
      error: "Balance verification timed out. Please try again.",
    });
  });

  it("returns a structured PLAID_UNAVAILABLE error on a network failure", async () => {
    process.env.PLAID_ACCESS_TOKEN = "token";
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await fetchPlaidBalance("req-3");
    expect(result).toEqual({
      ok: false,
      status: 502,
      code: "PLAID_UNAVAILABLE",
      error: "Balance verification service is unavailable. Please try again.",
    });
  });

  it("returns a structured PLAID_ERROR without leaking Plaid's raw error_message", async () => {
    process.env.PLAID_ACCESS_TOKEN = "token";
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () =>
        Promise.resolve({
          error_code: "ITEM_LOGIN_REQUIRED",
          error_message: "the access token for this item is no longer valid: super secret detail",
        }),
    });

    const result = await fetchPlaidBalance("req-4");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.code).toBe("PLAID_ERROR");
      expect(result.error).not.toContain("super secret detail");
      expect(result.error).not.toContain("ITEM_LOGIN_REQUIRED");
    }
  });

  it("returns PLAID_UNAVAILABLE when Plaid's response body isn't valid JSON", async () => {
    process.env.PLAID_ACCESS_TOKEN = "token";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("invalid json")),
    });

    const result = await fetchPlaidBalance("req-5");
    expect(result).toEqual({
      ok: false,
      status: 502,
      code: "PLAID_UNAVAILABLE",
      error: "Balance verification service returned an invalid response.",
    });
  });

  it("sums every depository account of a single item into the aggregate", async () => {
    process.env.PLAID_ACCESS_TOKEN = "token";
    global.fetch = vi.fn().mockResolvedValue(
      plaidResponse([
        { type: "depository", name: "Checking", balances: { available: 1200 } },
        { type: "depository", name: "Savings", balances: { available: 9800 } },
        { type: "credit", name: "Credit Card", balances: { available: 500 } },
      ]),
    );

    const result = await fetchPlaidBalance("req-6");
    expect(result).toEqual({
      ok: true,
      balance: 11000,
      sources: 1,
      accounts: [
        { name: "Savings", available: 9800 },
        { name: "Checking", available: 1200 },
      ],
    });
  });

  it("aggregates balances across multiple linked items", async () => {
    process.env.PLAID_ACCESS_TOKENS = "item-a,item-b";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        plaidResponse([
          { type: "depository", name: "Checking", balances: { available: 1500 } },
        ]),
      )
      .mockResolvedValueOnce(
        plaidResponse([
          { type: "depository", name: "High-Yield Savings", balances: { available: 25000 } },
          { type: "depository", name: "Brokerage Cash", balances: { available: 3500 } },
        ]),
      );
    global.fetch = fetchMock;

    const result = await fetchPlaidBalance("req-8");
    expect(result).toEqual({
      ok: true,
      balance: 30000,
      sources: 2,
      accounts: [
        { name: "High-Yield Savings", available: 25000 },
        { name: "Brokerage Cash", available: 3500 },
        { name: "Checking", available: 1500 },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("merges PLAID_ACCESS_TOKEN and PLAID_ACCESS_TOKENS, de-duplicating tokens", async () => {
    process.env.PLAID_ACCESS_TOKEN = "item-a";
    process.env.PLAID_ACCESS_TOKENS = "item-b, item-a";
    const fetchMock = vi.fn().mockImplementation(((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Promise.resolve(
        plaidResponse([
          {
            type: "depository",
            name: `Account ${body.access_token}`,
            balances: { available: 1000 },
          },
        ]),
      );
    }) as typeof fetch);
    global.fetch = fetchMock;

    const result = await fetchPlaidBalance("req-9");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.balance).toBe(2000);
      expect(result.sources).toBe(2);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when one linked item errors instead of understating the aggregate", async () => {
    process.env.PLAID_ACCESS_TOKENS = "item-a,item-broken,item-c";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        plaidResponse([
          { type: "depository", name: "Checking", balances: { available: 4000 } },
        ]),
      )
      .mockResolvedValueOnce({
        ok: false,
        json: () =>
          Promise.resolve({ error_code: "ITEM_LOGIN_REQUIRED", error_message: "secret" }),
      })
      .mockResolvedValueOnce(
        plaidResponse([
          { type: "depository", name: "Savings", balances: { available: 6000 } },
        ]),
      );
    global.fetch = fetchMock;

    const result = await fetchPlaidBalance("req-10");
    expect(result).toEqual({
      ok: false,
      status: 502,
      code: "PLAID_ERROR",
      error: "Balance verification failed.",
    });
  });

  it("fails closed when more items are configured than the fan-out bound", async () => {
    const tokens = Array.from({ length: 26 }, (_, i) => `item-${i}`).join(",");
    process.env.PLAID_ACCESS_TOKENS = tokens;
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const result = await fetchPlaidBalance("req-11");
    expect(result).toEqual({
      ok: false,
      status: 502,
      code: "PLAID_ERROR",
      error: "Balance verification failed.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts an item with no depository accounts as a zero-balance source", async () => {
    process.env.PLAID_ACCESS_TOKENS = "item-a,item-b";
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        plaidResponse([
          { type: "depository", name: "Checking", balances: { available: 700 } },
        ]),
      )
      .mockResolvedValueOnce(
        plaidResponse([{ type: "credit", name: "Card", balances: { available: 100 } }]),
      );

    const result = await fetchPlaidBalance("req-12");
    expect(result).toEqual({
      ok: true,
      balance: 700,
      sources: 2,
      accounts: [{ name: "Checking", available: 700 }],
    });
  });

  it("passes an AbortSignal to fetch so a hung request can actually be cancelled", async () => {
    process.env.PLAID_ACCESS_TOKEN = "token";
    const fetchMock = vi.fn().mockResolvedValue(plaidResponse([]));
    global.fetch = fetchMock;

    await fetchPlaidBalance("req-7");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("plaidAccessTokens", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PLAID_ACCESS_TOKEN;
    delete process.env.PLAID_ACCESS_TOKENS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns an empty list when nothing is configured", () => {
    expect(plaidAccessTokens()).toEqual([]);
  });

  it("returns the single token from PLAID_ACCESS_TOKEN", () => {
    process.env.PLAID_ACCESS_TOKEN = "item-a";
    expect(plaidAccessTokens()).toEqual(["item-a"]);
  });

  it("splits, trims, and drops blank entries from PLAID_ACCESS_TOKENS", () => {
    process.env.PLAID_ACCESS_TOKENS = " item-a , ,item-b ,,";
    expect(plaidAccessTokens()).toEqual(["item-a", "item-b"]);
  });
});

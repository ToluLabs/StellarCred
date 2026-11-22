// Configurable backoff, jitter, retry ceilings and abort signals for every
// RPC, indexer and polling call the SDK makes (#1056).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { isVerified, checkClaim } = vi.hoisted(() => ({
  isVerified: vi.fn(),
  checkClaim: vi.fn(),
}));

vi.mock("../../proof-registry/src/index", () => ({
  Client: vi.fn(function ProofRegistryClient() {
    return { is_verified: isVerified, check_claim: checkClaim };
  }),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {},
  StrKey: {
    isValidEd25519PublicKey: vi.fn((address: string) => /^G[A-Z2-7]{10,}$/.test(address)),
  },
}));

import {
  computeBackoffDelay,
  resolveJitter,
  isJitterOption,
  sleep,
  type BackoffPolicy,
} from "./backoff";
import {
  configure,
  resetConfig,
  getConfig,
  withRetry,
  watchClaim,
  subscribeClaims,
  submitTransaction,
  ConfigError,
  RpcError,
  type RetryAttemptInfo,
} from "./index";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const transient = () => new RpcError("service unavailable", { status: 503 });

beforeEach(() => {
  resetConfig();
  isVerified.mockReset();
  checkClaim.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetConfig();
});

// ---------------------------------------------------------------------------
// computeBackoffDelay
// ---------------------------------------------------------------------------

describe("computeBackoffDelay", () => {
  const policy = (jitter: BackoffPolicy["jitter"]): BackoffPolicy => ({
    baseDelayMs: 100,
    maxDelayMs: 500,
    jitter,
  });

  it('"none" doubles from the base and stops at the cap', () => {
    const delays = [1, 2, 3, 4, 5].map((n) => computeBackoffDelay(n, 0, policy("none")));
    expect(delays).toEqual([100, 200, 400, 500, 500]);
  });

  it('"equal" keeps the pre-#1056 curve: half fixed, half random', () => {
    expect(computeBackoffDelay(3, 0, policy("equal"), () => 0)).toBe(200);
    expect(computeBackoffDelay(3, 0, policy("equal"), () => 0.5)).toBe(300);
  });

  it('"full" draws from zero up to the exponential delay', () => {
    expect(computeBackoffDelay(3, 0, policy("full"), () => 0)).toBe(0);
    expect(computeBackoffDelay(3, 0, policy("full"), () => 0.5)).toBe(200);
    expect(computeBackoffDelay(9, 0, policy("full"), () => 0.999)).toBeLessThan(500);
  });

  it('"decorrelated" draws between the base and three times the previous delay', () => {
    // First retry: [base, 3 * base].
    expect(computeBackoffDelay(1, 0, policy("decorrelated"), () => 0)).toBe(100);
    expect(computeBackoffDelay(1, 0, policy("decorrelated"), () => 0.5)).toBe(200);
    // Later retries grow from the previous delay, still floored at the base.
    expect(computeBackoffDelay(2, 150, policy("decorrelated"), () => 0)).toBe(100);
    expect(computeBackoffDelay(2, 150, policy("decorrelated"), () => 0.5)).toBe(275);
    // ...and never exceed the cap.
    expect(computeBackoffDelay(5, 400, policy("decorrelated"), () => 0.999)).toBeLessThanOrEqual(
      500,
    );
  });

  it('"decorrelated" stays within [base, min(cap, 3 * previous)] for any draw', () => {
    let previous = 0;
    for (let attempt = 1; attempt <= 2000; attempt++) {
      const delay = computeBackoffDelay(attempt, previous, policy("decorrelated"));
      const ceiling = Math.min(500, (previous || 100) * 3);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(ceiling);
      previous = attempt % 7 === 0 ? 0 : delay;
    }
  });

  it("spreads clients that failed together instead of retrying them in one burst", () => {
    const clients = 200;
    const jittered = new Set(
      Array.from({ length: clients }, () => computeBackoffDelay(1, 0, policy("decorrelated"))),
    );
    const fixed = new Set(
      Array.from({ length: clients }, () => computeBackoffDelay(1, 0, policy("none"))),
    );
    expect(fixed.size).toBe(1);
    expect(jittered.size).toBeGreaterThan(clients * 0.95);
  });

  it("returns the cap when the base is larger than the cap", () => {
    const p: BackoffPolicy = { baseDelayMs: 900, maxDelayMs: 300, jitter: "decorrelated" };
    expect(computeBackoffDelay(1, 0, p, () => 0.7)).toBe(300);
  });
});

describe("jitter option", () => {
  it("maps true, false and undefined onto strategies", () => {
    expect(resolveJitter(undefined)).toBe("full");
    expect(resolveJitter(true)).toBe("full");
    expect(resolveJitter("decorrelated")).toBe("decorrelated");
    expect(resolveJitter(false)).toBe("none");
    expect(resolveJitter("full")).toBe("full");
  });

  it("accepts only known values", () => {
    expect(isJitterOption("equal")).toBe(true);
    expect(isJitterOption(false)).toBe(true);
    expect(isJitterOption("exponential")).toBe(false);
    expect(isJitterOption(1)).toBe(false);
  });
});

describe("sleep", () => {
  it("rejects with the abort reason and clears its timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry backoff, ceilings and abort signals (#1056)", () => {
  it("uses full jitter by default and reports exact delays", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const seen: RetryAttemptInfo[] = [];
    const operation = vi.fn().mockRejectedValueOnce(transient()).mockRejectedValueOnce(transient());
    operation.mockResolvedValue("ok");

    const result = withRetry(operation, { onRetry: (info) => seen.push(info) });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe("ok");
    // Defaults: base 500, cap 5000. Retry 1 in [0, 500]; retry 2 in [0, 1000].
    expect(seen.map((s) => s.delayMs)).toEqual([250, 500]);
    expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
    expect(seen[1].elapsedMs).toBe(250);
  });

  it("keeps the default worst case at the plain exponential total", () => {
    // With the default 3 retries, full jitter never waits longer in total than
    // 500 + 1000 + 2000 ms, so a fail-soft read cannot hang longer than before.
    const policy: BackoffPolicy = { baseDelayMs: 500, maxDelayMs: 5000, jitter: "full" };
    const worst = [1, 2, 3].reduce(
      (sum, n) => sum + computeBackoffDelay(n, 0, policy, () => 0.9999),
      0,
    );
    expect(worst).toBeLessThan(3500);
  });

  it("passes the attempt number and signal to the operation", async () => {
    const controller = new AbortController();
    const contexts: Array<{ attempt: number; signal?: AbortSignal }> = [];
    const operation = vi.fn(async (ctx: { attempt: number; signal?: AbortSignal }) => {
      contexts.push(ctx);
      if (contexts.length < 3) throw transient();
      return "ok";
    });

    await withRetry(operation, { baseDelayMs: 0, maxDelayMs: 0, signal: controller.signal });

    expect(contexts.map((c) => c.attempt)).toEqual([0, 1, 2]);
    expect(contexts.every((c) => c.signal === controller.signal)).toBe(true);
  });

  it("stops at the retries ceiling and throws the last error", async () => {
    const operation = vi.fn().mockRejectedValue(transient());
    await expect(
      withRetry(operation, { retries: 2, baseDelayMs: 0, maxDelayMs: 0 }),
    ).rejects.toThrow("service unavailable");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not start a retry that would end past maxElapsedMs", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValue(transient());
    const result = withRetry(operation, {
      retries: 10,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitter: false,
      maxElapsedMs: 250,
    }).catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(5_000);

    // Delays would be 100, 200, ...: 100 fits the 250 ms budget, 100 + 200 does not.
    expect(operation).toHaveBeenCalledTimes(2);
    expect(await result).toBeInstanceOf(RpcError);
  });

  it("throws the abort reason without calling the operation when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));
    const operation = vi.fn();
    await expect(withRetry(operation, { signal: controller.signal })).rejects.toThrow(
      "caller gave up",
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("cancels a pending delay as soon as the signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(transient());
    const result = withRetry(operation, {
      retries: 5,
      baseDelayMs: 1000,
      maxDelayMs: 1000,
      jitter: false,
      signal: controller.signal,
    }).catch((e: Error) => e);

    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error("unsubscribed"));
    // Settles right away, not when the 1000 ms delay would have ended.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await result) as Error).message).toBe("unsubscribed");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry an attempt that failed because the signal aborted", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort(new Error("aborted mid-request"));
      throw transient();
    });
    await expect(
      withRetry(operation, { retries: 3, baseDelayMs: 0, signal: controller.signal }),
    ).rejects.toThrow("aborted mid-request");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("ignores exceptions thrown by onRetry", async () => {
    const operation = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("ok");
    await expect(
      withRetry(operation, {
        baseDelayMs: 0,
        maxDelayMs: 0,
        onRetry: () => {
          throw new Error("logger broke");
        },
      }),
    ).resolves.toBe("ok");
  });

  it("rejects invalid per-call options with ConfigError", async () => {
    const op = async () => "ok";
    for (const bad of [
      { retries: -1 },
      { retries: 1.5 },
      { baseDelayMs: Number.NaN },
      { maxDelayMs: -5 },
      { maxElapsedMs: 0 },
      { jitter: "exponential" as never },
    ]) {
      await expect(withRetry(op, bad)).rejects.toBeInstanceOf(ConfigError);
    }
  });
});

describe("configure() retry settings", () => {
  it("accepts strategies and budgets and applies them to every call", async () => {
    vi.useFakeTimers();
    configure({ jitter: "none", baseDelayMs: 50, maxDelayMs: 1000, maxElapsedMs: 60_000 });
    expect(getConfig().jitter).toBe("none");
    expect(getConfig().maxElapsedMs).toBe(60_000);

    const delays: number[] = [];
    const operation = vi.fn().mockRejectedValueOnce(transient()).mockRejectedValueOnce(transient());
    operation.mockResolvedValue("ok");
    const result = withRetry(operation, { onRetry: (i) => delays.push(i.delayMs) });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("ok");
    expect(delays).toEqual([50, 100]);
  });

  it("defaults to full jitter with no time budget", () => {
    expect(getConfig().jitter).toBe(true);
    expect(getConfig().maxElapsedMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("rejects invalid retry settings", () => {
    expect(() => configure({ retries: -2 })).toThrow(ConfigError);
    expect(() => configure({ maxElapsedMs: -1 })).toThrow(ConfigError);
    expect(() => configure({ jitter: "random" as never })).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// Callers: submission, claim polling and subscriptions
// ---------------------------------------------------------------------------

describe("submitTransaction onRetry", () => {
  it("reports the exact delay and is not called after the final failure", async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const result = submitTransaction(() => Promise.reject(transient()), {
      retryOptions: { retries: 2, baseDelayMs: 100, maxDelayMs: 1000, jitter: false },
      onRetry,
    }).catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [1, 100],
      [2, 200],
    ]);
  });
  it("still calls onRetry when the caller's retryOptions.onRetry throws", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const result = await submitTransaction(
      async () => {
        calls++;
        if (calls < 2) throw transient();
        return "ok";
      },
      {
        retryOptions: {
          baseDelayMs: 0,
          maxDelayMs: 0,
          onRetry: () => {
            throw new Error("caller hook broke");
          },
        },
        onRetry,
      },
    );
    expect(result).toBe("ok");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("watchClaim polling", () => {
  it("cancels a read that is waiting to retry when the watch is stopped", async () => {
    // Real timers: the chain client is created asynchronously.
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue(new Error("503 service unavailable"));
    checkClaim.mockRejectedValue(new Error("503 service unavailable"));
    const reads = () => isVerified.mock.calls.length + checkClaim.mock.calls.length;

    const onChange = vi.fn();
    const stop = watchClaim(WALLET, "kyc", {
      pollMs: 60_000,
      timeoutMs: 600_000,
      onChange,
      retryOptions: { retries: 20, baseDelayMs: 150, maxDelayMs: 150, jitter: false },
    });
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(0), { timeout: 2_000 });

    stop();
    const readsAtStop = reads();
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(reads()).toBe(readsAtStop);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("subscribeClaims webhook delivery", () => {
  it("stops retrying a failing webhook after unsubscribe and reports no error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    configure({ indexerUrl: "http://indexer.test", jitter: false, baseDelayMs: 1000 });

    const webhookUrl = "https://protocol.test/hooks";
    let recent: unknown[] = [];
    const webhookSignals: Array<AbortSignal | null | undefined> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === webhookUrl) {
        webhookSignals.push(init?.signal);
        return { ok: false, status: 503, statusText: "busy", json: async () => ({}) };
      }
      const body = url.includes("/recent")
        ? { claims: recent, nextCursor: null }
        : { wallet: WALLET, claims: [] };
      return { ok: true, status: 200, statusText: "OK", json: async () => body };
    });
    vi.stubGlobal("fetch", fetchMock);

    const onError = vi.fn();
    const stop = subscribeClaims({
      wallets: [WALLET],
      pollMs: 1000,
      onError,
      webhook: { url: webhookUrl, retries: 5 },
    });
    await vi.advanceTimersByTimeAsync(0);

    recent = [
      {
        id: 2,
        wallet: WALLET,
        credential_type: "kyc",
        issuer: "GISSUER",
        verified_at: 1_699_999_940,
        expiry: 1_700_086_400,
        ledger_sequence: 200,
        threshold: null,
        revoked: 0,
        reason_code: "other",
      },
    ];
    await vi.advanceTimersByTimeAsync(1000);
    const deliveries = webhookSignals.length;
    expect(deliveries).toBeGreaterThan(0);
    expect(webhookSignals[0]).toBeInstanceOf(AbortSignal);

    stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(webhookSignals.length).toBe(deliveries);
    expect(onError).not.toHaveBeenCalled();
  });
});

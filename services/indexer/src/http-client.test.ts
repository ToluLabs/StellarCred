/**
 * http-client.test.ts — #761: retry/backoff and circuit-breaker behaviour.
 *
 * All tests drive the client with an injected fetch stub, a deterministic
 * rng and (where timing matters) an injected clock, so no test touches the
 * network and none depends on wall-clock sleeps longer than a few ms.
 */

import {
  CircuitOpenError,
  computeBackoffDelayMs,
  createHttpClient,
  isTransientStatus,
  parseRetryAfterMs,
  type HttpClientLogger,
} from "./http-client";

// ── helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function recordingLogger() {
  const lines: { level: string; msg: string }[] = [];
  const logger: HttpClientLogger = {
    info: (msg) => lines.push({ level: "info", msg }),
    warn: (msg) => lines.push({ level: "warn", msg }),
    error: (msg) => lines.push({ level: "error", msg }),
  };
  return { logger, lines };
}

/** Fast, deterministic client options shared by most tests. */
const FAST = {
  retry: { baseDelayMs: 1, maxDelayMs: 5_000, jitterRatio: 0 },
};

/** Script a fetch stub from a list of responses/throws; records calls. */
function scriptedFetch(...script: (Response | Error)[]) {
  const calls: string[] = [];
  const impl = async (input: string) => {
    calls.push(input);
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("isTransientStatus", () => {
  it.each([429, 408, 500, 502, 503, 504, 599])("retries %i", (s) =>
    expect(isTransientStatus(s)).toBe(true),
  );
  it.each([200, 201, 400, 401, 403, 404, 422])("does not retry %i", (s) =>
    expect(isTransientStatus(s)).toBe(false),
  );
});

describe("computeBackoffDelayMs", () => {
  const policy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0 };

  it("doubles per attempt", () => {
    expect(computeBackoffDelayMs(1, policy, () => 0)).toBe(500);
    expect(computeBackoffDelayMs(2, policy, () => 0)).toBe(1_000);
    expect(computeBackoffDelayMs(3, policy, () => 0)).toBe(2_000);
    expect(computeBackoffDelayMs(4, policy, () => 0)).toBe(4_000);
  });

  it("caps at maxDelayMs", () => {
    expect(computeBackoffDelayMs(10, policy, () => 0)).toBe(8_000);
  });

  it("adds at most jitterRatio × delay of jitter, still capped", () => {
    const jittered = { ...policy, jitterRatio: 0.2 };
    expect(computeBackoffDelayMs(1, jittered, () => 0.5)).toBe(550);
    expect(computeBackoffDelayMs(1, jittered, () => 1)).toBe(600);
    expect(computeBackoffDelayMs(10, jittered, () => 1)).toBe(8_000);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("5", 0)).toBe(5_000);
    expect(parseRetryAfterMs(" 1.5 ", 0)).toBe(1_500);
    expect(parseRetryAfterMs("0", 0)).toBe(0);
  });
  it("rejects negative and unparseable values", () => {
    expect(parseRetryAfterMs("-3", 0)).toBeNull();
    expect(parseRetryAfterMs("soon", 0)).toBeNull();
    expect(parseRetryAfterMs(null, 0)).toBeNull();
  });
  it("parses an HTTP-date relative to `now`", () => {
    const target = Date.UTC(2026, 9, 19, 12, 0, 0);
    expect(parseRetryAfterMs(new Date(target).toUTCString(), target - 10_000)).toBe(10_000);
    // A date already in the past means "retry now", never negative.
    expect(parseRetryAfterMs(new Date(target).toUTCString(), target + 10_000)).toBe(0);
  });
});

// ── retry behaviour ──────────────────────────────────────────────────────────

describe("createHttpClient — retries", () => {
  it("retries a 429 and returns the eventual success", async () => {
    const { impl, calls } = scriptedFetch(
      new Response("slow down", { status: 429 }),
      jsonResponse({ ok: 1 }),
    );
    const http = createHttpClient({ ...FAST, fetchImpl: impl });
    const res = await http.fetch("https://api.test/x");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("honours Retry-After on 429 — waits at least the advertised time", async () => {
    const { logger, lines } = recordingLogger();
    const { impl } = scriptedFetch(
      new Response("slow down", { status: 429, headers: { "retry-after": "0.05" } }),
      jsonResponse({ ok: 1 }),
    );
    const http = createHttpClient({ ...FAST, fetchImpl: impl, logger });
    await http.fetch("https://api.test/x");
    // Computed backoff would be 1ms; Retry-After asked for 50ms.
    expect(lines.some((l) => /retrying in 50ms/.test(l.msg))).toBe(true);
  });

  it("retries transient 5xx", async () => {
    const { impl, calls } = scriptedFetch(
      new Response("bad", { status: 502 }),
      new Response("worse", { status: 503 }),
      jsonResponse({ ok: 1 }),
    );
    const http = createHttpClient({ ...FAST, fetchImpl: impl });
    expect((await http.fetch("https://api.test/x")).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("does NOT retry non-transient 4xx — a 404 is an answer, not a failure", async () => {
    const { impl, calls } = scriptedFetch(new Response("nope", { status: 404 }));
    const http = createHttpClient({ ...FAST, fetchImpl: impl });
    const res = await http.fetch("https://api.test/x");
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("retries network errors and surfaces a clear message when they persist", async () => {
    const boom = new Error("socket hang up");
    const { impl, calls } = scriptedFetch(boom, boom, boom);
    const http = createHttpClient({ ...FAST, retry: { ...FAST.retry, maxAttempts: 3 }, fetchImpl: impl });
    await expect(http.fetch("https://api.test/x")).rejects.toThrow(
      "https://api.test/x failed after 3 attempts (network error: socket hang up)",
    );
    expect(calls).toHaveLength(3);
  });

  it("surfaces persistent rate limiting with the status and attempt count", async () => {
    const { impl } = scriptedFetch(new Response("no", { status: 503 }));
    const http = createHttpClient({ ...FAST, retry: { ...FAST.retry, maxAttempts: 2 }, fetchImpl: impl });
    await expect(http.fetch("https://api.test/x")).rejects.toThrow(
      "failed after 2 attempts (HTTP 503) — upstream is rate-limiting or unhealthy",
    );
  });

  it("maxAttempts=1 disables retrying", async () => {
    const { impl, calls } = scriptedFetch(new Response("no", { status: 429 }));
    const http = createHttpClient({
      ...FAST,
      retry: { ...FAST.retry, maxAttempts: 1 },
      fetchImpl: impl,
    });
    await expect(http.fetch("https://api.test/x")).rejects.toThrow(/HTTP 429/);
    expect(calls).toHaveLength(1);
  });
});

// ── circuit breaker ──────────────────────────────────────────────────────────

describe("createHttpClient — circuit breaker", () => {
  const breaker = { failureThreshold: 2, resetTimeoutMs: 100 };

  function failingClient(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
    let clock = 1_000;
    const { logger, lines } = recordingLogger();
    const http = createHttpClient({
      ...FAST,
      retry: { ...FAST.retry, maxAttempts: 1 },
      breaker,
      fetchImpl,
      logger,
      now: () => clock,
      random: () => 0,
    });
    return { http, lines, advance: (ms: number) => (clock += ms) };
  }

  it("opens after N consecutive failed calls and fails fast without network I/O", async () => {
    const { impl, calls } = scriptedFetch(new Response("no", { status: 503 }));
    const { http, lines } = failingClient(impl);

    await expect(http.fetch("u")).rejects.toThrow(/HTTP 503/);
    expect(http.breakerState()).toBe("closed");
    await expect(http.fetch("u")).rejects.toThrow(/HTTP 503/);
    expect(http.breakerState()).toBe("open");
    expect(lines.some((l) => l.level === "error" && /breaker OPEN after 2/.test(l.msg))).toBe(true);

    const callsBefore = calls.length;
    await expect(http.fetch("u")).rejects.toThrow(CircuitOpenError);
    expect(calls).toHaveLength(callsBefore); // refused without touching the network
  });

  it("reports the remaining cooldown on CircuitOpenError", async () => {
    const { impl } = scriptedFetch(new Response("no", { status: 503 }));
    const { http, advance } = failingClient(impl);
    await expect(http.fetch("u")).rejects.toThrow(/HTTP 503/);
    await expect(http.fetch("u")).rejects.toThrow(/HTTP 503/);
    advance(40);
    await expect(http.fetch("u")).rejects.toThrow(/retry in 60ms/);
  });

  it("half-opens after the reset window and closes again on a successful probe", async () => {
    let up = false;
    const impl = async () =>
      up ? jsonResponse({ ok: 1 }) : new Response("no", { status: 503 });
    const { http, advance } = failingClient(impl);

    await expect(http.fetch("u")).rejects.toThrow(/HTTP 503/);
    await expect(http.fetch("u")).rejects.toThrow(/HTTP 503/);
    expect(http.breakerState()).toBe("open");

    advance(100);
    up = true;
    const res = await http.fetch("u");
    expect(res.status).toBe(200);
    expect(http.breakerState()).toBe("closed");
    expect(http.consecutiveFailures()).toBe(0);
  });

  it("re-opens when the half-open probe fails", async () => {
    const { impl } = scriptedFetch(new Response("no", { status: 503 }));
    const { http, advance } = failingClient(impl);

    await expect(http.fetch("u")).rejects.toThrow();
    await expect(http.fetch("u")).rejects.toThrow();
    advance(100);
    await expect(http.fetch("u")).rejects.toThrow(/HTTP 503/); // probe failed
    expect(http.breakerState()).toBe("open");
    await expect(http.fetch("u")).rejects.toThrow(CircuitOpenError);
  });

  it("allows only one concurrent half-open probe", async () => {
    let gateNext = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const impl = async () => {
      if (gateNext) await gate;
      return new Response("no", { status: 503 });
    };
    const { http, advance } = failingClient(impl);

    await expect(http.fetch("u")).rejects.toThrow();
    await expect(http.fetch("u")).rejects.toThrow();
    advance(100);

    gateNext = true;
    const probe = http.fetch("u").catch((e) => e); // holds the probe slot (awaits gate)
    await expect(http.fetch("u")).rejects.toThrow(CircuitOpenError); // no second probe
    release();
    expect(await probe).toBeInstanceOf(Error);
  });

  it("a successful call resets the failure streak", async () => {
    const responses = [
      new Response("no", { status: 503 }),
      jsonResponse({ ok: 1 }),
      new Response("no", { status: 503 }),
      jsonResponse({ ok: 1 }),
    ];
    let i = 0;
    const http = createHttpClient({
      ...FAST,
      retry: { ...FAST.retry, maxAttempts: 1 },
      breaker,
      fetchImpl: async () => responses[i++],
    });

    await expect(http.fetch("u")).rejects.toThrow(/HTTP 503/);
    await http.fetch("u");
    await expect(http.fetch("u")).rejects.toThrow(/HTTP 503/);
    await http.fetch("u");
    expect(http.breakerState()).toBe("closed");
  });

  it("counts a non-transient 404 as a response from the server, not a failure", async () => {
    const http = createHttpClient({
      ...FAST,
      breaker: { failureThreshold: 1, resetTimeoutMs: 100 },
      fetchImpl: async () => new Response("nope", { status: 404 }),
    });
    const res = await http.fetch("u");
    expect(res.status).toBe(404);
    expect(http.breakerState()).toBe("closed");
    expect(http.consecutiveFailures()).toBe(0);
  });
});

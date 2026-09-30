// subscribeClaims — indexer-backed real-time subscriptions (#392)
//
// The indexer HTTP API (GET /recent, GET /claims) is mocked at the fetch
// boundary; the subscription loop is driven with fake timers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../proof-registry/src/index", () => ({
  Client: vi.fn(function ProofRegistryClient() {
    return {};
  }),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {},
  StrKey: {
    isValidEd25519PublicKey: vi.fn(
      (address: string) =>
        address === WALLET_A || address === WALLET_B,
    ),
  },
}));

import {
  configure,
  resetConfig,
  subscribeClaims,
  ConfigError,
  InvalidAddressError,
  InvalidClaimTypeError,
  type ClaimChangeEvent,
  type IndexerClaimRow,
} from "../index";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";
const INDEXER = "http://indexer.test";

const T0_SECONDS = 1_700_000_000;

function makeRow(overrides: Partial<IndexerClaimRow> = {}): IndexerClaimRow {
  return {
    id: 1,
    wallet: WALLET_A,
    credential_type: "kyc",
    issuer: "GISSUER000000000000000000000000000000000000000000000000000",
    verified_at: T0_SECONDS - 60,
    expiry: T0_SECONDS + 86_400,
    ledger_sequence: 100,
    threshold: null,
    revoked: 0,
    ...overrides,
  };
}

interface MockIndexer {
  recent: IndexerClaimRow[];
  claims: Record<string, IndexerClaimRow[]>;
}

/** fetch mock routing /recent and /claims?wallet= from a small fixture. */
function installIndexerMock(state: MockIndexer): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/recent")) {
      return jsonResponse({ claims: state.recent, nextCursor: null });
    }
    if (url.includes("/claims?wallet=")) {
      const wallet = decodeURIComponent(new URL(url).searchParams.get("wallet") ?? "");
      return jsonResponse({ wallet, claims: state.claims[wallet] ?? [] });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Advance `ms`, flushing timers and awaited microtasks at each step. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("subscribeClaims (#392)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_SECONDS * 1000);
    resetConfig();
    configure({ indexerUrl: INDEXER });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("seeds the baseline from /claims without emitting gained", async () => {
    installIndexerMock({
      recent: [],
      claims: { [WALLET_A]: [makeRow()] },
    });
    const onGained = vi.fn();
    const stop = subscribeClaims({
      wallets: [WALLET_A],
      onGained,
    });
    await flush();

    expect(onGained).not.toHaveBeenCalled();
    stop();
  });

  it("emits gained when a watched wallet appears in the /recent feed", async () => {
    const state: MockIndexer = { recent: [], claims: {} };
    installIndexerMock(state);
    const events: ClaimChangeEvent[] = [];
    const stop = subscribeClaims({
      wallets: [WALLET_A],
      claims: ["kyc"],
      pollMs: 1000,
      onChange: (e) => events.push(e),
    });
    await flush();
    expect(events).toHaveLength(0);

    state.recent = [makeRow({ ledger_sequence: 200 })];
    await advance(1000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "gained",
      wallet: WALLET_A,
      claim: "kyc",
      at: T0_SECONDS + 1,
      expiry: T0_SECONDS + 86_400,
    });
    expect(events[0].reason).toBeUndefined();
    stop();
  });

  it("ignores feed rows for unwatched wallets and claim types", async () => {
    const state: MockIndexer = { recent: [], claims: {} };
    installIndexerMock(state);
    const onChange = vi.fn();
    const stop = subscribeClaims({
      wallets: [WALLET_A],
      claims: ["kyc"],
      pollMs: 1000,
      onChange,
    });
    await flush();

    state.recent = [
      makeRow({ credential_type: "age", ledger_sequence: 201, id: 2 }),
      makeRow({ wallet: WALLET_B, ledger_sequence: 200 }),
    ];
    await advance(1000);

    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it("does not re-emit gained for a re-verification of an active claim", async () => {
    const state: MockIndexer = {
      recent: [makeRow({ ledger_sequence: 100 })],
      claims: { [WALLET_A]: [makeRow()] },
    };
    installIndexerMock(state);
    const onGained = vi.fn();
    const stop = subscribeClaims({
      wallets: [WALLET_A],
      pollMs: 1000,
      onGained,
    });
    await flush();
    expect(onGained).not.toHaveBeenCalled(); // baseline seeded

    // Same row, newer ledger/expiry (re-submit while active).
    state.recent = [makeRow({ ledger_sequence: 300, expiry: T0_SECONDS + 200_000 })];
    await advance(1000);
    expect(onGained).not.toHaveBeenCalled();
    stop();
  });

  it("emits lost with reason revoked when a resync sees revoked=1", async () => {
    const active = makeRow();
    const state: MockIndexer = { recent: [active], claims: { [WALLET_A]: [active] } };
    installIndexerMock(state);
    const events: ClaimChangeEvent[] = [];
    const stop = subscribeClaims({
      wallets: [WALLET_A],
      pollMs: 1000,
      resyncMs: 4000,
      onChange: (e) => events.push(e),
    });
    await flush();
    expect(events).toHaveLength(0);

    state.claims[WALLET_A] = [makeRow({ revoked: 1 })];
    await advance(4000);

    const lost = events.filter((e) => e.kind === "lost");
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBe("revoked");
    expect(lost[0].claim).toBe("kyc");
    stop();
  });

  it("emits lost with reason expired when the expiry passes (no new request needed)", async () => {
    const expiring = makeRow({ expiry: T0_SECONDS + 25 });
    const state: MockIndexer = { recent: [expiring], claims: { [WALLET_A]: [expiring] } };
    installIndexerMock(state);
    const events: ClaimChangeEvent[] = [];
    const stop = subscribeClaims({
      wallets: [WALLET_A],
      pollMs: 1000,
      resyncMs: 100_000,
      onChange: (e) => events.push(e),
    });
    await flush();
    expect(events).toHaveLength(0);

    await advance(30_000);

    const lost = events.filter((e) => e.kind === "lost");
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBe("expired");
    // Sweep fires once, not on every subsequent tick.
    await advance(5000);
    expect(events.filter((e) => e.kind === "lost")).toHaveLength(1);
    stop();
  });

  it("POSTs events to a registered webhook with the shared secret header", async () => {
    const state: MockIndexer = { recent: [], claims: {} };
    const fetchMock = installIndexerMock(state);
    const webhookUrl = "https://protocol.test/hooks/stellarcred";
    const postResponses: { ok: boolean; status: number }[] = [];
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === webhookUrl) {
        postResponses.push({ ok: true, status: 200 });
        return jsonResponse({ received: true });
      }
      if (url.includes("/recent")) {
        return jsonResponse({ claims: state.recent, nextCursor: null });
      }
      return jsonResponse({ wallet: WALLET_A, claims: [] });
    });

    const stop = subscribeClaims({
      wallets: [WALLET_A],
      claims: ["kyc"],
      pollMs: 1000,
      webhook: { url: webhookUrl, secret: "s3cret" },
    });
    await flush();

    state.recent = [makeRow({ ledger_sequence: 200 })];
    await advance(1000);

    const post = fetchMock.mock.calls.find(
      (c) => String(c[0]) === webhookUrl && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(post).toBeDefined();
    const init = post![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-StellarCred-Webhook-Secret"]).toBe("s3cret");
    expect(headers["X-StellarCred-Event"]).toBe("claim_gained");
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      event: "claim_gained",
      kind: "gained",
      wallet: WALLET_A,
      claim: "kyc",
    });
    stop();
  });

  it("reports webhook delivery failures through onError after retries", async () => {
    const state: MockIndexer = { recent: [], claims: {} };
    const fetchMock = installIndexerMock(state);
    const webhookUrl = "https://protocol.test/hooks";
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === webhookUrl) {
        return { ok: false, status: 500, statusText: "boom", json: async () => ({}) };
      }
      if (url.includes("/recent")) {
        return jsonResponse({ claims: state.recent, nextCursor: null });
      }
      return jsonResponse({ wallet: WALLET_A, claims: [] });
    });

    const onError = vi.fn();
    const stop = subscribeClaims({
      wallets: [WALLET_A],
      pollMs: 1000,
      onError,
      webhook: { url: webhookUrl, retries: 0 },
    });
    await flush();

    state.recent = [makeRow({ ledger_sequence: 200 })];
    await advance(1000);
    // Let the fire-and-forget webhook rejection surface.
    await advance(1000);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Webhook delivery failed") }),
    );
    stop();
  });

  it("stops all indexer polling after unsubscribe", async () => {
    const fetchMock = installIndexerMock({ recent: [], claims: {} });
    const stop = subscribeClaims({ wallets: [WALLET_A], pollMs: 1000 });
    await flush();
    const callsBefore = fetchMock.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    stop();
    await advance(10_000);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("reports invalid wallets through onError and stops", async () => {
    const fetchMock = installIndexerMock({ recent: [], claims: {} });
    const onError = vi.fn();
    subscribeClaims({ wallets: ["not-a-stellar-address"], pollMs: 1000, onError });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(InvalidAddressError);
    await advance(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces indexer errors through onError without crashing the loop", async () => {
    const state: MockIndexer = { recent: [], claims: {} };
    const fetchMock = installIndexerMock(state);
    let failing = true;
    fetchMock.mockImplementation(async (input: unknown) => {
      if (failing) throw new Error("fetch failed");
      const url = String(input);
      if (url.includes("/recent")) {
        return jsonResponse({ claims: state.recent, nextCursor: null });
      }
      const wallet = decodeURIComponent(new URL(url).searchParams.get("wallet") ?? "");
      return jsonResponse({ wallet, claims: state.claims[wallet] ?? [] });
    });

    const onError = vi.fn();
    const onGained = vi.fn();
    const stop = subscribeClaims({
      wallets: [WALLET_A],
      pollMs: 1000,
      onError,
      onGained,
    });
    await flush();
    expect(onError).toHaveBeenCalled();

    failing = false;
    await advance(1000); // recovers; baseline gets seeded
    state.recent = [makeRow({ ledger_sequence: 500 })];
    await advance(1000); // feed delta streams through
    expect(onGained).toHaveBeenCalledTimes(1);
    stop();
  });

  it("emits gained for the existing baseline when emitInitialState is true", async () => {
    installIndexerMock({
      recent: [],
      claims: { [WALLET_A]: [makeRow()] },
    });
    const onGained = vi.fn();
    const stop = subscribeClaims({
      wallets: [WALLET_A],
      emitInitialState: true,
      onGained,
    });
    await flush();

    expect(onGained).toHaveBeenCalledTimes(1);
    expect(onGained.mock.calls[0][0]).toMatchObject({ kind: "gained", claim: "kyc" });
    stop();
  });

  it("validates options synchronously", () => {
    expect(() => subscribeClaims({ wallets: [] })).toThrow(ConfigError);
    expect(() => subscribeClaims({ wallets: ["  "] })).toThrow(ConfigError);
    expect(() =>
      subscribeClaims({ wallets: [WALLET_A], claims: ["bogus" as never] }),
    ).toThrow(InvalidClaimTypeError);
    expect(() =>
      subscribeClaims({
        wallets: [WALLET_A],
        baseUrl: "not a url",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      subscribeClaims({
        wallets: [WALLET_A],
        webhook: { url: "ftp://x.test" },
      }),
    ).toThrow(ConfigError);
  });

  it("resolves the indexer base URL from opts before config", async () => {
    const fetchMock = installIndexerMock({ recent: [], claims: {} });
    configure({ indexerUrl: "http://from-config.test" });
    const stop = subscribeClaims({ wallets: [WALLET_A], baseUrl: "http://from-opts.test" });
    await flush();
    stop();

    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).startsWith("http://from-opts.test")),
    ).toBe(true);
  });

  it("sends Authorization: Bearer to guarded indexer endpoints when apiKey is set", async () => {
    const fetchMock = installIndexerMock({ recent: [], claims: {} });
    const stop = subscribeClaims({ wallets: [WALLET_A], apiKey: "key123" });
    await flush();
    stop();

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer key123",
      );
    }
  });
});

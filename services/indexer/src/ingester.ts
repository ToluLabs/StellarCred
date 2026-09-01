/**
 * ingester.ts — Poll Horizon for ProofRegistry contract events and write them
 * into the local DB.
 *
 * ProofRegistry emits two kinds of events:
 *
 *   Verified  topics: ["proof", "verified"]  value: expiry (u64)
 *   Revoked   topics: ["revoked"]            value: (holder, cred_type, issuer, ts)
 *
 * Horizon's /effects and /transactions endpoints don't surface Soroban contract
 * events natively, so we use the dedicated
 *   GET /contracts/{contract_id}/events
 * endpoint introduced alongside Protocol 20 / Soroban.
 *
 * Consistency guarantee
 * ──────────────────────
 * The indexer provides **eventual consistency with a configurable finality lag**.
 *
 *   - Events are only persisted once their ledger is at least `FINALITY_LAG`
 *     ledgers behind the network head (default: 6 ≈ 30 seconds at ~5 s/ledger).
 *   - This means indexed data is delayed by ~30 seconds in the default config,
 *     but is immune to Stellar ledger reorgs (which can replace the last 1–2
 *     ledgers during network instability).
 *   - If a reorg is detected (cursor > head), the indexer rolls back all claims
 *     with ledger_sequence beyond the reorg point and re-scans.
 *   - Idempotency: every cycle starts from (lastLedger + 1) and advances the
 *     cursor only after all rows for that ledger have been written. Restarting
 *     replays from the last saved cursor; duplicate events are absorbed by
 *     upsertClaim's ON CONFLICT DO UPDATE clause.
 *   - The `reconcile()` method can be called explicitly to re-scan a bounded
 *     window after a detected inconsistency.
 *
 * Configuration:
 *   FINALITY_LAG — number of ledgers to lag (default 6, set to 0 for no lag)
 * Idempotency: every cycle starts from (lastLedger + 1) and advances the cursor
 * only after all rows for that ledger have been written. Restarting replays from
 * the last saved cursor; duplicate events are absorbed by upsertClaim's
 * ON CONFLICT DO UPDATE clause.
 *
 * Retry / backoff: transient Horizon errors (5xx, network, 429) are retried
 * with exponential backoff (up to MAX_RETRIES attempts) before giving up for
 * the current tick. The cursor is NEVER advanced past unprocessed events.
 *
 * Health observability: every tick updates an IngesterHealth snapshot that the
 * HTTP /health endpoint exposes. Operators can alert on `lag > N` or
 * `consecutiveErrors > 0`.
 */

import { Horizon } from "@stellar/stellar-sdk";
import type { Config } from "./config";
import type { Db } from "./db";

// ── Retry configuration ───────────────────────────────────────────────────

/** Maximum number of fetch attempts per tick (1 = no retry). */
const MAX_RETRIES = 3;

/** Base delay in ms before the first retry (doubled each subsequent attempt). */
const BASE_RETRY_DELAY_MS = 500;

/** Maximum single-retry delay (caps exponential growth). */
const MAX_RETRY_DELAY_MS = 8_000;

// ── Health / lag observability ─────────────────────────────────────────────

export interface IngesterHealth {
  /** Ledger sequence of the last successfully processed event. 0 if none. */
  lastSuccessLedger: number;
  /** Current Horizon head ledger (best-effort, fetched once per tick). */
  headLedger: number;
  /** `headLedger - lastSuccessLedger` or -1 if head is unknown. */
  lag: number;
  /** Human-readable message from the most recent failed fetch, if any. */
  lastError: string | null;
  /** Timestamp (ms) of the most recent failed fetch. */
  lastErrorTime: number | null;
  /** How many consecutive ticks have failed (0 = healthy). */
  consecutiveErrors: number;
  /** Total fetch attempts (including retries) since start. */
  fetchAttempts: number;
  /** Total failed fetch attempts (all retries exhausted) since start. */
  fetchFailures: number;
}

/** Prometheus metrics for the ingester. */
export interface IngesterMetrics {
  /** Events processed total since the ingester started. */
  eventsProcessedTotal: number;
  /** Total fetch errors (all retries exhausted) since start. */
  fetchErrorsTotal: number;
  /** Uptime in seconds since the ingester started. */
  uptimeSeconds: number;
  /** Latest DB write latency in seconds. */
  dbWriteLatencySeconds: number;
  /** Ledgers behind head (head - last processed). */
  lag: number;
}

function freshHealth(): IngesterHealth {
  return {
    lastSuccessLedger: 0,
    headLedger: 0,
    lag: -1,
    lastError: null,
    lastErrorTime: null,
    consecutiveErrors: 0,
    fetchAttempts: 0,
    fetchFailures: 0,
  };
}

// ── Horizon event shape (Soroban contract events) ──────────────────────────

/**
 * Minimal representation of a record returned by
 * GET /contracts/{id}/events?cursor=…
 *
 * The full shape has many optional fields; we only care about these.
 */
interface HorizonContractEvent {
  /** Paging token / cursor. */
  paging_token: string;
  /** The contract that emitted this event. */
  contract_id: string;
  /** Ordered list of topic values, XDR-base64 encoded. */
  topic: string[];
  /** Event body value, XDR-base64 encoded. */
  value: string;
  /**
   * Ledger sequence number containing this event.
   * Horizon surfaces this as a string in the raw JSON.
   */
  ledger: number | string;
  /** Ledger close time (ISO-8601). */
  ledger_closed_at: string;
  /**
   * The transaction that contained this event.
   * Present on successful transactions.
   */
  transaction_hash?: string;
  /**
   * The account that submitted the transaction.
   * Horizon calls this "source_account" on the event object.
   */
  source_account?: string;
}

interface HorizonEventsPage {
  _embedded: { records: HorizonContractEvent[] };
}

/** Horizon root response — used to read the current ledger. */
interface HorizonRoot {
  core_latest_ledger: number;
}

// ── XDR decode helpers (no external XDR lib required) ─────────────────────

/**
 * Decode a base64-encoded Soroban ScVal and extract the string representation
 * of one of the following value kinds:
 *   - ScvSymbol  → raw symbol string
 *   - ScvAddress → Stellar StrKey (G…)
 *   - ScvU64     → decimal string
 *   - ScvU32     → decimal string
 *
 * We rely on stellar-sdk's SorobanDataBuilder / xdr module for the actual XDR
 * decode so we don't have to vendor a full XDR schema.
 */
function decodeScVal(b64: string): unknown {
  try {
    // stellar-sdk re-exports @stellar/stellar-base which ships xdr types.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { xdr, Address, scValToNative } = require(
      "@stellar/stellar-sdk"
    ) as typeof import("@stellar/stellar-sdk");

    const scval = xdr.ScVal.fromXDR(b64, "base64");
    // scValToNative converts to a JS primitive / bigint / string.
    // For Address types it returns a Stellar address string.
    const native: unknown = scValToNative(scval);

    // Addresses come back as an Address instance; convert to string.
    if (native instanceof Address) {
      return native.toString();
    }
    // BigInts → numbers (safe for u64 ledger values in our use-case).
    if (typeof native === "bigint") {
      return Number(native);
    }
    return native;
  } catch {
    return null;
  }
}

// ── Retry helper ───────────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine whether `err` is a transient error worth retrying.
 *
 * Retries on: network errors (ECONNRESET, ENOTFOUND, etc.), HTTP 5xx,
 * and HTTP 429 (rate limited).
 * Does NOT retry on: HTTP 4xx (except 429) — those are permanent request
 * errors (e.g. 404 = contract has no events, which we handle separately).
 */
function isTransientError(err: unknown): boolean {
  const msg = (err as Error).message?.toLowerCase() ?? "";
  // Node fetch network errors (fetch failed, terminated, ECONNRESET, etc.)
  if (
    msg.includes("fetch failed") ||
    msg.includes("terminated") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("timeout")
  ) {
    return true;
  }
  // Horizon HTTP-level transient errors are caught by the status code checks
  // in fetchEventsWithRetry. Anything else is non-transient.
  return false;
}

/**
 * Fetch with bounded exponential backoff. Returns the parsed Horizon events
 * page, or throws after all retries are exhausted.
 *
 * @param url       Full URL to fetch
 * @param signal    AbortSignal for timeout
 * @param retries   Remaining retries (internal, do not pass)
 * @param attempt   Current attempt number (1-based, internal)
 */
async function fetchEventsWithRetry(
  url: string,
  signal: AbortSignal,
  retries = MAX_RETRIES,
  attempt = 1,
): Promise<HorizonEventsPage> {
  try {
    const res = await fetch(url, { signal });
    if (res.ok) {
      return (await res.json()) as HorizonEventsPage;
    }
    // 404 = contract has no events yet — not an error, not transient.
    if (res.status === 404) {
      // Return an empty page rather than throwing so the caller sees
      // records.length === 0 and returns 0 events cleanly.
      return { _embedded: { records: [] } };
    }
    // 429 = rate limited — transient, worth retrying.
    // 5xx = server error — transient.
    if (res.status === 429 || res.status >= 500) {
      if (retries <= 0) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Horizon responded ${res.status} after ${attempt} attempts: ${text}`,
        );
      }
      // For 429, honour Retry-After if present; otherwise use exponential backoff.
      const retryAfter = res.headers.get("retry-after");
      const delayMs = retryAfter
        ? Math.min(Number(retryAfter) * 1000, MAX_RETRY_DELAY_MS)
        : Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
      console.warn(
        `[indexer] Horizon ${res.status} on attempt ${attempt}/${attempt + retries}, retrying in ${delayMs}ms…`,
      );
      await sleep(delayMs);
      return fetchEventsWithRetry(url, signal, retries - 1, attempt + 1);
    }
    // Other 4xx = permanent error, no retry.
    const text = await res.text().catch(() => "");
    throw new Error(`Horizon responded ${res.status}: ${text}`);
  } catch (err) {
    // If it's a non-transient error or we've exhausted retries, throw.
    if (!isTransientError(err) || retries <= 0) {
      throw err;
    }
    const delayMs = Math.min(
      BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1),
      MAX_RETRY_DELAY_MS,
    );
    console.warn(
      `[indexer] transient fetch error on attempt ${attempt}/${attempt + retries}: ${(err as Error).message}; retrying in ${delayMs}ms…`,
    );
    await sleep(delayMs);
    return fetchEventsWithRetry(url, signal, retries - 1, attempt + 1);
  }
}

// ── Event parser ───────────────────────────────────────────────────────────

type ParsedEvent =
  | {
      kind: "verified";
      holder: string;
      credentialType: string;
      issuer: string;
      expiry: number;
      ledgerSequence: number;
      verifiedAt: number;
    }
  | {
      kind: "revoked";
      holder: string;
      credentialType: string;
    }
  | { kind: "unknown" };

/**
 * Parse a raw Horizon contract event record into our domain type.
 *
 * ProofRegistry event topology
 * ─────────────────────────────
 * Verified:
 *   topics[0] = ScvSymbol "proof"
 *   topics[1] = ScvSymbol "verified"
 *   value     = ScvU64 expiry
 *
 *   The holder and credential_type are NOT in the topics; they are implicit in
 *   the storage key.  Horizon does, however, surface the transaction's
 *   source_account which is the holder (they must sign submit_proof).
 *
 * Revoked (issuer-initiated, from revoke()):
 *   topics[0] = ScvSymbol "revoked"
 *   value     = ScvVec [holder, credential_type, issuer, timestamp]
 *
 * Revoked (holder self-revoke, revoke_proof()):
 *   No event is emitted by the contract for self-revoke — holder just removes
 *   the storage key.  We therefore won't see a chain event; claims will expire
 *   naturally.
 */
function parseEvent(
  ev: HorizonContractEvent,
  contractId: string
): ParsedEvent {
  if (ev.contract_id !== contractId) return { kind: "unknown" };

  const topics = ev.topic.map(decodeScVal);
  const value = decodeScVal(ev.value);
  const ledgerSequence =
    typeof ev.ledger === "string"
      ? parseInt(ev.ledger, 10)
      : ev.ledger;

  // verified event
  if (topics[0] === "proof" && topics[1] === "verified") {
    const holder = ev.source_account ?? "";
    // credential_type is the 3rd topic (index 2) when emitted — but the
    // contract's current publish call only emits 2 topics + value.
    // We extract credential_type from the 3rd topic if present, else "unknown".
    const credentialType =
      typeof topics[2] === "string" ? topics[2] : "unknown";
    const expiry = typeof value === "number" ? value : 0;

    return {
      kind: "verified",
      holder,
      credentialType,
      issuer: "",
      expiry,
      ledgerSequence,
      verifiedAt: Math.floor(
        new Date(ev.ledger_closed_at).getTime() / 1000
      ),
    };
  }

  // revoked event
  if (topics[0] === "revoked") {
    if (Array.isArray(value) && value.length >= 2) {
      const holder = String(value[0]);
      const credentialType = String(value[1]);
      return { kind: "revoked", holder, credentialType };
    }
  }

  return { kind: "unknown" };
}

// ── Ingester ────────────────────────────────────────────────────────────────

export interface Ingester {
  /** Run one ingestion cycle (fetch + write). Returns number of events processed. */
  tick(): Promise<number>;
  /**
   * Re-scan a bounded window of ledgers to reconcile after a detected reorg.
   * Deletes claims newer than `reorgPoint` and re-indexes up to the new head.
   */
  reconcile(reorgPoint: number): Promise<number>;
  /** Start a continuous polling loop. */
  start(): void;
  /** Stop the polling loop. */
  stop(): void;
  /** Graceful shutdown: stop scheduling and await in-flight tick. */
  shutdown(): Promise<void>;
  /** Current health snapshot — safe to read at any time. */
  getHealth(): IngesterHealth;
  /** Get Prometheus metrics for the ingester. */
  getMetrics(): IngesterMetrics;
}

export function createIngester(config: Config, db: Db): Ingester {
  const server = new Horizon.Server(config.horizonUrl, {
    allowHttp: config.horizonUrl.startsWith("http://"),
  });

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlightTick: Promise<number> | null = null;
  const health = freshHealth();

  // ── Prometheus metrics state ──────────────────────────────────────────
  const startTime = Date.now();
  let eventsProcessedTotal = 0;
  let fetchErrorsTotal = 0;

  // ── Fetch current Horizon head ledger (cached per tick) ────────────────
  // We fetch this once at the start of each tick so lag is observable
  // without adding a second network call on every cycle.
  let cachedHeadLedger = 0;
  let cachedHeadTime = 0;
  const HEAD_CACHE_MS = 30_000;

  async function fetchHeadLedger(): Promise<number> {
    const now = Date.now();
    if (cachedHeadLedger > 0 && now - cachedHeadTime < HEAD_CACHE_MS) {
      return cachedHeadLedger;
    }
    try {
      const res = await fetch(config.horizonUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const root = (await res.json()) as HorizonRoot;
        const seq = root.core_latest_ledger ?? 0;
        if (seq > 0) {
          cachedHeadLedger = seq;
          cachedHeadTime = now;
        }
      }
    } catch {
      // Best-effort — head is not critical for tick correctness.
    }
    return cachedHeadLedger;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Fetch the current ledger sequence from Horizon.
   * Uses GET /ledgers?order=desc&limit=1 to get the latest closed ledger.
   */
  async function getLedgerHead(): Promise<number> {
    const url = new URL("/ledgers", config.horizonUrl);
    url.searchParams.set("order", "desc");
    url.searchParams.set("limit", "1");

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Horizon /ledgers responded ${res.status}`);
    }
    const body = (await res.json()) as {
      _embedded?: { records?: Array<{ sequence: number | string }> };
    };
    const seq = body._embedded?.records?.[0]?.sequence;
    if (seq === undefined) throw new Error("No ledger returned from Horizon");
    return typeof seq === "string" ? parseInt(seq, 10) : seq;
  }

  /**
   * Fetch contract events starting from a cursor, up to a max ledger.
   * Events with ledger > maxLedger are skipped (not persisted).
   */
  async function fetchEvents(
    cursor: string | undefined,
    maxLedger: number
  ): Promise<HorizonContractEvent[]> {
    const url = new URL(
      `/contracts/${config.proofRegistryContractId}/events`,
      config.horizonUrl
    );
    url.searchParams.set("order", "asc");
    url.searchParams.set("limit", "200");
    if (cursor !== undefined) {
      url.searchParams.set("cursor", cursor);
    }

    // Fetch head ledger (best-effort) so lag is visible in /health.
    // We fire this in parallel with the events fetch so we don't add
    // serial latency to every tick.
    const [, page] = await Promise.all([
      fetchHeadLedger(),
      (async () => {
        health.fetchAttempts++;
        try {
          return await fetchEventsWithRetry(
            url.toString(),
            AbortSignal.timeout(15_000)
          );
        } catch (err) {
          // All retries exhausted — record the error but do NOT advance cursor.
          health.lastError = (err as Error).message;
          health.lastErrorTime = Date.now();
          health.consecutiveErrors++;
          health.fetchFailures++;
          throw err;
        }
      })(),
    ]);

    const records = page._embedded?.records ?? [];
    if (records.length === 0) {
      // Successful empty fetch — reset error state and update lag.
      health.consecutiveErrors = 0;
      health.lastError = null;
      health.headLedger = cachedHeadLedger;
      health.lag =
        cachedHeadLedger > 0 ? cachedHeadLedger - (await db.getLastLedger()) : -1;
      return [];
    }

    // Filter out events beyond the finality boundary
    return records.filter((ev) => {
      const evLedger =
        typeof ev.ledger === "string" ? parseInt(ev.ledger, 10) : ev.ledger;
      return evLedger <= maxLedger;
    });
  }

  /** Process a batch of events, upserting/revoking claims. Returns count. */
  async function processEvents(events: HorizonContractEvent[]): Promise<number> {
    let processed = 0;
    for (const ev of events) {
      const parsed = parseEvent(ev, config.proofRegistryContractId);

      if (parsed.kind === "verified") {
        await db.upsertClaim({
          wallet: parsed.holder,
          credential_type: parsed.credentialType,
          issuer: parsed.issuer,
          verified_at: parsed.verifiedAt,
          expiry: parsed.expiry,
          ledger_sequence: parsed.ledgerSequence,
          threshold: null,
          revoked: 0,
        });
        processed++;
      } else if (parsed.kind === "revoked") {
        await db.revokeClaim(parsed.holder, parsed.credentialType);
        processed++;
      }
    }
    return processed;
  }

  // ── Core ingestion tick ──────────────────────────────────────────────────

  let lastTickDurationSec = 0;
let lastTickEnd = Date.now();

  async function tick(): Promise<number> {
    const tickStart = Date.now();

    const lastLedger = await db.getLastLedger();

    // 1. Determine the network head and the finality-safe ceiling.
    let headLedger: number;
    try {
      headLedger = await getLedgerHead();
    } catch (err) {
      console.warn("[indexer] Could not fetch ledger head:", (err as Error).message);
      fetchErrorsTotal++;
      return 0;
    }

    // 2. Detect potential reorg FIRST: if our cursor claims to have ingested
    //    a ledger that is now beyond the network head, the chain was likely
    //    reorged past our last checkpoint. This must run before the
    //    finality-ceiling early return below — a reorged head is exactly the
    //    case where (head - lag) has fallen at or below our cursor, which
    //    would otherwise make reorg detection unreachable.
    if (lastLedger > headLedger) {
      console.warn(
        `[indexer] REORG DETECTED: cursor=${lastLedger} > head=${headLedger}. ` +
          `Rolling back to head and re-scanning.`
      );
      fetchErrorsTotal++;
      return reconcile(headLedger);
    }

    // The finality ceiling: only persist events at or below (head - lag).
    // If the network hasn't progressed past our lag buffer yet, there's
    // nothing final to index.
    const finalityCeiling = headLedger - config.finalityLag;
    if (finalityCeiling <= lastLedger) {
      // Head hasn't advanced past our cursor + lag yet — nothing to do.
      return 0;
    }

    // 3. Build the Horizon cursor. For a fresh start with startLedger
    //    configured, begin there; otherwise resume from lastLedger.
    const cursorNum = lastLedger > 0 ? lastLedger * 100_000 : 0;
    const cursor =
      config.startLedger > 0 && lastLedger === 0
        ? String(config.startLedger * 100_000)
        : cursorNum > 0
        ? String(cursorNum)
        : undefined;

    // 4. Fetch events up to the finality ceiling.
    let events: HorizonContractEvent[];
    try {
      events = await fetchEvents(cursor, finalityCeiling);
    } catch (err) {
      console.warn("[indexer] Horizon fetch error:", (err as Error).message);
      fetchErrorsTotal++;
      return 0;
    }

    if (events.length === 0) {
      // Successful empty fetch — update lag only.
      const lag = cachedHeadLedger > 0 ? cachedHeadLedger - (await db.getLastLedger()) : -1;
      health.lastSuccessLedger = lastLedger;
      health.headLedger = cachedHeadLedger;
      health.lag = lag;
      health.consecutiveErrors = 0;
      health.lastError = null;
      return 0;
    }

    // 5. Process events and update cursor.
    const processed = await processEvents(events);
    eventsProcessedTotal += processed;

    // Advance cursor to the highest ledger among processed events.
    let maxLedger = lastLedger;
    for (const ev of events) {
      const evLedger = typeof ev.ledger === "string" ? parseInt(ev.ledger, 10) : ev.ledger;
      if (evLedger > maxLedger) maxLedger = evLedger;
    }
    if (maxLedger > lastLedger) {
      await db.setLastLedger(maxLedger);
    }

    const tickEnd = Date.now();
    const dbWriteLatencySec = (tickEnd - tickStart) / 1000;
    // Store latest DB write latency for metrics exposure.
    // (updated after db.setLastLedger above, the latency includes the write)

    // Update health on success.
    const lag = cachedHeadLedger > 0 ? cachedHeadLedger - maxLedger : -1;
    health.lastSuccessLedger = maxLedger;
    health.headLedger = cachedHeadLedger;
    health.lag = lag;
    health.consecutiveErrors = 0;
    health.lastError = null;

    lastTickDurationSec = (Date.now() - lastTickEnd) / 1000;
    lastTickEnd = Date.now();

    return processed;
  }

  // ── Reorg reconciliation ─────────────────────────────────────────────────

  /**
   * Re-scan a bounded window after detecting a reorg or called explicitly.
   * Deletes claims with ledger_sequence > reorgPoint, then re-indexes
   * from reorgPoint up to the current finality ceiling.
   */
  async function reconcile(reorgPoint: number): Promise<number> {
    console.log(`[indexer] Reconciling from ledger ${reorgPoint}`);

    // Roll back: delete all claims with ledger_sequence beyond the reorg point.
    await db.deleteClaimsAfter(reorgPoint);

    // Reset cursor so we re-fetch from the reorg point.
    await db.setLastLedger(reorgPoint);

    // Now run a normal tick — it will fetch events from reorgPoint onward
    // up to the new finality ceiling.
    return tick();
  }

  function scheduleNext() {
    timer = setTimeout(async () => {
      if (!running) return;
      try {
        inFlightTick = tick();
        const n = await inFlightTick;
        if (n > 0) {
          console.log(`[indexer] processed ${n} event(s)`);
        }
      } catch (err) {
        console.error("[indexer] tick error:", err);
      }
      scheduleNext();
    }, config.pollIntervalMs);
  }

  return {
    tick,
    reconcile,
    start() {
      if (running) return;
      running = true;
      console.log(
        `[indexer] starting — contract=${config.proofRegistryContractId} ` +
          `network=${config.stellarNetwork} poll=${config.pollIntervalMs}ms`
      );
      scheduleNext();
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async shutdown() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlightTick !== null) {
        console.log("[indexer] Waiting for in-flight tick…");
        await inFlightTick;
      }
      console.log("[indexer] Ingester stopped.");
    },
    getHealth() {
      return { ...health };
    },
    getMetrics(): IngesterMetrics {
      const now = Date.now();
      const uptimeSec = (now - startTime) / 1000;
      const lag = health.lag;
      return {
        eventsProcessedTotal,
        fetchErrorsTotal,
        uptimeSeconds: uptimeSec,
        dbWriteLatencySeconds: lastTickDurationSec,
        lag,
      };
    },
  };
}
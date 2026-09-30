// @stellarcred/sdk — real-time claim subscriptions (#392)
//
// Push-style notifications when a watched wallet gains or loses a claim,
// backed by the indexer HTTP API (services/indexer) instead of per-wallet
// ProofRegistry RPC polling like `watchClaim` does:
//
//   - Gains stream from `GET /recent` — one cursor-ordered request per poll
//     covers every wallet, so cost does not grow with the watch list.
//   - Revocation losses and full reconciliation come from periodic
//     `GET /claims?wallet=…` snapshots (the feed excludes revoked rows, so a
//     revocation is only visible as a state delta against the snapshot).
//   - Expiry losses are computed locally from indexed `expiry` timestamps —
//     no request needed, delivered within one poll interval.
//
// Events are delivered as callbacks (`onChange` / `onGained` / `onLost`)
// and/or POSTed to a webhook the protocol registers via `opts.webhook`.

import {
  CLAIM_TYPES,
  ConfigError,
  assertValidClaimType,
  getConfig,
  normalizeAndValidateWallet,
  withRetry,
  type ClaimType,
} from "./claims";
import type { IndexerClaimRow } from "./indexer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaimChangeKind = "gained" | "lost";

/** Why an active claim became invalid: issuer revocation, or proof expiry. */
export type ClaimLossReason = "revoked" | "expired";

export interface ClaimChangeEvent {
  kind: ClaimChangeKind;
  wallet: string;
  claim: string;
  /** Only set when `kind === "lost"`. */
  reason?: ClaimLossReason;
  /** Unix seconds at which the change was detected by the subscription. */
  at: number;
  issuer: string;
  verifiedAt: number;
  expiry: number;
  ledgerSequence: number;
  threshold: number | null;
}

export interface ClaimWebhookOptions {
  /** URL to POST each change event to. */
  url: string;
  /**
   * Shared secret sent as the `X-StellarCred-Webhook-Secret` header on every
   * delivery so the receiver can reject forged requests.
   */
  secret?: string;
  /** Extra headers (e.g. an auth header of your own). */
  headers?: Record<string, string>;
  /** Delivery attempts per event on transient failure. Default: 3. */
  retries?: number;
}

export interface SubscribeClaimsOptions {
  /** Wallet addresses to watch. Validated as Stellar Ed25519 keys before the first poll. */
  wallets: readonly string[];
  /** Claim types to watch. Defaults to every known `CLAIM_TYPES`. */
  claims?: readonly ClaimType[];
  /**
   * Indexer base URL. Resolution order: this option →
   * `configure({ indexerUrl })` / `STELLARCRED_INDEXER_URL` →
   * the SDK `baseUrl`.
   */
  baseUrl?: string;
  /** Sent as `Authorization: Bearer` — only needed when the indexer runs with API_KEY set. */
  apiKey?: string;
  /** Feed poll interval. Default: 10_000 ms. */
  pollMs?: number;
  /** Per-wallet snapshot reconciliation interval. Default: 60_000 ms. */
  resyncMs?: number;
  /** Emit `gained` for claims already active when the subscription starts. Default: false. */
  emitInitialState?: boolean;
  requestTimeoutMs?: number;
  onChange?: (event: ClaimChangeEvent) => void;
  onGained?: (event: ClaimChangeEvent) => void;
  onLost?: (event: ClaimChangeEvent) => void;
  /** Never let a delivery failure crash the loop — all errors surface here. */
  onError?: (error: unknown) => void;
  webhook?: ClaimWebhookOptions;
}

/** Call to stop the subscription. Idempotent. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_RESYNC_MS = 60_000;
const RECENT_PAGE_SIZE = 100;
const MAX_RECENT_PAGES_PER_TICK = 3;
const RESYNC_WALLET_BATCH = 4;

// ---------------------------------------------------------------------------
// Indexer HTTP helpers
// ---------------------------------------------------------------------------

async function fetchIndexerJson<T>(
  url: string,
  opts: { apiKey?: string; timeoutMs: number },
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // Bearer rather than X-API-Key to match sdk/indexer.ts: the indexer's CORS
  // policy does not let X-API-Key through a browser preflight.
  if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(opts.timeoutMs)
      : undefined;
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new Error(`Indexer request failed: HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function assertHttpUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`subscribeClaims: ${label} "${value}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `subscribeClaims: ${label} must use http or https, got "${parsed.protocol}"`,
    );
  }
}

/**
 * Subscribe to claim changes (gained / lost) across a set of wallets, backed
 * by the indexer. Returns an unsubscribe function.
 *
 * Throws synchronously (`ConfigError` / `InvalidClaimTypeError`) on invalid
 * options. Wallet address validation and indexer connectivity errors surface
 * asynchronously via `onError` — an invalid wallet stops the subscription.
 */
export function subscribeClaims(opts: SubscribeClaimsOptions): Unsubscribe {
  const wallets = (opts.wallets ?? []).map((w) => w.trim()).filter((w) => w !== "");
  if (wallets.length === 0) {
    throw new ConfigError("subscribeClaims requires a non-empty `wallets` list");
  }

  const claimTypes: readonly string[] =
    opts.claims && opts.claims.length > 0 ? opts.claims : CLAIM_TYPES;
  for (const t of claimTypes) assertValidClaimType(t);

  const config = getConfig();
  const baseUrl = (opts.baseUrl || config.indexerUrl || config.baseUrl || "").trim();
  if (!baseUrl) {
    throw new ConfigError(
      "subscribeClaims: no indexer URL — pass { baseUrl }, call configure({ indexerUrl }), " +
        "or set STELLARCRED_INDEXER_URL",
    );
  }
  assertHttpUrl(baseUrl, "indexer baseUrl");
  if (opts.webhook) assertHttpUrl(opts.webhook.url, "webhook url");

  const root = baseUrl.replace(/\/+$/, "");
  const pollMs = Math.max(1_000, opts.pollMs ?? DEFAULT_POLL_MS);
  const resyncMs = Math.max(pollMs, opts.resyncMs ?? DEFAULT_RESYNC_MS);
  const timeoutMs = opts.requestTimeoutMs ?? config.requestTimeoutMs;
  const apiKey = opts.apiKey;
  const watchedTypes = new Set(claimTypes);
  const watchedWallets = new Set(wallets);
  const onError = opts.onError ?? (() => {});

  /** Last-known active state, keyed by `wallet|credential_type`. */
  const active = new Map<string, IndexerClaimRow>();
  /** Keyset position of the newest `/recent` row seen; null until first seeded. */
  let feedCursor: { ledger: number; id: number } | null = null;
  let hasSeededBaseline = false;
  let lastResyncAt = 0;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stateKey = (row: IndexerClaimRow): string =>
    `${row.wallet}|${row.credential_type}`;

  const isLiveRow = (row: IndexerClaimRow, now: number): boolean =>
    row.revoked === 0 && row.expiry > now;

  const isNewer = (
    row: IndexerClaimRow,
    cursor: { ledger: number; id: number },
  ): boolean =>
    row.ledger_sequence > cursor.ledger ||
    (row.ledger_sequence === cursor.ledger && row.id > cursor.id);

  function buildEvent(
    kind: ClaimChangeKind,
    row: IndexerClaimRow,
    now: number,
    reason?: ClaimLossReason,
  ): ClaimChangeEvent {
    return {
      kind,
      wallet: row.wallet,
      claim: row.credential_type,
      ...(reason ? { reason } : {}),
      at: now,
      issuer: row.issuer,
      verifiedAt: row.verified_at,
      expiry: row.expiry,
      ledgerSequence: row.ledger_sequence,
      threshold: row.threshold,
    };
  }

  async function deliverWebhook(event: ClaimChangeEvent): Promise<void> {
    const webhook = opts.webhook;
    if (!webhook) return;
    const body = JSON.stringify({
      event: event.kind === "gained" ? "claim_gained" : "claim_lost",
      ...event,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-StellarCred-Event": event.kind === "gained" ? "claim_gained" : "claim_lost",
      ...(webhook.headers ?? {}),
    };
    if (webhook.secret) headers["X-StellarCred-Webhook-Secret"] = webhook.secret;
    try {
      await withRetry(
        async () => {
          const res = await fetch(webhook.url, { method: "POST", headers, body });
          if (!res.ok) {
            throw new Error(`Webhook delivery failed: HTTP ${res.status} for ${webhook.url}`);
          }
        },
        { retries: webhook.retries },
      );
    } catch (err) {
      onError(err);
    }
  }

  function emit(event: ClaimChangeEvent): void {
    try {
      if (event.kind === "gained") opts.onGained?.(event);
      else opts.onLost?.(event);
      opts.onChange?.(event);
    } catch (err) {
      onError(err);
    }
    if (opts.webhook) void deliverWebhook(event);
  }

  function markLost(key: string, row: IndexerClaimRow, reason: ClaimLossReason, now: number): void {
    active.delete(key);
    emit(buildEvent("lost", row, now, reason));
  }

  // ── /recent feed: gains ───────────────────────────────────────────────────
  //
  // Rows arrive newest-first ordered by (ledger_sequence, id). Each tick walks
  // pages back from the head until it hits the previous cursor position, so
  // every row is processed exactly once. Revoked rows never appear in the
  // feed — losses come from the snapshot pass and the expiry sweep.

  async function pollFeed(now: number): Promise<void> {
    const firstUrl = `${root}/recent?limit=${RECENT_PAGE_SIZE}`;
    // Before the snapshot baseline exists, the first non-empty page would
    // replay pre-submission history — record only the head position and let
    // resync() seed the state it covers.
    if (feedCursor === null && !hasSeededBaseline) {
      const page = await fetchIndexerJson<{ claims: IndexerClaimRow[] }>(firstUrl, {
        apiKey,
        timeoutMs,
      });
      const newest = page.claims?.[0];
      if (newest) {
        feedCursor = { ledger: newest.ledger_sequence, id: newest.id };
      }
      return;
    }

    const prevCursor = feedCursor;
    let url = firstUrl;
    let maxSeen = prevCursor;
    let reachedKnown = false;

    for (let page = 0; page < MAX_RECENT_PAGES_PER_TICK; page++) {
      const res = await fetchIndexerJson<{
        claims: IndexerClaimRow[];
        nextCursor: string | null;
      }>(url, { apiKey, timeoutMs });

      const rows = res.claims ?? [];
      // Pages are strictly (ledger, id) DESC, so the newest row seen on this
      // tick is the first one newer than the previous cursor.
      if (page === 0 && rows[0] && (!maxSeen || isNewer(rows[0], maxSeen))) {
        maxSeen = { ledger: rows[0].ledger_sequence, id: rows[0].id };
      }

      for (const row of rows) {
        if (prevCursor && !isNewer(row, prevCursor)) {
          reachedKnown = true;
          break;
        }
        if (!watchedWallets.has(row.wallet) || !watchedTypes.has(row.credential_type)) {
          continue;
        }
        if (!isLiveRow(row, now)) continue;
        const key = stateKey(row);
        if (!active.has(key)) {
          emit(buildEvent("gained", row, now));
        }
        // Whether first-seen or a re-verification of an active claim, refresh
        // the cached record (new expiry/ledger) — a re-verification while
        // already active must not emit a second `gained`.
        active.set(key, row);
      }

      if (reachedKnown || !res.nextCursor) break;
      url = `${root}/recent?limit=${RECENT_PAGE_SIZE}&cursor=${encodeURIComponent(res.nextCursor)}`;
    }

    if (maxSeen) feedCursor = maxSeen;
  }

  // ── Expiry sweep: losses without any request ─────────────────────────────

  function sweepExpiries(now: number): void {
    for (const [key, row] of active) {
      if (row.expiry <= now) markLost(key, row, "expired", now);
    }
  }

  // ── /claims snapshots: revocation losses + reconciliation ────────────────

  async function resync(now: number): Promise<void> {
    const rows: IndexerClaimRow[] = [];
    for (let i = 0; i < wallets.length; i += RESYNC_WALLET_BATCH) {
      const batch = wallets.slice(i, i + RESYNC_WALLET_BATCH);
      const pages = await Promise.all(
        batch.map((w) =>
          fetchIndexerJson<{ claims: IndexerClaimRow[] }>(
            `${root}/claims?wallet=${encodeURIComponent(w)}`,
            { apiKey, timeoutMs },
          ),
        ),
      );
      for (const page of pages) {
        for (const row of page.claims ?? []) {
          if (watchedTypes.has(row.credential_type) && watchedWallets.has(row.wallet)) {
            rows.push(row);
          }
        }
      }
    }

    const currentByKey = new Map<string, IndexerClaimRow>();
    for (const row of rows) currentByKey.set(stateKey(row), row);

    // Losses and refreshes against the authoritative snapshot.
    for (const [key, prev] of [...active]) {
      const cur = currentByKey.get(key);
      if (cur && isLiveRow(cur, now)) {
        active.set(key, cur);
        continue;
      }
      // Row absent (reorg rollback) is reported as `revoked` — holder
      // self-revocation never removes the indexed row, and expiry losses are
      // already covered by the `expired` branch above.
      const reason: ClaimLossReason = cur && cur.revoked === 0 ? "expired" : "revoked";
      markLost(key, prev, reason, now);
    }

    // Gains missed while the subscription was reconnecting (or the baseline).
    for (const row of rows) {
      if (!isLiveRow(row, now)) continue;
      const key = stateKey(row);
      if (active.has(key)) continue;
      active.set(key, row);
      if (hasSeededBaseline || opts.emitInitialState) {
        emit(buildEvent("gained", row, now));
      }
    }

    hasSeededBaseline = true;
    lastResyncAt = now;
  }

  // ── Tick loop ─────────────────────────────────────────────────────────────

  async function tick(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      try {
        await pollFeed(now);
      } catch (err) {
        onError(err);
      }
      try {
        sweepExpiries(now);
      } catch (err) {
        onError(err);
      }
      if (!hasSeededBaseline || now - lastResyncAt >= Math.ceil(resyncMs / 1000)) {
        try {
          await resync(now);
        } catch (err) {
          onError(err);
        }
      }
    } finally {
      running = false;
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(() => scheduleNext());
    }, pollMs);
    // Node: don't keep the process alive solely for the subscription.
    const t = timer as unknown as { unref?: () => void } | null;
    if (t && typeof t.unref === "function") t.unref();
  }

  async function start(): Promise<void> {
    if (stopped) return;
    try {
      for (let i = 0; i < wallets.length; i++) {
        wallets[i] = await normalizeAndValidateWallet(wallets[i]);
      }
    } catch (err) {
      onError(err);
      return;
    }
    watchedWallets.clear();
    for (const w of wallets) watchedWallets.add(w);
    await tick();
    scheduleNext();
  }

  void start();

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

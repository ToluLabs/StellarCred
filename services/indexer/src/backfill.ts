/**
 * backfill.ts — Bounded, resumable historical indexing (#611).
 *
 * The live ingester (`ingester.ts`) follows the network head from its saved
 * cursor. Backfill is a separate operator command for two situations:
 *
 *   - a new indexer pointed at a long-lived contract (index from deployment
 *     to head before going live), and
 *   - gap repair after an outage longer than Horizon's paging window.
 *
 * Guarantees
 * ──────────
 *   - Bounded: only events with `from <= ledger <= to` are written, and `to`
 *     never exceeds the finality-safe ceiling (head - FINALITY_LAG).
 *   - Separate from the live loop: backfill keeps its own checkpoint file and
 *     NEVER reads or writes the live cursor (`db.getLastLedger/setLastLedger`).
 *     It also never enqueues webhooks, so replaying history cannot re-notify
 *     integrators about old revocations.
 *   - Resumable: a checkpoint is persisted atomically after every batch. A
 *     `--resume` run continues from the last completed batch, so no completed
 *     page is fetched twice.
 *   - Idempotent: writes go through the same `upsertClaim` / `revokeClaim`
 *     paths as live ingestion, so overlapping a range the live loop already
 *     covered is safe.
 */

import fs from "fs";
import path from "path";
import type { Config } from "./config";
import type { Db } from "./db";
import {
  parseEvent,
  type HorizonContractEvent,
  type HorizonEventsPage,
} from "./ingester";

// ── Types ──────────────────────────────────────────────────────────────────

export type LedgerBound = number | "genesis" | "head";

export interface BackfillOptions {
  from: LedgerBound;
  to: LedgerBound;
  batchSize: number;
  resume: boolean;
  checkpointPath: string;
}

export interface BackfillCheckpoint {
  /** Inclusive lower bound of the run. 0 means "earliest Horizon retains". */
  from: number;
  /** Inclusive upper bound of the run (already capped at the finality ceiling). */
  to: number;
  /** Horizon paging token to continue after; undefined before the first batch. */
  cursor?: string;
  /** Highest ledger whose events have been fully written. */
  lastLedger: number;
  /** Total events written so far across all batches of this run. */
  processed: number;
  /** True once the range is fully indexed. */
  done: boolean;
  updatedAt: string;
}

export interface BackfillResult {
  from: number;
  to: number;
  batches: number;
  processed: number;
  lastLedger: number;
}

export interface BackfillDeps {
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CHECKPOINT = ".backfill-checkpoint.json";
const MAX_HORIZON_LIMIT = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

// ── CLI argument parsing ─────────────────────────────────────────────────

const parseBound = (raw: string, flag: string): LedgerBound => {
  const v = raw.trim().toLowerCase();
  if (v === "genesis" || v === "head") return v;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive ledger number, "genesis", or "head" (got "${raw}")`);
  }
  return n;
};

export const parseBackfillArgs = (argv: string[]): BackfillOptions => {
  const opts: BackfillOptions = {
    from: "genesis",
    to: "head",
    batchSize: MAX_HORIZON_LIMIT,
    resume: false,
    checkpointPath: process.env.BACKFILL_CHECKPOINT ?? DEFAULT_CHECKPOINT,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--from":
        opts.from = parseBound(next(), "--from");
        break;
      case "--to":
        opts.to = parseBound(next(), "--to");
        break;
      case "--batch-size": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1 || n > MAX_HORIZON_LIMIT) {
          throw new Error(`--batch-size must be an integer between 1 and ${MAX_HORIZON_LIMIT}`);
        }
        opts.batchSize = n;
        break;
      }
      case "--resume":
        opts.resume = true;
        break;
      case "--checkpoint":
        opts.checkpointPath = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.from === "head") throw new Error(`--from cannot be "head"`);
  if (opts.to === "genesis") throw new Error(`--to cannot be "genesis"`);
  if (typeof opts.from === "number" && typeof opts.to === "number" && opts.from > opts.to) {
    throw new Error(`--from (${opts.from}) must be <= --to (${opts.to})`);
  }
  return opts;
};

// ── Checkpoint persistence ──────────────────────────────────────────────────

export const readCheckpoint = (file: string): BackfillCheckpoint | undefined => {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as BackfillCheckpoint;
};

/** Write via temp file + rename so a crash never leaves a half-written checkpoint. */
export const writeCheckpoint = (file: string, cp: BackfillCheckpoint): void => {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2));
  fs.renameSync(tmp, file);
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const ledgerOf = (ev: HorizonContractEvent): number =>
  typeof ev.ledger === "string" ? parseInt(ev.ledger, 10) : ev.ledger;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Runner ──────────────────────────────────────────────────────────────────

export const runBackfill = async (
  config: Config,
  db: Db,
  opts: BackfillOptions,
  deps: BackfillDeps = {}
): Promise<BackfillResult> => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((m: string) => console.log(m));
  const sleep = deps.sleep ?? defaultSleep;

  const getJson = async (url: URL): Promise<unknown> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url.toString());
      } catch (err) {
        // Network-level failure: retryable.
        lastErr = err;
        if (attempt < MAX_RETRIES - 1) await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
        continue;
      }
      if (res.ok) return await res.json();
      if (res.status === 404) return undefined;
      lastErr = new Error(`Horizon responded ${res.status} for ${url.pathname}`);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) throw lastErr;
      if (attempt < MAX_RETRIES - 1) await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
    }
    throw lastErr;
  };

  const getHead = async (): Promise<number> => {
    const url = new URL("/ledgers", config.horizonUrl);
    url.searchParams.set("order", "desc");
    url.searchParams.set("limit", "1");
    const body = (await getJson(url)) as
      | { _embedded?: { records?: Array<{ sequence: number | string }> } }
      | undefined;
    const seq = body?._embedded?.records?.[0]?.sequence;
    if (seq === undefined) throw new Error("No ledger returned from Horizon");
    return typeof seq === "string" ? parseInt(seq, 10) : seq;
  };

  // 1. Resolve the range, or load it from the checkpoint.
  let cp: BackfillCheckpoint;
  const existing = readCheckpoint(opts.checkpointPath);

  if (opts.resume) {
    if (!existing) {
      throw new Error(`--resume given but no checkpoint found at ${opts.checkpointPath}`);
    }
    if (existing.done) {
      log(`[backfill] Checkpoint at ${opts.checkpointPath} is already complete (ledgers ${existing.from}..${existing.to}).`);
      return { from: existing.from, to: existing.to, batches: 0, processed: existing.processed, lastLedger: existing.lastLedger };
    }
    cp = existing;
    log(`[backfill] Resuming ${cp.from}..${cp.to} after ledger ${cp.lastLedger} (${cp.processed} events so far)`);
  } else {
    if (existing && !existing.done) {
      throw new Error(
        `An unfinished backfill checkpoint exists at ${opts.checkpointPath}. ` +
          `Run with --resume, or delete the file to start a new range.`
      );
    }
    const ceiling = (await getHead()) - config.finalityLag;
    const from: number =
      typeof opts.from === "number" ? opts.from : Math.max(config.startLedger, 0);
    const to: number = typeof opts.to === "number" ? Math.min(opts.to, ceiling) : ceiling;
    if (to < from) {
      throw new Error(`Nothing to backfill: range ${from}..${to} is empty after capping at the finality ceiling ${ceiling}`);
    }
    cp = { from, to, lastLedger: from > 0 ? from - 1 : 0, processed: 0, done: false, updatedAt: new Date().toISOString() };
    writeCheckpoint(opts.checkpointPath, cp);
    log(`[backfill] Starting ledgers ${from > 0 ? from : "earliest"}..${to}, batch size ${opts.batchSize}`);
  }

  // 2. Page through events in ascending order.
  const span = Math.max(cp.to - cp.from + 1, 1);
  let batches = 0;

  while (!cp.done) {
    const url = new URL(`/contracts/${config.proofRegistryContractId}/events`, config.horizonUrl);
    url.searchParams.set("order", "asc");
    url.searchParams.set("limit", String(opts.batchSize));
    // Same cursor convention as the live ingester for the first page; later
    // pages continue from the last record's paging token.
    const cursor = cp.cursor ?? (cp.from > 1 ? String((cp.from - 1) * 100_000) : undefined);
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);

    const page = (await getJson(url)) as HorizonEventsPage | undefined;
    const records = page?._embedded?.records ?? [];

    let batchProcessed = 0;
    let reachedEnd = records.length < opts.batchSize;

    for (const ev of records) {
      const ledger = ledgerOf(ev);
      if (ledger < cp.from) continue;
      if (ledger > cp.to) {
        reachedEnd = true;
        break;
      }
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
          reason_code: "other",
        });
        batchProcessed++;
      } else if (parsed.kind === "revoked") {
        await db.revokeClaim(parsed.holder, parsed.credentialType, parsed.reason);
        batchProcessed++;
      }
      cp.cursor = ev.paging_token;
      if (ledger > cp.lastLedger) cp.lastLedger = ledger;
    }

    batches++;
    cp.processed += batchProcessed;
    if (reachedEnd) {
      cp.done = true;
      cp.lastLedger = cp.to;
    }
    cp.updatedAt = new Date().toISOString();
    writeCheckpoint(opts.checkpointPath, cp);

    const pct = Math.min(100, Math.max(0, ((cp.lastLedger - cp.from + 1) / span) * 100));
    log(
      `[backfill] batch ${batches}: ${batchProcessed} events, through ledger ${cp.lastLedger}/${cp.to} ` +
        `(${pct.toFixed(1)}%, ${cp.processed} total)`
    );
  }

  log(`[backfill] Done: ledgers ${cp.from}..${cp.to}, ${cp.processed} events in ${batches} batches.`);
  return { from: cp.from, to: cp.to, batches, processed: cp.processed, lastLedger: cp.lastLedger };
};

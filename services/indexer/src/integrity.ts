/**
 * integrity.ts — Verify derived indexer state against on-chain truth (#612).
 *
 * Why this exists
 * ───────────────
 * Everything in the `claims` table is *derived*: it is rebuilt from Horizon
 * contract events, never read back from the contract. That derivation can be
 * wrong in ways that are invisible from the inside:
 *
 *   - an event missed during an RPC/Horizon outage (the cursor only advances
 *     after a successful fetch, but a permanently-failing ledger can strand
 *     the sweep without anything looking broken),
 *   - a decoding bug in `parseEvent` that writes a plausible-looking but wrong
 *     `expiry` / `issuer` / `verified_at`,
 *   - a reorg the reconcile path handled imperfectly — it deletes rows above the
 *     reorg point, but a row written *below* it from a fork that won is not
 *     reachable by that rollback,
 *   - a revoke that happened in a transaction whose event the indexer never saw.
 *
 * A consumer trusting the indexer gets a wrong answer with no signal, so this
 * module closes the loop: it samples indexed claims, reads each one back out of
 * the contract's own storage, and reports every disagreement as a metric.
 *
 * Expiry semantics — the documented guarantee
 * ──────────────────────────────────────────
 * `ProofRegistry` enforces expiry **lazily, at read time**:
 *
 *     is_verified => valid = !revoked && expiry > ledger.timestamp()
 *
 * Three consequences pin down what the indexer may and may not claim:
 *
 *  1. **Expiry emits no event.** There is no `expired` topic, so expiry cannot
 *     be derived from the event stream the way revocation is. The indexer
 *     therefore does *not* fold expiry into `revoked`: `revoked` stays a
 *     faithful mirror of the on-chain `ProofRecord.revoked` flag, and the
 *     `revoked` column means exactly "the issuer or holder revoked this".
 *  2. **The indexer computes expiry locally.** Every claim row carries the
 *     `expiry` timestamp from the `submitted` event, so the indexer can — and
 *     does — evaluate `expiry <= now` itself and surface it as the derived
 *     `expired` / `state` fields on `/claims` and `/recent`. This is a
 *     convenience for listing and filtering, and it is exact, because the
 *     timestamp is indexed data rather than a guess.
 *  3. **An expired claim still requires a chain check to be authoritative.**
 *     The contract TTL-bumps the persistent entry up to its `expiry`
 *     (`ProofRegistry::bump_ttl`), so after expiry elapses the entry can be
 *     evicted from contract state entirely and `get_record` returns `None`.
 *     A consumer that needs to act on an expired claim must call the live
 *     `is_verified` / `check_claim` read, because once the entry is evicted the
 *     chain can no longer confirm anything about it.
 *
 * Consequence for this checker: a claim missing from contract storage is only a
 * mismatch when it is **not** locally expired. A missing entry for an expired
 * claim is the expected steady state, not drift.
 *
 * Read path
 * ─────────
 * Claims are read with Soroban RPC `getLedgerEntries` (via the SDK's
 * `getContractData`), which returns the contract's stored `ProofRecord`
 * directly. That is the same durable state `is_verified` / `get_record` read,
 * so the check verifies the *stored* record rather than a re-derived one, and
 * it needs no simulated transaction or submitted authorization.
 */

import {
  Address,
  SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { Config } from "./config";
import { createHttpClient, optionsFromConfig } from "./http-client";
import type { ClaimRow, Db } from "./db-types";

// ── Types ──────────────────────────────────────────────────────────────────

/** The `ProofRegistry::ProofRecord` as stored in contract state. */
export interface ChainClaimState {
  revoked: boolean;
  expiry: number;
  verifiedAt: number;
  threshold: number | null;
  /** `None` in the contract (e.g. an un-migrated legacy record) → `null`. */
  issuer: string | null;
}

/**
 * Why an indexed claim disagrees with contract state. Kept narrow so each kind
 * points at a specific failure mode rather than a generic "drift".
 */
export type MismatchKind =
  /** Indexed as a live claim, no record in contract state, not expired. */
  | "missing_on_chain"
  /** The contract has `revoked = true` but the indexer never saw the event. */
  | "revoked_on_chain"
  /** The indexer says revoked but the contract's record is not revoked. */
  | "revoked_in_index"
  | "expiry_mismatch"
  | "verified_at_mismatch"
  | "threshold_mismatch"
  /** Event-decoding drift: the indexed issuer is not the recorded issuer. */
  | "issuer_mismatch";

export const MISMATCH_KINDS: readonly MismatchKind[] = [
  "missing_on_chain",
  "revoked_on_chain",
  "revoked_in_index",
  "expiry_mismatch",
  "verified_at_mismatch",
  "threshold_mismatch",
  "issuer_mismatch",
] as const;

export interface IntegrityMismatch {
  wallet: string;
  credential_type: string;
  ledger_sequence: number;
  kinds: MismatchKind[];
  /** What the indexer believes. */
  indexed: {
    revoked: number;
    expiry: number;
    verified_at: number;
    threshold: number | null;
    issuer: string;
  };
  /** What the contract holds, or `null` when no record exists. */
  chain: ChainClaimState | null;
}

export interface IntegrityReport {
  /** Wall-clock ms when the check started / finished. */
  startedAt: number;
  finishedAt: number;
  durationSeconds: number;
  /** Claims sampled and successfully read back from the contract. */
  checked: number;
  /** Claims the contract read failed for (RPC outage, bad address, …). */
  unreadable: number;
  mismatches: IntegrityMismatch[];
  mismatchCount: number;
  /** `true` only when every sampled claim was read successfully. */
  complete: boolean;
}

export interface IntegrityMetrics {
  /** Checks started since boot (scheduled and on-demand alike). */
  checksTotal: number;
  /** Checks that could not read at least one sampled claim. */
  checksIncompleteTotal: number;
  /** Cumulative mismatches across all checks — alert on a rate, not this. */
  mismatchesTotal: number;
  /** Mismatches in the most recently finished check. The alerting gauge. */
  lastMismatchCount: number;
  /** Claims compared in the most recently finished check. */
  lastCheckedCount: number;
  /** Unreadable claims in the most recently finished check. */
  lastUnreadableCount: number;
  /** Cumulative mismatch counts per kind, for label-filtered alerting. */
  mismatchesByKind: Record<MismatchKind, number>;
  /** Unix seconds of the last finished check (0 = never run). */
  lastRunTimestampSeconds: number;
  /** Unix seconds of the last check that read every sampled claim. */
  lastSuccessTimestampSeconds: number;
  /** Duration of the last finished check, in seconds. */
  lastDurationSeconds: number;
  lastError: string | null;
}

/**
 * The contract-read seam. Injected in tests so the comparison logic can be
 * exercised without a live RPC endpoint.
 */
export interface ContractReader {
  /** Read one stored `ProofRecord`; `null` when the entry does not exist. */
  readProofRecord(params: {
    contractId: string;
    wallet: string;
    credentialType: string;
  }): Promise<ChainClaimState | null>;
}

/**
 * Source of "now" for the expiry decision, in unix seconds.
 *
 * `is_verified` compares `expiry` against the *ledger* timestamp, so anchoring
 * the checker's expiry logic to the chain's own clock keeps it correct on a host
 * whose wall clock has drifted. A failed lookup degrades to the local clock
 * rather than failing the check — the chain timestamp refines the answer, it is
 * not the source of truth.
 */
export interface ChainClock {
  now(): Promise<number>;
}

export interface IntegrityChecker {
  /** Run one verification pass now. Returns the report for that pass. */
  run(options?: { sampleSize?: number }): Promise<IntegrityReport>;
  /** Start the periodic schedule (no-op when disabled). */
  start(): void;
  /** Stop the periodic schedule and await an in-flight run. */
  stop(): Promise<void>;
  /** Metrics snapshot, safe to read at any time. */
  getMetrics(): IntegrityMetrics;
  /** The most recent completed report, or `null` before the first run. */
  getLastReport(): IntegrityReport | null;
}

export interface IntegrityDeps {
  reader?: ContractReader;
  /** Injected clock, for deterministic expiry tests. */
  clock?: ChainClock;
}

// ── Comparison (pure) ──────────────────────────────────────────────────────

/**
 * Compare one indexed claim against what the contract holds.
 *
 * `chain` is `null` when contract storage has no entry for this
 * `(wallet, credential_type)`. Per the expiry semantics documented above, that
 * is expected once the claim's `expiry` has passed — the entry's TTL runs out
 * at expiry — so only a *non-expired* claim going missing counts as drift.
 */
export function compareIndexedClaim(
  indexed: ClaimRow,
  chain: ChainClaimState | null,
  now: number
): MismatchKind[] {
  const kinds: MismatchKind[] = [];

  if (chain === null) {
    const expired = indexed.expiry > 0 && indexed.expiry <= now;
    return expired ? kinds : ["missing_on_chain"];
  }

  const indexedRevoked = Number(indexed.revoked) === 1;
  if (indexedRevoked !== chain.revoked) {
    kinds.push(chain.revoked ? "revoked_on_chain" : "revoked_in_index");
  }

  if (Number(indexed.expiry) !== Number(chain.expiry)) {
    kinds.push("expiry_mismatch");
  }
  if (Number(indexed.verified_at) !== Number(chain.verifiedAt)) {
    kinds.push("verified_at_mismatch");
  }

  const indexedThreshold =
    indexed.threshold === null ? null : Number(indexed.threshold);
  if (indexedThreshold !== chain.threshold) {
    kinds.push("threshold_mismatch");
  }

  // The contract stores `issuer: Option<Address>`; the indexer stores the
  // decoded event value as a string, where a legacy/absent issuer is "".
  const indexedIssuer = indexed.issuer ?? "";
  const chainIssuer = chain.issuer ?? "";
  if (indexedIssuer !== chainIssuer) {
    kinds.push("issuer_mismatch");
  }

  return kinds;
}

// ── XDR decoding ───────────────────────────────────────────────────────────

/** Read a `ScVal` that must hold an unsigned integer. */
function readUint(val: xdr.ScVal): number {
  const name = val.switch().name;
  if (name === "scvU32") return val.u32();
  if (name === "scvU64") return Number(val.u64());
  throw new Error(`expected an unsigned integer ScVal, got ${name}`);
}

/**
 * Decode a stored `ProofRecord` into {@link ChainClaimState}.
 *
 * Read field-by-field from the ScVal rather than through `scValToNative`, so a
 * record whose optional fields are `void` (the un-migrated legacy shape) decodes
 * cleanly instead of collapsing the whole row into `undefined`.
 */
export function decodeProofRecord(val: xdr.ScVal): ChainClaimState {
  if (val.switch().name !== "scvMap") {
    throw new Error(`expected a ProofRecord map, got ${val.switch().name}`);
  }

  const fields = new Map<string, xdr.ScVal>();
  for (const entry of val.map() ?? []) {
    const key = entry.key();
    if (key.switch().name !== "scvSymbol") continue;
    fields.set(Buffer.from(key.sym()).toString("utf8"), entry.val());
  }

  const revokedField = fields.get("revoked");
  if (!revokedField || revokedField.switch().name !== "scvBool") {
    throw new Error("ProofRecord is missing a boolean `revoked` field");
  }

  const thresholdField = fields.get("threshold");
  const issuerField = fields.get("issuer");
  const verifiedAtField = fields.get("verified_at");
  const expiryField = fields.get("expiry");

  if (!verifiedAtField || !expiryField) {
    throw new Error("ProofRecord is missing `verified_at` or `expiry`");
  }

  return {
    revoked: revokedField.b(),
    expiry: readUint(expiryField),
    verifiedAt: readUint(verifiedAtField),
    threshold:
      thresholdField && thresholdField.switch().name !== "scvVoid"
        ? readUint(thresholdField)
        : null,
    issuer:
      issuerField && issuerField.switch().name === "scvAddress"
        ? Address.fromScAddress(issuerField.address()).toString()
        : null,
  };
}

/**
 * Build the storage key for `DataKey::Proof(holder, credential_type)`.
 *
 * `DataKey` is a `#[contracttype] enum` whose tuple variants serialise as a
 * bare `ScVal` vec of the variant's fields — the enum discriminant is omitted
 * for tuple variants — so the key is `[address, symbol]`.
 */
export function proofStorageKey(
  wallet: string,
  credentialType: string
): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvAddress(new Address(wallet).toScAddress()),
    xdr.ScVal.scvSymbol(Buffer.from(credentialType, "utf8")),
  ]);
}

// ── Soroban RPC reader ─────────────────────────────────────────────────────

/**
 * Read contract state over Soroban RPC.
 *
 * `getContractData` is a thin wrapper over `getLedgerEntries` that already
 * derives the ledger-entry data key from the ScVal, and it returns the same
 * durable entry `is_verified` / `get_record` read. Proofs live in
 * `env.storage().persistent()`, so `Durability.Persistent` is the correct
 * keyspace.
 */
export function createSorobanContractReader(config: Config): ContractReader {
  const server = new SorobanRpc.Server(config.rpcUrl);

  return {
    async readProofRecord({ contractId, wallet, credentialType }) {
      const key = proofStorageKey(wallet, credentialType);
      try {
        const entry = await server.getContractData(
          contractId,
          key,
          SorobanRpc.Durability.Persistent
        );
        const entryData = entry.val;
        if (entryData.switch().name !== "contractData") {
          throw new Error(
            `unexpected ledger entry kind ${entryData.switch().name} for a proof record`,
          );
        }
        return decodeProofRecord(entryData.contractData().val());
      } catch (err) {
        // The SDK rejects with a 404-shaped error when the entry is absent.
        // That is an answer, not a failure — let it through as `null`.
        if (isNotFound(err)) return null;
        throw err;
      }
    },
  };
}

/**
 * Read the chain's current time from the newest closed ledger.
 *
 * Horizon is used rather than Soroban RPC because `getLatestLedger` reports the
 * sequence but not the close time, and `GET /ledgers?order=desc&limit=1` is
 * already this service's source of truth for head-ledger sequencing.
 *
 * Goes through the shared HTTP client (#761): Horizon answers 429 when it is
 * rate-limiting us and 5xx when it is briefly unhealthy, and a raw fetch
 * treated the first such answer as a permanent clock failure. Now transient
 * answers are retried with backoff, and a Horizon that stays down opens the
 * circuit breaker so checks fail fast instead of queueing doomed requests.
 */
export function createHorizonChainClock(config: Config): ChainClock {
  const http = createHttpClient(optionsFromConfig(config.httpClient));
  return {
    async now() {
      const url = new URL("/ledgers", config.horizonUrl);
      url.searchParams.set("order", "desc");
      url.searchParams.set("limit", "1");
      const res = await http.fetch(url.toString());
      if (!res.ok) throw new Error(`Horizon /ledgers responded ${res.status}`);
      const body = (await res.json()) as {
        _embedded?: { records?: Array<{ closed_at?: string }> };
      };
      const closedAt = body._embedded?.records?.[0]?.closed_at;
      if (!closedAt) throw new Error("Horizon /ledgers returned no close time");
      return Math.floor(new Date(closedAt).getTime() / 1000);
    },
  };
}

/** True for the 404 shape `getContractData` uses to report an absent entry. */
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 404) return true;
  const message = (err as Error | null)?.message?.toLowerCase() ?? "";
  return message.includes("contract data not found");
}

/**
 * Build the default reader on first use rather than at startup.
 *
 * Constructing the RPC client can reject a malformed `RPC_URL`, and the indexer
 * already boots and serves cached state on a degraded RPC connection. Failing
 * here would turn a verification outage into an indexing outage, so a bad URL
 * must fail the check instead of the process.
 */
function lazySorobanReader(config: Config): ContractReader {
  let reader: ContractReader | null = null;
  const resolve = (): ContractReader => {
    reader ??= createSorobanContractReader(config);
    return reader;
  };
  return {
    async readProofRecord(params) {
      return resolve().readProofRecord(params);
    },
  };
}

// ── Checker ────────────────────────────────────────────────────────────────

/**
 * How many individual mismatches the scheduled run prints before deferring to
 * `/integrity/status`. The metrics and the status endpoint always carry the
 * complete set; this only keeps a bad pass from flooding the log.
 */
const MAX_LOGGED_MISMATCHES = 20;

function freshMetrics(): IntegrityMetrics {
  return {
    checksTotal: 0,
    checksIncompleteTotal: 0,
    mismatchesTotal: 0,
    lastMismatchCount: 0,
    lastCheckedCount: 0,
    lastUnreadableCount: 0,
    mismatchesByKind: Object.fromEntries(
      MISMATCH_KINDS.map((kind) => [kind, 0])
    ) as Record<MismatchKind, number>,
    lastRunTimestampSeconds: 0,
    lastSuccessTimestampSeconds: 0,
    lastDurationSeconds: 0,
    lastError: null,
  };
}

export function createIntegrityChecker(
  config: Config,
  db: Db,
  deps: IntegrityDeps = {}
): IntegrityChecker {
  const reader: ContractReader = deps.reader ?? lazySorobanReader(config);
  const chainClock: ChainClock = deps.clock ?? (() => {
    const horizonClock = createHorizonChainClock(config);
    // One network call per pass, not per claim: prefer the chain's own clock,
    // and fall back to this host's if Horizon is unreachable for the moment.
    return {
      async now() {
        try {
          return await horizonClock.now();
        } catch {
          return Math.floor(Date.now() / 1000);
        }
      },
    };
  })();

  const metrics = freshMetrics();
  let lastReport: IntegrityReport | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight: Promise<IntegrityReport> | null = null;

  async function runPass(sampleSize: number): Promise<IntegrityReport> {
    const startedAt = Date.now();

    // Read the chain's own clock for the expiry decision. `is_verified`
    // compares `expiry` against the ledger timestamp, so this keeps the check
    // honest on a host whose wall clock has drifted.
    const effectiveNow = await chainClock.now();

    const sampled = await db.sampleClaimsForVerification(sampleSize);
    const mismatches: IntegrityMismatch[] = [];
    let checked = 0;
    let unreadable = 0;
    let firstError: string | null = null;

    for (const row of sampled) {
      let chainState: ChainClaimState | null;
      try {
        chainState = await reader.readProofRecord({
          contractId: config.proofRegistryContractId,
          wallet: row.wallet,
          credentialType: row.credential_type,
        });
      } catch (err) {
        // A read failure is not evidence of drift — recording it as a mismatch
        // would turn an RPC outage into a false data-integrity alarm, which is
        // exactly the signal this metric exists to make trustworthy.
        unreadable += 1;
        firstError ??= (err as Error).message;
        continue;
      }

      checked += 1;
      const kinds = compareIndexedClaim(row, chainState, effectiveNow);
      if (kinds.length > 0) {
        for (const kind of kinds) metrics.mismatchesByKind[kind] += 1;
        mismatches.push({
          wallet: row.wallet,
          credential_type: row.credential_type,
          ledger_sequence: Number(row.ledger_sequence),
          kinds,
          indexed: {
            revoked: Number(row.revoked),
            expiry: Number(row.expiry),
            verified_at: Number(row.verified_at),
            threshold: row.threshold === null ? null : Number(row.threshold),
            issuer: row.issuer ?? "",
          },
          chain: chainState,
        });
      }
    }

    const finishedAt = Date.now();
    const report: IntegrityReport = {
      startedAt,
      finishedAt,
      durationSeconds: (finishedAt - startedAt) / 1000,
      checked,
      unreadable,
      mismatches,
      mismatchCount: mismatches.length,
      complete: unreadable === 0,
    };

    metrics.checksTotal += 1;
    metrics.lastCheckedCount = checked;
    metrics.lastUnreadableCount = unreadable;
    metrics.lastMismatchCount = report.mismatchCount;
    metrics.mismatchesTotal += report.mismatchCount;
    metrics.lastRunTimestampSeconds = Math.floor(finishedAt / 1000);
    metrics.lastDurationSeconds = report.durationSeconds;
    if (report.complete) {
      metrics.lastSuccessTimestampSeconds = metrics.lastRunTimestampSeconds;
      metrics.lastError = null;
    } else {
      metrics.checksIncompleteTotal += 1;
      metrics.lastError = firstError;
    }

    lastReport = report;
    return report;
  }

  function schedule() {
    timer = setTimeout(() => {
      timer = null;
      if (!running) return;
      void run()
        .then((report) => {
          if (report.mismatchCount > 0) {
            console.warn(
              `[indexer] integrity check found ${report.mismatchCount} mismatch(es) ` +
                `in ${report.checked} sampled claim(s)`,
            );
            for (const m of report.mismatches.slice(0, MAX_LOGGED_MISMATCHES)) {
              console.warn(
                `[indexer]   ${m.wallet}/${m.credential_type}: ${m.kinds.join(", ")}`,
              );
            }
            if (report.mismatches.length > MAX_LOGGED_MISMATCHES) {
              console.warn(
                `[indexer]   …and ${report.mismatches.length - MAX_LOGGED_MISMATCHES} more ` +
                  `(see /integrity/status for the full report)`,
              );
            }
          } else if (!report.complete) {
            console.warn(
              `[indexer] integrity check incomplete: ${report.unreadable} claim(s) could not be read` +
                (metrics.lastError ? ` (${metrics.lastError})` : ""),
            );
          }
        })
        .catch((err: unknown) => {
          console.error("[indexer] integrity check failed:", err);
        })
        .finally(() => {
          if (running) schedule();
        });
    }, config.integrityCheckIntervalMs);
  }

  const sampleSizeDefault = (): number =>
    Math.max(1, config.integrityCheckSampleSize);

  /** Run one pass, sharing an in-flight pass rather than overlapping it. */
  function run(options: { sampleSize?: number } = {}): Promise<IntegrityReport> {
    const sampleSize = Math.max(1, options.sampleSize ?? sampleSizeDefault());
    if (inFlight) return inFlight;
    inFlight = runPass(sampleSize).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    run,

    start() {
      if (running || !config.integrityCheckEnabled) return;
      running = true;
      console.log(
        `[indexer] integrity checks enabled — every ` +
          `${config.integrityCheckIntervalMs / 1000}s, sampling ` +
          `${sampleSizeDefault()} claim(s) per run against contract state`,
      );
      schedule();
    },

    async stop() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
    },

    getMetrics() {
      return { ...metrics, mismatchesByKind: { ...metrics.mismatchesByKind } };
    },

    getLastReport() {
      return lastReport;
    },
  };
}

// ── Derived expiry helpers (shared with the read API) ──────────────────────

/**
 * Whether a claim's `expiry` has passed at `now`.
 *
 * The indexer evaluates this itself (see the module doc comment): the `expiry`
 * timestamp comes from the `submitted` event, so this is indexed data, not a
 * guess. `expiry === 0` means the decoded event carried no usable timestamp,
 * which is treated as "not expired" so a decode gap never silently hides a
 * claim; the integrity checker reports those as `expiry_mismatch` instead.
 */
export function isExpired(row: ClaimRow, now: number): boolean {
  return Number(row.expiry) > 0 && Number(row.expiry) <= now;
}

/**
 * The three states a claim can be presented in, in precedence order:
 * revoked on-chain, then locally expired, then active.
 *
 * `expired` is derived and needs a live `is_verified` check to be treated as
 * authoritative — see the module doc comment.
 */
export function claimState(
  row: ClaimRow,
  now: number
): "revoked" | "expired" | "active" {
  if (Number(row.revoked) === 1) return "revoked";
  if (isExpired(row, now)) return "expired";
  return "active";
}
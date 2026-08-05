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
 * Idempotency: every cycle starts from (lastLedger + 1) and advances the cursor
 * only after all rows for that ledger have been written. Restarting replays from
 * the last saved cursor; duplicate events are absorbed by upsertClaim's
 * ON CONFLICT DO UPDATE clause.
 */

import { Horizon } from "@stellar/stellar-sdk";
import type { Config } from "./config";
import type { Db } from "./db";

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

// ── Ingester ───────────────────────────────────────────────────────────────

export interface Ingester {
  /** Run one ingestion cycle (fetch + write). Returns number of events processed. */
  tick(): Promise<number>;
  /** Start a continuous polling loop. */
  start(): void;
  /** Stop the polling loop. */
  stop(): void;
}

export function createIngester(config: Config, db: Db): Ingester {
  const server = new Horizon.Server(config.horizonUrl, {
    allowHttp: config.horizonUrl.startsWith("http://"),
  });

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<number> {
    const lastLedger = await db.getLastLedger();

    // Build cursor: Horizon contract event cursor is paging_token of the last
    // seen record. For a fresh start (lastLedger=0) pass "now" or omit it so
    // we start from the beginning (START_LEDGER=0 means index from genesis;
    // adjust in config if you only care about recent events).
    //
    // Horizon's GET /contracts/{id}/events accepts:
    //   cursor   — paging token (opaque)
    //   order    — asc (default)
    //   limit    — max records per page (max 200)
    //   ledger   — filter by ledger (not useful for polling)
    //
    // We use a simple numeric cursor derived from ledger*100_000 which is how
    // Horizon builds paging_tokens for events in practice.
    const cursorNum = lastLedger > 0 ? lastLedger * 100_000 : 0;
    const cursor = config.startLedger > 0 && lastLedger === 0
      ? String(config.startLedger * 100_000)
      : cursorNum > 0
      ? String(cursorNum)
      : undefined;

    const url = new URL(
      `/contracts/${config.proofRegistryContractId}/events`,
      config.horizonUrl
    );
    url.searchParams.set("order", "asc");
    url.searchParams.set("limit", "200");
    if (cursor !== undefined) {
      url.searchParams.set("cursor", cursor);
    }

    let page: HorizonEventsPage;
    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        if (res.status === 404) {
          // Contract has no events yet — not an error.
          return 0;
        }
        throw new Error(`Horizon responded ${res.status}: ${await res.text()}`);
      }
      page = (await res.json()) as HorizonEventsPage;
    } catch (err) {
      console.warn("[indexer] Horizon fetch error:", (err as Error).message);
      return 0;
    }

    const records = page._embedded?.records ?? [];
    if (records.length === 0) return 0;

    let maxLedger = lastLedger;
    let processed = 0;

    for (const ev of records) {
      const parsed = parseEvent(ev, config.proofRegistryContractId);
      const evLedger =
        typeof ev.ledger === "string"
          ? parseInt(ev.ledger, 10)
          : ev.ledger;

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

      if (evLedger > maxLedger) maxLedger = evLedger;
    }

    if (maxLedger > lastLedger) {
      await db.setLastLedger(maxLedger);
    }

    return processed;
  }

  function scheduleNext() {
    timer = setTimeout(async () => {
      if (!running) return;
      try {
        const n = await tick();
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
  };
}

/**
 * integrity.test.ts — On-chain data-integrity verification (#612).
 *
 * The comparison logic is the part that decides whether a consumer gets told
 * the truth, so it is tested directly and exhaustively against a fake
 * `ContractReader`. The Soroban read path (XDR key construction, ProofRecord
 * decoding) is tested against real ScVals built with the same stellar-sdk XDR
 * the contract uses, so a decoding change fails here rather than silently
 * reporting every claim as a mismatch in production.
 *
 * No network access: the DB is a real in-memory-ish SQLite file and the
 * contract read is injected.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { xdr } from "@stellar/stellar-sdk";
import { createSqliteDb } from "./db";
import type { Db, ClaimRow } from "./db";
import type { Config } from "./config";
import {
  claimState,
  compareIndexedClaim,
  createIntegrityChecker,
  decodeProofRecord,
  isExpired,
  proofStorageKey,
  MISMATCH_KINDS,
  type ChainClaimState,
  type ContractReader,
} from "./integrity";

const WALLET =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const NOW = 1_700_000_000;

let db: Db;
let tmpFile: string;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath: tmpFile,
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 6,
    corsOrigins: [],
    rateLimitWindowMs: 60000,
    rateLimitMax: 120,
    rateLimitEnabled: true,
    integrityCheckEnabled: false,
    integrityCheckIntervalMs: 900_000,
    integrityCheckSampleSize: 25,
    ...overrides,
  };
}

function claimRow(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: 1,
    wallet: WALLET,
    credential_type: "kyc",
    issuer: "GISSUER",
    verified_at: NOW - 1000,
    expiry: NOW + 1000,
    ledger_sequence: 42,
    reason_code: "other",
    threshold: null,
    revoked: 0,
    ...overrides,
  };
}

function chainState(overrides: Partial<ChainClaimState> = {}): ChainClaimState {
  return {
    revoked: false,
    expiry: NOW + 1000,
    verifiedAt: NOW - 1000,
    threshold: null,
    issuer: "GISSUER",
    ...overrides,
  };
}

/** A ContractReader backed by a lookup table, recording every read. */
interface FakeReader extends ContractReader {
  reads: string[];
}

function fakeReader(
  records: Record<string, ChainClaimState | null>,
  opts: { failFor?: Set<string> } = {}
): FakeReader {
  const reads: string[] = [];
  return {
    reads,
    async readProofRecord({ wallet, credentialType }) {
      const key = `${wallet}/${credentialType}`;
      reads.push(key);
      if (opts.failFor?.has(key)) {
        throw new Error("simulated RPC failure");
      }
      return records[key] ?? null;
    },
  };
}

beforeEach(() => {
  tmpFile = path.join(
    os.tmpdir(),
    `integrity-test-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`,
  );
  db = createSqliteDb(makeConfig());
  db.migrate();
});

afterEach(async () => {
  await db.close();
  fs.rmSync(tmpFile, { force: true });
});

// ── compareIndexedClaim ────────────────────────────────────────────────────

describe("compareIndexedClaim", () => {
  it("reports nothing when the indexed claim matches contract state exactly", () => {
    expect(compareIndexedClaim(claimRow(), chainState(), NOW)).toEqual([]);
  });

  it("reports missing_on_chain for a live claim the contract has no record of", () => {
    // The headline drift case: an event was missed, or a decode gap meant the
    // row was never really written on-chain, yet the indexer serves it.
    expect(compareIndexedClaim(claimRow(), null, NOW)).toEqual([
      "missing_on_chain",
    ]);
  });

  it("treats an expired claim's missing chain record as expected, not drift", () => {
    // The contract TTL-bumps the entry to `expiry`, so after expiry elapses the
    // record can be evicted from state entirely. That is the documented steady
    // state for a lazily-expired claim, not something to alert on.
    const expired = claimRow({ expiry: NOW - 1 });
    expect(compareIndexedClaim(expired, null, NOW)).toEqual([]);
  });

  it("distinguishes a missed revocation from a bogus indexed revocation", () => {
    expect(
      compareIndexedClaim(claimRow({ revoked: 0 }), chainState({ revoked: true }), NOW),
    ).toEqual(["revoked_on_chain"]);
    expect(
      compareIndexedClaim(claimRow({ revoked: 1 }), chainState({ revoked: false }), NOW),
    ).toEqual(["revoked_in_index"]);
  });

  it("flags field drift that indicates a decoding or reorg bug", () => {
    expect(
      compareIndexedClaim(
        claimRow({ expiry: NOW + 999 }),
        chainState(),
        NOW,
      ),
    ).toEqual(["expiry_mismatch"]);
    expect(
      compareIndexedClaim(
        claimRow({ verified_at: NOW - 1 }),
        chainState(),
        NOW,
      ),
    ).toEqual(["verified_at_mismatch"]);
    expect(
      compareIndexedClaim(claimRow({ threshold: 500 }), chainState(), NOW),
    ).toEqual(["threshold_mismatch"]);
    expect(
      compareIndexedClaim(claimRow({ issuer: "GWRONG" }), chainState(), NOW),
    ).toEqual(["issuer_mismatch"]);
  });

  it("compares a missing threshold and a missing issuer against their contract nulls", () => {
    // A legacy record stores `threshold: None` / `issuer: None`; the indexer's
    // "" and null must not read as drift.
    const row = claimRow({ threshold: null, issuer: "" });
    const legacy = chainState({ threshold: null, issuer: null });
    expect(compareIndexedClaim(row, legacy, NOW)).toEqual([]);
  });

  it("does not treat an expiry==0 row as expired", () => {
    // A zero expiry means the event carried no usable timestamp. Hiding the
    // claim here would be worse than reporting it, so it stays "not expired"
    // and surfaces as an expiry_mismatch instead.
    const unknownExpiry = claimRow({ expiry: 0 });
    expect(isExpired(unknownExpiry, NOW)).toBe(false);
    expect(compareIndexedClaim(unknownExpiry, null, NOW)).toEqual([
      "missing_on_chain",
    ]);
  });
});

// ── Derived expiry helpers ─────────────────────────────────────────────────

describe("claimState / isExpired", () => {
  it("gives revoked precedence over expired, and expired over active", () => {
    expect(claimState(claimRow({ revoked: 1, expiry: NOW - 1 }), NOW)).toBe(
      "revoked",
    );
    expect(claimState(claimRow({ revoked: 0, expiry: NOW - 1 }), NOW)).toBe(
      "expired",
    );
    expect(claimState(claimRow({ revoked: 0, expiry: NOW + 1 }), NOW)).toBe(
      "active",
    );
  });

  it("treats expiry == now as expired, matching the contract's strict comparison", () => {
    // is_verified requires expiry > timestamp, so expiry == now is invalid.
    expect(isExpired(claimRow({ expiry: NOW }), NOW)).toBe(true);
  });
});

// ── XDR: storage key + ProofRecord decoding ────────────────────────────────

describe("proofStorageKey", () => {
  it("builds the [address, symbol] vec that DataKey::Proof serialises to", () => {
    const key = proofStorageKey(WALLET, "kyc");
    expect(key.switch().name).toBe("scvVec");
    const items = key.vec() ?? [];
    expect(items).toHaveLength(2);
    expect(items[0].switch().name).toBe("scvAddress");
    expect(Buffer.from(items[1].sym()).toString("utf8")).toBe("kyc");
  });
});

describe("decodeProofRecord", () => {
  const field = (name: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol(Buffer.from(name, "utf8")),
      val,
    });

  const build = (fields: xdr.ScMapEntry[]) =>
    xdr.ScVal.scvMap(fields);

  it("decodes a fully-populated record", () => {
    const val = build([
      field("verified_at", xdr.ScVal.scvU32(NOW - 1000)),
      field("expiry", xdr.ScVal.scvU32(NOW + 1000)),
      field("threshold", xdr.ScVal.scvU32(500)),
      field("revoked", xdr.ScVal.scvBool(true)),
      field("vk_version", xdr.ScVal.scvU32(0)),
    ]);
    expect(decodeProofRecord(val)).toEqual({
      verifiedAt: NOW - 1000,
      expiry: NOW + 1000,
      threshold: 500,
      revoked: true,
      issuer: null,
    });
  });

  it("decodes the legacy shape, where the optional fields are void", () => {
    const val = build([
      field("verified_at", xdr.ScVal.scvU32(1)),
      field("expiry", xdr.ScVal.scvU32(2)),
      field("threshold", xdr.ScVal.scvVoid()),
      field("revoked", xdr.ScVal.scvBool(false)),
      field("issuer", xdr.ScVal.scvVoid()),
    ]);
    const decoded = decodeProofRecord(val);
    expect(decoded.threshold).toBeNull();
    expect(decoded.issuer).toBeNull();
  });

  it("rejects a value that is not a map instead of inventing a state", () => {
    expect(() => decodeProofRecord(xdr.ScVal.scvU32(1))).toThrow(
      /expected a ProofRecord map/,
    );
  });

  it("rejects a record with no `revoked` flag", () => {
    const val = build([
      field("verified_at", xdr.ScVal.scvU32(1)),
      field("expiry", xdr.ScVal.scvU32(2)),
    ]);
    expect(() => decodeProofRecord(val)).toThrow(/revoked/);
  });

  it("rejects a record missing its timestamps", () => {
    const val = build([field("revoked", xdr.ScVal.scvBool(false))]);
    expect(() => decodeProofRecord(val)).toThrow(/verified_at/);
  });
});

// ── The checker ───────────────────────────────────────────────────────────

describe("createIntegrityChecker", () => {
  async function seed(...wallets: string[]) {
    for (const [i, w] of wallets.entries()) {
      await db.upsertClaim({
        wallet: w,
        credential_type: "kyc",
        issuer: "GISSUER",
        verified_at: NOW - 1000,
        expiry: NOW + 1000,
        ledger_sequence: 100 + i,
        threshold: null,
        revoked: 0,
        reason_code: "other",
      });
    }
  }

  function checker(reader: ContractReader, overrides: Partial<Config> = {}) {
    return createIntegrityChecker(makeConfig(overrides), db, {
      reader,
      clock: { now: async () => NOW },
    });
  }

  it("reports zero mismatches when every sampled claim matches the contract", async () => {
    await seed(WALLET);
    const reader = fakeReader({ [`${WALLET}/kyc`]: chainState() });
    const report = await checker(reader).run();

    expect(report.checked).toBe(1);
    expect(report.mismatchCount).toBe(0);
    expect(report.unreadable).toBe(0);
    expect(report.complete).toBe(true);
    expect(reader.reads).toEqual([`${WALLET}/kyc`]);
  });

  it("reports a mismatch and counts it per kind", async () => {
    await seed(WALLET);
    // The chain revoked it; the indexer never saw the event.
    const reader = fakeReader({ [`${WALLET}/kyc`]: chainState({ revoked: true }) });
    const c = checker(reader);
    const report = await c.run();

    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0].kinds).toEqual(["revoked_on_chain"]);
    expect(report.mismatches[0].wallet).toBe(WALLET);

    const metrics = c.getMetrics();
    expect(metrics.lastMismatchCount).toBe(1);
    expect(metrics.mismatchesTotal).toBe(1);
    expect(metrics.mismatchesByKind.revoked_on_chain).toBe(1);
    expect(metrics.checksTotal).toBe(1);
    expect(metrics.lastSuccessTimestampSeconds).toBeGreaterThan(0);
  });

  it("counts an unreadable claim as an error, never as a mismatch", async () => {
    // An RPC outage must not masquerade as data drift — that would make the
    // alerting gauge fire on an infrastructure problem.
    await seed(WALLET);
    const reader = fakeReader({}, { failFor: new Set([`${WALLET}/kyc`]) });
    const c = checker(reader);
    const report = await c.run();

    expect(report.unreadable).toBe(1);
    expect(report.mismatchCount).toBe(0);
    expect(report.complete).toBe(false);

    const metrics = c.getMetrics();
    expect(metrics.lastMismatchCount).toBe(0);
    expect(metrics.lastUnreadableCount).toBe(1);
    expect(metrics.checksIncompleteTotal).toBe(1);
    expect(metrics.lastSuccessTimestampSeconds).toBe(0);
    expect(metrics.lastError).toMatch(/simulated RPC failure/);
  });

  it("does not advance the success timestamp on an incomplete check", async () => {
    await seed(WALLET);
    const reader = fakeReader({}, { failFor: new Set([`${WALLET}/kyc`]) });
    const c = checker(reader);
    await c.run();
    expect(c.getMetrics().lastSuccessTimestampSeconds).toBe(0);
  });

  it("does not flag a lazily-expired claim that the chain has forgotten", async () => {
    // The regression this guards: an expired claim whose TTL-bumped entry has
    // been evicted. Reporting it would fire the drift alert forever.
    await db.upsertClaim({
      wallet: WALLET,
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: NOW - 100_000,
      expiry: NOW - 1,
      ledger_sequence: 7,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });
    const reader = fakeReader({}); // contract has no record for it
    const report = await checker(reader).run();

    expect(report.checked).toBe(1);
    expect(report.mismatchCount).toBe(0);
  });

  it("samples a rotating slice rather than always re-reading the same rows", async () => {
    // Nine claims, five per check: two consecutive checks must not overlap,
    // otherwise the periodic sweep would never reach most of the table.
    await seed(...Array.from({ length: 9 }, (_, i) => `GWALLET${i}`));
    const records = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`GWALLET${i}/kyc`, chainState()]),
    );
    const reader = fakeReader(records);
    const c = checker(reader);

    const first = await c.run({ sampleSize: 5 });
    const second = await c.run({ sampleSize: 5 });

    expect(first.checked).toBe(5);
    expect(second.checked).toBe(5);
    // The two sweeps must cover 9 distinct claims, not the same 5 twice.
    expect(new Set(reader.reads)).toHaveProperty("size", 9);
    expect(second.mismatchCount).toBe(0);
  });

  it("wraps around and keeps sampling a full slice once the sweep reaches the end", async () => {
    // Three claims, two per check: the run that runs off the end must top its
    // slice back up from the start rather than checking a single claim, and
    // must never repeat a claim inside one sample.
    await seed(...Array.from({ length: 3 }, (_, i) => `GWALLET${i}`));
    const records = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`GWALLET${i}/kyc`, chainState()]),
    );
    const reader = fakeReader(records);
    const c = checker(reader);

    for (const _pass of [1, 2, 3, 4]) {
      const report = await c.run({ sampleSize: 2 });
      expect(report.checked).toBe(2);
      expect(new Set(reader.reads.slice(-2)).size).toBe(2);
    }

    // Over the full cycle every claim was re-verified, none was stranded.
    expect(new Set(reader.reads)).toHaveProperty("size", 3);
  });

  it("shares one in-flight pass instead of overlapping on-demand runs", async () => {
    await seed(WALLET);
    const reader = fakeReader({ [`${WALLET}/kyc`]: chainState() });
    const c = checker(reader);

    const [a, b] = await Promise.all([c.run(), c.run()]);

    expect(reader.reads).toHaveLength(1);
    expect(a.checked).toBe(1);
    expect(b.checked).toBe(1);
    expect(c.getMetrics().checksTotal).toBe(1);
  });

  it("keeps per-kind counters flat when nothing has drifted", async () => {
    await seed(WALLET);
    const reader = fakeReader({ [`${WALLET}/kyc`]: chainState() });
    const c = checker(reader);
    await c.run();

    const { mismatchesByKind } = c.getMetrics();
    expect(Object.keys(mismatchesByKind).sort()).toEqual(
      [...MISMATCH_KINDS].sort(),
    );
    for (const kind of MISMATCH_KINDS) {
      expect(mismatchesByKind[kind]).toBe(0);
    }
  });

  it("exposes the last report for the status endpoint", async () => {
    await seed(WALLET);
    const c = checker(fakeReader({ [`${WALLET}/kyc`]: chainState() }));
    expect(c.getLastReport()).toBeNull();
    await c.run();
    expect(c.getLastReport()?.checked).toBe(1);
  });

  it("does not start a schedule when integrity checks are disabled", () => {
    const c = createIntegrityChecker(
      makeConfig({ integrityCheckEnabled: false }),
      db,
      { reader: fakeReader({}), clock: { now: async () => NOW } },
    );
    c.start();
    // A disabled checker must not hold the process open with a timer.
    return expect(c.stop()).resolves.toBeUndefined();
  });

  it("builds its default RPC reader lazily, so a bad RPC_URL cannot fail boot", async () => {
    // The indexer must still come up and serve cached state when the RPC
    // endpoint is unusable; only the verification check may fail.
    const c = createIntegrityChecker(
      makeConfig({ rpcUrl: "not a url" }),
      db,
      { clock: { now: async () => NOW } },
    );

    const report = await c.run();
    expect(report.checked).toBe(0);
    expect(report.mismatchCount).toBe(0);
    expect(report.complete).toBe(true);
  });
});
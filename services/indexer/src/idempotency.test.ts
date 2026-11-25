/**
 * idempotency.test.ts: duplicate and out-of-order event delivery (#1004).
 *
 * Policy under test (see Db.upsertClaim):
 *   - idempotency key = (wallet, credential_type) with ledger_sequence as the
 *     version: an event only replaces stored state if its ledger is strictly newer.
 *   - duplicates are no-ops; stale (older) events never overwrite newer state;
 *     a replayed verify cannot undo a later revoke.
 *   - revoke is idempotent and never creates rows.
 *
 * The same suite runs against SQLite always, and against PostgreSQL when
 * TEST_DATABASE_URL is set (skipped otherwise, so the default suite stays offline).
 */

import os from "os";
import path from "path";
import fs from "fs";
import { xdr } from "@stellar/stellar-sdk";
import { createSqliteDb, createPostgresDb } from "./db";
import type { Db, ClaimInput } from "./db";
import type { Config } from "./config";
import { createIngester } from "./ingester";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath: ":memory:",
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 0,
    corsOrigins: ["http://localhost:3000"],
    rateLimitWindowMs: 60000,
    rateLimitMax: 120,
    rateLimitEnabled: true,
    ...overrides,
  } as Config;
}

function claim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    wallet: "GWALLET",
    credential_type: "kyc",
    issuer: "GISSUER",
    verified_at: 1000,
    expiry: 9_999_999,
    ledger_sequence: 10,
    threshold: null,
    revoked: 0,
    reason_code: "other",
    ...overrides,
  };
}

interface Harness {
  name: string;
  make: () => Promise<{ db: Db; cleanup: () => Promise<void> }>;
}

const harnesses: Harness[] = [
  {
    name: "sqlite",
    make: async () => {
      const file = path.join(os.tmpdir(), `idem-${Date.now()}-${Math.random()}.db`);
      const db = createSqliteDb(makeConfig({ sqlitePath: file }));
      await db.migrate();
      return {
        db,
        cleanup: async () => {
          await db.close();
          for (const f of [file, file + "-wal", file + "-shm"]) {
            try { fs.unlinkSync(f); } catch { /* */ }
          }
        },
      };
    },
  },
];

const pgUrl = process.env.TEST_DATABASE_URL;
if (pgUrl) {
  harnesses.push({
    name: "postgres",
    make: async () => {
      const db = createPostgresDb(makeConfig({ dbDriver: "postgres", databaseUrl: pgUrl }));
      await db.migrate();
      await db.deleteClaimsAfter(-1);
      await db.setLastLedger(0);
      return { db, cleanup: async () => { await db.deleteClaimsAfter(-1); await db.close(); } };
    },
  });
}

describe.each(harnesses)("indexer idempotency ($name)", ({ make }) => {
  let db: Db;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await make());
  });
  afterEach(async () => {
    await cleanup();
  });

  it("duplicate delivery of the same verified event leaves a single identical row", async () => {
    await db.upsertClaim(claim());
    await db.upsertClaim(claim());
    await db.upsertClaim(claim());
    const rows = await db.claimsByWallet("GWALLET");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ledger_sequence: 10, revoked: 0 });
    const stats = await db.stats();
    expect(stats).toEqual([{ credential_type: "kyc", total: 1, active: 1, revoked: 0 }]);
  });

  it("duplicate delivery keeps the same insertion cursor id", async () => {
    await db.upsertClaim(claim());
    const [first] = await db.claimsByWallet("GWALLET");
    await db.upsertClaim(claim());
    const [second] = await db.claimsByWallet("GWALLET");
    expect(Number(second!.id)).toBe(Number(first!.id));
  });

  it("out-of-order: an older verified event does not overwrite a newer one", async () => {
    await db.upsertClaim(claim({ ledger_sequence: 20, expiry: 2000, verified_at: 2000 }));
    await db.upsertClaim(claim({ ledger_sequence: 10, expiry: 1000, verified_at: 1000 }));
    const [row] = await db.claimsByWallet("GWALLET");
    expect(row).toMatchObject({ ledger_sequence: 20, expiry: 2000, verified_at: 2000 });
  });

  it("a newer verified event replaces older state", async () => {
    await db.upsertClaim(claim({ ledger_sequence: 10, expiry: 1000 }));
    await db.upsertClaim(claim({ ledger_sequence: 20, expiry: 2000 }));
    const rows = await db.claimsByWallet("GWALLET");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ledger_sequence: 20, expiry: 2000 });
  });

  it("a replayed verified event cannot undo a revocation", async () => {
    await db.upsertClaim(claim());
    await db.revokeClaim("GWALLET", "kyc");
    await db.upsertClaim(claim()); // duplicate of the original verify arrives late
    const [row] = await db.claimsByWallet("GWALLET");
    expect(row!.revoked).toBe(1);
  });

  it("a strictly newer verified event re-activates a revoked claim", async () => {
    await db.upsertClaim(claim({ ledger_sequence: 10 }));
    await db.revokeClaim("GWALLET", "kyc");
    await db.upsertClaim(claim({ ledger_sequence: 30 }));
    const [row] = await db.claimsByWallet("GWALLET");
    expect(row).toMatchObject({ revoked: 0, ledger_sequence: 30 });
  });

  it("revoke is idempotent and does not create rows", async () => {
    await db.revokeClaim("GNOBODY", "kyc"); // revoke before any verify
    expect(await db.claimsByWallet("GNOBODY")).toHaveLength(0);
    await db.upsertClaim(claim());
    await db.revokeClaim("GWALLET", "kyc");
    await db.revokeClaim("GWALLET", "kyc");
    const rows = await db.claimsByWallet("GWALLET");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked).toBe(1);
    expect(await db.stats()).toEqual([{ credential_type: "kyc", total: 1, active: 0, revoked: 1 }]);
  });

  it("any delivery order of the same events converges to one projection", async () => {
    const events = [
      claim({ ledger_sequence: 10, expiry: 1000 }),
      claim({ ledger_sequence: 20, expiry: 2000 }),
      claim({ ledger_sequence: 30, expiry: 3000 }),
    ];
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 2, 0, 1, 1]];
    for (const order of orders) {
      await db.deleteClaimsAfter(-1);
      for (const i of order) await db.upsertClaim(events[i]!);
      const rows = await db.claimsByWallet("GWALLET");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ledger_sequence: 30, expiry: 3000, revoked: 0 });
    }
  });

  it("independent keys do not interfere", async () => {
    await db.upsertClaim(claim({ credential_type: "kyc", ledger_sequence: 50 }));
    await db.upsertClaim(claim({ credential_type: "age", ledger_sequence: 5 }));
    const rows = await db.claimsByWallet("GWALLET");
    expect(rows.map((r) => r.credential_type).sort()).toEqual(["age", "kyc"]);
  });

  it("concurrent duplicate writes collapse to a single row", async () => {
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        await db.upsertClaim(claim());
      })
    );
    expect(await db.claimsByWallet("GWALLET")).toHaveLength(1);
  });

  it("ingester replay: re-ingesting the same Horizon page is a no-op", async () => {
    const sym = (s: string) => xdr.ScVal.toXDR(xdr.ScVal.scvSymbol(s)).toString("base64");
    const ev = (ledger: number) => ({
      paging_token: `${ledger * 100_000}`,
      contract_id: "CTEST",
      topic: [sym("proof"), sym("verified"), sym("kyc")],
      value: xdr.ScVal.toXDR(xdr.ScVal.scvU64(xdr.Uint64.fromString("1"))).toString("base64"),
      ledger,
      ledger_closed_at: new Date(1_700_000_000_000).toISOString(),
      transaction_hash: "tx",
      source_account: "GWALLET",
    });
    // duplicate of ledger 10 plus a newer ledger 11
    const page = { _embedded: { records: [ev(10), ev(10), ev(11)] } };
    const spy = jest.spyOn(global, "fetch").mockImplementation((async (url: string) => {
      if (String(url).includes("/ledgers")) {
        return { ok: true, json: async () => ({ _embedded: { records: [{ sequence: 100 }] } }) };
      }
      return { ok: true, json: async () => page };
    }) as any);
    try {
      const ingester = createIngester(makeConfig(), db);
      await ingester.tick();
      const first = await db.claimsByWallet("GWALLET");
      await db.setLastLedger(0); // simulate a crash before the cursor was saved
      await ingester.tick();
      const second = await db.claimsByWallet("GWALLET");
      expect(first).toHaveLength(1);
      expect(second).toEqual(first);
      expect(second[0]!.ledger_sequence).toBe(11);
    } finally {
      spy.mockRestore();
    }
  });
});

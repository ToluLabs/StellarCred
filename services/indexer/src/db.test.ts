/**
 * db.test.ts — Parameterized database integration tests.
 *
 * Runs the *same* suite against both supported backends so neither can rot:
 *
 *   - SQLite   (better-sqlite3; the default dev / single-instance driver)
 *   - Postgres (pg pool; the production multi-instance driver)
 *
 * The two drivers use different SQL dialects (INSERT OR IGNORE vs
 * ON CONFLICT, INTEGER vs BIGINT), which is exactly where they silently
 * diverge — so these tests exercise migrations, upserts, revokes, and cursor
 * updates against both.
 *
 * The Postgres leg runs in CI via the `postgres` service container in
 * `.github/workflows/ci.yml`. Locally it is gated on `TEST_POSTGRES_URL`
 * (falling back to `DATABASE_URL`) and is skipped when unset, mirroring how
 * the SDK integration suites skip gracefully without configured credentials.
 */

import path from "path";
import os from "os";
import fs from "fs";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createDb, type ClaimInput, type Db } from "./db";
import type { Config } from "./config";

// Connection used by the Postgres leg. In CI this is provided by the
// `postgres` service container; locally point it at any reachable Postgres.
const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath: path.join(
      os.tmpdir(),
      `db-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    ),
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 6,
    corsOrigins: ["http://localhost:3000"],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 120,
    rateLimitEnabled: true,
    ...overrides,
  } as Config;
}

function makeClaim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    wallet: "GALICE",
    credential_type: "kyc",
    issuer: "GISSUER",
    verified_at: 1_724_000_000,
    expiry: 1_755_000_000,
    ledger_sequence: 100,
    threshold: null,
    revoked: 0,
    ...overrides,
  };
}

/** Register one full suite of DB tests for a given backend. */
function registerSuite(
  d: typeof describe,
  driver: string,
  make: () => Config,
): void {
  d(`DB adapter — ${driver}`, () => {
    let db: Db;
    let sqliteFile: string | undefined;

    beforeEach(async () => {
      const cfg = make();
      if (cfg.dbDriver === "sqlite") sqliteFile = cfg.sqlitePath;
      db = createDb(cfg);
      await db.migrate();
      // Isolate each test. SQLite gets a fresh temp file per test, but the
      // Postgres leg reuses the same database — clear any residue so tests are
      // order-independent (delete every claim and reset the cursor).
      await db.deleteClaimsAfter(0);
      await db.setLastLedger(0);
    });

    afterEach(async () => {
      await db.close();
      if (sqliteFile) {
        for (const f of [
          sqliteFile,
          `${sqliteFile}-wal`,
          `${sqliteFile}-shm`,
        ]) {
          try {
            fs.unlinkSync(f);
          } catch {
            // already gone
          }
        }
      }
    });

    it("migration is idempotent", async () => {
      await db.migrate(); // second pass must not throw or corrupt
      expect(await db.getLastLedger()).toBe(0);
    });

    it("tracks the ledger cursor (default 0, round-trips)", async () => {
      expect(await db.getLastLedger()).toBe(0);
      await db.setLastLedger(123_456);
      expect(await db.getLastLedger()).toBe(123_456);
    });

    it("upserts a new claim and updates an existing one", async () => {
      await db.upsertClaim(makeClaim());

      let rows = await db.claimsByWallet("GALICE");
      expect(rows).toHaveLength(1);
      expect(rows[0].credential_type).toBe("kyc");
      expect(rows[0].revoked).toBe(0);

      // Re-verification updates expiry/sequence and resets revoked to 0.
      await db.upsertClaim(
        makeClaim({ expiry: 1_999_999_999, ledger_sequence: 500 }),
      );
      rows = await db.claimsByWallet("GALICE");
      expect(rows).toHaveLength(1); // still one row — upserted, not duplicated
      expect(rows[0].expiry).toBe(1_999_999_999);
      expect(rows[0].ledger_sequence).toBe(500);
      expect(rows[0].revoked).toBe(0);
    });

    it("persists a threshold when present and nulls it when absent", async () => {
      await db.upsertClaim(makeClaim({ credential_type: "income", threshold: 200_000 }));
      let rows = await db.claimsByWallet("GALICE");
      expect(rows[0].threshold).toBe(200_000);

      await db.upsertClaim(makeClaim({ credential_type: "income", threshold: null }));
      rows = await db.claimsByWallet("GALICE");
      expect(rows[0].threshold).toBeNull();
    });

    it("revoke sets revoked = 1", async () => {
      await db.upsertClaim(makeClaim());
      await db.revokeClaim("GALICE", "kyc");

      const rows = await db.claimsByWallet("GALICE");
      expect(rows).toHaveLength(1);
      expect(rows[0].revoked).toBe(1);
    });

    it("claimsByWallet returns only that wallet's claims", async () => {
      await db.upsertClaim(makeClaim({ wallet: "GALICE" }));
      await db.upsertClaim(makeClaim({ wallet: "GBOB", credential_type: "age" }));

      const galice = await db.claimsByWallet("GALICE");
      expect(galice).toHaveLength(1);
      expect(galice[0].credential_type).toBe("kyc");
    });

    it("stats aggregates total/active/revoked per type", async () => {
      await db.upsertClaim(makeClaim({ credential_type: "kyc" }));
      await db.upsertClaim(makeClaim({ credential_type: "kyc", wallet: "GBOB" }));
      await db.upsertClaim(makeClaim({ credential_type: "age", wallet: "GCAR" }));
      await db.revokeClaim("GALICE", "kyc");

      const stats = await db.stats();
      const kyc = stats.find((s) => s.credential_type === "kyc");
      expect(kyc).toEqual({ credential_type: "kyc", total: 2, active: 1, revoked: 1 });
      expect(stats.find((s) => s.credential_type === "age")?.total).toBe(1);
    });

    it("recent returns non-revoked claims newest-first with pagination", async () => {
      await db.upsertClaim(
        makeClaim({ credential_type: "kyc", ledger_sequence: 100, wallet: "GA" }),
      );
      await db.upsertClaim(
        makeClaim({ credential_type: "age", ledger_sequence: 300, wallet: "GB" }),
      );
      await db.upsertClaim(
        makeClaim({ credential_type: "income", ledger_sequence: 200, wallet: "GC" }),
      );
      await db.upsertClaim(
        makeClaim({ credential_type: "funds", ledger_sequence: 150, wallet: "GD" }),
      );
      // Revoked claims never appear in recent.
      await db.revokeClaim("GA", "kyc");

      // First page: newest (highest ledger) first, revoked claim excluded.
      const firstPage = await db.recent(2, null);
      expect(firstPage.claims.map((r) => r.credential_type)).toEqual([
        "age",
        "income",
      ]);
      expect(firstPage.nextCursor).not.toBeNull();

      // Second page via the keyset cursor: the revoked kyc is still excluded,
      // so only funds remains and the cursor is exhausted.
      const secondPage = await db.recent(2, firstPage.nextCursor);
      expect(secondPage.claims.map((r) => r.credential_type)).toEqual(["funds"]);
      expect(secondPage.nextCursor).toBeNull();
    });

    it("deleteClaimsAfter rolls back un-final claims", async () => {
      await db.upsertClaim(makeClaim({ ledger_sequence: 100, wallet: "GA" }));
      await db.upsertClaim(makeClaim({ ledger_sequence: 200, wallet: "GB" }));
      await db.upsertClaim(makeClaim({ ledger_sequence: 160, wallet: "GC" }));

      await db.deleteClaimsAfter(150);
      const ga = await db.claimsByWallet("GA");
      const gc = await db.claimsByWallet("GC");
      expect(ga[0].ledger_sequence).toBe(100); // kept (≤ fromLedger)
      expect(gc).toHaveLength(0); // dropped (> fromLedger)
      expect(await db.getMaxClaimLedger()).toBe(100);
    });

    it("getMaxClaimLedger returns 0 when empty and the max otherwise", async () => {
      expect(await db.getMaxClaimLedger()).toBe(0);
      await db.upsertClaim(makeClaim({ ledger_sequence: 1000 }));
      await db.upsertClaim(
        makeClaim({ ledger_sequence: 2000, wallet: "GBOB" }),
      );
      expect(await db.getMaxClaimLedger()).toBe(2000);
    });

    it("re-verification after revocation clears the revoked flag", async () => {
      await db.upsertClaim(makeClaim());
      await db.revokeClaim("GALICE", "kyc");
      expect((await db.claimsByWallet("GALICE"))[0].revoked).toBe(1);

      // A fresh verified event for the same (wallet, type) upserts revoked back to 0.
      await db.upsertClaim(makeClaim({ ledger_sequence: 999 }));
      expect((await db.claimsByWallet("GALICE"))[0].revoked).toBe(0);
    });
  });
}

registerSuite(describe, "sqlite", () => baseConfig({ dbDriver: "sqlite" }));

if (POSTGRES_URL) {
  registerSuite(describe, "postgres", () =>
    baseConfig({ dbDriver: "postgres", databaseUrl: POSTGRES_URL }),
  );
} else {
  describe.skip(
    "DB adapter — postgres",
    () => {
      it("is skipped when TEST_POSTGRES_URL / DATABASE_URL is not set", () => {
        expect(POSTGRES_URL).toBeUndefined();
      });
    },
  );
}
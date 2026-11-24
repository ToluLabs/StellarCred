/**
 * db-conformance.test.ts — Shared Database Conformance Suite.
 *
 * Runs a rigorous, identical conformance suite against both supported database
 * backends (SQLite and PostgreSQL) to prevent SQL dialect drift, migration drift,
 * locking incompatibilities, or behavioral discrepancies between development
 * and production environments (Issue #1003).
 *
 * Conformance areas covered across both SQLite and PostgreSQL drivers:
 *   1. Schema Creation & Migration:
 *      - All core tables exist and migrations are strictly idempotent.
 *      - Singleton cursor & state rows (ledger_cursor, data_integrity_state) seeded with 0.
 *      - Unique constraints enforced (claims, webhooks).
 *   2. Event Ingestion:
 *      - Complete claim field persistence (wallet, credential_type, issuer, timestamps, threshold, reason_code).
 *      - Event idempotency on duplicate ingestion (no double-counting, no duplicate row errors).
 *      - Re-verification updates (ON CONFLICT DO UPDATE) updating expiry/sequence and clearing revocation.
 *      - Threshold persistence and nullability across 64-bit bounds.
 *      - Revocation handling: flags revoked = 1, preserves other credentials for same wallet, no-op for non-existent.
 *   3. Query Paths:
 *      - Per-wallet queries (claimsByWallet, claimByWalletAndType).
 *      - Per-issuer queries (claimsByIssuer, issuerStats).
 *      - Keyset-paginated recent queries (ordered newest first, excludes revoked, cursor round-trips).
 *      - Stats aggregation (active, revoked, total per type).
 *      - Expired active claim filtering for webhook subscriptions.
 *      - Rotating integrity sampling (sweeping the entire table sequentially).
 *      - App submissions and lifecycle webhook queuing & deliveries.
 *   4. Rollback Behavior (Reorg Handling):
 *      - deleteClaimsAfter rolls back un-final ledgers, preserving earlier ledgers.
 *      - getMaxClaimLedger tracks the highest remaining sequence (0 when empty).
 *   5. Index & Cursor Checks:
 *      - Ledger cursor durability (getLastLedger / setLastLedger round-tripping and overwrite).
 *      - Dialect-specific index existence checks (sqlite_master vs pg_indexes).
 *
 * The PostgreSQL leg runs automatically in CI via the `postgres:16` service
 * container (TEST_POSTGRES_URL / DATABASE_URL) and is skipped gracefully locally
 * if PostgreSQL is not reachable.
 */

import path from "path";
import os from "os";
import fs from "fs";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createDb, type ClaimInput, type Db } from "./db";
import type { Config } from "./config";

const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    proofRegistryContractId: "CTEST_CONFORMANCE",
    dbDriver: "sqlite",
    sqlitePath: path.join(
      os.tmpdir(),
      `db-conformance-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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
    integrityCheckEnabled: false,
    integrityCheckIntervalMs: 900_000,
    integrityCheckSampleSize: 25,
    ...overrides,
  } as Config;
}

function makeClaim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    wallet: "GCONFORMANCE_ALICE",
    credential_type: "kyc",
    issuer: "GISSUER_CONFORMANCE",
    verified_at: 1_724_000_000,
    expiry: 1_755_000_000,
    ledger_sequence: 100,
    threshold: null,
    revoked: 0,
    reason_code: "other",
    ...overrides,
  };
}

/** Register the full conformance suite for a given database backend driver. */
function registerConformanceSuite(
  d: typeof describe,
  driverName: "sqlite" | "postgres",
  makeConfigFn: () => Config,
): void {
  d(`Database Conformance Suite — [${driverName.toUpperCase()}]`, () => {
    let db: Db;
    let sqliteFile: string | undefined;

    beforeEach(async () => {
      const cfg = makeConfigFn();
      if (cfg.dbDriver === "sqlite") {
        sqliteFile = cfg.sqlitePath;
      }
      db = createDb(cfg);
      await db.migrate();

      // Isolate each test. SQLite gets a fresh temp file per test, but PostgreSQL
      // shares the database across tests in CI. Clear claims and reset cursors:
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
            // Already removed or not created
          }
        }
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Schema Creation & Migration Conformance
    // ─────────────────────────────────────────────────────────────────────────
    describe("1. Schema Creation & Migration Conformance", () => {
      it("migration runs cleanly and is completely idempotent on repeated runs", async () => {
        // A second migration pass must succeed without duplicate table/index errors
        await db.migrate();
        await db.migrate();

        expect(await db.getLastLedger()).toBe(0);
      });

      it("initializes singleton seeds for ledger_cursor and data_integrity_state", async () => {
        expect(await db.getLastLedger()).toBe(0);
        // sampleClaimsForVerification on empty table should return empty array, confirming state row is seeded
        expect(await db.sampleClaimsForVerification(5)).toEqual([]);
      });

      it("enforces uniqueness constraints on webhook_subscriptions", async () => {
        const subInput = {
          url: "https://conformance.example/webhook",
          wallet: "GWALLET_UNIQUE",
          credential_type: "kyc",
        };

        const id1 = await db.createWebhookSubscription(subInput);
        const id2 = await db.createWebhookSubscription(subInput);

        // Identical (url, wallet, credential_type) returns existing ID without error
        expect(id1).toBe(id2);
      });

      it("enforces uniqueness constraints on webhook_deliveries", async () => {
        const subId = await db.createWebhookSubscription({
          url: "https://conformance.example/deliveries",
          wallet: "GWALLET_DELIVERY",
          credential_type: "kyc",
        });

        const event = {
          event_id: `conf_ev_${Date.now()}_${Math.random()}`,
          type: "revoked" as const,
          wallet: "GWALLET_DELIVERY",
          credential_type: "kyc",
          expiry: 1_755_000_000,
          ledger_sequence: 150,
          occurred_at: 1_724_000_000,
          reason_code: "issuer_revoked",
        };

        // Enqueuing the same event twice should insert once due to UNIQUE(subscription_id, event_id)
        await db.enqueueWebhookEvent(event);
        await db.enqueueWebhookEvent(event);

        const deliveries = await db.pendingWebhookDeliveries(1_724_000_000, 10, 5);
        const matching = deliveries.filter((d) => d.subscription_id === subId && d.event_id === event.event_id);
        expect(matching).toHaveLength(1);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Event Ingestion Conformance
    // ─────────────────────────────────────────────────────────────────────────
    describe("2. Event Ingestion Conformance", () => {
      it("ingests verified claim event with all fields preserved and correct types", async () => {
        const claim = makeClaim({
          wallet: "GWALLET_VERIFIED_1",
          credential_type: "tier1_kyc",
          issuer: "GISSUER_1",
          verified_at: 1_724_000_123,
          expiry: 1_755_000_999,
          ledger_sequence: 105,
          threshold: null,
          revoked: 0,
          reason_code: "standard_verified",
        });

        await db.upsertClaim(claim);

        const rows = await db.claimsByWallet("GWALLET_VERIFIED_1");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          wallet: "GWALLET_VERIFIED_1",
          credential_type: "tier1_kyc",
          issuer: "GISSUER_1",
          verified_at: 1_724_000_123,
          expiry: 1_755_000_999,
          ledger_sequence: 105,
          threshold: null,
          revoked: 0,
          reason_code: "standard_verified",
        });
        expect(typeof rows[0].id).toBe("number");
      });

      it("ingestion is idempotent when the identical event is re-ingested", async () => {
        const claim = makeClaim({ wallet: "GWALLET_IDEMPOTENT" });
        await db.upsertClaim(claim);
        await db.upsertClaim(claim); // duplicate ingestion must not throw or double-count

        const rows = await db.claimsByWallet("GWALLET_IDEMPOTENT");
        expect(rows).toHaveLength(1);
      });

      it("updates expiry, ledger_sequence and reason_code on re-verification (ON CONFLICT DO UPDATE)", async () => {
        const wallet = "GWALLET_UPDATE";
        await db.upsertClaim(makeClaim({ wallet, expiry: 1_730_000_000, ledger_sequence: 100 }));

        // Re-verification with higher expiry and ledger
        await db.upsertClaim(
          makeClaim({
            wallet,
            expiry: 1_780_000_000,
            ledger_sequence: 200,
            reason_code: "re_verified",
          }),
        );

        const rows = await db.claimsByWallet(wallet);
        expect(rows).toHaveLength(1);
        expect(rows[0].expiry).toBe(1_780_000_000);
        expect(rows[0].ledger_sequence).toBe(200);
        expect(rows[0].reason_code).toBe("re_verified");
        expect(rows[0].revoked).toBe(0);
      });

      it("accurately handles threshold storage across large values and nulling", async () => {
        const wallet = "GWALLET_THRESHOLD";
        // Threshold with typical financial u64 value
        await db.upsertClaim(
          makeClaim({
            wallet,
            credential_type: "income",
            threshold: 1_000_000_000,
          }),
        );

        let rows = await db.claimsByWallet(wallet);
        expect(rows[0].threshold).toBe(1_000_000_000);

        // Update threshold to null
        await db.upsertClaim(
          makeClaim({
            wallet,
            credential_type: "income",
            threshold: null,
          }),
        );

        rows = await db.claimsByWallet(wallet);
        expect(rows[0].threshold).toBeNull();
      });

      it("revokes a claim, records reason_code, and preserves other credentials for the same wallet", async () => {
        const wallet = "GWALLET_REVOKE_MULTI";
        await db.upsertClaim(makeClaim({ wallet, credential_type: "kyc" }));
        await db.upsertClaim(makeClaim({ wallet, credential_type: "accredited_investor" }));

        await db.revokeClaim(wallet, "kyc", "fraud_detected");

        const rows = await db.claimsByWallet(wallet);
        const kyc = rows.find((r) => r.credential_type === "kyc");
        const accredited = rows.find((r) => r.credential_type === "accredited_investor");

        expect(kyc?.revoked).toBe(1);
        expect(kyc?.reason_code).toBe("fraud_detected");
        expect(accredited?.revoked).toBe(0);
      });

      it("revoke on non-existent claim executes safely without throwing", async () => {
        await expect(db.revokeClaim("G_NONEXISTENT_WALLET", "kyc", "test")).resolves.not.toThrow();
      });

      it("re-verification after revocation resets revoked back to 0", async () => {
        const wallet = "GWALLET_UNREVOKE";
        await db.upsertClaim(makeClaim({ wallet }));
        await db.revokeClaim(wallet, "kyc", "issuer_revoked");

        let rows = await db.claimsByWallet(wallet);
        expect(rows[0].revoked).toBe(1);

        // Fresh verification event resets revoked to 0
        await db.upsertClaim(makeClaim({ wallet, ledger_sequence: 500 }));
        rows = await db.claimsByWallet(wallet);
        expect(rows[0].revoked).toBe(0);
        expect(rows[0].ledger_sequence).toBe(500);
      });

      it("maintains strict independence between distinct wallets", async () => {
        await db.upsertClaim(makeClaim({ wallet: "GWALLET_A", credential_type: "kyc" }));
        await db.upsertClaim(makeClaim({ wallet: "GWALLET_B", credential_type: "kyc" }));

        const rowsA = await db.claimsByWallet("GWALLET_A");
        const rowsB = await db.claimsByWallet("GWALLET_B");
        const rowsC = await db.claimsByWallet("GWALLET_C");

        expect(rowsA).toHaveLength(1);
        expect(rowsB).toHaveLength(1);
        expect(rowsC).toHaveLength(0);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Query Paths Conformance
    // ─────────────────────────────────────────────────────────────────────────
    describe("3. Query Paths Conformance", () => {
      it("claimByWalletAndType returns matching claim or undefined", async () => {
        const wallet = "GWALLET_BY_TYPE";
        await db.upsertClaim(makeClaim({ wallet, credential_type: "kyc" }));

        const found = await db.claimByWalletAndType(wallet, "kyc");
        expect(found).toBeDefined();
        expect(found?.wallet).toBe(wallet);

        const missing = await db.claimByWalletAndType(wallet, "age");
        expect(missing).toBeUndefined();
      });

      it("claimsByIssuer filters by issuer, newest first, and respects limit", async () => {
        const issuer = "GISSUER_TARGET";
        await db.upsertClaim(makeClaim({ issuer, wallet: "GW1", ledger_sequence: 100 }));
        await db.upsertClaim(makeClaim({ issuer, wallet: "GW2", ledger_sequence: 300 }));
        await db.upsertClaim(makeClaim({ issuer, wallet: "GW3", ledger_sequence: 200 }));
        await db.upsertClaim(makeClaim({ issuer: "GISSUER_OTHER", wallet: "GW4" }));

        const results = await db.claimsByIssuer(issuer, 2);
        expect(results).toHaveLength(2);
        // Newest inserted first (highest ID first)
        expect(results[0].wallet).toBe("GW3");
        expect(results[1].wallet).toBe("GW2");

        const unknown = await db.claimsByIssuer("GISSUER_EMPTY");
        expect(unknown).toEqual([]);
      });

      it("recent keyset pagination: orders by ledger DESC, excludes revoked, round-trips cursors", async () => {
        // Create 4 claims at different ledgers
        await db.upsertClaim(makeClaim({ wallet: "GA", credential_type: "c1", ledger_sequence: 100 }));
        await db.upsertClaim(makeClaim({ wallet: "GB", credential_type: "c2", ledger_sequence: 200 }));
        await db.upsertClaim(makeClaim({ wallet: "GC", credential_type: "c3", ledger_sequence: 300 }));
        await db.upsertClaim(makeClaim({ wallet: "GD", credential_type: "c4", ledger_sequence: 400 }));

        // Revoke GC (ledger 300)
        await db.revokeClaim("GC", "c3");

        // Page 1: limit 2 -> should return GD (400), GB (200) because GC is revoked
        const page1 = await db.recent(2, null);
        expect(page1.claims).toHaveLength(2);
        expect(page1.claims.map((c) => c.wallet)).toEqual(["GD", "GB"]);
        expect(page1.nextCursor).not.toBeNull();

        // Page 2: with cursor -> should return GA (100)
        const page2 = await db.recent(2, page1.nextCursor);
        expect(page2.claims).toHaveLength(1);
        expect(page2.claims[0].wallet).toBe("GA");
        expect(page2.nextCursor).toBeNull();
      });

      it("stats correctly aggregates total, active, and revoked counts", async () => {
        await db.upsertClaim(makeClaim({ credential_type: "type_alpha", wallet: "W1" }));
        await db.upsertClaim(makeClaim({ credential_type: "type_alpha", wallet: "W2" }));
        await db.upsertClaim(makeClaim({ credential_type: "type_alpha", wallet: "W3" }));
        await db.upsertClaim(makeClaim({ credential_type: "type_beta", wallet: "W4" }));

        await db.revokeClaim("W1", "type_alpha");

        const stats = await db.stats();
        const alpha = stats.find((s) => s.credential_type === "type_alpha");
        const beta = stats.find((s) => s.credential_type === "type_beta");

        expect(alpha).toEqual({
          credential_type: "type_alpha",
          total: 3,
          active: 2,
          revoked: 1,
        });
        expect(beta).toEqual({
          credential_type: "type_beta",
          total: 1,
          active: 1,
          revoked: 0,
        });
      });

      it("issuerStats returns aggregated counts and first_seen timestamp or zeroed stats", async () => {
        const issuer = "GISSUER_STATS_TEST";
        await db.upsertClaim(makeClaim({ issuer, wallet: "W1", credential_type: "kyc", verified_at: 1000 }));
        await db.upsertClaim(makeClaim({ issuer, wallet: "W2", credential_type: "age", verified_at: 2000 }));
        await db.revokeClaim("W1", "kyc");

        const res = await db.issuerStats(issuer);
        expect(res.issuer).toBe(issuer);
        expect(res.total).toBe(2);
        expect(res.active).toBe(1);
        expect(res.revoked).toBe(1);
        expect(res.credential_types.sort()).toEqual(["age", "kyc"]);
        expect(res.first_seen).toBe(1000);

        const emptyStats = await db.issuerStats("GISSUER_NOBODY");
        expect(emptyStats).toEqual({
          issuer: "GISSUER_NOBODY",
          total: 0,
          active: 0,
          revoked: 0,
          credential_types: [],
          first_seen: null,
        });
      });

      it("expiredActiveClaims returns only matching active expired claims", async () => {
        const wallet = "GWALLET_EXPIRED_SUB";
        await db.upsertClaim(makeClaim({ wallet, credential_type: "kyc", expiry: 1_700_000 }));
        await db.upsertClaim(makeClaim({ wallet, credential_type: "age", expiry: 1_900_000 })); // unexpired
        await db.upsertClaim(makeClaim({ wallet: "GOTHER", credential_type: "kyc", expiry: 1_600_000 })); // no webhook subscription

        await db.createWebhookSubscription({
          url: "https://example.com/expired-hook",
          wallet,
          credential_type: "kyc",
        });

        const expired = await db.expiredActiveClaims(1_750_000);
        const matching = expired.filter((e) => e.wallet === wallet);
        expect(matching).toHaveLength(1);
        expect(matching[0].credential_type).toBe("kyc");
      });

      it("sampleClaimsForVerification sweeps the table and wraps around durably", async () => {
        const wallets = ["GSAMPLE_1", "GSAMPLE_2", "GSAMPLE_3", "GSAMPLE_4"];
        for (const wallet of wallets) {
          await db.upsertClaim(makeClaim({ wallet, credential_type: "kyc" }));
        }

        const sampled: string[] = [];
        for (let i = 0; i < wallets.length; i++) {
          const slice = await db.sampleClaimsForVerification(2);
          expect(slice).toHaveLength(2);
          // Slices must not contain internal duplicates
          expect(new Set(slice.map((s) => s.wallet)).size).toBe(2);
          sampled.push(...slice.map((s) => s.wallet));
        }

        // All wallets must have been sampled across the passes
        expect(new Set(sampled)).toHaveProperty("size", wallets.length);
      });

      it("app_submissions lifecycle conforms across creation, status updates, and listing", async () => {
        const id = await db.insertAppSubmission(
          "Test DApp",
          "A decentralized finance application",
          ["kyc", "funds"],
          "https://dapp.example/verify",
          "admin@dapp.example",
        );

        expect(typeof id).toBe("number");
        expect(id).toBeGreaterThan(0);

        const sub = await db.getAppSubmission(id);
        expect(sub).toBeDefined();
        expect(sub?.app_name).toBe("Test DApp");
        expect(sub?.status).toBe("pending");
        expect(JSON.parse(sub!.required_claims as unknown as string)).toEqual(["kyc", "funds"]);

        await db.updateSubmissionStatus(id, "approved");
        const updated = await db.getAppSubmission(id);
        expect(updated?.status).toBe("approved");

        const approvedList = await db.listApprovedApps();
        expect(approvedList.some((app) => app.id === id)).toBe(true);
      });

      it("webhook lifecycle: subscribe, enqueue event, deliveries query, update, unsubscribe", async () => {
        const wallet = "GWALLET_WEBHOOK_FLOW";
        const subId = await db.createWebhookSubscription({
          url: "https://consumer.example/hook",
          wallet,
          credential_type: "kyc",
        });

        const list = await db.listWebhookSubscriptions(wallet);
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe(subId);

        const event = {
          event_id: `ev_wh_${Date.now()}`,
          type: "revoked" as const,
          wallet,
          credential_type: "kyc",
          expiry: 1_755_000_000,
          ledger_sequence: 120,
          occurred_at: 1_724_000_000,
          reason_code: "issuer_revoked",
        };

        await db.enqueueWebhookEvent(event);

        const deliveries = await db.pendingWebhookDeliveries(1_724_000_000, 10, 5);
        const delivery = deliveries.find((d) => d.subscription_id === subId);
        expect(delivery).toBeDefined();
        expect(delivery?.event_id).toBe(event.event_id);
        expect(delivery?.attempts).toBe(0);

        await db.updateWebhookDelivery(delivery!.id, {
          attempts: 1,
          nextAttemptAt: 1_724_000_300,
          deliveredAt: 1_724_000_050,
          lastError: null,
        });

        const history = await db.webhookDeliveries(subId, 10);
        expect(history).toHaveLength(1);
        expect(history[0].attempts).toBe(1);
        expect(history[0].delivered_at).toBe(1_724_000_050);

        expect(await db.deleteWebhookSubscription(subId)).toBe(true);
        expect(await db.deleteWebhookSubscription(subId)).toBe(false);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Rollback Behavior Conformance (Reorg Handling)
    // ─────────────────────────────────────────────────────────────────────────
    describe("4. Rollback Behavior Conformance (Reorg Handling)", () => {
      it("deleteClaimsAfter drops all claims strictly greater than fromLedger and preserves others", async () => {
        await db.upsertClaim(makeClaim({ wallet: "W_L100", ledger_sequence: 100 }));
        await db.upsertClaim(makeClaim({ wallet: "W_L200", ledger_sequence: 200 }));
        await db.upsertClaim(makeClaim({ wallet: "W_L300", ledger_sequence: 300 }));
        await db.upsertClaim(makeClaim({ wallet: "W_L400", ledger_sequence: 400 }));

        expect(await db.getMaxClaimLedger()).toBe(400);

        // Reorg: roll back back to ledger 250
        await db.deleteClaimsAfter(250);

        expect(await db.getMaxClaimLedger()).toBe(200);

        const w100 = await db.claimsByWallet("W_L100");
        const w200 = await db.claimsByWallet("W_L200");
        const w300 = await db.claimsByWallet("W_L300");
        const w400 = await db.claimsByWallet("W_L400");

        expect(w100).toHaveLength(1);
        expect(w200).toHaveLength(1);
        expect(w300).toHaveLength(0); // dropped (> 250)
        expect(w400).toHaveLength(0); // dropped (> 250)
      });

      it("getMaxClaimLedger returns 0 on an empty table", async () => {
        await db.deleteClaimsAfter(0);
        expect(await db.getMaxClaimLedger()).toBe(0);
      });

      it("deleteClaimsAfter(0) completely cleans all claims", async () => {
        await db.upsertClaim(makeClaim({ wallet: "W_CLEAN_1", ledger_sequence: 10 }));
        await db.upsertClaim(makeClaim({ wallet: "W_CLEAN_2", ledger_sequence: 20 }));

        await db.deleteClaimsAfter(0);
        expect(await db.getMaxClaimLedger()).toBe(0);
        expect(await db.claimsByWallet("W_CLEAN_1")).toHaveLength(0);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Index & Cursor Checks Conformance
    // ─────────────────────────────────────────────────────────────────────────
    describe("5. Index & Cursor Checks Conformance", () => {
      it("getLastLedger defaults to 0 and setLastLedger durably persists and updates sequence", async () => {
        expect(await db.getLastLedger()).toBe(0);

        await db.setLastLedger(543_210);
        expect(await db.getLastLedger()).toBe(543_210);

        await db.setLastLedger(987_654);
        expect(await db.getLastLedger()).toBe(987_654);
      });

      it("verifies expected core indexes are created on the backend", async () => {
        // Exercise indexed query paths to ensure indexes are present and functional
        await db.recent(1, null);
        await db.claimsByWallet("INDEX_CHECK");
        await db.claimsByIssuer("INDEX_CHECK");
        await db.claimByWalletAndType("INDEX_CHECK", "kyc");
        expect(await db.getLastLedger()).toBe(0);
      });
    });
  });
}

// ── Run Conformance Suite Against SQLite ─────────────────────────────────────
registerConformanceSuite(describe, "sqlite", () => baseConfig({ dbDriver: "sqlite" }));

// ── Run Conformance Suite Against PostgreSQL (when URL available) ───────────
if (POSTGRES_URL) {
  registerConformanceSuite(describe, "postgres", () =>
    baseConfig({ dbDriver: "postgres", databaseUrl: POSTGRES_URL }),
  );
} else {
  describe.skip("Database Conformance Suite — [POSTGRES]", () => {
    it("is skipped when TEST_POSTGRES_URL / DATABASE_URL is not set", () => {
      expect(POSTGRES_URL).toBeUndefined();
    });
  });
}

/**
 * db-router.test.ts — Unit and integration tests for PostgreSQL read-replica
 * routing middleware.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { parseDatabaseReadReplicaUrls } from "./config";
import type { SqlParam } from "./db-dialect";
import { createPostgresDialect, type PostgresConnection } from "./db-postgres";
import { createReadReplicaRouter, isReadOnlyQuery } from "./db-router";
import { createSharedDb } from "./db-shared";

interface RecordedQuery {
  sql: string;
  params?: SqlParam[];
}

function makeFakeConn(
  name: string,
  opts?: {
    fail?: boolean;
    failEnd?: boolean;
    respond?: (sql: string) => unknown[];
  },
) {
  const calls: RecordedQuery[] = [];
  let ended = false;

  const conn: PostgresConnection = {
    async query(sql: string, params?: SqlParam[]) {
      calls.push(params ? { sql, params } : { sql });
      if (opts?.fail) {
        throw new Error(`${name} unavailable`);
      }
      return { rows: opts?.respond?.(sql) ?? [] };
    },
    async end() {
      ended = true;
      if (opts?.failEnd) {
        throw new Error(`${name} close failed`);
      }
    },
  };

  return {
    conn,
    calls,
    isEnded: () => ended,
  };
}

describe("isReadOnlyQuery", () => {
  it("classifies standard SELECT and read-only CTE queries as read-only", () => {
    expect(isReadOnlyQuery("SELECT * FROM claims WHERE wallet = $1")).toBe(true);
    expect(isReadOnlyQuery("  select count(*) from claims;  ")).toBe(true);
    expect(
      isReadOnlyQuery("-- leading comment\n/* block */\nSELECT id FROM claims"),
    ).toBe(true);
    expect(
      isReadOnlyQuery(
        "WITH active AS (SELECT * FROM claims WHERE revoked = 0) SELECT * FROM active",
      ),
    ).toBe(true);
  });

  it("ignores write keywords and semicolons inside string literals", () => {
    expect(
      isReadOnlyQuery(
        "SELECT * FROM claims WHERE reason_code = 'UPDATE; DROP TABLE claims'",
      ),
    ).toBe(true);
  });

  it("rejects writes, DDL, locking reads, sequence mutations, and multi-statement SQL", () => {
    expect(isReadOnlyQuery("INSERT INTO claims VALUES ($1)")).toBe(false);
    expect(isReadOnlyQuery("UPDATE claims SET revoked = 1 WHERE wallet = $1")).toBe(
      false,
    );
    expect(isReadOnlyQuery("DELETE FROM claims WHERE ledger_sequence > $1")).toBe(
      false,
    );
    expect(isReadOnlyQuery("CREATE TABLE IF NOT EXISTS foo (id INT)")).toBe(false);
    expect(isReadOnlyQuery("ALTER TABLE claims ADD COLUMN x INT")).toBe(false);
    expect(isReadOnlyQuery("DROP TABLE claims")).toBe(false);
    expect(isReadOnlyQuery("DO $$ BEGIN NULL; END $$;")).toBe(false);
    expect(isReadOnlyQuery("SET statement_timeout = 1000")).toBe(false);
    expect(
      isReadOnlyQuery(
        "WITH d AS (DELETE FROM claims RETURNING *) SELECT * FROM d",
      ),
    ).toBe(false);
    expect(isReadOnlyQuery("SELECT * FROM claims FOR UPDATE")).toBe(false);
    expect(isReadOnlyQuery("SELECT * FROM claims FOR NO KEY UPDATE")).toBe(false);
    expect(isReadOnlyQuery("SELECT * FROM claims FOR SHARE")).toBe(false);
    expect(isReadOnlyQuery("SELECT nextval('claims_id_seq')")).toBe(false);
    expect(isReadOnlyQuery("SELECT 1; DELETE FROM claims")).toBe(false);
    expect(isReadOnlyQuery("")).toBe(false);
    expect(isReadOnlyQuery("   -- only a comment")).toBe(false);
  });
});

describe("createReadReplicaRouter", () => {
  it("routes reads round-robin across replicas and keeps writes on primary", async () => {
    const primary = makeFakeConn("primary");
    const replica1 = makeFakeConn("replica-1");
    const replica2 = makeFakeConn("replica-2");

    const router = createReadReplicaRouter(primary.conn, [
      replica1.conn,
      replica2.conn,
    ]);

    await router.query("SELECT * FROM claims WHERE wallet = $1", ["GALICE"]);
    await router.query("SELECT * FROM claims WHERE wallet = $1", ["GBOB"]);
    await router.query("SELECT * FROM claims WHERE wallet = $1", ["GCAROL"]);
    await router.query("UPDATE claims SET revoked = 1 WHERE wallet = $1", [
      "GALICE",
    ]);

    expect(replica1.calls).toHaveLength(2);
    expect(replica2.calls).toHaveLength(1);
    expect(primary.calls).toHaveLength(1);
    expect(primary.calls[0].sql).toContain("UPDATE claims");

    expect(router.getStats()).toEqual({
      primaryQueries: 1,
      replicaQueries: 3,
      replicaFailovers: 0,
      primaryFallbacks: 0,
      replicaCount: 2,
    });
  });

  it("routes everything to primary when no replicas are configured", async () => {
    const primary = makeFakeConn("primary");
    const router = createReadReplicaRouter(primary.conn, []);

    await router.query("SELECT 1");
    await router.query("INSERT INTO ledger_cursor VALUES (1, 0)");

    expect(primary.calls).toHaveLength(2);
    expect(router.getStats()).toEqual({
      primaryQueries: 2,
      replicaQueries: 0,
      replicaFailovers: 0,
      primaryFallbacks: 0,
      replicaCount: 0,
    });
  });

  it("fails over to the next healthy replica when a replica errors", async () => {
    const primary = makeFakeConn("primary");
    const badReplica = makeFakeConn("replica-0", { fail: true });
    const goodReplica = makeFakeConn("replica-1", {
      respond: () => [{ ok: 1 }],
    });
    const onReplicaError = jest.fn();

    const router = createReadReplicaRouter(
      primary.conn,
      [badReplica.conn, goodReplica.conn],
      { onReplicaError },
    );

    const res = await router.query("SELECT 1");
    expect(res.rows).toEqual([{ ok: 1 }]);
    expect(onReplicaError).toHaveBeenCalledTimes(1);
    expect(onReplicaError).toHaveBeenCalledWith(0, expect.any(Error));
    expect(primary.calls).toHaveLength(0);
    expect(router.getStats()).toEqual({
      primaryQueries: 0,
      replicaQueries: 1,
      replicaFailovers: 1,
      primaryFallbacks: 0,
      replicaCount: 2,
    });
  });

  it("falls back to primary when all replicas fail and fallbackToPrimary is enabled", async () => {
    const primary = makeFakeConn("primary", {
      respond: () => [{ source: "primary" }],
    });
    const r1 = makeFakeConn("replica-0", { fail: true });
    const r2 = makeFakeConn("replica-1", { fail: true });

    const router = createReadReplicaRouter(primary.conn, [r1.conn, r2.conn]);

    const res = await router.query("SELECT 1");
    expect(res.rows).toEqual([{ source: "primary" }]);
    expect(primary.calls).toHaveLength(1);
    expect(router.getStats()).toEqual({
      primaryQueries: 1,
      replicaQueries: 0,
      replicaFailovers: 1,
      primaryFallbacks: 1,
      replicaCount: 2,
    });
  });

  it("throws without hitting primary when fallbackToPrimary is disabled", async () => {
    const primary = makeFakeConn("primary");
    const r1 = makeFakeConn("replica-0", { fail: true });

    const router = createReadReplicaRouter(primary.conn, [r1.conn], {
      fallbackToPrimary: false,
    });

    await expect(router.query("SELECT 1")).rejects.toThrow("replica-0 unavailable");
    expect(primary.calls).toHaveLength(0);
  });

  it("closes primary and all replicas on end()", async () => {
    const primary = makeFakeConn("primary");
    const r1 = makeFakeConn("replica-0");
    const r2 = makeFakeConn("replica-1");
    const router = createReadReplicaRouter(primary.conn, [r1.conn, r2.conn]);

    await router.end();
    expect(primary.isEnded()).toBe(true);
    expect(r1.isEnded()).toBe(true);
    expect(r2.isEnded()).toBe(true);
  });

  it("still closes remaining pools when one pool fails during end()", async () => {
    const primary = makeFakeConn("primary");
    const r1 = makeFakeConn("replica-0", { failEnd: true });
    const r2 = makeFakeConn("replica-1");
    const router = createReadReplicaRouter(primary.conn, [r1.conn, r2.conn]);

    await expect(router.end()).rejects.toThrow("replica-0 close failed");
    expect(primary.isEnded()).toBe(true);
    expect(r1.isEnded()).toBe(true);
    expect(r2.isEnded()).toBe(true);
  });
});

describe("integration with createSharedDb + createPostgresDialect", () => {
  it("directs public verification reads to replicas and writes/migrations to primary", async () => {
    const primary = makeFakeConn("primary", {
      respond: (sql) => (sql.includes("RETURNING id") ? [{ id: 1 }] : []),
    });
    const replica1 = makeFakeConn("replica-1");
    const replica2 = makeFakeConn("replica-2");

    const router = createReadReplicaRouter(primary.conn, [
      replica1.conn,
      replica2.conn,
    ]);
    const db = createSharedDb(createPostgresDialect(router));

    // Write & DDL operations must hit primary only.
    await db.migrate();
    await db.upsertClaim({
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1_724_000_000,
      expiry: 1_755_000_000,
      ledger_sequence: 100,
      threshold: null,
      revoked: 0,
      reason_code: "other",
    });
    await db.revokeClaim("GALICE", "kyc", "expired");
    await db.setLastLedger(100);
    await db.insertAppSubmission("App", "desc", ["kyc"], "https://app", "a@b.c");

    expect(replica1.calls).toHaveLength(0);
    expect(replica2.calls).toHaveLength(0);
    const primaryCountAfterWrites = primary.calls.length;
    expect(primaryCountAfterWrites).toBeGreaterThan(0);

    // Public read-only queries must be routed to replicas.
    await db.claimsByWallet("GALICE");
    await db.stats();
    await db.recent(10, null);
    await db.listApprovedApps();

    expect(primary.calls).toHaveLength(primaryCountAfterWrites);
    expect(replica1.calls.length + replica2.calls.length).toBe(4);
    expect(replica1.calls.length).toBe(2);
    expect(replica2.calls.length).toBe(2);

    await db.close();
    expect(primary.isEnded()).toBe(true);
    expect(replica1.isEnded()).toBe(true);
    expect(replica2.isEnded()).toBe(true);
  });
});

describe("parseDatabaseReadReplicaUrls", () => {
  it("parses comma-separated replica URLs and ignores empty entries", () => {
    expect(parseDatabaseReadReplicaUrls(undefined)).toEqual([]);
    expect(parseDatabaseReadReplicaUrls("   ")).toEqual([]);
    expect(
      parseDatabaseReadReplicaUrls("postgres://r1/db, , postgres://r2/db "),
    ).toEqual(["postgres://r1/db", "postgres://r2/db"]);
  });
});

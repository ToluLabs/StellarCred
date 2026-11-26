/**
 * db-pg-query.test.ts — Postgres pool tuning + prepared-statement behaviour.
 *
 * Neither of these needs a live server: `createPostgresDialect` talks to the
 * narrow `PostgresConnection` interface, so a recording fake shows exactly what
 * would reach `pg` (a `(text, values)` pair or a named `{ name, text, values }`
 * query), and `poolOptions` is a pure mapping.
 */

import { describe, it, expect } from "@jest/globals";
import { DEFAULT_DB_POOL, resolveDbPoolConfig } from "./config";
import {
  createPgStatementCache,
  createPostgresDialect,
  poolOptions,
  type PostgresConnection,
  type PostgresQueryConfig,
} from "./db-postgres";
import type { SqlParam } from "./db-dialect";

interface Captured {
  sql: string;
  params?: SqlParam[];
  name?: string;
  /** True when the dialect used the named-query form. */
  named: boolean;
}

function recordingConnection(rows: unknown[] = []): {
  conn: PostgresConnection;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const conn: PostgresConnection = {
    async query(
      textOrConfig: string | PostgresQueryConfig,
      values?: SqlParam[],
    ) {
      const named = typeof textOrConfig !== "string";
      const sql = named ? textOrConfig.text : textOrConfig;
      const params = named ? textOrConfig.values : values;
      calls.push({
        sql,
        params,
        name: named ? textOrConfig.name : undefined,
        named,
      });
      return { rows };
    },
    async end() {},
  };
  return { conn, calls };
}

describe("postgres pool options", () => {
  it("maps every tuning knob onto the node-postgres pool", () => {
    expect(poolOptions(DEFAULT_DB_POOL)).toEqual({
      max: 10,
      min: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      maxUses: 7_500,
    });
  });

  it("bounds the pool by default instead of leaving pg unbounded", () => {
    const options = poolOptions(DEFAULT_DB_POOL);
    expect(options.max).toBeGreaterThan(0);
    expect(options.max).toBeLessThanOrEqual(50);
    // A zero connection timeout would queue forever on an exhausted pool,
    // which is the failure mode #1069 reports.
    expect(options.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(options.idleTimeoutMillis).toBeGreaterThan(0);
  });

  it("honours overrides from the environment", () => {
    expect(
      resolveDbPoolConfig({
        DB_POOL_MAX: "24",
        DB_POOL_MIN: "4",
        DB_POOL_IDLE_TIMEOUT_MS: "1500",
        DB_POOL_CONNECTION_TIMEOUT_MS: "750",
        DB_POOL_MAX_USES: "0",
        DB_POOL_PREPARED_STATEMENTS: "false",
      }),
    ).toEqual({
      max: 24,
      min: 4,
      idleTimeoutMs: 1500,
      connectionTimeoutMs: 750,
      maxUses: 0,
      preparedStatements: false,
    });
  });

  it("rejects a minimum larger than the maximum", () => {
    expect(() =>
      resolveDbPoolConfig({ DB_POOL_MAX: "4", DB_POOL_MIN: "8" }),
    ).toThrow(/DB_POOL_MIN \(8\) must not exceed DB_POOL_MAX \(4\)/);
  });

  it.each([
    ["DB_POOL_MAX", "0"],
    ["DB_POOL_MAX", "2.5"],
    ["DB_POOL_MAX", "many"],
    ["DB_POOL_MIN", "-1"],
    ["DB_POOL_IDLE_TIMEOUT_MS", "-5"],
    ["DB_POOL_CONNECTION_TIMEOUT_MS", "NaN"],
  ])("rejects an invalid %s=%s", (name, value) => {
    expect(() => resolveDbPoolConfig({ [name]: value })).toThrow(
      new RegExp(`${name} must be an integer`),
    );
  });
});

describe("postgres prepared statements", () => {
  it("stays on the unnamed form unless preparation is enabled", async () => {
    const { conn, calls } = recordingConnection([{ id: 1 }]);
    const db = createPostgresDialect(conn);

    await db.get("SELECT * FROM claims WHERE wallet = ?", ["GALICE"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sql: "SELECT * FROM claims WHERE wallet = $1",
      params: ["GALICE"],
      named: false,
    });
  });

  it("sends parameterised queries as stable named statements", async () => {
    const { conn, calls } = recordingConnection();
    const db = createPostgresDialect(conn, { statements: "prepared" });

    await db.get("SELECT * FROM claims WHERE wallet = ?", ["GALICE"]);
    await db.get("SELECT * FROM claims WHERE wallet = ?", ["GBOB"]);
    await db.all("SELECT * FROM claims WHERE issuer = ?", ["GISSUER"]);

    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.named).toBe(true);

    // Same SQL → same prepared-statement name, so pg parses it once per
    // connection; different SQL → a different name.
    expect(calls[0].name).toBeDefined();
    expect(calls[0].name).toBe(calls[1].name);
    expect(calls[2].name).not.toBe(calls[0].name);

    // Names must be valid Postgres identifiers (63-byte limit).
    for (const call of calls) {
      expect(call.name).toMatch(/^stellarcred_[0-9a-f]{16}$/);
      expect(call.name!.length).toBeLessThanOrEqual(63);
    }
  });

  it("does not prepare statements with no bind values (multi-statement DDL)", async () => {
    const { conn, calls } = recordingConnection();
    const db = createPostgresDialect(conn, { statements: "prepared" });

    await db.exec("CREATE TABLE a (id INT); CREATE TABLE b (id INT);");
    await db.get("SELECT COUNT(*) AS total FROM claims");

    for (const call of calls) {
      expect(call.named).toBe(false);
      expect(call.name).toBeUndefined();
    }
  });

  it("prepares the id-returning insert form, not the bare insert", async () => {
    const { conn, calls } = recordingConnection([{ id: 7 }]);
    const db = createPostgresDialect(conn, { statements: "prepared" });

    const id = await db.insert("INSERT INTO app_submissions (a) VALUES (?)", ["x"]);

    expect(id).toBe(7);
    expect(calls[0].named).toBe(true);
    expect(calls[0].sql).toContain("RETURNING id");
  });

  it("names are deterministic across caches, so restarts reuse them", () => {
    const first = createPgStatementCache();
    const second = createPgStatementCache();
    const sql = "SELECT * FROM claims WHERE id = $1";
    expect(first.nameFor(sql)).toBe(second.nameFor(sql));
  });

  it("bounds the statement cache and keeps names stable after eviction", () => {
    const cache = createPgStatementCache(2);
    const a = cache.nameFor("SELECT 1");
    cache.nameFor("SELECT 2");
    cache.nameFor("SELECT 3"); // evicts "SELECT 1"
    expect(cache.size()).toBe(2);
    expect(cache.nameFor("SELECT 1")).toBe(a);
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.nameFor("SELECT 1")).toBe(a);
  });
});

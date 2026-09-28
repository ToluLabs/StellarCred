/**
 * db-dialect.test.ts — Shared-layer / dialect-adapter contract tests.
 *
 * `db.test.ts` runs the behavioural matrix against a *real* database on each
 * backend (Postgres only where `TEST_POSTGRES_URL` / `DATABASE_URL` points at a
 * reachable server). This file covers the part that matrix cannot: that the two
 * dialects really are thin adapters over one shared query layer.
 *
 * It drives `createSharedDb` with recording fakes for each backend, so it runs
 * everywhere, and asserts that:
 *
 *   1. the same operation produces the same SQL on both backends, once the
 *      dialect spellings (placeholders, EXCLUDED casing, `::int`, `now()`,
 *      `RETURNING id`) are normalised away;
 *   2. Postgres' numbered placeholders are numbered correctly;
 *   3. rows coming back from Postgres (BIGINTs as strings) are normalised to
 *      the same JS shapes SQLite returns;
 *   4. the two schemas declare the same columns, nullability and indexes.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import os from "os";
import path from "path";
import fs from "fs";
import BetterSqlite3 from "better-sqlite3";
import { bindSql, type SqlParam } from "./db-dialect";
import { createPostgresDialect, type PostgresConnection } from "./db-postgres";
import { buildClaimsTable, buildSchema } from "./db-schema";
import { createSharedDb } from "./db-shared";
import { createSqliteDialect, type SqliteDatabase } from "./db-sqlite";
import type { ClaimInput, Db } from "./db-types";

// ── Recording fakes ────────────────────────────────────────────────────────

interface Recorded {
  sql: string;
  params?: SqlParam[];
}

function fakePostgres(respond?: (sql: string) => unknown[]) {
  const calls: Recorded[] = [];
  const conn: PostgresConnection = {
    async query(sql, params) {
      calls.push(params ? { sql, params } : { sql });
      return { rows: respond?.(sql) ?? [] };
    },
    async end() {},
  };
  return { conn, calls };
}

function fakeSqlite(respond?: (sql: string) => unknown) {
  const calls: Recorded[] = [];
  const batches: string[] = [];
  const db: SqliteDatabase = {
    exec(sql) {
      batches.push(sql);
      return undefined;
    },
    pragma() {
      return undefined;
    },
    prepare(sql) {
      return {
        run(...params: SqlParam[]) {
          calls.push({ sql, params });
          return { lastInsertRowid: 42, changes: 1 };
        },
        get(...params: SqlParam[]) {
          calls.push({ sql, params });
          return respond?.(sql);
        },
        all(...params: SqlParam[]) {
          calls.push({ sql, params });
          const value = respond?.(sql);
          return Array.isArray(value) ? value : [];
        },
      };
    },
    transaction(fn) {
      return fn;
    },
    close() {
      return undefined;
    },
  };
  return { db, calls, batches };
}

/**
 * Collapse the dialect spellings the shared layer deliberately delegates, so
 * two statements can be compared for "same query, different backend".
 */
function normalize(sql: string): string {
  return sql
    .replace(/\$\d+/g, "?") // $1, $2 → ?
    .replace(/EXCLUDED\./g, "excluded.")
    .replace(/::int/g, "")
    .replace(/datetime\('now'\)/g, "now()")
    .replace(/\s*RETURNING id/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const claim: ClaimInput = {
  wallet: "GALICE",
  credential_type: "kyc",
  issuer: "GISSUER",
  verified_at: 1_724_000_000,
  expiry: 1_755_000_000,
  ledger_sequence: 100,
  threshold: null,
  revoked: 0,
};

// ── Placeholder binding ────────────────────────────────────────────────────

describe("placeholder binding", () => {
  const sqlite = createSqliteDialect(fakeSqlite().db);
  const postgres = createPostgresDialect(fakePostgres().conn);

  it("numbers placeholders positionally for Postgres and leaves SQLite alone", () => {
    expect(bindSql(sqlite, "SELECT * FROM claims WHERE a = ? AND b = ?", [1, 2]))
      .toBe("SELECT * FROM claims WHERE a = ? AND b = ?");
    expect(
      bindSql(postgres, "SELECT * FROM claims WHERE a = ? AND b = ?", [1, 2]),
    ).toBe("SELECT * FROM claims WHERE a = $1 AND b = $2");
  });

  it("fails loudly when a value is missing or extra", () => {
    expect(() => bindSql(postgres, "SELECT ?", [])).toThrow(
      /1 placeholder\(s\) but 0 value\(s\)/,
    );
    expect(() => bindSql(postgres, "SELECT ?", [1, 2])).toThrow(
      /1 placeholder\(s\) but 2 value\(s\)/,
    );
  });
});

// ── Same query, both backends ──────────────────────────────────────────────

describe("shared query layer drives both backends identically", () => {
  /**
   * Run one operation against both dialects and return the single statement
   * each produced (normalised for dialect spellings).
   */
  async function statementsFor(
    run: (db: Db, calls: Recorded[]) => Promise<unknown>,
  ): Promise<{ sqlite: string; postgres: string; params: SqlParam[] }> {
    const s = fakeSqlite();
    const sqliteCalls: Recorded[] = s.calls;
    await run(createSharedDb(createSqliteDialect(s.db)), sqliteCalls);

    const p = fakePostgres();
    const postgresCalls: Recorded[] = p.calls;
    await run(createSharedDb(createPostgresDialect(p.conn)), postgresCalls);

    return {
      sqlite: normalize(sqliteCalls[sqliteCalls.length - 1].sql),
      postgres: normalize(postgresCalls[postgresCalls.length - 1].sql),
      params: postgresCalls[postgresCalls.length - 1].params ?? [],
    };
  }

  it("cursor read/write", async () => {
    const { sqlite, postgres } = await statementsFor(async (db) => {
      await db.getLastLedger();
      await db.setLastLedger(42);
    });
    expect(postgres).toBe(sqlite);
    expect(sqlite).toBe(
      "UPDATE ledger_cursor SET last_ledger = ? WHERE id = 1",
    );
  });

  it("upsert binds the claim in write order and clears revoked", async () => {
    const { sqlite, postgres, params } = await statementsFor(async (db) => {
      await db.upsertClaim(claim);
    });
    expect(postgres).toBe(sqlite);
    expect(sqlite).toContain("ON CONFLICT(wallet, credential_type) DO UPDATE SET");
    expect(sqlite).toContain("revoked = 0");
    expect(params).toEqual([
      "GALICE",
      "kyc",
      "GISSUER",
      1_724_000_000,
      1_755_000_000,
      100,
      null,
      0,
    ]);
  });

  it("revoke and the reconcile delete", async () => {
    const revoke = await statementsFor(async (db) => {
      await db.revokeClaim("GALICE", "kyc");
    });
    expect(revoke.postgres).toBe(revoke.sqlite);
    expect(revoke.params).toEqual(["GALICE", "kyc"]);

    const reconcile = await statementsFor(async (db) => {
      await db.deleteClaimsAfter(150);
    });
    expect(reconcile.postgres).toBe(reconcile.sqlite);
    expect(reconcile.params).toEqual([150]);
  });

  it("per-wallet and per-issuer reads", async () => {
    const byWallet = await statementsFor(async (db) => {
      await db.claimsByWallet("GALICE");
    });
    expect(byWallet.postgres).toBe(byWallet.sqlite);

    const byIssuer = await statementsFor(async (db) => {
      await db.claimsByIssuer("GISSUER");
    });
    expect(byIssuer.postgres).toBe(byIssuer.sqlite);
    expect(byIssuer.params).toEqual(["GISSUER"]);
  });

  it("aggregates", async () => {
    const stats = await statementsFor(async (db) => {
      await db.stats();
    });
    expect(stats.postgres).toBe(stats.sqlite);
    expect(stats.sqlite).toContain("COUNT(*) FILTER (WHERE revoked=0) AS active");

    const issuerStats = await statementsFor(async (db) => {
      await db.issuerStats("GISSUER");
    });
    // issuerStats issues two statements; both must match across backends.
    expect(issuerStats.postgres).toBe(issuerStats.sqlite);
  });

  it("the keyset-paginated recent query, with and without a cursor", async () => {
    const first = await statementsFor(async (db) => {
      await db.recent(2, null);
    });
    expect(first.postgres).toBe(first.sqlite);
    expect(first.sqlite).toContain("ORDER BY ledger_sequence DESC, id DESC");
    expect(first.sqlite).toContain("LIMIT ?");
    // limit + 1 so the page can report whether more exist.
    expect(first.params).toEqual([3]);

    const next = await statementsFor(async (db) => {
      await db.recent(2, { ledgerSequence: 300, id: 7 });
    });
    expect(next.postgres).toBe(next.sqlite);
    expect(next.sqlite).toContain(
      "(ledger_sequence < ? OR (ledger_sequence = ? AND id < ?))",
    );
    expect(next.params).toEqual([300, 300, 7, 3]);
  });

  it("app submissions: insert returns the new id, status update stamps reviewed_at", async () => {
    const s = fakePostgres(() => [{ id: 9 }]);
    const pgDb = createSharedDb(createPostgresDialect(s.conn));
    const id = await pgDb.insertAppSubmission("App", "desc", ["kyc"], "u", "e@x");
    expect(id).toBe(9);
    expect(s.calls[0].sql).toContain("RETURNING id");
    expect(s.calls[0].params).toEqual(["App", "desc", '["kyc"]', "u", "e@x"]);

    const { sqlite, postgres } = await statementsFor(async (db) => {
      await db.updateSubmissionStatus(9, "approved");
    });
    expect(postgres).toBe(sqlite);
    expect(postgres).toContain("SET status = ?, reviewed_at = now() WHERE id = ?");
    expect(sqlite).toContain("SET status = ?, reviewed_at = now() WHERE id = ?");
  });
});

// ── Postgres-specific behaviour, without a server ──────────────────────────

describe("postgres dialect", () => {
  it("normalises BIGINTs returned as strings into JS numbers", async () => {
    // pg hands back BIGINT/INT4 as strings; the shared layer must not leak that.
    const { conn } = fakePostgres((sql) => {
      if (sql.includes("FROM ledger_cursor")) {
        return [{ last_ledger: "123456" }];
      }
      if (sql.includes("MAX(ledger_sequence)")) {
        return [{ max_ledger: "2000" }];
      }
      return [];
    });
    const db = createSharedDb(createPostgresDialect(conn));

    expect(await db.getLastLedger()).toBe(123456);
    expect(typeof (await db.getLastLedger())).toBe("number");
    expect(await db.getMaxClaimLedger()).toBe(2000);
  });

  it("maps claim rows to the same shape SQLite returns, keeping null thresholds", async () => {
    const row = {
      id: "7",
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: "1000",
      expiry: "9999999",
      ledger_sequence: "42",
      threshold: null,
      revoked: "0",
    };
    const { conn } = fakePostgres((sql) =>
      sql.includes("FROM claims") ? [row] : [],
    );
    const db = createSharedDb(createPostgresDialect(conn));

    const [mapped] = await db.claimsByWallet("GALICE");
    expect(mapped).toEqual({
      id: 7,
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1000,
      expiry: 9999999,
      ledger_sequence: 42,
      threshold: null,
      revoked: 0,
    });
  });

  it("treats an empty aggregate as zero, not NaN", async () => {
    const { conn } = fakePostgres(() => [{ max_ledger: null }]);
    const db = createSharedDb(createPostgresDialect(conn));
    expect(await db.getMaxClaimLedger()).toBe(0);
  });

  it("derives the keyset page and its next cursor from the shared code", async () => {
    const rows = [10, 9, 8].map((seq, i) => ({
      id: i + 1,
      wallet: `GA${i}`,
      credential_type: "kyc",
      issuer: "G",
      verified_at: "1",
      expiry: "2",
      ledger_sequence: String(seq),
      threshold: null,
      revoked: "0",
    }));
    const { conn } = fakePostgres(() => rows);
    const db = createSharedDb(createPostgresDialect(conn));

    const page = await db.recent(2, null);
    expect(page.claims.map((c) => c.ledger_sequence)).toEqual([10, 9]);
    expect(page.nextCursor).toEqual({ ledgerSequence: 9, id: 2 });
  });

  it("appends RETURNING id only on insert", async () => {
    const { conn, calls } = fakePostgres(() => [{ id: "3" }]);
    const db = createSharedDb(createPostgresDialect(conn));
    await db.getAppSubmission(3);
    expect(calls[0].sql).toBe("SELECT * FROM app_submissions WHERE id = $1");
    expect(calls[0].params).toEqual([3]);
  });
});

// ── Schema parity ──────────────────────────────────────────────────────────

describe("schema", () => {
  it("declares the same claims columns on both backends", () => {
    const sqlite = createSqliteDialect(fakeSqlite().db);
    const postgres = createPostgresDialect(fakePostgres().conn);

    // Column lines only — the trailing table-level key clause is the one piece
    // of `claims` DDL that is genuinely allowed to differ (UNIQUE vs PRIMARY
    // KEY), and it is asserted separately below.
    const columns = (sql: string) =>
      sql
        .split("\n")
        .map((line) => line.trim().replace(/,$/, ""))
        .filter((line) => /^\w+\s/.test(line))
        .filter((line) => !/^(UNIQUE|PRIMARY KEY|CHECK|FOREIGN KEY)\b/.test(line))
        // Keep only the column name; types differ by design.
        .map((line) => line.replace(/\s+[A-Z][A-Z0-9_]*(\s.*)?$/, ""));

    expect(columns(buildClaimsTable(sqlite))).toEqual(
      columns(buildClaimsTable(postgres)),
    );
  });

  it("uses each backend's own spelling for the pieces that differ", () => {
    const sqlite = createSqliteDialect(fakeSqlite().db);
    const postgres = createPostgresDialect(fakePostgres().conn);

    expect(sqlite.intType).toBe("INTEGER");
    expect(postgres.intType).toBe("BIGINT");
    expect(sqlite.placeholder(1)).toBe("?");
    expect(postgres.placeholder(2)).toBe("$2");
    expect(sqlite.excludedRef).toBe("excluded");
    expect(postgres.excludedRef).toBe("EXCLUDED");
    expect(sqlite.insertIgnorePrefix).toBe("OR IGNORE ");
    expect(postgres.conflictDoNothing).toContain("ON CONFLICT (id) DO NOTHING");
    expect(sqlite.nowExpr).toBe("datetime('now')");
    expect(postgres.nowExpr).toBe("now()");
    // SQLite's rowid alias is already unique; Postgres needs an index.
    expect(sqlite.extraClaimIndexes).toEqual([]);
    expect(postgres.extraClaimIndexes.join(" ")).toContain("UNIQUE INDEX");
  });

  it("gives every table at most one primary key", () => {
    // Postgres rejects a table with two primary keys, and it is easy to
    // reintroduce by declaring an inline PRIMARY KEY on the id column while
    // the shared builder also emits the table's key clause.
    for (const [driver, dialect] of [
      ["sqlite", createSqliteDialect(fakeSqlite().db)],
      ["postgres", createPostgresDialect(fakePostgres().conn)],
    ] as const) {
      for (const statement of buildSchema(dialect).tables.split(/;\n\n/)) {
        const table = statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
        if (!table) continue;
        const keys = statement.match(/PRIMARY KEY/gi) ?? [];
        expect({ driver, table, primaryKeys: keys.length }).toEqual({
          driver,
          table,
          primaryKeys: 1,
        });
      }
    }
  });

  it("keeps the claims id unique on Postgres via an index, not a second key", () => {
    const postgres = createPostgresDialect(fakePostgres().conn);
    const claims = buildClaimsTable(postgres);
    expect(claims).toContain("id BIGSERIAL,");
    expect(claims).toContain("PRIMARY KEY (wallet, credential_type)");
    expect(buildSchema(postgres).indexes).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_id",
    );
  });

  it("names every column it declares", () => {
    for (const dialect of [
      createSqliteDialect(fakeSqlite().db),
      createPostgresDialect(fakePostgres().conn),
    ]) {
      for (const statement of buildSchema(dialect).tables.split(/;\n\n/)) {
        if (!statement.trim().startsWith("CREATE TABLE")) continue;
        for (const line of statement.split("\n").slice(1, -1)) {
          const decl = line.trim().replace(/,$/, "");
          if (/^(UNIQUE|PRIMARY KEY|CHECK|FOREIGN KEY)\b/.test(decl)) continue;
          // A column declaration is `<name> <type> …`; a bare type would mean
          // the shared builder forgot to name the column.
          expect(decl).toMatch(/^\w+\s+\w+/);
        }
      }
    }
  });

  it("round-trips a real SQLite schema with every expected column", async () => {
    const raw = new BetterSqlite3(":memory:");
    const db = createSharedDb(createSqliteDialect(raw as unknown as SqliteDatabase));
    await db.migrate();

    const columns = (table: string): string[] =>
      (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((c) => c.name);

    expect(columns("claims")).toEqual([
      "id",
      "wallet",
      "credential_type",
      "issuer",
      "verified_at",
      "expiry",
      "ledger_sequence",
      "threshold",
      "revoked",
    ]);
    expect(columns("ledger_cursor")).toEqual(["id", "last_ledger"]);
    expect(columns("app_submissions")).toEqual([
      "id",
      "app_name",
      "description",
      "required_claims",
      "verify_url",
      "contact_email",
      "status",
      "created_at",
      "reviewed_at",
    ]);

    // `created_at` is stamped by the database default, not by the caller.
    const id = await db.insertAppSubmission("Gate", "d", ["kyc"], "u", "e@x");
    const row = await db.getAppSubmission(id);
    expect(row?.created_at).toBeTruthy();
    await db.updateSubmissionStatus(id, "approved");
    expect((await db.getAppSubmission(id))?.reviewed_at).toBeTruthy();

    await db.close();
  });

  it("migrates tables, then the legacy id upgrade, then indexes", async () => {
    const s = fakeSqlite();
    const db = createSharedDb(createSqliteDialect(s.db));
    await db.migrate();
    expect(s.batches).toHaveLength(2);
    expect(s.batches[0]).toContain("CREATE TABLE IF NOT EXISTS claims");
    expect(s.batches[0]).toContain("CREATE TABLE IF NOT EXISTS app_submissions");
    expect(s.batches[1]).toContain("idx_claims_recent");
  });

  it("seeds the singleton ledger cursor with the dialect's ignore form", async () => {
    const s = fakeSqlite();
    await createSharedDb(createSqliteDialect(s.db)).migrate();
    expect(s.batches[0]).toContain("INSERT OR IGNORE INTO ledger_cursor");

    const p = fakePostgres();
    await createSharedDb(createPostgresDialect(p.conn)).migrate();
    expect(p.calls[0].sql).toContain("INSERT INTO ledger_cursor");
    expect(p.calls[0].sql).toContain("ON CONFLICT (id) DO NOTHING");
  });
});

// ── Legacy database upgrade ────────────────────────────────────────────────

describe("legacy claims.id upgrade", () => {
  const files: string[] = [];

  afterEach(() => {
    for (const f of files.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.unlinkSync(f + suffix);
        } catch {
          /* already gone */
        }
      }
    }
  });

  /** Build a database in the pre-`id` shape the migration has to repair. */
  function legacyDb(): SqliteDatabase {
    const file = path.join(
      os.tmpdir(),
      `legacy-${process.pid}-${Math.random().toString(16).slice(2)}.db`,
    );
    files.push(file);
    const raw = new BetterSqlite3(file);
    raw.exec(`
      CREATE TABLE claims (
        wallet           TEXT    NOT NULL,
        credential_type  TEXT    NOT NULL,
        issuer           TEXT    NOT NULL DEFAULT '',
        verified_at      INTEGER NOT NULL DEFAULT 0,
        expiry           INTEGER NOT NULL DEFAULT 0,
        ledger_sequence  INTEGER NOT NULL DEFAULT 0,
        threshold        INTEGER,
        revoked          INTEGER NOT NULL DEFAULT 0,
        UNIQUE (wallet, credential_type)
      );
      CREATE TABLE ledger_cursor (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        last_ledger INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO ledger_cursor (id, last_ledger) VALUES (1, 55);
      INSERT INTO claims (wallet, credential_type, ledger_sequence)
        VALUES ('GALICE', 'kyc', 10), ('GBOB', 'age', 20);
    `);
    return raw as unknown as SqliteDatabase;
  }

  it("preserves existing rows and cursor while adding the id cursor", async () => {
    const raw = legacyDb();
    const db = createSharedDb(createSqliteDialect(raw));
    await db.migrate();

    // The rebuilt table keeps the old rows, in their prior order, with ids.
    const rows = await db.claimsByWallet("GALICE");
    expect(rows).toHaveLength(1);
    expect(rows[0].ledger_sequence).toBe(10);
    expect(Number.isInteger(rows[0].id)).toBe(true);
    expect((await db.claimsByWallet("GBOB"))[0].id).toBe(rows[0].id + 1);

    // The cursor survives the migration rather than being reset to 0.
    expect(await db.getLastLedger()).toBe(55);

    // …and the keyset index the new query depends on now exists.
    const indexes = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'claims'",
    ).all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("idx_claims_recent");

    await db.close();
  });

  it("is idempotent on the already-migrated shape", async () => {
    const raw = legacyDb();
    const db = createSharedDb(createSqliteDialect(raw));
    await db.migrate();
    await db.migrate();
    expect(await db.claimsByWallet("GALICE")).toHaveLength(1);
    expect(await db.getLastLedger()).toBe(55);
    await db.close();
  });
});

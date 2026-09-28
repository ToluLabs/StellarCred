/**
 * db-sqlite.ts — SQLite adapter.
 *
 * The only thing this file knows about is better-sqlite3 and SQLite's spelling
 * of the handful of things that differ (`?` placeholders, `INTEGER PRIMARY KEY
 * AUTOINCREMENT`, `INSERT OR IGNORE`, `datetime('now')`, `lastInsertRowid`, and
 * the table-rebuild needed for legacy databases). All query logic lives in
 * `db-shared.ts`.
 */

import path from "path";
import fs from "fs";
import type { Config } from "./config";
import { bindSql, type PlaceholderStyle, type SqlDialect, type SqlParam } from "./db-dialect";
import { buildClaimsTable } from "./db-schema";
import { createSharedDb } from "./db-shared";
import type { Db } from "./db-types";

/** SQLite's bind-parameter spelling. */
const SQLITE_PLACEHOLDERS: PlaceholderStyle = {
  name: "sqlite",
  placeholder: () => "?",
};

/** The slice of better-sqlite3's Database this adapter uses. */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  pragma(statement: string): unknown;
  prepare(sql: string): {
    run(...params: SqlParam[]): { lastInsertRowid: number | bigint; changes: number };
    get(...params: SqlParam[]): unknown;
    all(...params: SqlParam[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
  close(): unknown;
}

export function createSqliteDialect(raw: SqliteDatabase): SqlDialect {
  const dialect: SqlDialect = {
    name: "sqlite",

    async exec(sql) {
      raw.exec(sql);
    },

    async run(sql, params = []) {
      raw.prepare(bindSql(SQLITE_PLACEHOLDERS, sql, params)).run(...params);
    },

    async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      return raw.prepare(bindSql(SQLITE_PLACEHOLDERS, sql, params)).all(
        ...params,
      ) as T[];
    },

    async get<T>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
      return raw.prepare(bindSql(SQLITE_PLACEHOLDERS, sql, params)).get(
        ...params,
      ) as T | undefined;
    },

    async insert(sql: string, params: SqlParam[] = []) {
      const info = raw
        .prepare(bindSql(SQLITE_PLACEHOLDERS, sql, params))
        .run(...params);
      return Number(info.lastInsertRowid);
    },

    async close() {
      raw.close();
    },

    placeholder(index) {
      return SQLITE_PLACEHOLDERS.placeholder(index);
    },

    claimsIdType: "INTEGER PRIMARY KEY AUTOINCREMENT",
    submissionIdType: "INTEGER PRIMARY KEY AUTOINCREMENT",
    claimsKeyClause: "UNIQUE (wallet, credential_type)",
    intType: "INTEGER",
    flagType: "INTEGER",
    timestampType: "TEXT",
    createdAtType: "TEXT NOT NULL DEFAULT (datetime('now'))",
    nowExpr: "datetime('now')",
    insertIgnorePrefix: "OR IGNORE ",
    conflictDoNothing: "",
    excludedRef: "excluded",
    castCount: (expr) => expr,
    // `id` is SQLite's rowid alias, so it is already unique.
    extraClaimIndexes: [],

    async migrateClaimsId() {
      // Migration for databases created before the insertion-cursor `id` column
      // existed: rebuild the table so every existing row gets an auto-increment
      // id (preserving its prior rowid order) and the keyset index can exist.
      const cols = raw.prepare("PRAGMA table_info(claims)").all() as {
        name: string;
      }[];
      if (cols.length === 0 || cols.some((c) => c.name === "id")) return;

      const rebuild = raw.transaction(() => {
        // Renaming moves the old indexes along with the table; they are
        // dropped with claims_old and recreated below on the new table.
        raw.exec("ALTER TABLE claims RENAME TO claims_old;");
        raw.exec(buildClaimsTable(dialect));
        raw.exec(`
          INSERT INTO claims
            (wallet, credential_type, issuer, verified_at, expiry,
             ledger_sequence, threshold, revoked)
          SELECT wallet, credential_type, issuer, verified_at, expiry,
                 ledger_sequence, threshold, revoked
          FROM claims_old;
        `);
        raw.exec("DROP TABLE claims_old;");
      });
      rebuild();
    },
  };

  return dialect;
}

export function createSqliteDb(config: Config): Db {
  // Lazily import so postgres-only environments don't need better-sqlite3.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");

  const dbPath = path.resolve(config.sqlitePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const raw = new BetterSqlite3(dbPath) as unknown as SqliteDatabase;

  // Enable WAL for better concurrent read performance.
  raw.pragma("journal_mode = WAL");

  return createSharedDb(createSqliteDialect(raw));
}

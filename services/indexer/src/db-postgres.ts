/**
 * db-postgres.ts — Postgres adapter.
 *
 * The only thing this file knows about is the `pg` pool and Postgres' spelling
 * of the handful of things that differ (`$1`-style placeholders, `SERIAL
 * PRIMARY KEY`, `BIGINT`, `ON CONFLICT ... DO NOTHING`, `EXCLUDED`, `now()`,
 * `RETURNING id`, and the `DO $$` block that upgrades a pre-`id` claims table).
 * All query logic lives in `db-shared.ts`.
 */

import type { Config } from "./config";
import { bindSql, type PlaceholderStyle, type SqlDialect, type SqlParam } from "./db-dialect";
import { createSharedDb } from "./db-shared";
import type { Db } from "./db-types";

/** Postgres' numbered bind-parameter spelling. */
const POSTGRES_PLACEHOLDERS: PlaceholderStyle = {
  name: "postgres",
  placeholder: (index) => `$${index}`,
};

/** The slice of a `pg` Pool / Client this adapter uses. */
export interface PostgresConnection {
  query(
    text: string,
    values?: SqlParam[],
  ): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export function createPostgresDialect(conn: PostgresConnection): SqlDialect {
  return {
    name: "postgres",

    async exec(sql) {
      // No values ⇒ simple query protocol, which allows a multi-statement batch.
      await conn.query(sql);
    },

    async run(sql, params = []) {
      await conn.query(bindSql(POSTGRES_PLACEHOLDERS, sql, params), params);
    },

    async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      const res = await conn.query(
        bindSql(POSTGRES_PLACEHOLDERS, sql, params),
        params,
      );
      return res.rows as T[];
    },

    async get<T>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
      const res = await conn.query(
        bindSql(POSTGRES_PLACEHOLDERS, sql, params),
        params,
      );
      return res.rows[0] as T | undefined;
    },

    async insert(sql: string, params: SqlParam[] = []) {
      const res = await conn.query(
        `${bindSql(POSTGRES_PLACEHOLDERS, sql, params)} RETURNING id`,
        params,
      );
      return Number((res.rows[0] as { id: SqlParam }).id);
    },

    async close() {
      await conn.end();
    },

    placeholder(index) {
      return POSTGRES_PLACEHOLDERS.placeholder(index);
    },

    // No inline PRIMARY KEY on the claims cursor: that table takes its primary
    // key from the shared `claimsKeyClause` (PRIMARY KEY (wallet, credential_type))
    // and Postgres rejects a second one. `id` stays unique via idx_claims_id.
    claimsIdType: "BIGSERIAL",
    // app_submissions has no shared key clause, so its id is a plain primary key.
    submissionIdType: "SERIAL PRIMARY KEY",
    claimsKeyClause: "PRIMARY KEY (wallet, credential_type)",
    intType: "BIGINT",
    flagType: "INTEGER",
    timestampType: "TIMESTAMPTZ",
    createdAtType: "TIMESTAMPTZ NOT NULL DEFAULT now()",
    nowExpr: "now()",
    insertIgnorePrefix: "",
    conflictDoNothing: "\n  ON CONFLICT (id) DO NOTHING",
    excludedRef: "EXCLUDED",
    // COUNT(*) is BIGINT in Postgres; narrow it so both backends report numbers.
    castCount: (expr) => `${expr}::int`,
    // Unlike SQLite's rowid alias, `id` needs its own uniqueness guarantee.
    extraClaimIndexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_id ON claims (id)`,
    ],

    async migrateClaimsId() {
      // Migration for databases created before the insertion-cursor `id` column
      // existed: add it, backfill from the sequence, and enforce uniqueness.
      await conn.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'claims' AND column_name = 'id'
          ) THEN
            ALTER TABLE claims ADD COLUMN id BIGINT;
            CREATE SEQUENCE IF NOT EXISTS claims_id_seq OWNED BY claims.id;
            ALTER TABLE claims ALTER COLUMN id SET DEFAULT nextval('claims_id_seq');
            UPDATE claims SET id = nextval('claims_id_seq');
            ALTER TABLE claims ALTER COLUMN id SET NOT NULL;
          END IF;
        END $$;
      `);
    },
  };
}

export function createPostgresDb(config: Config): Db {
  if (!config.databaseUrl) {
    throw new Error(
      "DATABASE_URL must be set when DB_DRIVER=postgres"
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg") as typeof import("pg");
  const { Pool } = pg;

  // pg returns INT8/BIGINT and INT4/INTEGER columns as strings by default,
  // which would make ClaimRow's numeric fields (verified_at, expiry,
  // ledger_sequence, threshold, revoked) come back as strings on Postgres but
  // numbers on SQLite. Force them to JS numbers so both backends expose
  // identical row shapes.
  pg.types.setTypeParser(20, Number); // INT8 / BIGINT
  pg.types.setTypeParser(23, Number); // INT4 / INTEGER

  const pool = new Pool({ connectionString: config.databaseUrl });

  return createSharedDb(createPostgresDialect(pool));
}

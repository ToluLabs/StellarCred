/**
 * db-postgres.ts — Postgres adapter.
 *
 * The only thing this file knows about is the `pg` pool and Postgres' spelling
 * of the handful of things that differ (`$1`-style placeholders, `SERIAL
 * PRIMARY KEY`, `BIGINT`, `ON CONFLICT ... DO NOTHING`, `EXCLUDED`, `now()`,
 * `RETURNING id`, and the `DO $$` block that upgrades a pre-`id` claims table).
 * All query logic lives in `db-shared.ts`.
 *
 * Two things beyond SQL spelling live here, both specific to `pg`:
 *
 *   - pool limits (size, idle reaping, connect timeout, connection rotation),
 *     read from `config.dbPool` (#1069), and
 *   - named prepared statements for parameterised queries, so the server parses
 *     and plans each hot statement once per connection instead of once per
 *     execution. `exec()` deliberately stays on the simple query protocol,
 *     which is what allows a multi-statement DDL batch.
 */

import { createHash } from "crypto";
import type { Config, DbPoolConfig } from "./config";
import { DEFAULT_DB_POOL } from "./config";
import { bindSql, type PlaceholderStyle, type SqlDialect, type SqlParam } from "./db-dialect";
import { createReadReplicaRouter } from "./db-router";
import { createSharedDb } from "./db-shared";
import type { Db } from "./db-types";

/** Postgres' numbered bind-parameter spelling. */
const POSTGRES_PLACEHOLDERS: PlaceholderStyle = {
  name: "postgres",
  placeholder: (index) => `$${index}`,
};

/** A query as node-postgres accepts it, with an optional prepared-statement name. */
export interface PostgresQueryConfig {
  name?: string;
  text: string;
  values?: SqlParam[];
}

/** The slice of a `pg` Pool / Client this adapter uses. */
export interface PostgresConnection {
  query(text: string): Promise<{ rows: unknown[] }>;
  query(text: string, values: SqlParam[]): Promise<{ rows: unknown[] }>;
  query(config: PostgresQueryConfig): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

/**
 * How parameterised queries reach the server.
 *
 *   - `prepared` — named prepared statements (production default)
 *   - `simple`   — unnamed, server-side-parse-every-time (for poolers such as
 *                  PgBouncer in transaction mode, which cannot reuse
 *                  session-level prepared statements)
 */
export type PgStatementMode = "prepared" | "simple";

/**
 * Map statement text to a stable prepared-statement name.
 *
 * `pg` keys prepared statements by name per connection, so the name must be a
 * pure function of the SQL: two different statements must never collide, and
 * the same statement must get the same name on every connection and in every
 * process. A truncated SHA-1 of the bound SQL gives both, and keeps the name
 * inside Postgres' 63-byte identifier limit. The map is bounded so a workload
 * that interpolates identifiers into SQL cannot grow it without limit.
 */
export interface PgStatementCache {
  /** The prepared-statement name for `sql`, creating one if needed. */
  nameFor(sql: string): string;
  /** Number of statements currently cached. */
  size(): number;
  /** Drop every cached name (names are deterministic, so this is safe). */
  clear(): void;
}

export function createPgStatementCache(maxEntries = 250): PgStatementCache {
  const names = new Map<string, string>();
  return {
    nameFor(sql) {
      const cached = names.get(sql);
      if (cached) return cached;
      const name = `stellarcred_${createHash("sha1").update(sql).digest("hex").slice(0, 16)}`;
      if (names.size >= maxEntries) {
        // Evict the oldest entry; recomputing its name later yields the same
        // value, so eviction only costs a hash, never correctness.
        const oldest = names.keys().next();
        if (!oldest.done) names.delete(oldest.value);
      }
      names.set(sql, name);
      return name;
    },
    size: () => names.size,
    clear: () => names.clear(),
  };
}

export interface PostgresDialectOptions {
  /** Defaults to `simple` so callers opt in to prepared statements explicitly. */
  statements?: PgStatementMode;
  /** Shared statement-name cache; one per pool. */
  statementCache?: PgStatementCache;
}

export function createPostgresDialect(
  conn: PostgresConnection,
  options: PostgresDialectOptions = {},
): SqlDialect {
  const mode: PgStatementMode = options.statements ?? "simple";
  const cache = options.statementCache ?? createPgStatementCache();

  /** Run one parameterised statement through the configured protocol. */
  const execute = (text: string, params: SqlParam[] = []) => {
    if (mode === "prepared" && params.length > 0) {
      return conn.query({ name: cache.nameFor(text), text, values: params });
    }
    return params.length > 0 ? conn.query(text, params) : conn.query(text);
  };

  return {
    name: "postgres",

    async exec(sql) {
      // No values ⇒ simple query protocol, which allows a multi-statement batch.
      await conn.query(sql);
    },

    async run(sql, params = []) {
      await execute(bindSql(POSTGRES_PLACEHOLDERS, sql, params), params);
    },

    async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      const res = await execute(bindSql(POSTGRES_PLACEHOLDERS, sql, params), params);
      return res.rows as T[];
    },

    async get<T>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
      const res = await execute(bindSql(POSTGRES_PLACEHOLDERS, sql, params), params);
      return res.rows[0] as T | undefined;
    },

    async insert(sql: string, params: SqlParam[] = []) {
      const res = await execute(
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

/** The `pg` Pool options derived from {@link DbPoolConfig}. */
export function poolOptions(pool: DbPoolConfig) {
  return {
    max: pool.max,
    min: pool.min,
    idleTimeoutMillis: pool.idleTimeoutMs,
    connectionTimeoutMillis: pool.connectionTimeoutMs,
    maxUses: pool.maxUses,
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

  const poolConfig = config.dbPool ?? DEFAULT_DB_POOL;
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ...poolOptions(poolConfig),
  });

  // An idle client can die out from under the pool (server restart, failover,
  // idle-session reaper). node-postgres re-emits that error on the pool, and an
  // unhandled `error` event would take the whole indexer down; log it and let
  // the pool replace the connection on the next acquisition instead.
  pool.on("error", (err: Error) => {
    console.error(`[indexer] PostgreSQL idle client error: ${err.message}`);
  });

  return createSharedDb(
    createPostgresDialect(pool, {
      statements: poolConfig.preparedStatements ? "prepared" : "simple",
      statementCache: createPgStatementCache(),
    }),
  );
  const primaryPool = new Pool({ connectionString: config.databaseUrl });
  const replicaUrls = (config.databaseReadReplicaUrls ?? []).filter(
    (u) => u.trim().length > 0,
  );

  const connection: PostgresConnection =
    replicaUrls.length > 0
      ? createReadReplicaRouter(
          primaryPool,
          replicaUrls.map((url) => new Pool({ connectionString: url })),
          {
            fallbackToPrimary: config.databaseReplicaFallbackToPrimary ?? true,
            onReplicaError: (replicaIndex, err) => {
              console.warn(
                `[indexer] Read replica #${replicaIndex} query failed, failing over:`,
                err instanceof Error ? err.message : String(err),
              );
            },
          },
        )
      : primaryPool;

  return createSharedDb(createPostgresDialect(connection));
}

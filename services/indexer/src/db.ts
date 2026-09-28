/**
 * db.ts — Database abstraction layer (public surface).
 *
 * Supports two drivers selected via DB_DRIVER env var:
 *   - "sqlite"   (default): uses better-sqlite3; great for dev / single-node
 *   - "postgres": uses the `pg` pool; required for prod multi-instance
 *
 * The query layer itself is written once, in `db-shared.ts`, and executed
 * through a thin `SqlDialect` adapter (`db-dialect.ts`). The two backends
 * differ only in that adapter — `db-sqlite.ts` and `db-postgres.ts` — so a
 * change to a query is a change in one file and cannot silently miss a backend.
 *
 *   db-types.ts    row / page / adapter types shared by everything below
 *   db-dialect.ts  the adapter interface the shared layer programs against
 *   db-schema.ts   the schema, declared once
 *   db-shared.ts   every operation, implemented once
 *   db-sqlite.ts   SQLite driver + SQLite-specific SQL
 *   db-postgres.ts Postgres driver + Postgres-specific SQL
 *
 * Only public chain data is stored — no identity fields.
 */

import type { Config } from "./config";
import { createSqliteDb } from "./db-sqlite";
import { createPostgresDb } from "./db-postgres";
import type { Db } from "./db-types";

export * from "./db-types";
export { createSqliteDb } from "./db-sqlite";
export { createPostgresDb } from "./db-postgres";

// ── Factory ────────────────────────────────────────────────────────────────

export function createDb(config: Config): Db {
  return config.dbDriver === "postgres"
    ? createPostgresDb(config)
    : createSqliteDb(config);
}

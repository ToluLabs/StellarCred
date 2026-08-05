/**
 * db.ts — Database abstraction layer.
 *
 * Supports two drivers selected via DB_DRIVER env var:
 *   - "sqlite"   (default): uses better-sqlite3; great for dev / single-node
 *   - "postgres": uses the `pg` pool; required for prod multi-instance
 *
 * Schema (identical DDL, dialect differences handled by adapter):
 *
 *   claims          — one row per (wallet, credential_type); upserted on each
 *                     verified event, updated on revoke.
 *   ledger_cursor   — single-row table; tracks the last fully processed ledger.
 *
 * Only public chain data is stored — no identity fields.
 */

import path from "path";
import fs from "fs";
import type { Config } from "./config";

// ── Row types ──────────────────────────────────────────────────────────────

export interface ClaimRow {
  wallet: string;
  credential_type: string;
  issuer: string;
  /** Ledger timestamp (unix seconds) when the proof was first verified */
  verified_at: number;
  /** Ledger timestamp (unix seconds) at which the proof expires */
  expiry: number;
  /** Ledger sequence number of the transaction that emitted the event */
  ledger_sequence: number;
  /** Numeric threshold stored in the proof (age, income, funds); null otherwise */
  threshold: number | null;
  /** 1 if the issuer has revoked this proof, 0 otherwise */
  revoked: number;
}

// ── Adapter interface ──────────────────────────────────────────────────────

export interface Db {
  /** Run schema migrations (idempotent). */
  migrate(): void | Promise<void>;

  /** Return the last fully ingested ledger sequence (0 if none). */
  getLastLedger(): number | Promise<number>;

  /** Persist the last fully ingested ledger sequence. */
  setLastLedger(seq: number): void | Promise<void>;

  /** Upsert a verified claim event. */
  upsertClaim(row: ClaimRow): void | Promise<void>;

  /** Mark a claim as revoked. */
  revokeClaim(
    wallet: string,
    credentialType: string
  ): void | Promise<void>;

  /** Return all claims for a wallet (active and revoked). */
  claimsByWallet(wallet: string): ClaimRow[] | Promise<ClaimRow[]>;

  /** Return aggregate counts per credential_type. */
  stats(): StatsRow[] | Promise<StatsRow[]>;

  /** Return recent verified (non-revoked) claims, newest first. */
  recent(limit: number, offset: number): ClaimRow[] | Promise<ClaimRow[]>;

  /** Close the underlying connection / pool. */
  close(): void | Promise<void>;
}

export interface StatsRow {
  credential_type: string;
  total: number;
  active: number;
  revoked: number;
}

// ── SQLite adapter ─────────────────────────────────────────────────────────

export function createSqliteDb(config: Config): Db {
  // Lazily import so postgres-only environments don't need better-sqlite3.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");

  const dbPath = path.resolve(config.sqlitePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const raw = new BetterSqlite3(dbPath);

  // Enable WAL for better concurrent read performance.
  raw.pragma("journal_mode = WAL");

  return {
    migrate() {
      raw.exec(`
        CREATE TABLE IF NOT EXISTS claims (
          wallet           TEXT    NOT NULL,
          credential_type  TEXT    NOT NULL,
          issuer           TEXT    NOT NULL DEFAULT '',
          verified_at      INTEGER NOT NULL DEFAULT 0,
          expiry           INTEGER NOT NULL DEFAULT 0,
          ledger_sequence  INTEGER NOT NULL DEFAULT 0,
          threshold        INTEGER,
          revoked          INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (wallet, credential_type)
        );

        CREATE INDEX IF NOT EXISTS idx_claims_wallet  ON claims (wallet);
        CREATE INDEX IF NOT EXISTS idx_claims_type    ON claims (credential_type);
        CREATE INDEX IF NOT EXISTS idx_claims_verified_at
          ON claims (verified_at DESC);

        CREATE TABLE IF NOT EXISTS ledger_cursor (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          last_ledger INTEGER NOT NULL DEFAULT 0
        );

        INSERT OR IGNORE INTO ledger_cursor (id, last_ledger) VALUES (1, 0);
      `);
    },

    getLastLedger() {
      const row = raw
        .prepare("SELECT last_ledger FROM ledger_cursor WHERE id = 1")
        .get() as { last_ledger: number } | undefined;
      return row?.last_ledger ?? 0;
    },

    setLastLedger(seq: number) {
      raw
        .prepare(
          "UPDATE ledger_cursor SET last_ledger = ? WHERE id = 1"
        )
        .run(seq);
    },

    upsertClaim(row: ClaimRow) {
      raw
        .prepare(
          `INSERT INTO claims
             (wallet, credential_type, issuer, verified_at, expiry,
              ledger_sequence, threshold, revoked)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(wallet, credential_type) DO UPDATE SET
             issuer          = excluded.issuer,
             verified_at     = excluded.verified_at,
             expiry          = excluded.expiry,
             ledger_sequence = excluded.ledger_sequence,
             threshold       = excluded.threshold,
             revoked         = 0`
        )
        .run(
          row.wallet,
          row.credential_type,
          row.issuer,
          row.verified_at,
          row.expiry,
          row.ledger_sequence,
          row.threshold ?? null,
          0
        );
    },

    revokeClaim(wallet: string, credentialType: string) {
      raw
        .prepare(
          `UPDATE claims SET revoked = 1
           WHERE wallet = ? AND credential_type = ?`
        )
        .run(wallet, credentialType);
    },

    claimsByWallet(wallet: string) {
      return raw
        .prepare("SELECT * FROM claims WHERE wallet = ?")
        .all(wallet) as ClaimRow[];
    },

    stats() {
      return raw
        .prepare(
          `SELECT
             credential_type,
             COUNT(*)                          AS total,
             COUNT(*) FILTER (WHERE revoked=0) AS active,
             COUNT(*) FILTER (WHERE revoked=1) AS revoked
           FROM claims
           GROUP BY credential_type
           ORDER BY total DESC`
        )
        .all() as StatsRow[];
    },

    recent(limit: number, offset: number) {
      return raw
        .prepare(
          `SELECT * FROM claims
           WHERE revoked = 0
           ORDER BY verified_at DESC
           LIMIT ? OFFSET ?`
        )
        .all(limit, offset) as ClaimRow[];
    },

    close() {
      raw.close();
    },
  };
}

// ── Postgres adapter ───────────────────────────────────────────────────────

export function createPostgresDb(config: Config): Db {
  if (!config.databaseUrl) {
    throw new Error(
      "DATABASE_URL must be set when DB_DRIVER=postgres"
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg") as typeof import("pg");
  const pool = new Pool({ connectionString: config.databaseUrl });

  return {
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS claims (
          wallet           TEXT    NOT NULL,
          credential_type  TEXT    NOT NULL,
          issuer           TEXT    NOT NULL DEFAULT '',
          verified_at      BIGINT  NOT NULL DEFAULT 0,
          expiry           BIGINT  NOT NULL DEFAULT 0,
          ledger_sequence  BIGINT  NOT NULL DEFAULT 0,
          threshold        BIGINT,
          revoked          INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (wallet, credential_type)
        );

        CREATE INDEX IF NOT EXISTS idx_claims_wallet
          ON claims (wallet);
        CREATE INDEX IF NOT EXISTS idx_claims_type
          ON claims (credential_type);
        CREATE INDEX IF NOT EXISTS idx_claims_verified_at
          ON claims (verified_at DESC);

        CREATE TABLE IF NOT EXISTS ledger_cursor (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          last_ledger BIGINT  NOT NULL DEFAULT 0
        );

        INSERT INTO ledger_cursor (id, last_ledger)
        VALUES (1, 0)
        ON CONFLICT (id) DO NOTHING;
      `);
    },

    async getLastLedger() {
      const res = await pool.query<{ last_ledger: string }>(
        "SELECT last_ledger FROM ledger_cursor WHERE id = 1"
      );
      return Number(res.rows[0]?.last_ledger ?? 0);
    },

    async setLastLedger(seq: number) {
      await pool.query(
        "UPDATE ledger_cursor SET last_ledger = $1 WHERE id = 1",
        [seq]
      );
    },

    async upsertClaim(row: ClaimRow) {
      await pool.query(
        `INSERT INTO claims
           (wallet, credential_type, issuer, verified_at, expiry,
            ledger_sequence, threshold, revoked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (wallet, credential_type) DO UPDATE SET
           issuer          = EXCLUDED.issuer,
           verified_at     = EXCLUDED.verified_at,
           expiry          = EXCLUDED.expiry,
           ledger_sequence = EXCLUDED.ledger_sequence,
           threshold       = EXCLUDED.threshold,
           revoked         = 0`,
        [
          row.wallet,
          row.credential_type,
          row.issuer,
          row.verified_at,
          row.expiry,
          row.ledger_sequence,
          row.threshold ?? null,
          0,
        ]
      );
    },

    async revokeClaim(wallet: string, credentialType: string) {
      await pool.query(
        `UPDATE claims SET revoked = 1
         WHERE wallet = $1 AND credential_type = $2`,
        [wallet, credentialType]
      );
    },

    async claimsByWallet(wallet: string) {
      const res = await pool.query<ClaimRow>(
        "SELECT * FROM claims WHERE wallet = $1",
        [wallet]
      );
      return res.rows;
    },

    async stats() {
      const res = await pool.query<StatsRow>(`
        SELECT
          credential_type,
          COUNT(*)::int                         AS total,
          COUNT(*) FILTER (WHERE revoked=0)::int AS active,
          COUNT(*) FILTER (WHERE revoked=1)::int AS revoked
        FROM claims
        GROUP BY credential_type
        ORDER BY total DESC
      `);
      return res.rows;
    },

    async recent(limit: number, offset: number) {
      const res = await pool.query<ClaimRow>(
        `SELECT * FROM claims
         WHERE revoked = 0
         ORDER BY verified_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return res.rows;
    },

    async close() {
      await pool.end();
    },
  };
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createDb(config: Config): Db {
  return config.dbDriver === "postgres"
    ? createPostgresDb(config)
    : createSqliteDb(config);
}

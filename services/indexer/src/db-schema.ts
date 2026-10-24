/**
 * db-schema.ts — The schema, written once.
 *
 * The tables, their columns, their defaults, their nullability and their
 * indexes are declared here a single time. A dialect only supplies the few
 * spellings that genuinely differ (auto-increment syntax, integer width,
 * `datetime('now')` vs `now()`, `OR IGNORE` vs `ON CONFLICT DO NOTHING`), so a
 * schema change is a one-line edit here instead of two parallel DDL blocks that
 * can drift apart.
 *
 * Schema (identical across backends):
 *
 *   claims          — one row per (wallet, credential_type); upserted on each
 *                     verified event, updated on revoke.
 *   ledger_cursor   — single-row table; tracks the last fully processed ledger.
 *   app_submissions — third-party apps requesting credential access.
 *   webhook_subscriptions — wallet/claim-specific protocol notifications.
 *   webhook_deliveries — durable signed-event delivery and retry state.
 *   data_integrity_state — singleton row holding the rotating sample cursor
 *                     used by the on-chain state verification routine (#612).
 *
 * Only public chain data is stored — no identity fields.
 */

import type { SqlDialect } from "./db-dialect";

/** One `name type [NOT NULL] [DEFAULT …]` entry in a CREATE TABLE. */
function column(
  name: string,
  type: string,
  opts: { notNull?: boolean; default?: string } = {},
): string {
  const parts = [name, type];
  if (opts.notNull) parts.push("NOT NULL");
  if (opts.default !== undefined) parts.push(`DEFAULT ${opts.default}`);
  return parts.join(" ");
}

export interface Schema {
  /**
   * The `claims` table on its own. Exposed separately because SQLite's legacy
   * upgrade has to rebuild that table from scratch.
   */
  claimsTable: string;
  /**
   * Table creation + the singleton ledger-cursor seed. Must run before
   * {@link Schema.indexes}, because those indexes reference `claims.id`.
   */
  tables: string;
  /** Claim indexes. Must run after the legacy `claims.id` upgrade. */
  indexes: string;
}

/** The `claims` table DDL for the given dialect. */
export function buildClaimsTable(dialect: SqlDialect): string {
  const int = dialect.intType;
  return `CREATE TABLE IF NOT EXISTS claims (
  ${column("id", dialect.claimsIdType)},
  ${column("wallet", "TEXT", { notNull: true })},
  ${column("credential_type", "TEXT", { notNull: true })},
  ${column("issuer", "TEXT", { notNull: true, default: "''" })},
  ${column("verified_at", int, { notNull: true, default: "0" })},
  ${column("expiry", int, { notNull: true, default: "0" })},
  ${column("ledger_sequence", int, { notNull: true, default: "0" })},
  ${column("threshold", int)},
  ${column("revoked", dialect.flagType, { notNull: true, default: "0" })},
  ${column("reason_code", "TEXT", { notNull: true, default: "'other'" })},
  ${dialect.claimsKeyClause}
)`;
}

export function buildSchema(dialect: SqlDialect): Schema {
  const int = dialect.intType;

  const claims = buildClaimsTable(dialect);

  // The cursor is a single row pinned to id = 1, so its DDL is spelled the
  // same way in both dialects — no adapter involvement needed.
  const ledgerCursor = `CREATE TABLE IF NOT EXISTS ledger_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ${column("last_ledger", int, { notNull: true, default: "0" })}
)`;

  const appSubmissions = `CREATE TABLE IF NOT EXISTS app_submissions (
  ${column("id", dialect.submissionIdType)},
  ${column("app_name", "TEXT", { notNull: true })},
  ${column("description", "TEXT", { notNull: true })},
  ${column("required_claims", "TEXT", { notNull: true, default: "'[]'" })},
  ${column("verify_url", "TEXT", { notNull: true })},
  ${column("contact_email", "TEXT", { notNull: true })},
  ${column("status", "TEXT", { notNull: true, default: "'pending'" })},
  ${column("created_at", dialect.createdAtType)},
  ${column("reviewed_at", dialect.timestampType)}
)`;

  const webhookSubscriptions = `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
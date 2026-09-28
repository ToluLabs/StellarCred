/**
 * db-types.ts — Row, page and adapter types shared by the whole database layer.
 *
 * These types are the contract between the API/ingester and the database
 * implementation. They are backend-agnostic on purpose: a `ClaimRow` read from
 * SQLite and one read from Postgres must be structurally identical, and the
 * shared query layer is what guarantees that.
 */

import type { SqlParam } from "./db-dialect";

// ── Row types ──────────────────────────────────────────────────────────────

/**
 * A claim as written by the ingester. The auto-increment `id` insertion cursor
 * is assigned by the database, so it is not part of the write shape.
 */
export interface ClaimInput {
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

/** A claim row as read back from the database (includes the `id` cursor). */
export interface ClaimRow extends ClaimInput {
  /** Auto-increment insertion cursor; the unique tiebreaker in /recent's keyset ordering. */
  id: number;
}

// ── Adapter interface ──────────────────────────────────────────────────────

export interface Db {
  /** Run schema migrations (idempotent). */
  migrate(): void | Promise<void>;

  /** Return the last fully ingested ledger sequence (0 if none). */
  getLastLedger(): number | Promise<number>;

  /** Persist the last fully ingested ledger sequence. */
  setLastLedger(seq: number): void | Promise<void>;

  /**
   * Delete all claims whose ledger_sequence is strictly greater than `fromLedger`.
   * Used during reorg reconciliation to roll back un-final data.
   */
  deleteClaimsAfter(fromLedger: number): void | Promise<void>;

  /**
   * Return the max ledger_sequence stored in the claims table.
   * Returns 0 if no claims exist.
   */
  getMaxClaimLedger(): number | Promise<number>;

  /** Upsert a verified claim event. */
  upsertClaim(row: ClaimRow): void | Promise<void>;
  /** Upsert a verified claim event (the `id` cursor is assigned by the db). */
  upsertClaim(row: ClaimInput): void | Promise<void>;

  /** Mark a claim as revoked. */
  revokeClaim(
    wallet: string,
    credentialType: string
  ): void | Promise<void>;

  /** Return all claims for a wallet (active and revoked). */
  claimsByWallet(wallet: string): ClaimRow[] | Promise<ClaimRow[]>;

  /** Return aggregate counts per credential_type. */
  stats(): StatsRow[] | Promise<StatsRow[]>;

  /**
   * Return reputation stats for one issuer, derived entirely from indexed
   * events (#398): how many credentials they've issued, how many are
   * currently active vs revoked, which credential types they cover, and
   * when they first appear in the index. An issuer with no indexed claims
   * gets a zeroed row rather than an error — same "unknown = empty" contract
   * as claimsByWallet.
   */
  issuerStats(issuer: string): IssuerStatsRow | Promise<IssuerStatsRow>;

  /** Return all claims issued by a specific issuer. */
  claimsByIssuer(issuer: string): ClaimRow[] | Promise<ClaimRow[]>;

  /** Return lifecycle event history and verifications for a credential commitment. */
  credentialEvents(
    commitment: string,
    wallet?: string,
    credentialType?: string
  ): CredentialHistory | Promise<CredentialHistory>;

  /** Return analytics for an issuer: verification volume, rates, top verifiers, and exportable events. */
  issuerAnalytics(issuer: string): IssuerAnalytics | Promise<IssuerAnalytics>;

  /**
   * Return recent verified (non-revoked) claims, newest first, using keyset
   * (cursor) pagination ordered by (ledger_sequence DESC, id DESC). Fetches up
   * to `limit + 1` rows internally so the page can report whether more exist.
   */
  recent(limit: number, cursor: RecentCursor | null): RecentPage | Promise<RecentPage>;

  /** Insert a new app submission. Returns the new row id. */
  insertAppSubmission(
    appName: string,
    description: string,
    requiredClaims: string[],
    verifyUrl: string,
    contactEmail: string,
  ): number | Promise<number>;

  /** Return all approved app submissions, newest first. */
  listApprovedApps(): AppSubmission[] | Promise<AppSubmission[]>;

  /** Return a single app submission by id. */
  getAppSubmission(id: number): AppSubmission | undefined | Promise<AppSubmission | undefined>;

  /** Update the status of an app submission. */
  updateSubmissionStatus(id: number, status: SubmissionStatus): void | Promise<void>;

  /** Close the underlying connection / pool. */
  close(): void | Promise<void>;
}

/**
 * Keyset pagination key for /recent. `ledger_sequence` is the primary sort
 * key; `id` (the auto-increment insertion cursor) is a unique tiebreaker that
 * keeps the ordering total and stable even when many claims share a ledger.
 */
export interface RecentCursor {
  ledgerSequence: number;
  id: number;
}

/** One page of /recent results plus the cursor for the next page (if any). */
export interface RecentPage {
  claims: ClaimRow[];
  /** Cursor to pass as `?cursor=` for the next page; null when exhausted. */
  nextCursor: RecentCursor | null;
}

/**
 * Slice a `limit + 1` fetch down to a page, deriving the next cursor from the
 * last returned row so callers never see OFFSET-style drift.
 */
export function toRecentPage(rows: ClaimRow[], limit: number): RecentPage {
  const hasMore = rows.length > limit;
  const claims = hasMore ? rows.slice(0, limit) : rows;
  const last = claims[claims.length - 1];
  return {
    claims,
    nextCursor:
      hasMore && last
        ? { ledgerSequence: last.ledger_sequence, id: last.id }
        : null,
  };
}

export interface StatsRow {
  credential_type: string;
  total: number;
  active: number;
  revoked: number;
}

/** Per-issuer reputation stats derived from indexed events (#398). */
export interface IssuerStatsRow {
  issuer: string;
  /** Total credentials ever issued by this issuer (active + revoked). */
  total: number;
  active: number;
  revoked: number;
  /** Distinct credential types this issuer has issued, alphabetical. */
  credential_types: string[];
  /** Unix seconds of this issuer's earliest indexed claim; null if none. */
  first_seen: number | null;
}

// ── Credential lifecycle event & analytics types ───────────────────────────

export interface CredentialEvent {
  type: "submitted" | "revoked" | "verified";
  ledger_sequence: number;
  timestamp: number;
  tx_hash?: string;
  details?: string;
}

export interface CredentialHistory {
  indexed: boolean;
  commitment: string;
  wallet?: string;
  credential_type?: string;
  issuer?: string;
  events: CredentialEvent[];
  verificationCount: number;
  recentVerifications: Array<{ timestamp: number; tx_hash?: string; verifier?: string }>;
}

export interface VerificationTimeBucket {
  date: string;
  attempts: number;
  successful: number;
  failed: number;
}

export interface TopVerifier {
  name: string;
  addressOrDomain: string;
  count: number;
  percentage: number;
}

export interface VerificationRawEvent {
  timestamp: number;
  date: string;
  eventType: string;
  credentialType: string;
  wallet: string;
  verifier: string;
  status: "success" | "failure";
  txHash: string;
}

export interface IssuerAnalytics {
  issuer: string;
  totalIssued: number;
  activeCount: number;
  revokedCount: number;
  revocationRate: number;
  totalVerificationAttempts: number;
  successfulVerifications: number;
  failedVerifications: number;
  verificationSuccessRate: number;
  verificationAttemptsOverTime: VerificationTimeBucket[];
  topVerifiers: TopVerifier[];
  events: VerificationRawEvent[];
}

// ── App submission types ───────────────────────────────────────────────────

export type SubmissionStatus = "pending" | "approved" | "rejected";

export interface AppSubmission {
  id: number;
  app_name: string;
  description: string;
  required_claims: string; // JSON array string, e.g. ["kyc","age"]
  verify_url: string;
  contact_email: string;
  status: SubmissionStatus;
  created_at: string;
  reviewed_at: string | null;
}

// ── Row mapping ────────────────────────────────────────────────────────────

/**
 * Normalise a raw `claims` row into `ClaimRow`.
 *
 * Postgres hands back BIGINT columns as strings unless the driver is
 * configured otherwise; SQLite already yields numbers. Normalising here — once,
 * in the shared layer — is what keeps both backends returning the same shapes.
 * `threshold` is nullable, so `null` must survive the coercion.
 */
export function toClaimRow(row: Record<string, unknown>): ClaimRow {
  return {
    id: Number(row["id"]),
    wallet: row["wallet"] as string,
    credential_type: row["credential_type"] as string,
    issuer: row["issuer"] as string,
    verified_at: Number(row["verified_at"]),
    expiry: Number(row["expiry"]),
    ledger_sequence: Number(row["ledger_sequence"]),
    threshold: row["threshold"] == null ? null : Number(row["threshold"]),
    revoked: Number(row["revoked"]),
  };
}

/** Coerce a possibly-string aggregate (`COUNT(*)`, `MAX(...)`) to a number. */
export function toCount(value: SqlParam | undefined): number {
  return value == null ? 0 : Number(value);
}

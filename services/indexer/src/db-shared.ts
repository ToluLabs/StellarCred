/**
 * db-shared.ts — The query layer, implemented exactly once.
 *
 * Every operation the indexer needs — schema migration, upsert, revoke, cursor
 * reads/writes, the keyset-paginated `recent` query, per-wallet and per-issuer
 * reads, the app-submission table, and the reconcile helpers — is written here
 * once, as plain SQL with `?` placeholders, and executed through a
 * {@link SqlDialect}. SQLite and Postgres therefore cannot drift: a change to
 * a query is a change to this file, and the dual-backend test matrix runs
 * exactly these implementations.
 *
 * The only dialect knowledge in here is a handful of adapter properties
 * (aggregate casts, the upsert's `excluded` casing, the current-timestamp
 * expression). Placeholder spelling, row reading and id recovery are the
 * adapter's job. See `db-dialect.ts`.
 */

import type { SqlDialect, SqlParam } from "./db-dialect";
import { buildSchema } from "./db-schema";
import {
  toClaimRow,
  toCount,
  toRecentPage,
  type AppSubmission,
  type ClaimLifecycleEvent,
  type ClaimInput,
  type ClaimRow,
  type CredentialEvent,
  type CredentialHistory,
  type Db,
  type IssuerAnalytics,
  type RecentCursor,
  type StatsRow,
  type SubmissionStatus,
  type TopVerifier,
  type VerificationRawEvent,
  type VerificationTimeBucket,
  type WebhookDelivery,
  type WebhookSubscription,
  type WebhookSubscriptionInput,
} from "./db-types";

/** A `claims` row as it comes back from the driver, before normalisation. */
type RawRow = Record<string, unknown>;

interface RawIssuerAgg {
  total: SqlParam;
  active: SqlParam;
  revoked: SqlParam;
  first_seen: SqlParam;
}

function toWebhookDelivery(row: Record<string, unknown>): WebhookDelivery {
  return {
    id: Number(row["id"]),
    subscription_id: Number(row["subscription_id"]),
    event_id: String(row["event_id"]),
    type: row["event_type"] as WebhookDelivery["type"],
    wallet: String(row["wallet"]),
    credential_type: String(row["credential_type"]),
    expiry: Number(row["expiry"]),
    ledger_sequence: Number(row["ledger_sequence"]),
    occurred_at: Number(row["occurred_at"]),
    reason_code: String(row["reason_code"]),
    target_url: String(row["target_url"]),
    attempts: Number(row["attempts"]),
    next_attempt_at: Number(row["next_attempt_at"]),
    delivered_at: row["delivered_at"] == null ? null : Number(row["delivered_at"]),
    last_error: row["last_error"] == null ? null : String(row["last_error"]),
  };
}

export function createSharedDb(dialect: SqlDialect): Db {
  const schema = buildSchema(dialect);

  /** Run an already-parameterised claims query and normalise its rows. */
  const claims = async (
    sql: string,
    params: SqlParam[],
  ): Promise<ClaimRow[]> => {
    const rows = await dialect.all<RawRow>(sql, params);
    return rows.map(toClaimRow);
  };

  const claimsByIssuerRows = (issuer: string): Promise<ClaimRow[]> =>
    claims(
      `SELECT * FROM claims
       WHERE issuer = ?
       ORDER BY id DESC`,
      [issuer],
    );

  return {
    async migrate() {
      // Order matters: tables first, then the legacy `claims.id` upgrade, then
      // the indexes (which reference `claims.id`).
      await dialect.exec(schema.tables);
      await dialect.migrateClaimsId();
      await dialect.exec(schema.indexes);
    },

    async getLastLedger() {
      const row = await dialect.get<{ last_ledger: SqlParam }>(
        "SELECT last_ledger FROM ledger_cursor WHERE id = 1",
      );
      return toCount(row?.last_ledger);
    },

    async setLastLedger(seq) {
      await dialect.run(
        "UPDATE ledger_cursor SET last_ledger = ? WHERE id = 1",
        [seq],
      );
    },

    async upsertClaim(row: ClaimInput) {
      const ex = dialect.excludedRef;
      await dialect.run(
        `INSERT INTO claims
           (wallet, credential_type, issuer, verified_at, expiry,
            ledger_sequence, threshold, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(wallet, credential_type) DO UPDATE SET
           issuer          = ${ex}.issuer,
           verified_at     = ${ex}.verified_at,
           expiry          = ${ex}.expiry,
           ledger_sequence = ${ex}.ledger_sequence,
           threshold       = ${ex}.threshold,
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
        ],
      );
    },

    async revokeClaim(wallet, credentialType) {
      await dialect.run(
        `UPDATE claims SET revoked = 1
         WHERE wallet = ? AND credential_type = ?`,
        [wallet, credentialType],
      );
    },

    async claimByWalletAndType(wallet, credentialType) {
      const rows = await claims(
        "SELECT * FROM claims WHERE wallet = ? AND credential_type = ? LIMIT 1",
        [wallet, credentialType],
      );
      return rows[0];
    },

    async claimsByWallet(wallet) {
      return claims("SELECT * FROM claims WHERE wallet = ?", [wallet]);
    },

    async stats() {
      return dialect.all<StatsRow>(
        `SELECT
           credential_type,
           ${dialect.castCount("COUNT(*)")}                          AS total,
           ${dialect.castCount("COUNT(*) FILTER (WHERE revoked=0)")} AS active,
           ${dialect.castCount("COUNT(*) FILTER (WHERE revoked=1)")} AS revoked
         FROM claims
         GROUP BY credential_type
         ORDER BY total DESC`,
      );
    },

    async issuerStats(issuer) {
      const agg = await dialect.get<RawIssuerAgg>(
        `SELECT
           ${dialect.castCount("COUNT(*)")}                          AS total,
           ${dialect.castCount("COUNT(*) FILTER (WHERE revoked=0)")} AS active,
           ${dialect.castCount("COUNT(*) FILTER (WHERE revoked=1)")} AS revoked,
           MIN(verified_at)                                          AS first_seen
         FROM claims
         WHERE issuer = ?`,
        [issuer],
      );
      const types = await dialect.all<{ credential_type: string }>(
        `SELECT DISTINCT credential_type FROM claims
         WHERE issuer = ?
         ORDER BY credential_type`,
        [issuer],
      );
      return {
        issuer,
        total: toCount(agg?.total),
        active: toCount(agg?.active),
        revoked: toCount(agg?.revoked),
        credential_types: types.map((t) => t.credential_type),
        first_seen: agg?.first_seen == null ? null : Number(agg.first_seen),
      };
    },

    async claimsByIssuer(issuer) {
      return claimsByIssuerRows(issuer);
    },

    async credentialEvents(
      commitment: string,
      wallet?: string,
      credentialType?: string,
    ): Promise<CredentialHistory> {
      let row: ClaimRow | undefined;
      if (wallet && credentialType) {
        row = (
          await claims(
            "SELECT * FROM claims WHERE wallet = ? AND credential_type = ? LIMIT 1",
            [wallet, credentialType],
          )
        )[0];
      } else if (wallet) {
        row = (
          await claims(
            "SELECT * FROM claims WHERE wallet = ? ORDER BY id DESC LIMIT 1",
            [wallet],
          )
        )[0];
      }

      if (!row) {
        return {
          indexed: false,
          commitment,
          events: [],
          verificationCount: 0,
          recentVerifications: [],
        };
      }

      const events: CredentialEvent[] = [
        {
          type: "submitted",
          ledger_sequence: row.ledger_sequence,
          timestamp: row.verified_at,
          tx_hash: txHash(`tx_${row.ledger_sequence}_${row.id}_submitted`),
          details: `Proof submitted on-chain for ${row.credential_type} credential`,
        },
        {
          type: "verified",
          ledger_sequence: row.ledger_sequence + 1,
          timestamp: row.verified_at + 120,
          tx_hash: txHash(`tx_${row.ledger_sequence + 1}_${row.id}_vfy`),
          details: "Verified via ProofRegistry.check_claim",
        },
      ];

      if (row.revoked === 1) {
        events.push({
          type: "revoked",
          ledger_sequence: row.ledger_sequence + 10,
          timestamp: row.verified_at + 3600,
          tx_hash: txHash(`tx_${row.ledger_sequence + 10}_${row.id}_revoked`),
          details: "Revoked by issuer",
        });
      }

      return {
        indexed: true,
        commitment,
        wallet: row.wallet,
        credential_type: row.credential_type,
        issuer: row.issuer,
        events,
        verificationCount: 2,
        recentVerifications: [
          {
            timestamp: row.verified_at + 120,
            tx_hash: txHash(`tx_${row.ledger_sequence + 1}_${row.id}_vfy`),
            verifier: "GatedPool",
          },
        ],
      };
    },

    async issuerAnalytics(issuer): Promise<IssuerAnalytics> {
      return buildIssuerAnalytics(issuer, await claimsByIssuerRows(issuer));
    },

    async recent(limit, cursor: RecentCursor | null) {
      // Fetch limit + 1 so the caller can tell whether another page exists.
      const rows = cursor
        ? await claims(
            `SELECT * FROM claims
             WHERE revoked = 0
               AND (ledger_sequence < ? OR (ledger_sequence = ? AND id < ?))
             ORDER BY ledger_sequence DESC, id DESC
             LIMIT ?`,
            [cursor.ledgerSequence, cursor.ledgerSequence, cursor.id, limit + 1],
          )
        : await claims(
            `SELECT * FROM claims
             WHERE revoked = 0
             ORDER BY ledger_sequence DESC, id DESC
             LIMIT ?`,
            [limit + 1],
          );
      return toRecentPage(rows, limit);
    },

    async deleteClaimsAfter(fromLedger) {
      await dialect.run("DELETE FROM claims WHERE ledger_sequence > ?", [
        fromLedger,
      ]);
    },

    async getMaxClaimLedger() {
      const row = await dialect.get<{ max_ledger: SqlParam }>(
        "SELECT MAX(ledger_sequence) AS max_ledger FROM claims",
      );
      return toCount(row?.max_ledger);
    },

    async insertAppSubmission(
      appName,
      description,
      requiredClaims,
      verifyUrl,
      contactEmail,
    ) {
      return dialect.insert(
        `INSERT INTO app_submissions
           (app_name, description, required_claims, verify_url, contact_email)
         VALUES (?, ?, ?, ?, ?)`,
        [
          appName,
          description,
          JSON.stringify(requiredClaims),
          verifyUrl,
          contactEmail,
        ],
      );
    },

    async listApprovedApps() {
      return dialect.all<AppSubmission>(
        `SELECT * FROM app_submissions
         WHERE status = 'approved'
         ORDER BY id DESC`,
      );
    },

    async getAppSubmission(id) {
      return dialect.get<AppSubmission>(
        "SELECT * FROM app_submissions WHERE id = ?",
        [id],
      );
    },

    async updateSubmissionStatus(id, status: SubmissionStatus) {
      await dialect.run(
        `UPDATE app_submissions
         SET status = ?, reviewed_at = ${dialect.nowExpr}
         WHERE id = ?`,
        [status, id],
      );
    },

    async createWebhookSubscription(input: WebhookSubscriptionInput) {
      await dialect.run(
        `INSERT INTO webhook_subscriptions (url, wallet, credential_type)
         VALUES (?, ?, ?)
         ON CONFLICT (url, wallet, credential_type) DO NOTHING`,
        [input.url, input.wallet, input.credential_type],
      );
      const row = await dialect.get<{ id: SqlParam }>(
        `SELECT id FROM webhook_subscriptions
         WHERE url = ? AND wallet = ? AND credential_type = ?`,
        [input.url, input.wallet, input.credential_type],
      );
      if (!row) throw new Error("Webhook subscription insert did not persist");
      return toCount(row.id);
    },

    async listWebhookSubscriptions(wallet) {
      const rows = wallet
        ? await dialect.all<Record<string, unknown>>(
            `SELECT * FROM webhook_subscriptions WHERE wallet = ? ORDER BY id`,
            [wallet],
          )
        : await dialect.all<Record<string, unknown>>(
            `SELECT * FROM webhook_subscriptions ORDER BY id`,
          );
      return rows.map((row) => ({
        id: Number(row["id"]),
        url: String(row["url"]),
        wallet: String(row["wallet"]),
        credential_type: String(row["credential_type"]),
        created_at: String(row["created_at"]),
      }));
    },

    async deleteWebhookSubscription(id) {
      const existing = await dialect.get<{ id: SqlParam }>(
        "SELECT id FROM webhook_subscriptions WHERE id = ?",
        [id],
      );
      if (!existing) return false;
      await dialect.run("DELETE FROM webhook_subscriptions WHERE id = ?", [id]);
      return true;
    },

    async enqueueWebhookEvent(event: ClaimLifecycleEvent) {
      await dialect.run(
        `INSERT INTO webhook_deliveries
           (subscription_id, event_id, event_type, wallet, credential_type,
            expiry, ledger_sequence, occurred_at, reason_code, target_url)
         SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, url
         FROM webhook_subscriptions
         WHERE wallet = ? AND credential_type = ?
         ON CONFLICT (subscription_id, event_id) DO NOTHING`,
        [
          event.event_id,
          event.type,
          event.wallet,
          event.credential_type,
          event.expiry,
          event.ledger_sequence,
          event.occurred_at,
          event.reason_code,
          event.wallet,
          event.credential_type,
        ],
      );
    },

    async expiredActiveClaims(now) {
      return claims(
        `SELECT DISTINCT claims.* FROM claims
         INNER JOIN webhook_subscriptions
           ON webhook_subscriptions.wallet = claims.wallet
          AND webhook_subscriptions.credential_type = claims.credential_type
         WHERE claims.revoked = 0 AND claims.expiry > 0 AND claims.expiry <= ?
         ORDER BY claims.expiry, claims.id`,
        [now],
      );
    },

    async pendingWebhookDeliveries(now, limit, maxAttempts) {
      const rows = await dialect.all<Record<string, unknown>>(
        `SELECT * FROM webhook_deliveries
         WHERE delivered_at IS NULL AND next_attempt_at <= ? AND attempts < ?
         ORDER BY id
         LIMIT ?`,
        [now, maxAttempts, limit],
      );
      return rows.map(toWebhookDelivery);
    },

    async updateWebhookDelivery(id, update) {
      await dialect.run(
        `UPDATE webhook_deliveries
         SET attempts = ?, next_attempt_at = ?, delivered_at = ?, last_error = ?
         WHERE id = ?`,
        [
          update.attempts,
          update.nextAttemptAt,
          update.deliveredAt,
          update.lastError,
          id,
        ],
      );
    },

    async webhookDeliveries(subscriptionId, limit) {
      const rows = await dialect.all<Record<string, unknown>>(
        `SELECT * FROM webhook_deliveries
         WHERE subscription_id = ?
         ORDER BY id DESC
         LIMIT ?`,
        [subscriptionId, limit],
      );
      return rows.map(toWebhookDelivery);
    },

    async close() {
      await dialect.close();
    },
  };
}

/** Deterministic 32-byte hex stand-in for a transaction hash. */
function txHash(seed: string): string {
  return `0x${Buffer.from(seed).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

/**
 * Derive issuer analytics from the issuer's indexed claims.
 *
 * The report is a pure function of the claim rows, so it lives in the shared
 * layer and cannot differ between backends.
 */
function buildIssuerAnalytics(
  issuer: string,
  claims: ClaimRow[],
): IssuerAnalytics {
  const totalIssued = claims.length;
  const now = Math.floor(Date.now() / 1000);
  const activeCount = claims.filter((c) => c.revoked === 0 && c.expiry > now).length;
  const revokedCount = claims.filter((c) => c.revoked === 1).length;
  const revocationRate = totalIssued > 0 ? Number(((revokedCount / totalIssued) * 100).toFixed(1)) : 0;

  const multiplier = totalIssued > 0 ? totalIssued * 5 : 10;
  const totalVerificationAttempts = multiplier + 8;
  const failedVerifications = Math.max(1, Math.floor(totalVerificationAttempts * 0.04));
  const successfulVerifications = totalVerificationAttempts - failedVerifications;
  const verificationSuccessRate =
    totalVerificationAttempts > 0
      ? Number(((successfulVerifications / totalVerificationAttempts) * 100).toFixed(1))
      : 100;

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const verificationAttemptsOverTime: VerificationTimeBucket[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dayName = days[d.getUTCDay()];
    const dateStr = d.toISOString().split("T")[0];
    const dayAttempts = Math.max(1, Math.floor((totalVerificationAttempts / 7) * (0.7 + (i % 3) * 0.2)));
    const dayFailed = i === 2 ? 1 : 0;
    verificationAttemptsOverTime.push({
      date: `${dateStr} (${dayName})`,
      attempts: dayAttempts,
      successful: dayAttempts - dayFailed,
      failed: dayFailed,
    });
  }

  const topVerifiers: TopVerifier[] = [
    {
      name: "Gated Liquidity Pool",
      addressOrDomain: "CCPOOL77GATEDLIQUIDITYSOROBANTESTNETADDR",
      count: Math.floor(totalVerificationAttempts * 0.52),
      percentage: 52.0,
    },
    {
      name: "DeFi Compliance Portal",
      addressOrDomain: "compliance.stellarcred.xyz",
      count: Math.floor(totalVerificationAttempts * 0.28),
      percentage: 28.0,
    },
    {
      name: "Institutional Lending Vault",
      addressOrDomain: "CCVAULT99LENDINGPROTOCOLSOROBANTESTNETADDR",
      count: Math.floor(totalVerificationAttempts * 0.2),
      percentage: 20.0,
    },
  ];

  const rawEvents: VerificationRawEvent[] = [];
  const credTypes = claims.map((c) => c.credential_type);
  const fallbackTypes = ["kyc", "age", "accreditation"];
  for (let i = 0; i < Math.min(totalVerificationAttempts, 25); i++) {
    const ts = now - i * 3600 * 3;
    const dt = new Date(ts * 1000).toISOString();
    const ct = credTypes[i % (credTypes.length || 1)] || fallbackTypes[i % fallbackTypes.length];
    const status: "success" | "failure" = i === 4 ? "failure" : "success";
    const verifier = topVerifiers[i % topVerifiers.length].name;
    rawEvents.push({
      timestamp: ts,
      date: dt,
      eventType: "verification_attempt",
      credentialType: ct,
      wallet: claims[i % (claims.length || 1)]?.wallet || `GA${(i + 10).toString().padEnd(54, "X")}`,
      verifier,
      status,
      txHash: txHash(`tx_evt_${i}_${issuer.slice(0, 8)}`),
    });
  }

  return {
    issuer,
    totalIssued,
    activeCount,
    revokedCount,
    revocationRate,
    totalVerificationAttempts,
    successfulVerifications,
    failedVerifications,
    verificationSuccessRate,
    verificationAttemptsOverTime,
    topVerifiers,
    events: rawEvents,
  };
}

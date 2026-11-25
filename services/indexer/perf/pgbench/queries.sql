-- queries.sql — the pgbench transaction script for the indexer latency gate.
--
-- One transaction per script execution, mixing the four statements the indexer
-- runs most under peak ledger ingestion:
--
--   1. per-wallet claim read       (GET /claims?wallet=, SDK subscriptions)
--   2. keyset-paginated recent page (GET /recent, the hottest read path)
--   3. credential-type aggregate    (GET /stats)
--   4. claim upsert                 (the ingestion write path)
--
-- Statements are written with `?` in db-shared.ts and bound as $1..$n on
-- Postgres; the literal numbers here are the same shapes pgbench can generate
-- from its own variables, so the server sees the same plans either way.
--
-- Wallet values come from the same 'GA' || lpad(i, 54, 'X') construction as
-- perf/pgbench/seed.sql, so lookups hit real rows.

\set w random(1, 50000)

-- 1. Per-wallet read (claimsByWallet)
SELECT wallet, credential_type, issuer, verified_at, expiry,
       ledger_sequence, threshold, revoked, reason_code
  FROM claims
 WHERE wallet = 'GA' || lpad(CAST(:w AS text), 54, 'X');

-- 2. Recent feed, keyset page (recent)
\set l random(1, 5000)
SELECT *
  FROM claims
 WHERE revoked = 0
   AND (ledger_sequence < :l OR (ledger_sequence = :l AND id < 1000))
 ORDER BY ledger_sequence DESC, id DESC
 LIMIT 21;

-- 3. Stats aggregate (stats)
SELECT credential_type,
       COUNT(*)::int                          AS total,
       COUNT(*) FILTER (WHERE revoked = 0)::int AS active,
       COUNT(*) FILTER (WHERE revoked = 1)::int AS revoked
  FROM claims
 GROUP BY credential_type
 ORDER BY total DESC;

-- 4. Ingestion upsert (upsertClaim)
INSERT INTO claims
  (wallet, credential_type, issuer, verified_at, expiry,
   ledger_sequence, threshold, revoked, reason_code)
VALUES ('GA' || lpad(CAST(:w AS text), 54, 'X'), 'kyc', 'GISSUERPERF001',
        1724000000, 1755000000, 5000, 18, 0, 'other')
ON CONFLICT (wallet, credential_type) DO UPDATE SET
  issuer          = EXCLUDED.issuer,
  verified_at     = EXCLUDED.verified_at,
  expiry          = EXCLUDED.expiry,
  ledger_sequence = EXCLUDED.ledger_sequence,
  threshold       = EXCLUDED.threshold,
  revoked         = EXCLUDED.revoked,
  reason_code     = EXCLUDED.reason_code;

-- seed.sql — deterministic dataset for the pgbench latency benchmark.
--
-- The table itself is created by the indexer's own `db.migrate()` (the runner
-- imports dist/db.js), so the benchmark always measures the real schema. This
-- file only fills it: %%ROWS%% claims spread over the credential types the API
-- serves, with unique (wallet, credential_type) pairs so the ingestion upsert
-- path can be exercised against them.
--
-- Wallets are 'GA' || lpad(i, 54, 'X') so pgbench's :w variable can rebuild the
-- same value in SQL without a join table.
INSERT INTO claims
  (wallet, credential_type, issuer, verified_at, expiry,
   ledger_sequence, threshold, revoked, reason_code)
SELECT
  'GA' || lpad(i::text, 54, 'X'),
  (ARRAY['kyc', 'age', 'jurisdiction'])[1 + (i % 3)],
  'GISSUERPERF' || lpad((i % 50)::text, 3, '0'),
  1724000000 + (i * 60),
  1755000000 + (i * 60),
  (i % 5000) + 1,
  CASE WHEN i % 3 = 0 THEN 18 ELSE NULL END,
  CASE WHEN i % 97 = 0 THEN 1 ELSE 0 END,
  'other'
FROM generate_series(1, %%ROWS%%) AS i;

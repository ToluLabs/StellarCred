# pgbench latency regression benchmark

A committed, automated answer to "did this change make the indexer's database
queries slower?" — the Postgres half of #1069.

## What it measures

One pgbench transaction runs the four statements the indexer issues most under
peak ledger ingestion:

| Statement | Indexer path |
|---|---|
| `SELECT … FROM claims WHERE wallet = $1` | `GET /claims?wallet=`, SDK claim subscriptions |
| Keyset page over `(ledger_sequence, id)` with `LIMIT 21` | `GET /recent` |
| `GROUP BY credential_type` with `FILTER (WHERE revoked = …)` | `GET /stats` |
| Insert / `ON CONFLICT … DO UPDATE` on `(wallet, credential_type)` | ingestion `upsertClaim` |

The metrics are mean transaction latency and tps as reported by pgbench. The
gate compares mean latency (not tps) with the committed baseline, because
latency is the signal the issue is about and tps on a shared CI runner is too
noisy to gate on.

## Files

| File | Purpose |
|---|---|
| `queries.sql` | the pgbench transaction script (one mixed read/write transaction) |
| `seed.sql` | deterministic 50k-row dataset; wallets are `'GA' \|\| lpad(i, 54, 'X')` |
| `baseline.json` | committed reference latency + tps, with the workload description |

The `claims` table is **not** defined here. `scripts/pgbench-latency.mjs` imports
`dist/db.js` and calls `db.migrate()`, so the benchmark always runs on the
schema the migrations actually produce — including every index the query paths
depend on.

## Running it

```bash
npm run build
DATABASE_URL=postgres://indexer:indexer@localhost:5432/indexer npm run bench:pgbench

# tune the load / workload size
npm run bench:pgbench -- --clients 16 --seconds 30 --rows 200000

# only exercise the comparison rule (no database)
npm run bench:pgbench:self-test
```

The script seeds the database (truncating `claims`) so runs are comparable, then
writes `perf/pgbench-report.json` (git-ignored; uploaded as a CI artifact).

## The gate

`src/latency-regression.ts` holds the rule, unit-tested in
`src/latency-regression.test.ts`:

```
budget = max(baseline.averageLatencyMs × tolerance, absoluteFloorMs)
```

Defaults are `tolerance = 2.5` and `absoluteFloorMs = 20`; override them with
`--tolerance` / `--floor` or `PGBENCH_TOLERANCE` / `PGBENCH_FLOOR_MS`. The gate
is deliberately generous: a committed baseline is one measurement on one machine,
and a benchmark that fails on jitter gets ignored. It exists to catch a real
regression — a dropped index, an unindexed filter, a plan change — not to police
single-digit percentage differences.

## Re-recording the baseline

Only do this in a PR that changes the measured workload or intentionally accepts
the new cost, and explain why in the PR description:

```bash
DATABASE_URL=… npm run bench:pgbench -- --write-baseline
```

Record it on an idle machine (not while running other builds), with the default
`8` clients / `15` seconds, then commit the updated `baseline.json`.

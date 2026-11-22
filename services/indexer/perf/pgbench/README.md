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
| `seed.sql` | deterministic 50krow dataset; wallets are `'GA' \|\| lpad(i, 54, 'X')` |
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
`--tolerance` / `--floor` or `PGBENCH_TOLERANCE` / `PGBENCH_FLOOR_MS`.

### No committed baseline yet

The shipped `baseline.json` is intentionally a placeholder — it has
`version: 1` and a tiny `averageLatencyMs` so the gate never fails against a
number that was never actually measured. The gate treats `version >= 2` as the
signal that a real baseline has been recorded.

In that `version < 2` case the gate **skips**: it returns a single
`gate-skipped` failure and the runner prints what to do next, then exits
successfully, so CI does not fail on a made-up number. The report still records
the measurement and the skip reason, so the first real run can re-establish the
baseline.

To re-establish it:

1. Run the benchmark on a quiet, transient workload (not a shared CI runner that
   is also running other jobs).
2. Re-record the baseline with `--write-baseline`:

   ```bash
   DATABASE_URL=postgres://indexer:indexer@localhost:5432/indexer \
     npx node scripts/pgbench-latency.mjs --clients 8 --seconds 15 --write-baseline
   ```

3. The runner now writes `version: 2` into the baseline. Commit that file.
4. From the next run on, the gate evaluates against the committed value rather
   than skipping.

Do **not** record a baseline on a busy or shared machine, and do **not** use
`--write-baseline` as a convenient way to silence a regression — that would turn
a real regression into a new committed baseline that hides it.

## Recording a baseline on the CI Postgres container

The CI job runs the benchmark automatically. To record the very first baseline,
run one of these manually:

- Locally against the same Postgres 16 service container used by CI:

  ```bash
  cd services/indexer
  npm run build
  DATABASE_URL=postgres://indexer:indexer@localhost:5432/indexer \
    node scripts/pgbench-latency.mjs --clients 8 --seconds 15 --write-baseline
  ```

  (Commit `version: 2` into `baseline.json`.) This is the exact workload the
  CI job measures, so the recorded number is comparable.

- In-repo, the `baseline.json` is the artefact the gate reads, so once you have
  recorded it locally and committed `version: 2`, the CI job evaluates against
  it.

## Re-recording the baseline

Only do this in a PR that changes the measured workload or intentionally accepts
the new cost, and explain why in the PR description. The runner writes `version:
2` so a spreadsheet of re-recordings is implicit in the baseline history, not
something you have to maintain by hand.

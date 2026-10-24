# Indexer Backfill Guide

> **Issue #611** — Historical indexing for a bounded ledger range.

The live ingester polls for new events and advances a cursor forward in time.
Backfill is the complementary operation: it indexes a *bounded historical
range* as fast as Horizon allows, without touching the live poll loop.

Use backfill when:

- Standing up a new indexer against a contract that has been live for weeks or
  months (the live ingester only picks up events from its configured
  `START_LEDGER` forward).
- Repairing a gap caused by an outage (e.g. the service was down for several
  hours and the cursor jumped past events).
- Migrating to a new database and needing to replay history from genesis.

---

## Quick start

```bash
# Index ledgers 100 000 – 120 000
npm run backfill -- --from 100000 --to 120000

# Index from genesis (ledger 1) to the current network tip
npm run backfill -- --from genesis --to head

# Index from a specific ledger to the current tip (--to defaults to head)
npm run backfill -- --from 500000
```

The command **never starts the live poll loop** — it exits once the range is
complete. The live indexer can run in parallel without interference.

---

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--from <ledger\|genesis>` | Yes | First ledger to index. `genesis` is an alias for ledger 1. Must be ≥ 1. |
| `--to <ledger\|head>` | No | Last ledger to index (inclusive). `head` (default) resolves to the current network tip at startup. Must be ≥ `--from`. |

---

## Progress output

While running, the CLI prints a live progress line:

```
[backfill] 250000/500000 (50%) pages=1250 events=3842 elapsed=4m 10s | 1000.0 ledgers/s | ETA 4m 09s
```

| Field | Meaning |
|-------|---------|
| `currentLedger/toLedger` | How far the backfill has reached vs the target |
| `(%)` | Percentage of the ledger range covered |
| `pages` | Horizon pages fetched so far |
| `events` | Matching contract events processed so far |
| `elapsed` | Wall-clock time since the backfill started |
| `ledgers/s` | Average throughput since start |
| `ETA` | Estimated time to completion at current throughput |

On completion the summary line is:

```
[backfill] complete: ledger 100000 → 120000 | 423 event(s) | 100 page(s) | 12s elapsed | avg 1666.7 ledgers/s
```

---

## Resuming an interrupted backfill

The backfill is **fully resumable**. After every Horizon page the exact page
cursor is saved to the database. If the process is interrupted (Ctrl-C,
SIGTERM, power loss, OOM kill) re-running with the **same `--from`** value
resumes from the last saved cursor — it does not re-fetch already-processed
pages.

```bash
# First run — interrupted at 60 %
npm run backfill -- --from 100000 --to 500000
# ^C

# Second run — picks up exactly where it left off
npm run backfill -- --from 100000 --to 500000
```

Passing a **different `--from`** resets the checkpoint and starts a fresh
backfill from the new start ledger.

### Checkpoint tables

Three DB tables are used exclusively by the backfill subsystem:

| Table | Purpose |
|-------|---------|
| `backfill_checkpoint` | Records the `start_ledger` of the active range so a different `--from` can be detected. |
| `backfill_cursor` | The highest ledger fully processed so far. |
| `backfill_page_cursor` | The opaque Horizon paging cursor for the *current* page, enabling exact mid-page resumption. |

These tables are **separate** from `ledger_cursor` (used by the live
ingester), so a backfill never clobbers live ingestion state.

---

## Graceful interruption

Press **Ctrl-C** (or send `SIGTERM`) at any time. The backfill will:

1. Finish the in-flight Horizon request (up to the 30 s request timeout).
2. Write the page cursor checkpoint to the database.
3. Print a summary showing where it stopped and the exact command to resume.
4. Exit with code **130** (128 + SIGINT), the conventional signal-interrupt
   exit code.

```
[backfill] SIGINT received — finishing current page and checkpointing…
[backfill] interrupted — checkpointed at ledger 234800.
Resume with: npm run backfill -- --from 100000 --to 500000
```

A second Ctrl-C during the drain window forces an immediate exit (the last
page checkpoint written before the interrupt is preserved).

---

## Monitoring a running backfill

### HTTP API

The live indexer HTTP API exposes a `/backfill/status` endpoint that reflects
the last known progress snapshot:

```
GET /backfill/status
```

**No backfill running in this process:**
```json
{ "status": "idle" }
```

**Backfill in progress:**
```json
{
  "status": "running",
  "progress": {
    "fromLedger": 1,
    "toLedger": 5000000,
    "currentLedger": 1250000,
    "eventsProcessed": 8432,
    "pagesProcessed": 6250,
    "percent": 25,
    "elapsedSeconds": 310.5,
    "ledgersPerSecond": 4025.8,
    "etaSeconds": 931,
    "running": true
  }
}
```

**Backfill complete:**
```json
{
  "status": "complete",
  "progress": { "...", "running": false, "percent": 100, "etaSeconds": null }
}
```

> **Note:** The CLI (`npm run backfill`) and the live indexer (`npm start`) are
> separate processes. The `/backfill/status` endpoint only reflects backfills
> started in the *same process* — it shows `idle` in the live indexer unless
> you trigger a backfill programmatically via `ingester.backfill()`.

### Logs

Both the CLI and the ingester emit structured log lines at each page boundary:

```
[indexer] backfill starting: 100000 → 500000 (resume ledger 234800)
[indexer] backfill progress: 240000/500000 (53%) — 3100 event(s) | 998.3 ledgers/s | ETA 262s
[indexer] backfill progress: 280000/500000 (63%) — 3740 event(s) | 1021.4 ledgers/s | ETA 215s
```

---

## Throughput tuning

### `BACKFILL_BATCH_SIZE`

Controls the number of events requested per Horizon page. Default: `200`
(Horizon's maximum). Smaller values reduce memory pressure and increase
checkpoint granularity at the cost of more round-trips.

```bash
BACKFILL_BATCH_SIZE=100 npm run backfill -- --from genesis
```

Valid range: 1–200. Values above 200 are silently capped at 200.

### Timing estimates

Backfill throughput is bounded by Horizon API latency. Typical figures on
Horizon testnet:

| Scenario | Approx. throughput | Approx. time for 5 M ledgers |
|----------|--------------------|------------------------------|
| Public Horizon testnet (shared) | 500–2 000 ledgers/s | 42 min – 2 h 45 min |
| Self-hosted Horizon (same region) | 2 000–8 000 ledgers/s | 10 min – 42 min |

These figures assume a mostly-empty contract history. Contracts with dense
event logs (many events per ledger) are slower because each page covers fewer
ledgers.

**Practical formula:**

```
estimated_seconds = (toLedger - fromLedger) / ledgers_per_second
```

The real-time `ledgers/s` figure in the progress line gives you an accurate
rolling estimate; the ETA field applies it automatically.

---

## Interaction with live ingestion

Backfill and live ingestion use **independent cursor tables** and can run
simultaneously without conflict:

- The live ingester reads/writes `ledger_cursor`.
- The backfill reads/writes `backfill_cursor`, `backfill_checkpoint`, and
  `backfill_page_cursor`.
- Both write to the shared `claims` table via idempotent `UPSERT` statements,
  so processing the same event twice is safe.

Running them in parallel is not recommended for throughput (both compete for
Horizon rate limits), but it is **safe for data correctness**.

---

## Running in Docker / CI

```dockerfile
# In a separate one-off container or init container
CMD ["node", "dist/backfill.js", "--from", "genesis", "--to", "head"]
```

For a Kubernetes Job:

```yaml
- name: backfill
  image: stellarcred/indexer:latest
  command: ["node", "dist/backfill.js"]
  args: ["--from", "genesis"]
  envFrom:
    - secretRef: { name: indexer-env }
```

The job exits 0 on success, 1 on fatal error, and 130 on SIGINT/SIGTERM
interruption. Kubernetes `restartPolicy: OnFailure` will retry on error but
not on clean interruption.

---

## FAQ

**Q: Does backfill affect the live ingester's cursor?**  
A: No. Backfill writes to `backfill_cursor`; the live ingester reads
`ledger_cursor`. They are entirely independent.

**Q: Can I run backfill while the live indexer is running?**  
A: Yes. The writes are idempotent (UPSERT). Horizon rate limits are shared,
so throughput on both sides will be reduced.

**Q: What happens if I change `--to` on a resume?**  
A: The `--to` value is not persisted. Only `--from` is used for range-change
detection. If you resume with the same `--from` but a different `--to`, the
backfill resumes from the saved cursor and stops at the new `--to`. If the
new `--to` is earlier than the checkpointed ledger, the backfill returns
immediately at 100 %.

**Q: The backfill finished but I don't see all expected events. Why?**  
A: Check that `PROOF_REGISTRY_CONTRACT_ID` matches the on-chain contract and
that `STELLAR_NETWORK` matches the network the contract is deployed on.
Also verify your `--from` ledger is at or before the contract's deployment
ledger.

**Q: How do I find the contract's deployment ledger?**  
A: Use Stellar Explorer or query Horizon:  
`GET /contracts/{CONTRACT_ID}/operations?order=asc&limit=1`  
The first operation's `created_at` ledger is the deployment ledger.

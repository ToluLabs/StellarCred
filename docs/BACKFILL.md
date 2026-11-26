# Indexer backfill

The live indexer follows the network head from its saved cursor. Backfill is a
separate, bounded operator command for indexing history the live loop never saw.

## When to backfill

- **New indexer, long-lived contract.** Index from contract deployment to head
  before pointing consumers at the API.
- **Gap repair.** After an outage longer than Horizon's retention or paging
  window, re-index the affected ledger range.

You do not need to stop the live service. Backfill never reads or moves the
live cursor and never enqueues webhooks, so replaying old revocations does not
re-notify integrators. Writes use the same idempotent `upsertClaim` /
`revokeClaim` paths as live ingestion, so overlapping a range the live loop
already covered is safe.

## Usage

```bash
# Explicit range (inclusive)
make backfill FROM=1000000 TO=1200000

# From START_LEDGER (or the earliest ledger Horizon retains) to head
make backfill FROM=genesis

# Continue an interrupted run
make backfill-resume

# Direct invocation, with a custom batch size and checkpoint file
cd services/indexer
npm run backfill -- --from 1000000 --to head --batch-size 100 --checkpoint /var/lib/indexer/backfill.json
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--from` | `genesis` | First ledger to index. `genesis` uses `START_LEDGER`, or the earliest Horizon retains when it is 0. |
| `--to` | `head` | Last ledger to index. Always capped at `head - FINALITY_LAG`. |
| `--batch-size` | `200` | Events per Horizon page (1 to 200). |
| `--resume` | off | Continue from the checkpoint instead of starting a new range. |
| `--checkpoint` | `.backfill-checkpoint.json` | Checkpoint path. Also settable with `BACKFILL_CHECKPOINT`. |

## Progress and resume

Each batch prints one line:

```
[backfill] batch 12: 200 events, through ledger 1043120/1200000 (21.6%, 2400 total)
```

The checkpoint is written atomically after every batch with the range, the
Horizon paging token, the highest completed ledger, and the running total. If a
run is interrupted (Ctrl-C, crash, Horizon outage), `--resume` continues after
the last completed batch without re-fetching it. Starting a new range while an
unfinished checkpoint exists is refused; resume it or delete the file first.

Transient Horizon errors (429, 5xx, network) are retried with exponential
backoff; other errors stop the run with the checkpoint intact.

## Timing

Run time tracks the number of ProofRegistry events in the range, not the number
of ledgers: each request returns up to 200 events. On a rate-limited public
Horizon, budget roughly one request per second; on a dedicated endpoint, the
database write rate is usually the limit.

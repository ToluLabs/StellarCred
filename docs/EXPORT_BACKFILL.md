# Historical Export Backfill & Migration Plan

This document describes how to migrate **legacy proof-history exports** into the
versioned export pipeline introduced for schema-versioned artifacts
([#780](https://github.com/ToluLabs/StellarCred/issues/780)). It covers the
schema, the backfill scripts, the dry-run safety workflow, migration steps,
risks, and estimated resource costs.

Related: the exporter itself lives in
[`frontend/lib/export-history.ts`](../frontend/lib/export-history.ts); the
versioned artifact and the shared validation/convert logic live in
[`frontend/lib/export-schema.ts`](../frontend/lib/export-schema.ts); the CLI is
[`frontend/scripts/backfill-export.ts`](../frontend/scripts/backfill-export.ts).

---

## 1. What is "legacy" vs. "new"

The **legacy export** is the unversioned file users already hold. It has no
schema marker, so a downstream reader cannot tell which format a file is in or
when it was produced.

- Legacy **JSON** (from `exportHistoryAsJson`):
  ```json
  { "exportedAt": "2025-12-01T00:00:00.000Z",
    "entries": [
      { "claimType": "kyc", "verifiedAt": 1700000000,
        "expiry": 1702592000, "txHash": "abc", "issuer": "G…" } ] }
  ```
- Legacy **CSV** (from `exportHistoryAsCsv`), header
  `claim_type,verified_at,expiry,tx_hash,issuer`, with ISO-8601 timestamps and
  an empty `expiry` meaning "unknown".

The **new pipeline** emits a **schema v1 artifact** — the same entries wrapped in
a versioned envelope with **generation metadata** that records when the artifact
was produced, by what, and which legacy format it was backfilled from:

```json
{
  "schemaVersion": 1,
  "generation": {
    "generatedAt": "2026-01-02T03:04:05.000Z",
    "generator": "backfill-export",
    "sourceFormat": "legacy-json",
    "sourceExportedAt": "2025-12-01T00:00:00.000Z"
  },
  "count": 2,
  "entries": [
    { "claimType": "kyc", "verifiedAt": 1700000000, "expiry": 1702592000, "txHash": "abc", "issuer": "G…" }
  ]
}
```

`schemaVersion` follows the same forward-compatibility discipline as the
on-chain `PROOF_RECORD_SCHEMA_VERSION` and the credential envelope: it is **only
ever added to** — a released version is never reinterpreted. A future v2 means a
new `case` in the reader plus a v1→v2 migration, never a silent redefinition.

---

## 2. The backfill script

`pnpm backfill:export` (or `node --import tsx scripts/backfill-export.ts`) reads
one legacy file and writes one schema v1 artifact.

```
node --import tsx scripts/backfill-export.ts --input FILE
     [--output FILE] [--format json|csv] [--generator NAME]
     [--dry-run] [--force]
```

| Flag | Meaning |
| --- | --- |
| `--input` | Legacy export file to read. **Required.** |
| `--output` | Artifact path. Defaults to `<input>.v1.json`. |
| `--format` | Force `legacy-json` / `legacy-csv`. Default: sniff the extension (`.csv` → CSV, else JSON). |
| `--generator` | Producer string stamped into `generation.generator`. Default `backfill-export`. |
| `--dry-run` | Validate and report only — **writes nothing**. |
| `--force` | Permit overwriting an existing `--output`. Off by default. |

**Exit codes:** `0` success (including a dry-run and any run with skipped
entries), `1` input/read/write error or a blocked overwrite, `2` bad usage.
Skipped entries are reported, not fatal, so a whole folder can be triaged in one
dry-run pass.

---

## 3. Safety checks

Every entry passes through `validateEntry` before it can land in an artifact:

- `claimType` must be a non-empty string.
- `verifiedAt` must be a **non-negative integer** unix seconds.
- `expiry` must be a non-negative integer; `0` is allowed as "unknown".
- A non-zero `expiry` must not predate its `verifiedAt`.
- `txHash` / `issuer` must be strings (empty is allowed — submission-log-only
  entries legitimately have neither).

Structural problems throw a `LegacyExportError` and abort the run with exit `1`:
invalid JSON, a missing `exportedAt`/`entries`, or a non-numeric timestamp. A
malformed individual entry is **skipped and reported**, never silently dropped —
a corrupt file cannot poison the new pipeline, and the operator sees exactly
which 1-based entry was rejected and why.

Additional guards at the CLI layer:

- **No silent overwrite** — writing to an existing `--output` is refused unless
  `--force` is passed.
- **Read-only by default** — always run `--dry-run` first; it exercises the full
  validation path and touches no files.

---

## 4. Migration steps

1. **Inventory** the legacy exports to backfill. They are ordinary JSON/CSV
   files; collect their paths.
2. **Dry-run each file** and review the report:
   ```
   pnpm backfill:export -- --input ./exports/stellarcred-history-2025-12-01.json --dry-run
   ```
   Confirm `read / carried / skipped` numbers are what you expect. Investigate
   every `skipped` line before proceeding.
3. **Backfill for real** once the dry-run is clean:
   ```
   pnpm backfill:export -- --input ./exports/stellarcred-history-2025-12-01.json \
        --output ./exports/v1/2025-12-01.json --generator "ops-backfill-v1"
   ```
4. **Validate the artifact** loads under the new pipeline:
   `isExportArtifact(JSON.parse(readFile(out)))` is `true`, and `count === entries.length`.
5. **Archive the originals.** Keep the legacy files until the artifacts are
   confirmed; the artifact is derived data, the original is the source of truth.
6. **Batching.** To process a folder, invoke the script once per file. It is
   single-file by design so a failure isolates to one artifact.

---

## 5. Estimated resource costs

Backfill is **pure local CPU/IO** — no network calls, no on-chain transactions,
no Soroban state rent. A schema v1 artifact is roughly the legacy file plus a
small fixed metadata envelope.

| Dimension | Estimate |
| --- | --- |
| Throughput | Linear in entry count. A Node process converts **tens of thousands of entries/sec**; even a 1 M-entry export converts in seconds. |
| Memory | O(n) — the whole file is parsed in memory. A 100k-entry JSON export is ~10–20 MB in, ~25–40 MB resident; safe well past a million entries on a laptop. |
| Disk | Output ≈ 1.2–1.5× the legacy JSON (2-space pretty JSON + envelope). Size the destination folder at ~1.5× the source set. |
| Time (wall) | Dominated by file IO, not conversion. Practically instantaneous per file for typical exports (hundreds–thousands of entries). |
| Cost | Zero external spend: no RPC reads, no writes to chain, no paid APIs. |

For an unusually large corpus (many millions of entries across thousands of
files), run the per-file conversions sequentially in a loop; process-isolated
single-file runs bound peak memory and keep a bad file from stalling the batch.

---

## 6. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Silent data loss from a parser bug. | Every rejected entry is reported with its 1-based index and reason; dry-run surfaces all of them before anything is written. |
| Overwriting a good artifact by re-running. | Default overwrite guard; requires explicit `--force`. |
| Lossy CSV round-trip (timestamp coercion). | Parser accepts both ISO strings and raw unix numbers, treats empty as `0` (unknown), and never lets `Date.parse` reinterpret a numeric field. Pinned by regression tests. |
| Mislabelled format (wrong `--format`). | Extension sniff is the default; `--format` overrides only when the file is genuinely misnamed. Dry-run echoes the detected `sourceFormat`. |
| Reinterpreting a released schema later. | `schemaVersion` is append-only; changes go through a new version + migration, mirroring the versioning policy in `SUPPORT_POLICY.md`. |
| Legacy source files lost during migration. | Artifacts are derived; originals are the source of truth and are archived until artifacts are verified. |

---

## 7. Rollback

The backfill is non-destructive: it reads legacy files and writes **new**
`--output` artifacts, never mutating the inputs. To roll back, delete the
generated artifacts — the legacy exports are intact and the operation can be
re-run (or re-run against a corrected schema) at any time.

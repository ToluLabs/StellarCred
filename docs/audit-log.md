# Issuance Audit Log (hash-chained, PII-free)

Every credential issuance is recorded in a tamper-evident, privacy-preserving
audit trail. Issuers and auditors can verify that a given commitment was signed
at a given time — without any identity data.

## What gets logged

`POST /api/issue` appends **one entry per signed commitment**. Each entry
contains **only** these non-identity fields:

| Field         | Source                              | PII? |
|---------------|-------------------------------------|------|
| `timestamp`   | `credential.issuedAt` (unix seconds)| No   |
| `requestId`   | opaque request correlation id       | No   |
| `issuer`      | the issuer's registered id/address  | No   |
| `commitment`  | Poseidon2 hash of `[value, salt]`   | No   |
| `index`       | position in the chain               | —    |
| `prevHash`    | digest of the previous entry        | —    |
| `hash`        | digest of this entry                | —    |

**Never logged:** `first_name`, `last_name`, `id_number`, wallet address,
attribute values, or any other identity data. The commitment is a hash — it
reveals nothing about the holder.

## How tampering is detected

The chain works like a blockchain:

```
entry[0].hash = SHA256(timestamp, requestId, issuer, commitment, GENESIS)
entry[1].hash = SHA256(timestamp, requestId, issuer, commitment, entry[0].hash)
entry[2].hash = SHA256(timestamp, requestId, issuer, commitment, entry[1].hash)
```

`GENESIS` is 64 zero hex characters. Because each entry's digest covers the
previous entry's digest, **any** change — editing a commitment, rewriting a
hash, deleting or re-ordering an entry — breaks every subsequent link and is
detected by the verifier. The verifier also refuses entries carrying a
disallowed field (e.g. a tampered file smuggling `first_name` in).

## Verifying the log

```bash
# from frontend/
pnpm verify:audit-log                  # default file (.data/audit-log.jsonl)
pnpm verify:audit-log -- --file PATH   # explicit log file
AUDIT_LOG_PATH=PATH pnpm verify:audit-log
```

Exit codes: `0` = chain intact, `1` = tampering or an unreadable/invalid file,
`2` = bad usage.

```
$ pnpm verify:audit-log
audit log OK: 12 entries, chain intact (.data/audit-log.jsonl)
```

After someone edits a commitment:

```
$ pnpm verify:audit-log
audit log TAMPERED: 12 entries, 3 problem(s) (.data/audit-log.jsonl)
  - entry 3: stored hash 0a9f... does not match recomputed hash c14b...
  - entry 4: prevHash 0a9f... does not match previous entry hash c14b...
  - entry 5: prevHash 0a9f... does not match previous entry hash c14b...
```

## Storage

- Entries are written as **JSON-lines** (one entry per line) to
  `.data/audit-log.jsonl` under the frontend directory by default.
- Override with `AUDIT_LOG_PATH`.
- The chain is bootstrapped from the file at startup, so it continues across
  restarts instead of restarting at index 0.
- The directory is gitignored (runtime data, not source).

## Implementation notes

- Core module: `frontend/lib/audit-log.ts` (hash, append, verify, persist,
  PII-safe parser).
- Wired into `frontend/app/api/issue/route.ts` after successful signing; a
  persistence failure is logged loudly but never fails issuance.
- Like the idempotency and rate-limit stores, the in-memory chain is
  **single-instance**. A horizontally scaled deployment should back the chain
  with shared storage (see `frontend/lib/idempotency.ts` for the same caveat).

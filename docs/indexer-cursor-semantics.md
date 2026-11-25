# Indexer Keyset Pagination and Cursor Semantics

This document specifies the cursor-based pagination contract for the StellarCred indexer HTTP API (`GET /recent`).

## Overview

The indexer exposes recent verified credential claims via keyset (cursor-based) pagination.
Traditional `OFFSET` pagination causes data drift: when new ledgers and claim events are ingested between successive page fetches, offsets shift, causing integrators to observe duplicate rows or miss newly-inserted events entirely.
Additionally, `OFFSET` queries suffer degradation on deep pages because database engines must scan and discard preceding rows.

To guarantee stability, deterministic ordering, and constant-time index access, `GET /recent` employs keyset pagination over the tuple:

`(ledger_sequence DESC, id DESC)`

## Keyset Ordering Keys

1. **`ledger_sequence` (Primary Order - Descending)**:
   - Identifies the Stellar ledger sequence number in which the proof was verified on-chain.
   - Newer ledgers appear first.

2. **`id` (Tie-Breaker - Descending)**:
   - Unique auto-increment database primary key assigned upon insertion.
   - Multiple claims frequently occur within the same ledger. Timestamps are insufficient because all transactions in a ledger share the exact same closing time.
   - The auto-increment `id` guarantees a total, deterministic ordering across claims within the same ledger.

## Exclusive Boundary Semantics

The pagination window evaluates the cursor using strict exclusive inequality:

```sql
WHERE revoked = 0
  AND (ledger_sequence < :cursor_ledger_sequence
       OR (ledger_sequence = :cursor_ledger_sequence AND id < :cursor_id))
ORDER BY ledger_sequence DESC, id DESC
LIMIT :limit + 1
```

- **Exclusive Boundary**: The row referenced by the cursor is excluded from subsequent pages.
- **Limit Handling**: The query fetches `limit + 1` rows to check if subsequent pages exist.
- **Page Size**: The API slices results to `limit` entries. If a subsequent row exists, `nextCursor` is derived from the last item of the current page. If no further rows exist, `nextCursor` is `null`.

## Wire Format and Opaque Token Contract

The `nextCursor` value returned by `GET /recent` is an opaque token:

- Encoded as the `base64url` representation of `<ledger_sequence>:<id>`.
- Example decoded string: `54210089:1420` -> Base64url token: `NTQyMTAwODk6MTQyMA`.
- Integrators and clients must treat `nextCursor` as an opaque token:
  - Do not construct or fabricate cursor strings client-side.
  - Pass the exact returned string back into `GET /recent?cursor=<token>`.
  - Pass no cursor or `cursor=` to start from the newest claims.

## Duplicate Event Handling and Idempotency

- Ledger ingestion handles re-delivered or repeated chain events via idempotent upserts on the unique constraint `(wallet, credential_type)`.
- Updates to existing credentials (such as expiry renewals or reason code updates) update the existing row rather than generating duplicate active entries.
- If an existing claim updates its ledger sequence, it moves to the current ledger position deterministically without corrupting cursor boundaries.

## Stale and Invalid Cursor Behavior

### Stale Cursors
- If ledgers or claims are ingested after a client obtains a cursor, the keyset condition `(ledger_sequence < :seq OR (ledger_sequence = :seq AND id < :id))` continues from the exact coordinates of that cursor.
- Integrators will not see duplicated rows that were already returned on preceding pages.
- If all subsequent records have been pruned or none exist, the API returns `{ claims: [], limit: N, nextCursor: null }` with HTTP 200.

### Invalid Cursors
- If a client supplies a malformed, corrupted, non-base64url, negative, or non-numeric cursor, the API rejects the request immediately with:
  - HTTP Status: `400 Bad Request`
  - Response body: `{"error": "invalid cursor"}`
- The indexer never falls back to page 1 silently on an invalid cursor, preventing silent infinite loops or accidental reprocessing.

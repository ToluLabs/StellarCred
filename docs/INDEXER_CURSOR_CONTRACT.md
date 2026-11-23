# Indexer Cursor Contract

This document specifies the cursor behavior that indexers and integrators can rely on when reading StellarCred claim data or replaying ledger events. It covers ordering keys, boundary semantics, duplicate delivery, and stale/invalid cursors. Event topic and payload schemas remain defined in the single canonical copy at [EVENTS.md](EVENTS.md); this document does not duplicate them.

---

## Scope

| Surface | Cursor input | Purpose |
|---|---|---|
| `GET /recent?limit=&cursor=` | Opaque `nextCursor` from a previous response | Walk the recent active-claim feed, newest first |
| `POST /graphql` (`claims(first, after)`) | Opaque `endCursor` from `pageInfo` | Walk the same feed with filters applied |
| Indexer ingestion (Horizon `GET /contracts/{id}/events`) | Source paging token derived from the last indexed ledger | Resume event ingestion after a restart |

Cursors from these surfaces are **not interchangeable**. A token returned by one endpoint must only be sent back to the same endpoint family (`/recent` and GraphQL share the same encoding but have different validation, as noted below).

---

## Ordering Keys

### Query feeds (`/recent`, GraphQL `claims`)

Rows are ordered by **`(ledger_sequence DESC, id DESC)`** — `ledger_sequence` first, with the monotonically increasing `claims.id` as the tiebreaker for events sharing a ledger. `id` is the stable insertion identity of the indexed row; it is not an event index within the ledger.

- `verified_at`, `ledger_closed_at`, and any other timestamp are **never** ordering keys. Multiple events can share a ledger time, so timestamp-only ordering is explicitly not supported and must not be inferred by clients.
- The ordering is total: two distinct rows cannot compare equal on both keys, so a full traversal visits each row exactly once.
- Revoked claims are excluded from `/recent`; GraphQL applies its requested filters before paging. Filters on `verifiedAfter`/`verifiedBefore` are value filters, not cursor keys.
- The API surface is the contract. The SQL implementation and the internal token format may change; consumers must not depend on either.

### Ingestion (Horizon event stream)

Horizon events are fetched with `order=asc` and a source paging token derived from the persisted last-indexed ledger (`ledger_sequence * 100_000`; on a fresh database, `START_LEDGER * 100_000`). Events whose ledger is above the finality ceiling (`head - FINALITY_LAG`) are filtered out and are not persisted. The stream's own `paging_token`/`ledger`/`ledger_closed_at` fields describe arrival order but do not replace the persisted ledger cursor.

---

## Boundaries

### Read cursors are exclusive

A read cursor identifies the **last row already returned**. The next page contains only rows strictly below that tuple:

```
ledger_sequence < L OR (ledger_sequence = L AND id < I)
```

| Input | Behavior |
|---|---|
| No `cursor` / `cursor=` | First page: newest matching rows |
| `nextCursor` / `endCursor` echoed back | Page starting immediately **after** the boundary row in descending order; that row is not repeated |
| `nextCursor: null` (`/recent`) or `endCursor: ""` with `hasNextPage: false` (GraphQL) | End of traversal; stop paging |

Pages are fetched as `limit + 1` rows and trimmed, so `hasNextPage`/`nextCursor` reflect whether another row exists. `limit` defaults to `20` and is clamped to `100` on `/recent`; GraphQL `first` is clamped to `1..100`. An invalid or out-of-range `limit` falls back to the default rather than failing the request.

Rows inserted at a ledger **newer** than an in-flight cursor do not appear in that traversal; they belong on a fresh first page. Rows inserted at older ledgers are picked up if they sort below the current boundary. This is what makes paging stable while events continue to arrive.

### Time and ingestion boundaries

- GraphQL `verifiedAfter` is inclusive (`>=`), `verifiedBefore` is exclusive (`<`). They constrain eligibility, not the cursor.
- The ingestion token is exclusive at the source token (fetch resumes after it) and the finality ceiling is inclusive (`event ledger <= head - FINALITY_LAG`).
- A reorg (persisted cursor ahead of the network head) rolls back claims with `ledger_sequence > reorgPoint`, resets the cursor to the reorg point, and re-scans. The rollback boundary is strictly greater than the reorg point.

---

## Duplicate Event Handling

- Ingestion is idempotent: `upsertClaim` writes with `ON CONFLICT(wallet, credential_type) DO UPDATE`. Replaying a submitted event refreshes the same claim instead of creating a second row, and a revocation updates that row's `revoked`/`reason_code`.
- The persisted ledger cursor is advanced only after a batch is processed successfully. A failed fetch or a restart replays from the last committed cursor, so duplicate delivery is expected and must be absorbed by the same upsert path.
- Webhook lifecycle notifications derive a stable `event_id` from the event, giving subscription-side deduplication the same replay-safe behavior.
- Read cursors are exclusive, so a correctly echoed token never repeats a row already returned. Clients should still key received claims by `(wallet, credential_type)` when merging pages into local state, because the underlying claim row can be updated (for example, revoked) between page requests.

---

## Stale and Invalid Cursors

### Stale (well-formed but old)

A stale token is a valid keyset boundary; it is **not** expired, rejected, or translated into a fresh page. It keeps returning rows strictly older than its `(ledger_sequence, id)` pair. Rows that arrived after that boundary are intentionally invisible to that traversal — start a new traversal with no cursor to see them. There is no TTL and no `410 Gone` behavior for read cursors; a token from an earlier session remains usable as long as its encoding is valid. Clients that need a current snapshot should restart from page one.

For ingestion, a cursor ahead of the network head is treated as a reorg signal and triggers the rollback/re-scan described above; it is not silently clamped.

### Invalid (malformed or unusable)

| Surface | Behavior |
|---|---|
| `GET /recent?cursor=<malformed>` | `400` with `{ "error": "invalid cursor" }`. Tokens must decode to non-negative integer `ledgerSequence` and positive integer `id`. Empty/omitted cursor means first page. |
| GraphQL `claims(after: <malformed>)` | Decoding is lenient: a malformed `after` is ignored and the first page is returned. No GraphQL error is raised. This asymmetry with `/recent` is intentional and must not be relied on to mask a broken cursor. |
| Cursor from a different endpoint family | Not a supported input; treat the response as undefined and restart the traversal. |

Clients must echo cursor strings verbatim (URL-encoding them when needed), never construct or increment them, and must not assume a token's decoded form will keep its current shape.

---

## Verification

The behavior above is pinned by the existing indexer suites:

- `services/indexer/src/api.test.ts` — newest-first ordering, id tiebreaker within a ledger, exclusive paging, stability when claims arrive mid-traversal, and `400` on a malformed `/recent` cursor.
- `services/indexer/src/db.test.ts` — upsert does not duplicate a claim on replay.
- `services/indexer/src/ingester.test.ts` — reorg detection, rollback, and re-scan from the cursor.
- `services/indexer/src/graphql.ts` behavior via `services/indexer/src/api.test.ts` — GraphQL `first`/`after` paging.

Run them with `npm test` in `services/indexer` (or `make test-indexer` from the repository root). The event-shape assertions in the contract crates are separate and are referenced from [EVENTS.md](EVENTS.md).

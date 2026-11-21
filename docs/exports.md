# Export API — Documentation & Contributor Guide

This document covers the admin export pipeline introduced in issues [#783](https://github.com/ToluLabs/StellarCred/issues/783) and [#784](https://github.com/ToluLabs/StellarCred/issues/784): how to use it, how data is shaped, how security is enforced, and what contributors must know before modifying it.

---

## Table of contents

1. [Overview](#overview)
2. [Authorization](#authorization)
3. [API reference](#api-reference)
4. [Data schema](#data-schema)
5. [Resumable downloads](#resumable-downloads)
6. [Audit log integration](#audit-log-integration)
7. [Retention and storage](#retention-and-storage)
8. [cURL examples](#curl-examples)
9. [SDK / TypeScript examples](#sdk--typescript-examples)
10. [Verification scripts](#verification-scripts)
11. [Contributor checklist](#contributor-checklist)
12. [Testing guidance](#testing-guidance)
13. [Security considerations](#security-considerations)

---

## Overview

The export pipeline lets authorised administrators inspect, revoke, and download credential export artifacts in a tamper-evident, resumable way.

```
ExportRecord store          lib/export-store.ts
  (create / list / get / revoke)
        │ 1-to-1 via shared KV
ExportJob + chunks          lib/export-job-store.ts
  (pre-materialized, persisted in KV)
        │ signed cursor tokens
Chunks endpoint             app/api/admin/exports/[id]/chunks/route.ts
  GET /api/admin/exports/:id/chunks
```

All admin routes are protected by a bearer API key. Every significant action is appended to the hash-chained PII-free audit log.

---

## Authorization

Every `/api/admin/*` endpoint requires:

```
Authorization: Bearer <ADMIN_API_KEY>
```

`ADMIN_API_KEY` is a server-only env var (see `.env.example`). If unset, every admin route returns `401` — safe-by-default. The admin web UI at `/admin/exports` is a Next.js Server Component that calls the store libraries directly on the server; it never exposes the key to the browser.

Cursor tokens for resumable downloads are signed with `EXPORT_CURSOR_SECRET` (falls back to `ADMIN_API_KEY`). Rotating `EXPORT_CURSOR_SECRET` invalidates all in-flight cursors; clients must restart from chunk 0.

---

## API reference

All endpoints return `application/json`. Errors always include `{ "error": string }`.

### List exports

```
GET /api/admin/exports?limit=100
```

| Param | Default | Max | Description |
|-------|---------|-----|-------------|
| `limit` | `100` | `500` | Records to return, most-recent first |

```jsonc
// 200
{ "exports": [ /* ExportRecord[] */ ] }
```

> In multi-instance / serverless deployments the list reflects only records in the current instance's memory cache. Individual records are always retrievable by ID.

### Get single export

```
GET /api/admin/exports/:id
```

```jsonc
// 200
{ "export": { /* ExportRecord */ } }
// 404 — not found
```

### Revoke export

```
POST /api/admin/exports/:id/revoke
Content-Type: application/json
{ "revokedBy": "admin-alice" }
```

Sets `revokedAt` / `revokedBy` on the record and appends an `adminAction: "revoke"` audit entry.

```jsonc
// 200
{ "success": true, "record": { /* ExportRecord */ } }
// 400 — revokedBy missing
// 404 — not found
```

### Read audit chain

```
GET /api/admin/audit?limit=100&issuer=GISS
```

| Param | Default | Max | Description |
|-------|---------|-----|-------------|
| `limit` | `100` | `500` | Entries to return, most-recent first |
| `issuer` | — | — | Case-insensitive substring filter on `issuer` field |

```jsonc
// 200
{
  "entries": [
    {
      "index": 42,
      "timestamp": 1705312800000,
      "requestId": "a1b2c3d4-...",
      "issuer": "GISS...",
      "commitment": "0xabc...",
      "prevHash": "deadbeef...",
      "hash": "cafebabe...",
      "adminAction": "revoke"   // present only on admin events
    }
  ],
  "chainValid": true,
  "errors": []
}
```

`chainValid: false` means the log has been tampered with or truncated — treat it as a security incident.

### Download export (chunked, resumable)

```
GET /api/admin/exports/:id/chunks?cursor=<token>&limit=100
```

| Param | Description |
|-------|-------------|
| `cursor` | Omit on first call (chunk 0). Pass `nextCursor` from each response to advance. |
| `limit` | Rows per chunk (default `100`, max `1000`). Only applies at job creation; ignored on cursor calls. |

```jsonc
// 200 — mid-stream
{
  "jobId": "lz1abc9def",
  "index": 0,
  "totalChunks": 3,
  "chunk": {
    "index": 0,
    "totalChunks": 3,
    "rows": [
      { "id": "rec-1", "field": "issuer",         "value": "GISS..." },
      { "id": "rec-1", "field": "commitment",     "value": "0xabc..." },
      { "id": "rec-1", "field": "credentialType", "value": "kyc" },
      { "id": "rec-1", "field": "requestedAt",    "value": "2026-01-15T10:00:00.000Z" },
      { "id": "rec-1", "field": "revokedAt",      "value": "" },
      { "id": "rec-1", "field": "revokedBy",      "value": "" },
      { "id": "rec-1", "field": "artifactUrl",    "value": "" }
    ]
  },
  "nextCursor": "eyJqIjoibHox...",
  "done": false
}

// 200 — last chunk
{ ..., "nextCursor": null, "done": true }
```

Stop paging when `done === true`. Concatenate `chunk.rows` across indices `0..totalChunks-1` to reconstruct the full export.

| Status | Reason |
|--------|--------|
| `400` | Tampered cursor; cursor bound to a different record; index out of range |
| `403` | Export revoked |
| `404` | Record not found; job gone (TTL/delete); chunk missing — may be transient, retry same cursor |

---

## Data schema

### ExportRecord

All fields are PII-free by design.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique record ID |
| `issuer` | `string` | Stellar issuer address (G…) |
| `commitment` | `string` | Credential commitment hash |
| `credentialType` | `string` | Circuit / claim type (`"kyc"`, `"age"`, …) |
| `requestedAt` | `string` | ISO 8601 creation timestamp |
| `revokedAt` | `string \| null` | ISO 8601 revocation timestamp, or `null` |
| `revokedBy` | `string \| null` | Admin identity that revoked, or `null` |
| `artifactUrl` | `string \| null` | Artifact URL, or `null` |
| `metadata` | `Record<string, string>` | Arbitrary PII-free key/value metadata |

### ExportRow (chunk payload)

`buildExportRows()` in `lib/export-job-store.ts` maps one `ExportRecord` to a fixed ordered row set:

| # | `field` | Notes |
|---|---------|-------|
| 1 | `issuer` | |
| 2 | `commitment` | |
| 3 | `credentialType` | |
| 4 | `requestedAt` | |
| 5 | `revokedAt` | `""` when null |
| 6 | `revokedBy` | `""` when null |
| 7 | `artifactUrl` | `""` when null |
| 8+ | `metadata.<key>` | One row per metadata entry, insertion order |

Null optional fields emit `value: ""` — row count is stable for a given record shape.

### Cursor tokens

```
payloadJson  = JSON.stringify({ j: jobId, i: chunkIndex })
sig          = HMAC-SHA256(EXPORT_CURSOR_SECRET || ADMIN_API_KEY, payloadJson)
token        = base64url(payloadJson) + "." + hex(sig)
```

Cursors are tamper-resistant (HMAC-signed), self-contained (no server lookup needed to verify), and bound to a record (the `jobId` is cross-checked against the path `:id`). A cursor from record A cannot be used against record B's path.

---

## Resumable downloads

On the first call (no cursor) the server materialises an `ExportJob`: it splits the record's rows into chunks and writes each chunk to the shared KV store under `export:job:<jobId>:chunk:<i>`. This happens once; the chunks are immutable thereafter.

Subsequent cursor calls read pre-materialized chunks directly from the KV. Because job state lives in the durable shared KV (not in module-level memory), the same cursor works after a worker restart — memory caches miss, the KV fallback returns the chunk, and the download continues.

A `404 "chunk not found"` can be transient (a KV read error swallowed as a miss). Retry the same cursor; the token is still valid.

---

## Audit log integration

| Trigger | `adminAction` | `commitment` |
|---------|--------------|--------------|
| Export revoked | `"revoke"` | export record ID |
| First chunk served | `"export:chunk"` | export record ID |
| Last chunk served | `"export:chunk:done"` | export record ID |

Intermediate chunk downloads append no audit entries, to avoid flooding the chain for large exports. The `adminAction` field is excluded from the SHA-256 hash input so admin events cannot corrupt issuance chain integrity.

---

## Retention and storage

| Key pattern | Value | Notes |
|-------------|-------|-------|
| `export:record:<id>` | JSON `ExportRecord` | Never deleted (revocation marks, not deletes) |
| `export:job:<jobId>` | JSON `ExportJob` metadata | No TTL currently — follow-up needed |
| `export:job:<jobId>:chunk:<i>` | JSON `ExportChunk` | No TTL currently — follow-up needed |
| `export:job:byrecord:<recordId>` | `jobId` string | |
| `export:cursor:<jobId>` | JSON `CursorHandle` | Observability only |

There is currently no TTL on job/chunk keys. In high-volume production deployments, configure Redis key expiry or a periodic cleanup job.

---

## cURL examples

```bash
export ADMIN_KEY="your-admin-api-key"
export BASE="https://your-deployment.vercel.app"
```

**List recent exports**

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE/api/admin/exports?limit=20" | jq .
```

**Get a single export**

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE/api/admin/exports/lz1abc9def" | jq .
```

**Revoke an export**

```bash
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"revokedBy":"admin-alice"}' \
  "$BASE/api/admin/exports/lz1abc9def/revoke" | jq .
```

**Read the audit chain**

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE/api/admin/audit" | jq '{chainValid:.chainValid, count:(.entries|length)}'
```

**Download a full export (bash pager)**

```bash
RECORD_ID="lz1abc9def"
CURSOR=""

while true; do
  if [ -z "$CURSOR" ]; then
    URL="$BASE/api/admin/exports/$RECORD_ID/chunks"
  else
    ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$CURSOR")
    URL="$BASE/api/admin/exports/$RECORD_ID/chunks?cursor=$ENC"
  fi

  RESP=$(curl -s -H "Authorization: Bearer $ADMIN_KEY" "$URL")
  echo "$RESP" | jq '.chunk.rows[]'

  DONE=$(echo "$RESP" | jq -r '.done')
  CURSOR=$(echo "$RESP" | jq -r '.nextCursor // ""')
  [ "$DONE" = "true" ] && break
done
```

---

## SDK / TypeScript examples

**Download all chunks**

```typescript
async function downloadAllChunks(
  baseUrl: string,
  adminKey: string,
  recordId: string,
  chunkSize = 100,
) {
  const headers = { Authorization: `Bearer ${adminKey}` };
  const rows: Array<{ id: string; field: string; value: string }> = [];
  let cursor: string | null = null;

  for (;;) {
    const url = new URL(`${baseUrl}/api/admin/exports/${recordId}/chunks`);
    if (cursor) url.searchParams.set("cursor", cursor);
    else url.searchParams.set("limit", String(chunkSize));

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`${res.status}: ${err.error ?? res.statusText}`);
    }

    const data = await res.json() as {
      chunk: { rows: typeof rows };
      nextCursor: string | null;
      done: boolean;
    };

    rows.push(...data.chunk.rows);
    cursor = data.nextCursor;
    if (data.done) break;
  }

  return rows;
}
```

**Resumable download with cursor persistence**

```typescript
async function resumableDownload(
  baseUrl: string,
  adminKey: string,
  recordId: string,
  onChunk: (rows: unknown[]) => void,
) {
  const headers = { Authorization: `Bearer ${adminKey}` };
  const storageKey = `export-cursor:${recordId}`;
  let cursor: string | null = sessionStorage.getItem(storageKey);

  for (;;) {
    const url = new URL(`${baseUrl}/api/admin/exports/${recordId}/chunks`);
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), { headers });

    // 404 may be a transient KV read blip — retry once with the same cursor.
    if (res.status === 404 && cursor) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as {
      chunk: { rows: unknown[] };
      nextCursor: string | null;
      done: boolean;
    };

    onChunk(data.chunk.rows);

    if (data.done) {
      sessionStorage.removeItem(storageKey);
      break;
    }

    cursor = data.nextCursor;
    if (cursor) sessionStorage.setItem(storageKey, cursor);
  }
}
```

**Verify audit chain**

```typescript
async function verifyAuditChain(baseUrl: string, adminKey: string) {
  const res = await fetch(`${baseUrl}/api/admin/audit`, {
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  const { chainValid, errors } = await res.json() as {
    chainValid: boolean;
    errors: string[];
  };
  if (!chainValid) throw new Error(`Audit chain invalid: ${errors.join(", ")}`);
  console.log("Audit chain verified.");
}
```

---

## Verification scripts

**Verify audit chain from CLI**

```bash
cd frontend
pnpm verify:audit-log
```

**Verify a cursor token (Node.js)**

```js
// Usage: ADMIN_API_KEY=<key> node scripts/verify-cursor.mjs <token>
import { createHmac } from "node:crypto";

const [,, token] = process.argv;
if (!token) { console.error("Usage: verify-cursor.mjs <token>"); process.exit(1); }

const secret = process.env.EXPORT_CURSOR_SECRET?.trim() || process.env.ADMIN_API_KEY?.trim();
if (!secret) { console.error("Set EXPORT_CURSOR_SECRET or ADMIN_API_KEY"); process.exit(1); }

const dot = token.indexOf(".");
const payloadB64 = token.slice(0, dot);
const sigPart = token.slice(dot + 1);
const pad = payloadB64.length % 4 === 0 ? "" : "=".repeat(4 - (payloadB64.length % 4));
const payloadJson = Buffer.from(
  payloadB64.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64"
).toString("utf8");
const expected = createHmac("sha256", secret).update(payloadJson).digest("hex");

if (sigPart === expected) {
  console.log("✓ Signature valid\nPayload:", JSON.parse(payloadJson));
} else {
  console.error("✗ Signature INVALID — token tampered or wrong secret");
  process.exit(1);
}
```

---

## Contributor checklist

Before opening a PR that touches any file in the export pipeline (`lib/export-store.ts`, `lib/export-job-store.ts`, `lib/export-cursor.ts`, `lib/export-chunks.ts`, `app/api/admin/exports/**`, `app/admin/exports/**`):

- [ ] **PII-free** — no new field on `ExportRecord`, `ExportRow`, `AuditLogEntry`, or any cursor payload contains personally-identifiable information. Run `assertPiiFreeEntry` against any new `AuditLogFields` shape.
- [ ] **Audit log backward-compatible** — new fields on `AuditLogFields` / `AuditLogEntry` must be added to `ALLOWED_ENTRY_KEYS`. Fields that must not affect chain integrity must be excluded from `canonicalEntryFields`. Never change existing hash inputs — that invalidates every deployed chain.
- [ ] **`ExportRecord` interface stable** — adding optional fields is fine; removing or renaming is a breaking change. Update `buildExportRows` and `lib/export-job-store.test.ts` if the shape changes.
- [ ] **Cursor format stable** — the `base64url(payloadJson) + "." + hex(hmac)` format must not change without versioning the token. A format change invalidates all in-flight cursors.
- [ ] **`checkAdminAuth` on every new admin route** — any new route under `app/api/admin/` must call `checkAdminAuth(req)` and return `401` before any other logic. The route integration test must cover the `401` path.
- [ ] **Next.js async params** — the repo is on Next.js 16; dynamic route handlers receive `{ params: Promise<{ id: string }> }`. Always `await params` before destructuring.
- [ ] **Shared-store for durable state** — anything that must survive a worker restart must be written to `getSharedStore()`. Never rely on module-level Maps for state that must persist across requests in a serverless deployment.
- [ ] **Tests pass** — run the export test suite (see [Testing guidance](#testing-guidance)) and confirm all pass.
- [ ] **Type check clean** — `npx tsc --noEmit` from `frontend/` reports zero errors in your touched files.

---

## Testing guidance

### Running export tests

```bash
cd frontend

npx vitest run \
  lib/export-store.test.ts \
  lib/export-job-store.test.ts \
  lib/export-cursor.test.ts \
  lib/export-chunks.test.ts \
  lib/admin-auth.test.ts \
  lib/admin-audit.test.ts \
  "app/api/admin/exports/[id]/chunks/__tests__/route.test.ts"
```

### What each file covers

| File | Key scenarios |
|------|--------------|
| `lib/export-store.test.ts` | create / list / get / revoke records; `__resetExportStoreForTesting` |
| `lib/export-job-store.test.ts` | chunk splitting, per-index retrieval, cursor handle persistence across in-memory reset, `buildExportRows` exact rows and null handling |
| `lib/export-cursor.test.ts` | round-trip sign/verify, tamper rejection, too-short signature (no throw), secret rotation, no-secret path |
| `lib/export-chunks.test.ts` | full paging until done, partial download, **resumed download after simulated restart**, invalid/mismatch/out-of-range cursor, revoke blocks chunk access, `limit` at creation, audit start/done entries with valid chain, no orphan entry on `createCursor` throw, transient chunk-read 404 with same-cursor retry |
| `lib/admin-auth.test.ts` | unset key, empty key, missing header, wrong token, correct token, Bearer case-insensitivity, length mismatch |
| `lib/admin-audit.test.ts` | `assertPiiFreeEntry` allows `adminAction`, audit round-trip, hash unchanged by `adminAction`, tamper detection still works |
| `route.test.ts` (chunks) | `401` on missing/invalid Authorization; `404` when key is valid but record unknown |

### Simulating a restart in tests

The resumability tests clear module-level caches without touching the shared store:

```typescript
import { __resetExportStoreForTesting } from "@/lib/export-store";
import { __resetExportJobStoreForTesting } from "@/lib/export-job-store";

// simulate worker restart
__resetExportStoreForTesting();
__resetExportJobStoreForTesting();
// shared store is untouched — cursors and chunks survive
```

---

## Security considerations

**Authentication** — all admin routes require a bearer token checked with a constant-time comparison to prevent timing oracle attacks (`lib/admin-auth.ts`). A missing or misconfigured `ADMIN_API_KEY` results in `401` for every request, never silent pass-through.

**Cursor integrity** — cursor tokens are HMAC-SHA256 signed. The signature is verified with a length pre-check before `timingSafeEqual` to prevent a `RangeError` on truncated signatures. `verifyCursor` never throws — any unexpected error returns `{ ok: false }`.

**Record binding** — the `jobId` embedded in a cursor is cross-checked against the path `:id` on every request. A cursor for one record cannot be replayed against a different record's endpoint.

**Revocation** — `record.revokedAt` is the sole source of revocation state. Once set, the revoke endpoint and the chunks endpoint both check it before any other logic. There is no separate "job revocation" state — revocation of the record blocks all chunk access immediately.

**PII** — all stored and audited data is PII-free by design. `ExportRecord` fields hold identifiers and hashes, not personal data. The audit log's `assertPiiFreeEntry` check enforces this at write time. Cursor tokens encode only `{ jobId, chunkIndex }`.

**Audit tamper detection** — the hash-chained audit log detects any post-write modification. `GET /api/admin/audit` returns `chainValid: false` when the chain fails verification. The `adminAction` field is excluded from the hash input so admin events coexist with issuance events in one chain without altering existing hash values.

**Secret rotation** — rotating `EXPORT_CURSOR_SECRET` invalidates all in-flight cursor tokens. Clients receive `400 "invalid cursor signature"` and must restart their download from chunk 0. Coordinate rotations with active download sessions or accept the restart cost.

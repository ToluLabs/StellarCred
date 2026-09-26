# StellarCred Indexer Service

An event ingestion and query service for StellarCred's on-chain Soroban contracts.

The indexer continuously polls Soroban contract events emitted by `ProofRegistry` (and other registry contracts), ingests them into a local database (SQLite or PostgreSQL), and exposes a lightweight read-only HTTP API for client applications, wallets, and community explorers.

---

## Features

- **Soroban Contract Event Ingestion**: Monitors ledger events (`submitted`, `revoked`, `paused`, `unpaused`) according to the authoritative [EVENTS.md](../../EVENTS.md) schema and maintains verified claim state per wallet.
- **Pluggable Database Storage**: Supports SQLite (for local development and single-instance deployments) and PostgreSQL (for production multi-instance deployments).
- **CORS Policy**: Configurable origin allowlisting (`CORS_ORIGIN` / `CORS_ALLOWED_ORIGINS`) with secure default-deny in production.
- **Per-IP Rate Limiting**: Built-in fixed-window rate limiting responding with HTTP `429 Too Many Requests` and `Retry-After` headers.
- **Zero Identity Exposure**: Ingests and stores only public on-chain commitments and verification metadata. No user identity fields are stored or processed.

---

## Contract Events Reference

For the authoritative specification of all contract events, topic tuples, payload structures, and drift-prevention guarantees across all StellarCred contracts, see [EVENTS.md](../../EVENTS.md) (or [docs/EVENTS.md](../../docs/EVENTS.md)).

---

## Security & Architecture

### CORS Configuration
Cross-Origin Resource Sharing (CORS) is enforced via `CORS_ORIGIN` (or `CORS_ALLOWED_ORIGINS`):
- **Development**: Defaults to `http://localhost:3000` when unset.
- **Production**: Defaults to same-origin / default-deny when unset.
- **Custom Origins**: Supply comma-separated origins (e.g. `https://stellarcred.app, https://app.stellarcred.xyz`) or `*` for public access.

### Rate Limiting
To prevent scraping and denial-of-service, all HTTP endpoints are protected by per-IP rate limiting:
- **Default limits**: 120 requests per 60-second window per IP.
- **Headers included**:
  - `RateLimit-Limit`: Maximum requests permitted within the window.
  - `RateLimit-Remaining`: Remaining request quota in the current window.
  - `RateLimit-Reset`: Number of seconds until the rate limit window resets.
- **429 Response**: When the quota is exceeded, the server returns status `429` with a `Retry-After: <seconds>` header and `{ "error": "too many requests", "retryAfter": <seconds> }`.

### Authentication & API Key Policy
- **Decision**: Public read endpoints (`/health`, `/claims`, `/stats`, `/recent`) do **not** require API keys.
- **Rationale**: The indexer provides read access to public, non-sensitive blockchain state. Requiring API keys for reads would introduce friction for decentralized dApp frontends, community explorers, and wallet integrations. Abuse resistance is achieved via per-IP rate limiting and CORS policy rather than API key gating.

---

## HTTP API Endpoints

All responses are JSON. Only `GET` and `OPTIONS` methods are supported (no write endpoints).

### 1. `GET /health`
Returns the operational health of the indexer and the last processed ledger sequence.
```json
{
  "status": "ok",
  "lastLedger": 1234567
}
```

### 2. `GET /claims?wallet=G...`
Retrieves all recorded credential claims (active and revoked) for a Stellar wallet address.
```json
{
  "wallet": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "claims": [
    {
      "wallet": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "credential_type": "kyc",
      "issuer": "GISSUER...",
      "verified_at": 1724000000,
      "expiry": 1755000000,
      "ledger_sequence": 1234560,
      "threshold": null,
      "revoked": 0
    }
  ]
}
```

### 3. `GET /stats`
Returns aggregated claim counts grouped by credential type.
```json
{
  "stats": [
    {
      "credential_type": "kyc",
      "total": 150,
      "active": 145,
      "revoked": 5
    }
  ]
}
```

### 4. `GET /recent?limit=20&cursor=<opaque>`
Returns recent active (non-revoked) verified claims, newest first.

Pagination is **keyset (cursor) based** — ordered by `(ledger_sequence, id)` and
driven by the opaque `nextCursor` returned with each page, so the feed stays
stable (no duplicates or skipped rows) while new claims are ingested between
requests, and there is no OFFSET skip cost on large tables. Omit `cursor` for
the first page; a `null` `nextCursor` means there are no more claims. `limit`
(default `20`, clamped to a max of `100`) controls the page size.

```json
{
  "claims": [...],
  "limit": 20,
  "nextCursor": "MTA6MTI="
}
```

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DB_DRIVER` | Database driver (`sqlite` or `postgres`) | `sqlite` |
| `SQLITE_PATH` | Path to SQLite database file | `./data/indexer.db` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `RPC_URL` | Soroban RPC endpoint URL | `https://soroban-testnet.stellar.org` |
| `HORIZON_URL` | Stellar Horizon endpoint URL | `https://horizon-testnet.stellar.org` |
| `PROOF_REGISTRY_CONTRACT_ID` | Deployed `ProofRegistry` contract address | *(Required)* |
| `POLL_INTERVAL_SECONDS` | Polling interval in seconds | `6` |
| `START_LEDGER` | Ledger sequence to start indexing from | `0` |
| `PORT` | HTTP API port | `3001` |
| `CORS_ORIGIN` | Allowed CORS origins (comma-separated or `*`) | `http://localhost:3000` (dev) / Deny (prod) |
| `RATE_LIMIT_WINDOW_SECONDS` | Rate limit window duration | `60` |
| `RATE_LIMIT_MAX` | Max requests per IP per window | `120` |
| `RATE_LIMIT_ENABLED` | Enable or disable rate limiting (`true`/`false`) | `true` |

---

## Database Backend Selection & Tradeoffs

The indexer is a thin storage layer over one of two backends, selected at
startup with the `DB_DRIVER` environment variable:

| `DB_DRIVER` | Engine          | Connection config            | Best for |
|---|---|---|---|
| `sqlite` (default) | better-sqlite3 (`journal_mode=WAL`) | `SQLITE_PATH` | local dev, demos, single-instance / hobby deployments |
| `postgres` | node-postgres pool | `DATABASE_URL` | production multi-instance deployments |

**How selection works.** `loadConfig()` reads `DB_DRIVER` (defaulting to
`sqlite`) and validates it. `createDb()` then returns the matching adapter and
runs the schema migrations for that engine. `DATABASE_URL` **must** be set
when `DB_DRIVER=postgres` (and is ignored by the SQLite adapter). Everything
above the adapter — the ingester and the HTTP API — is backend-agnostic and
talks only to the `Db` interface, so adding a new backend means implementing
that interface, not touching the business logic.

**Tradeoffs.**

- **Operational scale** — SQLite is embedded in the process (zero
  infrastructure,  single file, WAL for concurrent readers) and is perfect for
  local development and single-instance nodes. Postgres is a standalone
  service that supports concurrent writers and many readers, which is what a
  multi-instance / horizontally-scaled deployment needs.
- **Concurrency** — SQLite allows a single writer process; if you run more than
  one indexer instance against the same SQLite file you can corrupt/resolve the
  cursor incorrectly. Postgres serializes writes with row-level locking and a
  shared cursor row.
- **Operational tooling** — Postgres gives you replication, backups, managed
  hosting, and point-in-time recovery out of the box; SQLite needs your own
  file-backup strategy.
- **Dependency footprint** — SQLite (via `better-sqlite3`) adds a native
  module to `node_modules`; the Postgres driver (`pg`) is pure JS. Choose the
  default (`sqlite`) unless you actually need Postgres's scaling and tooling.

> **Recommendation:** run `sqlite` in development and single-instance
> production; enable `postgres` only when you need multiple reader/writer
> instances or managed database tooling.

**Testing both backends.** The worker test suite runs the **same DB test
matrix against SQLite and Postgres** (`src/db.test.ts`). Coverage includes
schema migrations (idempotency), ledger-cursor updates, claim upserts,
revokes, `claimsByWallet`, `stats`, paginated `recent`, `deleteClaimsAfter`
and `getMaxClaimLedger`. The SQLite leg always runs locally; the Postgres leg
runs in CI (via the `postgres` service container in `.github/workflows/ci.yml`)and locally whenever `TEST_POSTGRES_URL` (or `DATABASE_URL`) points at a live
Postgres, and is skipped otherwise:

```bash
# SQLite leg only (no Postgres reachable):
npm test

# Both legs, against a local Postgres, e.g. `docker run ... -p 5432:5432 postgres`: 
TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/db npm test
```

Because the two engines use different SQL dialects (`INSERT OR IGNORE` vs
`ON CONFLICT`, `INTEGER` vs `BIGINT`), the matrix is exactly where silent
cross-backend divergences surface (e.g. Postgres returning `BIGINT` columns as
strings) — running it on both is how we keep either backend from rotting.

---

## Consistency, Finality & Reorg Guarantees

- **Cursor Progression**: The indexer stores the last successfully processed ledger sequence in database metadata. In the event of a restart, ingestion resumes seamlessly from the saved checkpoint without skipping events.
- **Idempotency**: Ingested events and claim records are keyed by `(contract_id, topic, ledger_sequence, tx_hash)`, making replays and repeated ingestion fully idempotent.
- **Finality**: Stellar consensus achieves deterministic single-slot finality (~5 seconds per ledger). By polling confirmed ledgers via Soroban RPC `getEvents`, the indexer avoids unconfirmed/mempool race conditions.

---

## Development & Testing

```bash
# Install dependencies
npm install

# Run unit and integration tests (SQLite by default; add TEST_POSTGRES_URL
# to also exercise the Postgres backend — see "Database Backend Selection")
npm test

# Build TypeScript to dist/
npm run build

# Start the indexer
npm start
```

---

## Docker & Container Deployment

### Build & Run Container

```bash
docker build -t stellarcred-indexer services/indexer
docker run -p 3001:3001 \
  -e PROOF_REGISTRY_CONTRACT_ID=C... \
  -e RPC_URL=https://soroban-testnet.stellar.org \
  stellarcred-indexer
```

### Docker Compose
You can run the indexer alongside PostgreSQL and other services via the root `docker-compose.yml`:

```bash
docker compose up indexer
```

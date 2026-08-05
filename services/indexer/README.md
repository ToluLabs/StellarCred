# StellarCred Indexer Service

A lightweight indexer service that ingests `ProofRegistry` events from the Stellar Horizon API into a queryable local database (SQLite for development, PostgreSQL for production) and exposes a read-only, public-data-only API.

## Features

- **Idempotent Ingestion**: Tracks the last fully processed ledger. Safe to restart; it resumes exactly where it left off.
- **Public Data Only**: Indexes only public chain data: wallet address, credential type, issuer, expiry, ledger sequence, and revoked flag. No identity fields are stored.
- **Zero-State Blockchain Synchronization**: Does not mutate chain state; simply provides a fast query layer on top of on-chain verification events.

## API Endpoints

All endpoints are read-only and return JSON. No authentication is required.

- `GET /health`
  Returns the health status and the `lastLedger` ingested.
- `GET /claims?wallet=<address>`
  Returns all claims (active and revoked) for a given wallet address.
- `GET /stats`
  Returns aggregate counts of active, revoked, and total verifications per credential type.
- `GET /recent?limit=20&page=1`
  Returns the most recent active verifications (paginated).

## Running the Indexer

The indexer is configured to run out-of-the-box via Docker Compose alongside the frontend.

```bash
# In the repository root
docker compose up indexer
```

### Running Locally (Development)

1. Navigate to the indexer directory:
   ```bash
   cd services/indexer
   ```
2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
3. Set your environment variables (copy `.env.example` to `.env` and fill it out).
4. Start the service:
   ```bash
   npm start
   # Or for development: npm run dev
   ```

### Database Configuration

- **SQLite (Default)**: Set `DB_DRIVER=sqlite` (default) and configure `SQLITE_PATH` (e.g. `./data/indexer.db`).
- **PostgreSQL**: Set `DB_DRIVER=postgres` and provide the full connection string via `DATABASE_URL`.

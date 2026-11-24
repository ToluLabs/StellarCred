# Indexer Database Backup, Restore, and Migration Recovery (#1002)

This document provides tested, production-grade procedures for database backups, restores, and schema migration recoveries for the StellarCred indexer service across both supported database backends (`sqlite` and `postgres`).

---

## 1. Architecture Overview

The indexer supports two database backends configured via `DB_DRIVER`:
- `sqlite`: Single-node embedded database using `better-sqlite3` with WAL mode enabled.
- `postgres`: Production multi-instance database accessed through connection pooling.

Both backends share a unified schema (`services/indexer/src/db-schema.ts`) and execute identical query logic (`services/indexer/src/db-shared.ts`).

### Startup Compatibility Guard
The indexer enforces schema compatibility via a singleton `schema_version` table.
- Before applying migrations or starting ingestion, the indexer queries `schema_version`.
- If the persisted schema version is newer than the version supported by the indexer binary (`CURRENT_SCHEMA_VERSION`), the service halts immediately with a clear error:
  ```
  Database schema version X is newer than supported indexer version Y. Migration or startup refused to preserve last known good data.
  ```
This guard prevents older binaries or accidental rollbacks from corrupting newer schemas.

---

## 2. SQLite Procedures

### 2.1 Online Backup
Because SQLite operates in WAL (Write-Ahead Logging) mode, simply copying `indexer.db` while active can capture inconsistent WAL frames. Use either the programmatic backup method or the CLI `.backup` command:

#### Programmatic / In-Process Backup:
```typescript
import { createDb } from "./db";
import { loadConfig } from "./config";

const db = createDb(loadConfig());
await db.backup("/var/backups/stellarcred/indexer-backup-$(date +%s).db");
await db.close();
```

#### CLI Hot Backup:
```bash
sqlite3 /data/indexer.db ".backup '/var/backups/stellarcred/indexer-backup-$(date +%s).db'"
```

### 2.2 Restore Procedure
To restore from a backup:
1. Stop the indexer service:
   ```bash
   systemctl stop stellarcred-indexer
   ```
2. Archive the current database and WAL files:
   ```bash
   mv /data/indexer.db /data/indexer.db.corrupt
   rm -f /data/indexer.db-wal /data/indexer.db-shm
   ```
3. Copy the backup file into place:
   ```bash
   cp /var/backups/stellarcred/indexer-backup-latest.db /data/indexer.db
   ```
4. Verify database integrity:
   ```bash
   sqlite3 /data/indexer.db "PRAGMA integrity_check;"
   ```
5. Restart the indexer:
   ```bash
   systemctl start stellarcred-indexer
   ```

---

## 3. PostgreSQL Procedures

### 3.1 Backup (Logical Snapshot)
Use `pg_dump` with custom format (`-Fc`) for atomic, compressed backups:

```bash
pg_dump -Fc -d "$DATABASE_URL" -f "/var/backups/stellarcred/indexer-pg-$(date +%s).dump"
```

For scheduled cron backups:
```bash
0 2 * * * pg_dump -Fc -d "$DATABASE_URL" -f "/var/backups/stellarcred/indexer-pg-$(date +\%F).dump"
```

### 3.2 Restore Procedure
To restore into a clean or existing database:
1. Stop all indexer instances to terminate active connections:
   ```bash
   systemctl stop stellarcred-indexer
   ```
2. Restore using `pg_restore` with transaction cleanliness:
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" "/var/backups/stellarcred/indexer-pg-latest.dump"
   ```
3. Verify table contents and last indexed ledger:
   ```bash
   psql "$DATABASE_URL" -c "SELECT * FROM ledger_cursor WHERE id = 1;"
   psql "$DATABASE_URL" -c "SELECT * FROM schema_version WHERE id = 1;"
   ```
4. Restart indexers:
   ```bash
   systemctl start stellarcred-indexer
   ```

---

## 4. Schema Migration Recovery & Troubleshooting

### Idempotent Migrations
All indexer migrations (`db.migrate()`) are strictly idempotent:
- Table definitions use `CREATE TABLE IF NOT EXISTS`.
- Cursor and version seeds use `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`.
- Upgrades like `claims.id` keyset columns run inside atomic transactions.

### Recovering from an Interrupted Migration
If a migration is interrupted by SIGINT, network failure, or process crash:
1. Check the logs for the exact point of interruption.
2. In SQLite: WAL atomic transactions automatically roll back partial uncommitted DDL/DML. Re-run `npm run start` or `db.migrate()` directly.
3. In PostgreSQL: Schema migrations run inside transactions; if interrupted, the transaction aborts cleanly.
4. Verify schema version:
   ```sql
   SELECT version, applied_at FROM schema_version WHERE id = 1;
   ```
5. If the indexer was upgraded and needs to be rolled back to an older version:
   - Restore the database snapshot taken immediately prior to the upgrade.
   - Do not attempt to run an older indexer binary against a newer schema; the startup compatibility check will deliberately prevent execution to prevent data corruption.

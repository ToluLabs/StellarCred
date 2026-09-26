# StellarCred Contract Upgrade & Migration Runbook

## Overview

This runbook documents the safe, transparent upgrade process for StellarCred smart contracts on Stellar. The system supports zero-downtime upgrades with comprehensive versioning, audit trails, and rollback capabilities.

**Key Principles:**
- All contract versions are exposed on-chain and in the app footer
- Events emit detailed version information for audit trails
- Data migrations are tracked with timestamps
- Rollback procedures are documented for each scenario
- WASM hash verification prevents silent deployment failures

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Pre-Upgrade Checklist](#pre-upgrade-checklist)
3. [Contract Upgrade Procedure](#contract-upgrade-procedure)
4. [Verification Steps](#verification-steps)
5. [Data Migration Strategy](#data-migration-strategy)
6. [Rollback Procedures](#rollback-procedures)
7. [Monitoring & Alerts](#monitoring--alerts)
8. [Troubleshooting](#troubleshooting)
9. [Version Compatibility Matrix](#version-compatibility-matrix)

---

## Architecture Overview

### Contract Version System

Each contract exposes a `version()` query endpoint returning a semantic version encoded as `u32`:
```
Encoding: (major * 1000000) + (minor * 1000) + patch
Example:  1.2.3 → 1002003
```

**Contracts & Current Versions:**
- `credential_verifier`: 1.0.0
- `proof_registry`: 1.0.0
- `issuer_registry`: 1.0.0
- `gated_pool`: 1.0.0

### On-Chain Version Tracking

**ProofRegistry Data Schema Versioning:**
- `PROOF_RECORD_SCHEMA_VERSION = 1` (current)
- Tracked in persistent storage for forward-compatible migrations
- Migration timestamp recorded for audit trail

**Upgrade Events:**
- `EventContractUpgraded`: Emitted on contract WASM replacement
- `EventVkSet`: Includes `version` and `contract_version` for VK registration
- `EventVkPruned`: Includes `version` and `contract_version` for VK removal

### Frontend Version Display

The app footer displays:
- **App Version**: `NEXT_PUBLIC_APP_VERSION` env var (default: "dev")
- **SDK Version**: 0.1.1 (from `frontend/packages/sdk/package.json`)
- **Contract Versions**: Fetched from `/api/ready` endpoint

The `/api/ready` endpoint returns:
```json
{
  "ready": true,
  "app_version": "1.0.0",
  "contract_versions": {
    "proofRegistry": {
      "address": "CA...",
      "version": "1.0.0",
      "status": "ok"
    },
    ...
  }
}
```

---

## Pre-Upgrade Checklist

Before upgrading any contract:

### 1. Planning & Testing
- [ ] Identify which contract(s) need upgrading
- [ ] Document the reason for upgrade (bug fix, feature, breaking change)
- [ ] Determine if MAJOR, MINOR, or PATCH version bump applies
- [ ] Build and test new WASM locally: `stellar contract build`
- [ ] Run contract tests: `cargo test -p <contract_name>`
- [ ] Record new WASM hash: `sha256sum target/wasm32-unknown-unknown/release/<contract>.wasm`

### 2. Data Migration Planning
- [ ] For data-affecting upgrades: Plan ProofRecord or other structure changes
- [ ] If changing ProofRecord: Update `PROOF_RECORD_SCHEMA_VERSION`
- [ ] Document migration logic in contract code
- [ ] Estimate data migration time and impact on users
- [ ] Prepare rollback data snapshots (contract state exports)

### 3. Dependency Verification
- [ ] Verify no breaking changes in contract interfaces (ABI)
- [ ] Check if external systems depend on this contract
- [ ] Notify frontend team of any API changes
- [ ] Update SDK if needed: `frontend/packages/sdk/package.json`

### 4. Deployment Preparation
- [ ] Update `Cargo.toml` version for the contract
- [ ] Update `CONTRACT_VERSION` constant in contract code
- [ ] Prepare deployment script with new WASM hash
- [ ] Set deployment window (preferably low-traffic time)
- [ ] Notify stakeholders of upgrade window

---

## Contract Upgrade Procedure

### Step 1: Build New WASM

```bash
# From repo root
stellar contract build

# Verify WASM was created
ls -lh target/wasm32-unknown-unknown/release/<contract_name>.wasm
```

### Step 2: Record WASM Hash

```bash
# Compute SHA-256 hash (for verification)
sha256sum target/wasm32-unknown-unknown/release/<contract_name>.wasm

# Example output:
# a1b2c3d4e5f6... target/wasm32-unknown-unknown/release/proof_registry.wasm

# Save this hash for verification step
export WASM_HASH="a1b2c3d4e5f6..."
```

### Step 3: Update Version in Cargo.toml

Edit `contracts/<contract_name>/Cargo.toml`:

```toml
[package]
name = "<contract_name>"
version = "1.1.0"  # Bump version (MAJOR.MINOR.PATCH)
```

Update `CONTRACT_VERSION` constant in `src/lib.rs`:

```rust
// For version 1.1.0:
const CONTRACT_VERSION: u32 = 1_001_000; // 1.1.0
```

### Step 4: Call Upgrade Endpoint

For **ProofRegistry** and **CredentialVerifier** (which have `upgrade()` methods):

```bash
# Set environment
export ADMIN="<admin_address>"
export SOURCE="<admin_key_name>"
export NETWORK="testnet"

# Get new WASM hash (as Bytes32)
export NEW_WASM_HASH="a1b2c3d4e5f6..."  # 64-char hex string

# Call ProofRegistry.upgrade()
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$SOURCE" --network "$NETWORK" \
  --send yes \
  -- upgrade \
  --new_wasm_hash "$NEW_WASM_HASH"
```

This will:
1. Emit `EventContractUpgraded` event
2. Update contract WASM on-chain
3. Record upgrade timestamp in `LastUpgradeTimestamp`

For **other contracts** (IssuerRegistry, GatedPool):
- These contracts don't expose an `upgrade()` method
- Use `env.deployer().update_current_contract_wasm(hash)` indirectly through Stellar protocol
- Or add `upgrade()` method following the same pattern as ProofRegistry

### Step 5: Verify Deployment

See [Verification Steps](#verification-steps) section below.

---

## Verification Steps

### Step 1: Check Contract Version On-Chain

```bash
# Query new contract version
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- version

# Expected output: 1001000 (for version 1.1.0)
# Decode: major=1, minor=1, patch=0
```

### Step 2: Verify WASM Hash

```bash
# Check contract info (if available through Stellar CLI)
stellar contract info --id "$PROOF_REGISTRY_ID"

# Compare WASM hash from deployment:
# - New hash recorded during build
# - Hash stored in contract events (EventContractUpgraded)
# - Hash verifiable on-chain

# Command to export contract state (if needed):
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- last_upgrade_timestamp

# Should return recent timestamp (current ledger time)
```

### Step 3: Check Readiness Endpoint

```bash
# Hit the /api/ready endpoint
curl https://app.example.com/api/ready

# Expected response:
{
  "ready": true,
  "signer": { "status": "ok", "issuer": "configured" },
  "contracts": { "status": "ok" },
  "contract_versions": {
    "proofRegistry": {
      "address": "CA...",
      "version": "1.1.0",
      "status": "ok"
    },
    ...
  },
  "app_version": "1.0.0"
}
```

### Step 4: Verify Contract Functionality

```bash
# Test critical path (e.g., proof submission for ProofRegistry)
# Submit a test proof and verify it works:

stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$HOLDER" --network "$NETWORK" \
  --send yes \
  -- submit_proof \
  --holder "$HOLDER" \
  --issuer_id "$ISSUER" \
  --credential_type "kyc" \
  --proof "<proof_bytes>" \
  --public_inputs "<public_inputs_bytes>" \
  --vk_version 1 \
  --expiry <future_timestamp>

# Should succeed without error
```

### Step 5: Check Event Logs

```bash
# Query recent events for upgrade event
# Use Soroban testnet explorer or local indexer:
# Look for EventContractUpgraded with:
# - Topics: (symbol_short!("proof_reg"), symbol_short!("upgraded"))
# - Payload: { admin, new_wasm_hash, upgraded_at, from_version, to_version }
```

### Step 6: Frontend Version Display

1. Open app footer and click version indicator
2. Verify version drawer shows:
   - App version matches `NEXT_PUBLIC_APP_VERSION`
   - SDK version is 0.1.1
   - Contract versions show 1.1.0 (or new version)

---

## Data Migration Strategy

### Scenario 1: Adding Fields to ProofRecord

**Current Structure (Schema Version 1):**
```rust
pub struct ProofRecord {
    pub verified_at: u64,
    pub expiry: u64,
    pub threshold: Option<u64>,
    pub revoked: bool,
    pub issuer: Option<Address>,
    pub vk_version: u32,
}
```

**If Adding New Field:**

1. Update struct in contract:
```rust
pub struct ProofRecord {
    pub verified_at: u64,
    pub expiry: u64,
    pub threshold: Option<u64>,
    pub revoked: bool,
    pub issuer: Option<Address>,
    pub vk_version: u32,
    pub new_field: u64,  // NEW FIELD
}
```

2. Increment schema version:
```rust
const PROOF_RECORD_SCHEMA_VERSION: u32 = 2;
```

3. Create migration function:
```rust
pub fn migrate_data(env: Env) {
    let admin = Self::require_admin(&env);
    
    // Iterate all proofs (expensive but necessary)
    // For each proof with schema version 1:
    //   - Read old ProofRecord
    //   - Add default value for new_field
    //   - Write updated ProofRecord
    
    // Update schema version
    env.storage().instance().set(
        &DataKey::ProofRecordSchemaVersion,
        &PROOF_RECORD_SCHEMA_VERSION
    );
    
    env.storage().instance().set(
        &DataKey::LastMigrationTimestamp,
        &env.ledger().timestamp()
    );
}
```

4. Call migration after deployment:
```bash
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  --send yes \
  -- migrate_data
```

### Scenario 2: Removing Fields

**NOT RECOMMENDED** - Use deprecation flags instead:
```rust
pub struct ProofRecord {
    pub verified_at: u64,
    pub expiry: u64,
    pub threshold: Option<u64>,
    pub revoked: bool,
    pub issuer: Option<Address>,
    pub vk_version: u32,
    #[deprecated]  // Mark as deprecated, don't remove
    pub old_field: Option<u64>,
}
```

### Scenario 3: Structural Changes (Breaking)

For major breaking changes:
1. Deploy new contract alongside old one (separate contract ID)
2. Provide migration period where both accept submissions
3. Plan data export/import process
4. Coordinate with frontend to support both contract IDs temporarily

---

## Rollback Procedures

### Quick Rollback (< 1 hour from deployment)

**If deployment is unsuccessful:**

1. **Identify the issue:**
```bash
# Check readiness endpoint
curl https://app.example.com/api/ready
# Look for error status

# Check contract events for errors
stellar events --id "$PROOF_REGISTRY_ID"
```

2. **Revert to previous WASM:**
```bash
# Get previous WASM hash
export OLD_WASM_HASH="<previous_hash_from_backup>"

# Call upgrade with old hash
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  --send yes \
  -- upgrade \
  --new_wasm_hash "$OLD_WASM_HASH"
```

3. **Verify rollback:**
```bash
# Check version returns to previous
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- version

# Expected: 1000000 (for version 1.0.0, if rolling back from 1.1.0)

# Verify functionality works again
# Run tests from Verification Steps
```

### Full Rollback (with data restoration)

**For persistent data issues:**

1. **Pause submissions** (if possible):
```bash
# For ProofRegistry:
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  --send yes \
  -- pause
```

2. **Export state** (if not already backed up):
```bash
# Query all proofs for a given holder (example)
# Use Soroban RPC to export contract storage

# Store in backup file with timestamp
# backup-proof-registry-$(date +%s).json
```

3. **Restore from snapshot:**
- Only applicable if you have a state export mechanism
- Soroban does not support in-contract state rollback
- Manual re-submission may be required for critical data

4. **Resume submissions:**
```bash
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  --send yes \
  -- unpause
```

### Zero-Downtime Failover (Circuit Breaker)

**For Credential Verifier VK changes:**

Rather than roll back the entire contract:

1. **Deprecate new VK version** (if it's causing issues):
```bash
stellar contract invoke \
  --id "$CREDENTIAL_VERIFIER_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  --send yes \
  -- deprecate_version \
  --credential_type "kyc" \
  --version 2

# New submissions against version 2 will now fail
# Old proofs verified against version 1 still work
```

2. **Clients automatically fallback** to version 1:
```bash
# ProofRegistry.submit_proof() with vk_version=None
# resolves to latest non-deprecated version
```

3. **No rollback needed** - system self-heals through deprecation

---

## Monitoring & Alerts

### Key Metrics to Track

1. **Contract Version Mismatch:**
   - Alert if `app_version` doesn't match `contract_versions`
   - May indicate deployment lag

2. **Upgrade Event Delays:**
   - Track time between `EventContractUpgraded` emission and `/api/ready` update
   - Alert if > 5 minutes (indicates indexer/RPC lag)

3. **Data Migration Status:**
   - Query `last_migration_timestamp` frequently
   - Alert if migration incomplete after deployment

4. **Proof Submission Failures:**
   - Monitor for sudden increase in `VerificationFailed` errors
   - May indicate VK version deprecation issues

### Monitoring Queries

```bash
# Check all contract versions periodically (every 5 minutes)
curl https://app.example.com/api/ready | jq '.contract_versions'

# Query last upgrade timestamp
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- last_upgrade_timestamp

# Query proof record schema version
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- proof_record_schema_version

# Query last migration timestamp
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- last_migration_timestamp
```

### Alert Thresholds

| Alert | Condition | Action |
|-------|-----------|--------|
| Deployment Lag | Version mismatch > 10 min | Check RPC/indexer status |
| Migration Timeout | Migration not complete 30 min after upgrade | Investigate migration logic |
| Submission Failures | Error rate > 5% | Check VK deprecation status |
| Schema Version Mismatch | Schema version doesn't match expected | Rollback/fix migration |

---

## Troubleshooting

### Issue: Contract version query returns 0

**Cause:** Contract not initialized or very old version

**Solution:**
1. Verify contract is deployed: `stellar contract info --id "$CONTRACT_ID"`
2. Check if constructor was called with valid admin
3. If old deployment, redeploy with new version

### Issue: Upgrade fails with "NotAuthorized"

**Cause:** Caller is not the contract admin

**Solution:**
```bash
# Verify admin address
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- admin

# Ensure SOURCE in upgrade call matches this address
export SOURCE="<correct_admin_key>"
```

### Issue: WASM hash mismatch

**Cause:** Hash provided doesn't match actual compiled WASM

**Solution:**
1. Recompute hash: `sha256sum target/wasm32.../release/<contract>.wasm`
2. Verify build environment (Rust version, dependencies)
3. Compare with hash from previous deployment
4. Use exact same build flags: `stellar contract build`

### Issue: ProofRecord deserialization errors

**Cause:** Old proofs can't be read after schema change

**Solution:**
1. Check schema version: `proof_record_schema_version()`
2. Ensure migration was called: `migrate_data()`
3. Check `last_migration_timestamp` is recent
4. If migration incomplete, call again:
```bash
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  --send yes \
  -- migrate_data
```

### Issue: Footer doesn't show updated version

**Cause:** Frontend cache or stale `/api/ready` response

**Solution:**
1. Hard refresh browser (Cmd+Shift+R or Ctrl+Shift+R)
2. Check `/api/ready` directly: `curl https://app.example.com/api/ready`
3. Verify `NEXT_PUBLIC_APP_VERSION` env var is set in deployment
4. Clear Next.js cache: `rm -rf frontend/.next`

---

## Version Compatibility Matrix

| App Version | SDK Version | ProofRegistry | CredentialVerifier | IssuerRegistry | GatedPool | Notes |
|-------------|-------------|---------------|-------------------|---|---|---|
| 1.0.0 | 0.1.1 | 1.0.0 | 1.0.0 | 1.0.0 | 1.0.0 | Initial release |
| 1.1.0 | 0.1.1 | 1.0.0 | 1.1.0 | 1.0.0 | 1.0.0 | VK versioning added |
| 1.1.0 | 0.2.0 | 1.1.0 | 1.1.0 | 1.0.0 | 1.0.0 | SDK breaking change |

### Update Triggers

- **MAJOR bump**: Breaking change in contract ABI or SDK API
- **MINOR bump**: New on-chain features, new events, backward compatible
- **PATCH bump**: Bug fixes, internal optimization, no user-visible change

### Before Upgrading

Always check this matrix to ensure compatibility between:
1. Frontend app version
2. SDK version used by clients
3. Each contract version

Mismatches may cause:
- Failed proof submissions (old SDK incompatible with new contract)
- Event parsing errors (old indexers can't parse new events)
- Type errors in frontend (old SDK types don't match new contract ABI)

---

## Appendix: Useful Commands

### Query Endpoints

```bash
# Get all contract versions at once
curl https://app.example.com/api/ready | jq '.contract_versions'

# Check single contract version
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- version | jq

# Get upgrade timestamp
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- last_upgrade_timestamp
```

### Event Inspection

```bash
# Find all upgrade events (requires indexer or local RPC)
stellar events \
  --id "$PROOF_REGISTRY_ID" \
  --network "$NETWORK" \
  --topic-filter '("proof_reg", "upgraded")' \
  | jq '.[] | {admin, new_wasm_hash, upgraded_at}'
```

### Backup & Restore

```bash
# Export contract storage state (if supported)
stellar contract export --id "$PROOF_REGISTRY_ID" > backup.json

# Snapshot for later recovery
cp backup.json "backup-$(date +%Y%m%d-%H%M%S).json"
```

---

## Change Log

| Date | Version | Changes |
|------|---------|---------|
| 2024-08-30 | 1.0.0 | Initial runbook created |
| | | - Contract versioning (1.0.0) |
| | | - Upgrade procedure documented |
| | | - Data migration strategy |
| | | - Rollback procedures |
| | | - Monitoring guidelines |

---

## Contact & Support

For upgrade issues:
- **Frontend**: Check `/api/ready` endpoint
- **Contracts**: Inspect events in Soroban explorer
- **SDK**: Review version in `frontend/packages/sdk/package.json`
- **Escalation**: Contact admin team with version mismatch details


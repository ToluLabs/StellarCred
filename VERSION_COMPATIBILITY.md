# StellarCred Version Compatibility Matrix

## Overview

This document defines compatibility between StellarCred components across versions. Use this matrix when upgrading to ensure all components work together correctly.

**Key Principles:**
- MAJOR version changes indicate breaking ABI changes
- MINOR version changes are backward compatible (new features)
- PATCH version changes are fully backward compatible (bug fixes)
- Clients must support the contract versions deployed on-chain

---

## Current Deployment (v1.0.0)

| Component | Version | Semantic | Notes |
|-----------|---------|----------|-------|
| **Contracts** | | | |
| credential_verifier | 1.0.0 | 1.0.0 | UltraHonk verifier, VK registration |
| proof_registry | 1.0.0 | 1.0.0 | Proof caching, batch submissions |
| issuer_registry | 1.0.0 | 1.0.0 | Issuer management |
| gated_pool | 1.0.0 | 1.0.0 | Demo DeFi gating |
| **Frontend** | | | |
| App (StellarCred) | 1.0.0 | 1.0.0 | Next.js UI, credential issuance |
| SDK (@stellarcred/sdk) | 0.1.1 | 0.1.1 | Read-only client library |

---

## Compatibility Matrix

### App ↔ Contract Compatibility

| App | SDK | ProofRegistry | CredentialVerifier | IssuerRegistry | GatedPool | Status |
|-----|-----|---------------|-------------------|---|---|---|
| 1.0.0 | 0.1.x | 1.0.0 | 1.0.0 | 1.0.0 | 1.0.0 | ✓ Stable |
| 1.0.0 | 0.2.0+ | 1.0.0 | 1.0.0 | 1.0.0 | 1.0.0 | ⚠ Test First |
| 1.1.0+ | 0.1.x | 1.0.0 | 1.1.0+ | 1.0.0 | 1.0.0 | ⚠ Test First |
| 1.1.0+ | 0.2.0+ | 1.1.0+ | 1.1.0+ | 1.0.0+ | 1.0.0+ | ⚠ Test First |

**Legend:**
- ✓ Stable = Tested combination
- ⚠ Test First = Theoretically compatible but not yet tested

### SDK ↔ Contract Compatibility

The SDK is a read-only client that queries deployed contracts. Compatibility depends on:

1. **Method Presence**: New SDK versions must support querying methods in deployed contracts
2. **Type Compatibility**: SDK types must match contract serialization formats
3. **Event Parsing**: SDK must parse events emitted by contracts

| SDK | Supported Contracts | Notes |
|-----|-------------------|-------|
| 0.1.1 | proof_registry 1.0.0 | Initial version, basic proof submission |
| 0.1.1 | credential_verifier 1.0.0 | VK registration, deprecation |
| 0.1.1 | issuer_registry 1.0.0 | Issuer enumeration |
| 0.1.1 | gated_pool 1.0.0 | Demo pool queries |
| 0.2.0 (planned) | proof_registry 1.0.0+ | Supports version queries, migrations |
| 0.2.0 (planned) | credential_verifier 1.0.0+ | Supports upgrade events |

---

## Breaking Changes & Migration Guide

### ProofRegistry 1.0.0 → 1.1.0 (Hypothetical)

**What Changes:**
- New `migrate_data()` endpoint for schema migrations
- New `proof_record_schema_version()` query
- Event `EventContractUpgraded` added

**Client Impact:**
- ✓ No impact on existing proof submissions (backward compatible)
- ⚠ New features not available in SDK 0.1.x
- Requires SDK 0.2.0 to use new migration endpoints

**Action Required:**
```bash
# Before upgrade
npm install @stellarcred/sdk@0.1.1

# After upgrade to ProofRegistry 1.1.0
npm install @stellarcred/sdk@0.2.0
```

### CredentialVerifier 1.0.0 → 2.0.0 (Hypothetical Breaking Change)

**What Changes:**
- `verify_proof()` signature changes (e.g., new required parameter)
- New proof format incompatible with old caches

**Client Impact:**
- ✗ Existing proofs may not validate
- ✗ Old SDK cannot call new contract
- Requires major version bump in SDK

**Action Required:**
1. **Before:** Pause new proof submissions
2. **Migrate:** Re-verify all cached proofs with new contract
3. **Update:** Upgrade app and SDK simultaneously
4. **Resume:** Re-enable submissions after verification

---

## Version Upgrade Checklist

### When Upgrading Contracts

1. **Check Compatibility Matrix**
   ```bash
   # Look up your current versions
   curl https://app.example.com/api/ready | jq '.contract_versions'
   ```

2. **Review Release Notes**
   - Check if upgrade is MAJOR, MINOR, or PATCH
   - Identify required SDK updates
   - Verify no breaking changes for your use case

3. **Test in Staging**
   ```bash
   # Deploy new contract to testnet
   SOURCE=deployer NETWORK=testnet ./scripts/deploy.sh
   
   # Test with current app/SDK
   npm test
   
   # If breaking change, update SDK and re-test
   npm install @stellarcred/sdk@new-version
   npm test
   ```

4. **Verify Compatibility**
   ```bash
   # Check /api/ready shows all versions aligned
   curl https://staging.example.com/api/ready | jq '{
     app_version: .app_version,
     contracts: .contract_versions | map_values(.version)
   }'
   ```

5. **Deploy to Production**
   - Follow MIGRATION_RUNBOOK.md procedures
   - Use deployment script to record WASM hashes
   - Verify checksums match

### When Upgrading SDK

1. **Check Contract Support**
   ```bash
   # Read SDK changelog
   cat node_modules/@stellarcred/sdk/CHANGELOG.md | head -50
   ```

2. **Review API Changes**
   - New methods?
   - Changed method signatures?
   - New error types?

3. **Update Incrementally**
   ```bash
   npm install @stellarcred/sdk@latest
   npm run build  # Check for type errors
   npm test
   ```

4. **Backward Compatibility Check**
   - Can old SDK talk to new contracts? (Usually yes for MINOR/PATCH)
   - Can new SDK talk to old contracts? (Usually yes)

---

## Component Maturity & Support

| Component | Stability | Update Frequency | Support Window |
|-----------|-----------|------------------|---|
| credential_verifier | Production | Ad-hoc (when circuits change) | 12 months |
| proof_registry | Production | Ad-hoc (when schema changes) | 12 months |
| issuer_registry | Production | Ad-hoc (issuer management) | 12 months |
| gated_pool | Demo | Actively developed | N/A |
| App (StellarCred) | Beta | Monthly releases | 6 months |
| SDK | Beta | Quarterly releases | 6 months |

---

## Deprecation Policy

### Gradual Deprecation (Recommended)

1. **Announce** (1 month): Deprecation notice in release notes
2. **Deprecate** (1 month): Issue warnings but still function
3. **Remove** (1 month): Remove functionality entirely

Example: Deprecating old VK versions

```rust
// v1.1.0: Announce deprecation
// Topics: ("proof_reg", "deprecated_version_announced")

// v1.1.0: Mark as deprecated (clients see warnings)
pub fn deprecate_version(env: Env, credential_type: Symbol, version: u32) {
    // New submissions fail gracefully
    panic_with_error!(&env, Error::VersionDeprecated);
}

// v1.2.0: Remove (old proofs can't validate)
pub fn prune_version(env: Env, credential_type: Symbol, version: u32) {
    env.storage().persistent().remove(&vk_key);
}
```

### Client-Side Impact Timeline

| Phase | Deadline | Client Action |
|-------|----------|---------------|
| Deprecation Announced | Month 0 | Monitor release notes |
| Functionality Degraded | Month 1 | Update SDK/app |
| Functionality Removed | Month 2 | Emergency upgrade required |

---

## Version Query Reference

### Query Contract Versions On-Chain

```typescript
// Using SDK (requires SDK 0.2.0+)
import { ProofRegistry } from "@stellarcred/sdk";

const registry = new ProofRegistry(contractAddress, client);
const version = await registry.version();
console.log(version); // 1000000 = v1.0.0
```

```bash
# Using Stellar CLI
stellar contract invoke \
  --id "$PROOF_REGISTRY_ID" \
  --source "$ADMIN" --network "$NETWORK" \
  -- version
```

### Decode Version from u32

```typescript
function decodeVersion(versionU32: number): string {
  const major = Math.floor(versionU32 / 1_000_000);
  const minor = Math.floor((versionU32 % 1_000_000) / 1_000);
  const patch = versionU32 % 1_000;
  return `${major}.${minor}.${patch}`;
}

console.log(decodeVersion(1002003)); // "1.2.3"
```

### Check Readiness with Versions

```bash
# Get all deployment versions at once
curl https://app.example.com/api/ready | jq '{
  app: .app_version,
  sdk: "0.1.1",  // hardcoded in Footer component
  contracts: .contract_versions | map_values(.version)
}'
```

---

## Network-Specific Versions

### Testnet (SDF Network)

- **Latest Deployed**: See `/api/ready`
- **Deployment Manifest**: `deployment-manifests/deployment-*.json`
- **Chain**: Stellar Testnet
- **RPC**: `https://soroban-testnet.stellar.org`

### Mainnet (When Available)

- **Status**: Not yet deployed
- **Expected**: Follow testnet by 3 months
- **Chain**: Stellar Public Network
- **RPC**: `https://soroban-mainnet.stellar.org`

---

## Common Compatibility Scenarios

### Scenario 1: Old App + New Contracts

**Setup:**
- App v1.0.0, SDK 0.1.1
- Upgraded: ProofRegistry 1.1.0

**Result:** ⚠ Partial compatibility
- ✓ Can submit proofs (backward compatible)
- ✗ Cannot call new `migrate_data()` endpoint
- ✗ Version drawer shows "unknown"

**Fix:** Update app and SDK
```bash
npm install @stellarcred/sdk@0.2.0
```

### Scenario 2: New App + Old Contracts

**Setup:**
- App v1.1.0, SDK 0.2.0
- Deployed: ProofRegistry 1.0.0

**Result:** ✓ Full compatibility
- New SDK gracefully handles old contracts
- Version endpoints may not exist (handled with defaults)
- All features work except new ones

**Fix:** Optional (already compatible)

### Scenario 3: Different Contract Versions

**Setup:**
- ProofRegistry 1.1.0
- CredentialVerifier 1.0.0
- IssuerRegistry 1.1.0
- GatedPool 1.0.0

**Result:** ✓ Compatible
- Each contract version is independent
- ProofRegistry.upgrade() called separately
- No cross-contract version requirements

**Behavior:** Contracts negotiate features dynamically
```rust
// ProofRegistry 1.1.0 calls IssuerRegistry 1.1.0
// Both support new features, backward compatible
if let Ok(metadata) = registry.get_issuer_metadata(&issuer) {
    // v1.1.0 feature
}
```

---

## Troubleshooting Version Issues

### Problem: Version Mismatch in /api/ready

```json
{
  "app_version": "1.0.0",
  "contract_versions": {
    "proofRegistry": { "version": "1.1.0" }
  }
}
```

**Cause:** App deployed before contract upgrade, or vice versa

**Solution:**
1. Check deployment times
2. Wait for app deployment to complete (5-10 min)
3. Hard refresh browser (Cmd+Shift+R)
4. If persists, check frontend/.env vars match deployed contracts

### Problem: "Contract version not found"

**Cause:** Contract not deployed or version() endpoint not implemented

**Solution:**
1. Verify contract is deployed: `stellar contract info --id "$ID"`
2. Check contract source code has `version()` function
3. Rebuild and redeploy with version support

### Problem: SDK Type Mismatch Error

```
Error: Cannot assign ProofRecord to ProofRecordV2
```

**Cause:** SDK type definitions don't match contract serialization

**Solution:**
1. Update SDK: `npm install @stellarcred/sdk@latest`
2. Clear build cache: `rm -rf dist node_modules/.cache`
3. Rebuild: `npm run build`

---

## Planned Roadmap

### v1.1.0 (Planned Q4 2024)

**Contract Changes:**
- [ ] CredentialVerifier: Add `upgrade()` endpoint
- [ ] IssuerRegistry: Add `set_issuer_metadata()` endpoint
- [ ] ProofRegistry: Add `migrate_data()` endpoint

**SDK Changes:**
- [ ] Support new version queries
- [ ] Parse `EventContractUpgraded` events
- [ ] Add type stubs for migration data

**App Changes:**
- [ ] Display contract upgrade timestamps in footer
- [ ] Add admin panel for migrations

### v2.0.0 (Planned Q2 2025)

**Breaking Changes:**
- [ ] ProofRecord redesign (new schema)
- [ ] Event format changes
- [ ] Contract ABI versioning

**Migration Required:**
- [ ] Major version bump for all components
- [ ] Comprehensive data migration runbook
- [ ] Parallel deployment of v1.x and v2.0

---

## Support & Questions

**Check Before Opening Issue:**
1. Are your versions in the compatibility matrix?
2. Does your scenario match "Common Compatibility Scenarios"?
3. Have you tried the troubleshooting steps?

**How to Report Version Issues:**
```
Title: Version compatibility issue with SDK 0.1.1 + ProofRegistry 1.1.0

Details:
- App version: 1.0.0
- SDK version: 0.1.1
- Error: Cannot call migrate_data()
- Expected: migrate_data() should work

Steps to reproduce:
1. Deploy ProofRegistry 1.1.0
2. Call /api/ready and check versions
3. Try calling migrate_data()
```

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2024-08-30 | 1.0.0 | Initial deployment |
| | | - All contracts v1.0.0 |
| | | - App v1.0.0, SDK 0.1.1 |
| | | - Compatibility matrix created |


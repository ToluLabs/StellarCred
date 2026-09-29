# StellarCred Support Policy

This document is the authoritative statement of support windows, deprecation
procedures, and migration paths for every versioned artifact in StellarCred.
It binds operators, protocol integrators, and SDK consumers alike.

Cross-references:

- [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) — per-release
  compatibility matrix and upgrade checklists.
- [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md) — step-by-step procedures for
  contract upgrades and data migrations.

---

## Table of Contents

1. [Scope](#scope)
2. [Versioned Artifacts](#versioned-artifacts)
3. [Support Windows](#support-windows)
4. [Deprecation Procedure](#deprecation-procedure)
5. [VK Versions and the Pruning Rule](#vk-versions-and-the-pruning-rule)
6. [Proof Record Schema Versions](#proof-record-schema-versions)
7. [Contract Versions](#contract-versions)
8. [SDK Versions](#sdk-versions)
9. [Backup Envelope Versions](#backup-envelope-versions)
10. [Breaking vs Non-Breaking Changes](#breaking-vs-non-breaking-changes)
11. [Notices and Communication](#notices-and-communication)

---

## Scope

StellarCred contains several independently versioned components. This policy
governs:

| Artifact | Where | Current version |
|---|---|---|
| Verification key (VK) per credential type | `CredentialVerifier` on-chain | type-specific `u32` counter |
| Proof record schema | `ProofRegistry` on-chain | `PROOF_RECORD_SCHEMA_VERSION = 1` |
| Contract ABI | each Soroban contract | `CONTRACT_VERSION = 1_000_000` (1.0.0) |
| SDK (`@stellarcred/sdk`) | npm / `frontend/packages/sdk` | 0.1.1 |
| Backup envelope | browser `localStorage` / export JSON | 2 (version 1 legacy) |

---

## Versioned Artifacts

### Verification Keys (VK)

Each credential type (`kyc`, `age`, `income`, `jurisdiction`, `funds`, …) has
one VK stored per version counter in `CredentialVerifier`. The VK ties a
specific Noir circuit compiled with a specific Barretenberg (`bb`) release to
the on-chain verifier. A proof is only accepted if it was generated against a
registered, non-deprecated VK version.

VK versions are monotonically increasing `u32` values starting at 1.
Version 0 is permanently reserved as the sentinel meaning "version not stored"
and can never be registered.

### Proof Record Schema Version

`ProofRegistry` persists a `ProofRecord` struct per `(holder, credential_type)`
key. The `PROOF_RECORD_SCHEMA_VERSION` constant (currently `1`) tracks the
on-chain shape of that struct. When the struct gains, loses, or reorders fields
the version increments and a `migrate_record` / `migrate_data` call is required.

### Contract Versions

All four Soroban contracts expose a `version() → u32` query.  
Encoding: `(major × 1 000 000) + (minor × 1 000) + patch` (e.g. `1_002_003`
= v1.2.3). The current version for all contracts is `1_000_000` (v1.0.0).

### SDK (`@stellarcred/sdk`)

The npm package version follows [Semantic Versioning 2.0](https://semver.org).
The current version is `0.1.1`.

### Backup Envelope

Local credential backups use a `version` field in their JSON payload.
Version 2 is current (AES-256-GCM, 600 000 PBKDF2 iterations).
Version 1 is the legacy format (100 000 PBKDF2 iterations) and remains
readable but new exports always write version 2.

---

## Support Windows

The table below states the minimum period each artifact version remains **fully
functional** after a successor version is available.

| Artifact | Support window after successor is live |
|---|---|
| VK version (credential circuit) | **90 days** |
| Proof record schema version | **6 months** |
| Contract MAJOR version | **6 months** |
| Contract MINOR / PATCH version | No minimum (backward compatible) |
| SDK MAJOR version | **6 months** |
| SDK MINOR / PATCH version | No minimum (backward compatible) |
| Backup envelope version | Indefinite read support; write support at operator discretion |

"Fully functional" means:

- **VK version**: the old VK is still accepted for new proof submissions; no
  pruning has occurred.
- **Schema version**: old records are still readable and `is_verified` / 
  `check_claim` work without migration.
- **Contract MAJOR**: the old ABI is still deployed and callable (parallel
  deployment or rollback path maintained).
- **SDK MAJOR**: the old SDK package still resolves against deployed contracts
  and type definitions are accurate.
- **Backup envelope**: files created under any supported envelope version can be
  decrypted and imported.

---

## Deprecation Procedure

Every versioned artifact follows a three-phase lifecycle:

```
Active → Deprecated → Removed
```

### Phase 1 — Announce (before any code change)

- Publish a GitHub release note or issue comment stating:
  - Which artifact and version is being deprecated.
  - The reason (circuit upgrade, schema change, security fix, etc.).
  - The planned date of Phase 2 (at least 30 days out for non-security changes;
    may be immediate for critical security issues).
- For VK deprecations: call `CredentialVerifier.deprecate_version` on-chain.
  This records a `deprecated_at` timestamp and emits a `vk_deprecation_announced`
  event visible to all indexers.
- For SDK deprecations: publish a release with a deprecation notice in the npm
  tag and changelog.

### Phase 2 — Deprecated (old version still works, warnings added)

- **VK**: new calls to `verify_proof` against the deprecated version succeed
  but the version is flagged; monitoring alerts should fire for operators still
  submitting to deprecated versions.
- **Schema**: `proof_record_schema_version()` returns the old version; records
  are still readable; `migrate_data()` is available for operators.
- **Contract / SDK**: the old version continues to work; release notes carry
  a prominent `[DEPRECATED]` label.

Phase 2 lasts at least as long as the support window for that artifact (see
table above).

### Phase 3 — Removed

- **VK**: `CredentialVerifier.prune_version` removes the VK bytes on-chain.
  New proof submissions against that version fail. Existing *cached* proofs in
  `ProofRegistry` remain readable until their own `expiry` timestamp passes.
  See [VK Versions and the Pruning Rule](#vk-versions-and-the-pruning-rule)
  for the exact timing constraint.
- **Schema**: old record shape is no longer supported without migration;
  `migrate_record` / `migrate_data` must have been called before removal.
- **Contract MAJOR**: old contract ID is no longer officially supported; operators
  still running against it receive no patch or security updates.
- **SDK MAJOR**: old npm tag unpublished or marked `deprecated` on the registry.

---

## VK Versions and the Pruning Rule

> **The safety delay is a hard on-chain constraint, not an operator judgment
> call.** `prune_version` will revert unless the delay has elapsed.

### Rationale

A holder may submit a proof at any point up to their proof's `expiry`. The
`ProofRegistry` caches the result, but the VK must remain available in
`CredentialVerifier` for the lifetime of any proof that might still be
re-submitted or re-verified against it. Removing a VK too early would cause
`verify_proof` to revert for holders who legitimately generated their proof
before the circuit was upgraded.

The longest permitted proof expiry is `MAX_CREDENTIAL_TTL_SECS = 365 days`
(enforced by `ProofRegistry.validate_expiry`). The support window for a VK
version — 90 days from deprecation — is intentionally shorter than the
maximum proof lifetime because:

1. At deprecation time new submissions against the old VK are blocked.
2. Any proof already cached in `ProofRegistry` does not need the VK to remain
   registered (the verification result is cached, not re-run on `is_verified`).
3. The 90-day window covers the worst-case gap between a holder generating a
   proof offline and submitting it, accounting for network outages and
   infrequent wallet usage.

### On-chain enforcement

The `prune_version` function in `CredentialVerifier` enforces this directly:

```rust
// contracts/credential_verifier/src/lib.rs
const MAX_PROOF_VALIDITY_SECONDS: u64 = 90 * 86_400; // 90 days

pub fn prune_version(env: Env, credential_type: Symbol, version: u32) {
    // ...
    let deprecated_at = /* DeprecatedAt(credential_type, version) */;
    if env.ledger().timestamp() < deprecated_at.saturating_add(MAX_PROOF_VALIDITY_SECONDS) {
        panic_with_error!(&env, Error::VkStillReferenceable);
    }
    // only reaches here after 90 days have passed since deprecation
    env.storage().persistent().remove(&vk_key);
}
```

`MAX_PROOF_VALIDITY_SECONDS = 90 × 86 400 = 7 776 000 seconds`.  
This constant **is** the policy; it must be updated in lock-step with any
revision to the 90-day support window in this document.

### Pruning timeline (summary)

| Day | Event |
|---|---|
| 0 | `deprecate_version` called; `deprecated_at` recorded on-chain. New proof submissions against this VK are rejected. Deprecation event emitted. |
| 0–90 | Old VK still present; any holder who generated a proof before day 0 can still submit it. |
| ≥ 90 | `prune_version` is unblocked. Operator may remove the VK bytes at their convenience. |
| After pruning | Proof submissions against pruned version fail. Cached proofs in `ProofRegistry` remain valid until their own `expiry`. |

### What breaks and what does not

| Scenario | Impact after pruning |
|---|---|
| Holder already submitted their proof before pruning | ✓ No impact — cached result still readable |
| Holder generated a proof before deprecation but not yet submitted | ✗ Submission fails after pruning; holder must re-prove with new VK |
| Protocol calls `is_verified` / `check_claim` | ✓ No impact — reads from `ProofRegistry` cache only |
| New proof submission against deprecated (not yet pruned) VK | ✗ Rejected from day 0 of deprecation |

---

## Proof Record Schema Versions

`ProofRegistry` stores a `ProofRecord` per `(holder, credential_type)` entry.
The current schema version is `1` and covers:

```rust
pub struct ProofRecord {
    pub verified_at: u64,
    pub expiry:      u64,
    pub threshold:   Option<u64>,
    pub revoked:     bool,
    pub issuer:      Option<Address>,
    pub vk_version:  u32,
}
```

### When the schema version changes

The schema version increments when a field is added, removed, or reordered in
`ProofRecord`. The `PROOF_RECORD_SCHEMA_VERSION` constant in
`contracts/proof_registry/src/lib.rs` is the canonical source of truth.

### Migration requirements

| Change type | Migration required | Breaking |
|---|---|---|
| Add optional field | Yes — `migrate_data` to back-fill defaults | No |
| Remove field | Yes — `migrate_record` per holder | Yes (MAJOR bump) |
| Reorder fields | Yes — full `migrate_data` pass | Yes (MAJOR bump) |

A data migration **must** be callable and complete before the old schema version
leaves its support window (6 months from the release of the new version).

Operators can query migration status:

```bash
stellar contract invoke --id "$PROOF_REGISTRY_ID" -- proof_record_schema_version
stellar contract invoke --id "$PROOF_REGISTRY_ID" -- last_migration_timestamp
```

---

## Contract Versions

### Version encoding

```
CONTRACT_VERSION = (major × 1_000_000) + (minor × 1_000) + patch
```

Current: `1_000_000` = v1.0.0 for all four contracts.

### Compatibility promises

| Version change | Backward compatible | Forward compatible | Client action required |
|---|---|---|---|
| PATCH (x.y.Z) | ✓ Yes | ✓ Yes | None |
| MINOR (x.Y.0) | ✓ Yes (additive only) | ✓ Yes | Optional upgrade to access new features |
| MAJOR (X.0.0) | ✗ No | ✗ No | SDK update + migration runbook |

### Support window for MAJOR versions

When a new MAJOR contract version is deployed, the previous MAJOR version
remains supported for **6 months** from the date the new version is announced.
During that window:

- Security patches are back-ported to the previous MAJOR where feasible.
- The previous contract ID continues to be listed in `DEPLOYMENTS.md`.
- The SDK ships compatibility shims for both versions simultaneously.

After 6 months the previous MAJOR contract ID is no longer supported and
operators must have migrated.

### Upgrade procedure

See [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md) for the full procedure.
The relevant sections are:

- Pre-Upgrade Checklist
- Contract Upgrade Procedure
- Data Migration Strategy
- Rollback Procedures

---

## SDK Versions

The `@stellarcred/sdk` npm package version follows Semantic Versioning 2.0.

### Compatibility promise

| Artifact | SDK PATCH | SDK MINOR | SDK MAJOR |
|---|---|---|---|
| Existing contract calls | ✓ Unaffected | ✓ Unaffected | ✗ May break |
| TypeScript types | ✓ Unaffected | ✓ Unaffected | ✗ May change |
| `hasClaim` / `getClaims` / `buildVerifyUrl` | ✓ Unaffected | ✓ Unaffected | ✗ Signature may change |

### Support window

| SDK version | Support duration |
|---|---|
| Current MINOR (0.1.x) | Until superseded + 6 months |
| Previous MAJOR | 6 months after new MAJOR published |

### Checking your SDK version

```bash
npm list @stellarcred/sdk
# or
node -e "console.log(require('@stellarcred/sdk/package.json').version)"
```

### What to do before a MAJOR SDK upgrade

1. Read the changelog for the new MAJOR release.
2. Check the [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) matrix for
   the minimum contract versions required.
3. Run `npm install @stellarcred/sdk@latest` in a staging environment.
4. Fix type errors; new method signatures are documented in the release notes.
5. Verify with `make test-sdk` (or your own integration suite).

---

## Backup Envelope Versions

Credential backup files (JSON exported from the Holder page) carry a `version`
field. The version governs the KDF parameters used to encrypt the file.

| Version | KDF iterations | Status |
|---|---|---|
| 1 | 100 000 PBKDF2-HMAC-SHA256 | Legacy — readable, never written |
| 2 | 600 000 PBKDF2-HMAC-SHA256 | Current |

**Read support** for version 1 is indefinite — existing backup files will always
be importable. **Write support** (i.e. new exports) always produce version 2.

If a future version 3 is introduced (e.g. to replace PBKDF2 with Argon2), the
same pattern applies: version 2 remains readable until at least one full year of
version 3 availability has elapsed, giving holders ample time to re-export.

---

## Breaking vs Non-Breaking Changes

For clarity, the following are **always breaking** and require at minimum a
MAJOR version bump and the full deprecation procedure:

- Removing a contract entry point (function signature disappears).
- Changing the parameter types or return types of an existing entry point.
- Changing the `ProofRecord` struct layout without a migration path.
- Retiring a VK version before the 90-day safety delay has elapsed.
- Publishing an SDK release that removes exported symbols or narrows accepted
  types.

The following are **never breaking** and may be shipped as MINOR or PATCH:

- Adding new contract entry points with no change to existing ones.
- Adding optional fields to `ProofRecord` (schema version increments but no
  migration is mandatory before the 6-month window).
- Registering an additional VK version for a credential type.
- Adding new SDK exports that do not remove or rename existing ones.
- Updating documentation, comments, or internal constants with no ABI effect.

---

## Notices and Communication

Deprecation and removal notices are communicated through:

1. **GitHub releases** — the release body includes a `[DEPRECATED]` or
   `[REMOVED]` section for every affected artifact.
2. **On-chain events** — `EventVkSet` / `EventVkPruned` (CredentialVerifier)
   and `EventContractUpgraded` (ProofRegistry, CredentialVerifier) are indexed
   by the StellarCred indexer service and available for operators to subscribe
   to.
3. **`/api/ready` endpoint** — the response includes contract versions; a
   version mismatch between the deployed contract and a known-deprecated ABI
   is surfaced as a warning.
4. **CHANGELOG.md** — every release entry documents the version bump reason
   and any action required by integrators.

Operators are responsible for monitoring these channels. StellarCred does not
proactively contact individual integrators; it is the integrator's
responsibility to track the support windows stated in this document.

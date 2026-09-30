# ProofRegistry — Contract API Reference

Complete reference for every public entrypoint of the `ProofRegistry` contract
(`contracts/proof_registry/src/lib.rs`).

**What ProofRegistry is.** A cache of successful verifications so gated protocols
never re-run the (expensive) UltraHonk verifier on every interaction. A holder
proves once; the registry records *"this address satisfies credential X until
ledger time T"*. Any gated protocol then makes a single cheap read.

**Audience legend** — every function below is tagged with the persona it is for:

| Tag | Who | Typical caller |
|-----|-----|----------------|
| **Holder** | The credential holder (wallet that owns the proof) | Wallet / dApp frontend |
| **Integrator** | Any gated protocol or dApp consuming verification results | Server or on-chain contract |
| **Issuer** | A registered credential issuer | Issuer backend / operations key |
| **Admin** | Governance / operations keys (RBAC roles or root admin) | Ops tooling, multisig |

**Stability.** Functions tagged **Stable** form the public integration surface
that downstream protocols should build on and that we treat as ABI-frozen.
Functions tagged **Operational** exist for governance and incident response;
they may evolve between minor versions. See [Stable integration surface](#8-stable-integration-surface-vs-operationsurface).

## 0. How to read this reference

- **Auth** — who must sign the invocation. `holder.require_auth()` means the
  named `holder` address must authorize (wallet signature / soroban auth
  entry). `require_admin` means the root admin key; `require_role("x")` means
  the current holder of role `x`. Authorization failures abort the invocation
  at the host level — they do **not** produce a contract error code.
- **Panics** — the `Error` enum variants the function can abort with, with
  their numeric codes (see [§7 Error codes](#7-error-codes)). Cross-contract
  calls (IssuerRegistry, CredentialVerifier) can also propagate *their* errors.
- **Events** — topics and payloads published on success. See
  [EVENTS.md](EVENTS.md) for the authoritative catalog and XDR shapes.
- **No panic / no event** is stated explicitly where it applies.

### RBAC model in one paragraph

The constructor seeds three roles — `admin`, `upgrader`, `pauser` — with the
deployer address. Roles live in a `Map<Symbol, Address>` (role name → current
holder). The root admin delegates/rotates role holders via `grant_role` /
`revoke_role`; anyone can query membership with `has_role`. `upgrade` requires
the `upgrader` role, `pause`/`unpause` the `pauser` role, `migrate_record` the
`admin` role. Role-management functions themselves (`grant_role`, `revoke_role`,
`propose_admin`, `cancel_admin_proposal`, `migrate_data`) stay on the bootstrap
trust anchor: the **root admin** key, not a delegatable role. Root-admin
transfer is two-step: `propose_admin` → `accept_admin`; on acceptance the new
admin inherits every role the outgoing admin held.

### Storage & TTL semantics (shared by many functions)

| Constant | Value | Meaning |
|----------|-------|---------|
| `MAX_BATCH_SIZE` | 5 | Max entries in `submit_proofs` / aggregate proof |
| `MAX_CREDENTIAL_TTL_SECS` | 365 days | Max `expiry` distance from now |
| `PROOF_TTL` | 90 days (in ledgers) | Minimum persistent-entry lifetime after a write/bump |
| `PROOF_BUMP_THRESHOLD` | 1 day (17280 ledgers) | Extend TTL when entry is within this of expiration |
| `SECONDS_PER_LEDGER` | 5 | Ledger time conversion |

Proof records, delegation grants and their TTLs live in **persistent** storage.
Every write bumps the entry's TTL to at least `max(90 days, time until expiry)`,
so a claim stays readable for its whole validity window. `claim_expiry` and
`bump_claim` refresh the TTL on read. Contract-level data (admin, roles,
verifier/registry addresses) lives in **instance** storage.

## 1. Constructor

### `__constructor`

```rust
fn __constructor(env: Env, admin: Address, verifier: Address, issuer_registry: Address)
```

- **Audience:** Admin (deployer)
- **Auth:** Deployment itself; no runtime auth.
- **Stability:** Operational
- **Parameters:**
  - `admin` — root admin address; also seeded as the initial holder of the
    `admin`, `upgrader` and `pauser` roles.
  - `verifier` — address of the deployed CredentialVerifier contract.
  - `issuer_registry` — address of the deployed IssuerRegistry contract.
- **Returns:** —
- **Panics:** none.
- **Events:** none.
- **Notes:** initializes `Paused = false`. The contract is unusable until
  deployed with real `verifier` / `issuer_registry` addresses; reads of unset
  addresses panic with `NotInitialized (1)`.

## 2. Proof submission (Holder operations)

### `submit_proof`

```rust
fn submit_proof(env, holder: Address, issuer_id: Address, credential_type: Symbol,
                proof: Bytes, public_inputs: Bytes, vk_version: Option<u32>, expiry: u64)
```

- **Audience:** Holder
- **Auth:** `holder.require_auth()` — the holder's wallet signs.
- **Stability:** Stable
- **Parameters:**
  - `holder` — address the claim will be cached for.
  - `issuer_id` — issuer that signed the credential.
  - `credential_type` — e.g. `"kyc"`, `"age"`, `"income"`, `"jurisdiction"`,
    `"funds"`, `"accreditation"`, `"employment"`.
  - `proof` / `public_inputs` — UltraHonk proof bytes; the issuer secp256k1
    pubkey is read from `public_inputs` field 1..65.
  - `vk_version` — verifying-key version; `None` means "latest at submission
    time" (stored as `vk_version = 0`).
  - `expiry` — unix seconds; must be in the future and ≤ 1 year out.
- **Returns:** —
- **Panics:** `SubmissionsPaused (11)`, `InvalidExpiry (12)`,
  `IssuerNotTrusted (4)`, `IssuerKeyMismatch (5)`, `VerificationFailed (2)`.
- **Events:** `("proof_reg", "submitted", credential_type)` →
  `EventProofSubmitted { holder, issuer, verified_at, expiry }`.
- **Notes:** verifies issuer trust via IssuerRegistry *and* forwards the proof
  to CredentialVerifier; caches `ProofRecord` only if both pass.

### `submit_proofs`

```rust
fn submit_proofs(env, holder: Address, submissions: Vec<ProofSubmission>) -> Vec<bool>
```

- **Audience:** Holder
- **Auth:** `holder.require_auth()`.
- **Stability:** Stable
- **Parameters:** `submissions` — 1..=5 `ProofSubmission` entries (each carries
  `credential_type`, `proof`, `public_inputs` (`Vec<u32>`), `issuer_id`,
  `expiry`, `vk_version`). Credential types must be unique within the batch.
- **Returns:** `Vec<bool>` — one `true` per submission (on success; any failure
  reverts the whole call).
- **Panics:** `BatchEmpty (8)`, `BatchTooLarge (7)`, `DuplicateCredentialType (9)`,
  then per entry: `InvalidExpiry (12)`, `IssuerNotTrusted (4)`,
  `IssuerKeyMismatch (5)`, `VerificationFailed (2)`. **Atomic:** if any entry
  fails, nothing from the batch is stored.
- **Events:** one `submitted` event per credential.
- **Notes:** saves the holder multiple wallet confirmations / fee payments.

### `submit_aggregate_proof`

```rust
fn submit_aggregate_proof(env, holder: Address, issuer_ids: Vec<Address>,
                          credential_types: Vec<Symbol>, proof: Bytes,
                          public_inputs: Bytes, expiries: Vec<u64>)
```

- **Audience:** Holder
- **Auth:** `holder.require_auth()`.
- **Stability:** Stable
- **Parameters:** one aggregate proof covering N credential types
  (N = 2 in the PoC: KYC + age; 2 ≤ N ≤ 5). `issuer_ids`, `credential_types`
  and `expiries` must all have length N matching the circuit's
  `num_credentials` public input. Each `expiry` is validated like `submit_proof`.
- **Returns:** —
- **Panics:** `VerificationFailed (2)`, `AggregateLayoutInvalid (10)`,
  `InvalidExpiry (12)`, `IssuerNotTrusted (4)`, `IssuerKeyMismatch (5)`.
- **Events:** one `submitted` event per credential.
- **Notes:** the aggregate verifying key is selected by CredentialVerifier via
  the `"aggregate"` credential type; per-credential thresholds are extracted
  from the packed public inputs (age and income/funds layouts differ).

## 3. Reads (Integrator operations)

All reads are permissionless view calls — no auth, no fees beyond the RPC call.
They never panic (except the address introspectors in §6, which panic with
`NotInitialized` only if the contract was not constructed).

### `is_verified`

```rust
fn is_verified(env, holder: Address, credential_type: Symbol,
               trusted_issuers: Option<Vec<Address>>) -> (bool, u64, u64)
```

- **Audience:** Integrator
- **Auth:** none (public read).
- **Stability:** Stable
- **Parameters:** `trusted_issuers` — `None` accepts a claim from any issuer
  registered at submission time; `Some(list)` restricts acceptance to those
  issuers (a record with no stored issuer — e.g. an un-migrated legacy record —
  is rejected under a filter).
- **Returns:** `(valid, verified_at, expiry)`:
  - `valid` is `true` only if the record exists, is not revoked, `expiry` is in
    the future, and the issuer filter passes.
  - `verified_at` / `expiry` are returned **even when `valid` is false**, so
    callers can distinguish "never submitted" (both `0`) from "submitted but no
    longer valid".
- **Panics:** none (missing record → `(false, 0, 0)`).
- **Events:** none.

### `check_claim`

```rust
fn check_claim(env, holder: Address, credential_type: Symbol,
               min_threshold: Option<u64>, trusted_issuers: Option<Vec<Address>>) -> bool
```

- **Audience:** Integrator
- **Auth:** none (public read).
- **Stability:** Stable
- **Parameters:** `min_threshold` — e.g. minimum age-years, income or funds
  threshold; `None` means "any threshold". Thresholds are only recorded for
  `age`, `income`, `funds`, `accreditation`, `employment`; other types store
  threshold `None` which compares as `0`.
- **Returns:** `true` iff the claim exists, is not revoked, is unexpired, the
  issuer filter passes, and the stored threshold ≥ `min_threshold`.
- **Panics:** none.
- **Events:** none.

### `get_record`

```rust
fn get_record(env, holder: Address, credential_type: Symbol) -> Option<ProofRecord>
```

- **Audience:** Integrator
- **Auth:** none (public read).
- **Stability:** Stable
- **Returns:** the raw `ProofRecord { verified_at, expiry, threshold, revoked,
  issuer, vk_version }`, or `None`. Use when you need fields beyond
  `is_verified`'s triple (e.g. `revoked` even after expiry, or the issuer).
- **Panics:** none.
- **Events:** none.

### `claim_expiry`

```rust
fn claim_expiry(env, holder: Address, credential_type: Symbol) -> u64
```

- **Audience:** Integrator
- **Auth:** none (public read).
- **Stability:** Stable
- **Returns:** the claim's `expiry` unix seconds, or `0` if no record exists.
- **Panics:** none.
- **Events:** none.
- **Notes:** **side effect** — bumps the record's persistent-entry TTL, keeping
  long-lived claims readable.

### `check_delegated_verification`

```rust
fn check_delegated_verification(env, holder: Address, verifier: Address,
                                credential_type: Symbol) -> (bool, u64, u64)
```

- **Audience:** Integrator (the delegated `verifier`)
- **Auth:** none (public read; gated by the delegation state, not by auth).
- **Stability:** Stable
- **Returns:** `is_verified`'s own `(valid, verified_at, expiry)` — but only if
  `verifier` currently holds a non-expired `grant_verification` delegation from
  `holder` for that credential type; otherwise `(false, 0, 0)`, mirroring
  `is_verified`'s "never submitted" shape (deliberate: callers cannot
  distinguish "no delegation" from "no claim" by shape alone — Soroban storage
  is public, so this is a consent record for apps to condition their *own*
  gating on, not a confidentiality boundary).
- **Panics:** none.
- **Events:** none.

## 4. Delegated reads (Holder operations)

### `grant_verification`

```rust
fn grant_verification(env, holder: Address, verifier: Address,
                      credential_type: Symbol, expiry: u64)
```

- **Audience:** Holder
- **Auth:** `holder.require_auth()`.
- **Stability:** Stable
- **Parameters:** `verifier` — the dApp/protocol being granted access;
  `expiry` — unix seconds, must be in the future and ≤ 1 year out.
- **Returns:** —
- **Panics:** `InvalidExpiry (12)`.
- **Events:** `("proof_reg", "dlg_grant", credential_type)` →
  `EventVerificationGranted { holder, verifier, expiry }`.
- **Notes:** purely additive — `is_verified` remains a public read exactly as
  before. Re-granting the same `(holder, verifier, credential_type)` overwrites
  the previous expiry. Does not require an existing claim.

### `revoke_verification`

```rust
fn revoke_verification(env, holder: Address, verifier: Address, credential_type: Symbol)
```

- **Audience:** Holder
- **Auth:** `holder.require_auth()` (holder revokes their own grants).
- **Stability:** Stable
- **Returns:** —
- **Panics:** none — revoking a never-granted delegation is a no-op.
- **Events:** `("proof_reg", "dlg_revok", credential_type)` →
  `EventVerificationRevoked { holder, verifier }`.

## 5. Revocation (Holder & Issuer operations)

### `revoke_proof`

```rust
fn revoke_proof(env, holder: Address, credential_type: Symbol)
```

- **Audience:** Holder
- **Auth:** `holder.require_auth()`.
- **Stability:** Stable
- **Returns:** —
- **Panics:** none (removing a non-existent record is a no-op).
- **Events:** none.
- **Notes:** deletes the cached proof record entirely.

### `revoke_all`

```rust
fn revoke_all(env, holder: Address)
```

- **Audience:** Holder
- **Auth:** `holder.require_auth()`.
- **Stability:** Stable
- **Returns:** —
- **Panics:** none.
- **Events:** none.
- **Notes:** deletes the holder's records for all seven known credential types
  (`kyc`, `age`, `income`, `jurisdiction`, `funds`, `accreditation`,
  `employment`). A credential type submitted under a symbol outside this fixed
  list is not covered.

### `revoke`

```rust
fn revoke(env, issuer: Address, holder: Address, credential_type: Symbol)
```

- **Audience:** Issuer
- **Auth:** `issuer.require_auth()`.
- **Stability:** Stable
- **Returns:** —
- **Panics:** `IssuerNotTrusted (4)` — the caller is not a *currently* trusted
  issuer for that credential type; `ProofNotFound (6)`; `NotAuthorized (3)` —
  the caller is not the issuer stored on the record.
- **Events:** `("proof_reg", "revoked", credential_type)` →
  `EventProofRevoked { holder, issuer, revoked_at }`.
- **Notes:** flags the record `revoked = true` rather than deleting it (the
  tombstone stays readable); the record's TTL is extended so the revocation
  itself remains visible. Read functions treat revoked records as invalid.

## 6. Governance & operations (Admin operations)

### `upgrade`

```rust
fn upgrade(env, new_wasm_hash: BytesN<32>)
```

- **Audience:** Admin (`upgrader` role)
- **Auth:** `require_role("upgrader")`.
- **Stability:** Operational
- **Returns:** —
- **Panics:** `RoleNotHeld (13)` if the role has no holder;
  `NotInitialized (1)` if role storage is missing.
- **Events:** `("proof_reg", "upgraded")` → `EventContractUpgraded { admin,
  new_wasm_hash, upgraded_at, from_version, to_version }` (`admin` here is the
  current *upgrader* role holder).
- **Notes:** `update_current_contract_wasm` — the new WASM must expose a
  compatible storage layout. See `MIGRATION_RUNBOOK.md`.

### `pause`

```rust
fn pause(env)
```

- **Audience:** Admin (`pauser` role)
- **Auth:** `require_role("pauser")`.
- **Stability:** Operational
- **Returns:** —
- **Panics:** `RoleNotHeld (13)` if the role has no holder;
  `NotInitialized (1)` if role storage is missing.
- **Events:** `("proof_reg", "paused")` → `EventPaused { admin, paused_at }`.
  (The payload field is named `admin` for event-ABI compatibility with
  existing indexers; it carries the *pauser* role holder.)
- **Notes:** pausing blocks only new submissions (`submit_proof`,
  `submit_proofs`, `submit_aggregate_proof`); reads, delegation and revocation
  keep working. Pausing an already-paused contract is permitted and re-emits
  the event.

### `unpause`

```rust
fn unpause(env)
```

- **Audience:** Admin (`pauser` role)
- **Auth:** `require_role("pauser")`.
- **Stability:** Operational
- **Returns:** —
- **Panics:** `RoleNotHeld (13)` if the role has no holder;
  `NotInitialized (1)` if role storage is missing.
- **Events:** `("proof_reg", "unpaused")` →
  `EventUnpaused { admin, unpaused_at }` (payload carries the *pauser* role
  holder — see `pause`).
- **Notes:** restores submission acceptance. Unpausing an already-unpaused
  contract is permitted and re-emits the event.

### `propose_admin`

```rust
fn propose_admin(env, new_admin: Address)
```

- **Audience:** Admin (root admin key)
- **Auth:** `require_admin` — root admin, not a delegatable role.
- **Stability:** Operational
- **Returns:** —
- **Panics:** `NotInitialized (1)`.
- **Events:** `("proof_reg", "adm_prop")` with the proposed address as payload.
- **Notes:** overwrites any existing pending proposal.

### `accept_admin`

```rust
fn accept_admin(env)
```

- **Audience:** Admin (pending admin)
- **Auth:** `pending.require_auth()` — only the proposed address can accept.
- **Stability:** Operational
- **Returns:** —
- **Panics:** `NoPendingAdmin (15)` if no proposal is pending;
  `NotInitialized (1)` if no admin is stored (pre-construction edge).
- **Events:** `("proof_reg", "adm_acc")` with the new admin as payload.
- **Notes:** two-step admin transfer (#343): the accepted address becomes the
  new root admin **and inherits every role the outgoing admin held**; the
  pending proposal is consumed.

### `cancel_admin_proposal`

```rust
fn cancel_admin_proposal(env)
```

- **Audience:** Admin (root admin key)
- **Auth:** `require_admin`.
- **Stability:** Operational
- **Returns:** —
- **Panics:** `NotInitialized (1)`.
- **Events:** `("proof_reg", "adm_canc")` with an empty payload.
- **Notes:** clearing a non-existent proposal is a no-op (the event is still
  emitted).

### `grant_role`

```rust
fn grant_role(env, role: Symbol, address: Address)
```

- **Audience:** Admin (root admin key)
- **Auth:** `require_admin`.
- **Stability:** Operational
- **Parameters:** `role` — role name symbol (e.g. `"admin"`, `"upgrader"`,
  `"pauser"`; new role names are allowed); `address` — new holder.
- **Returns:** —
- **Panics:** `NotInitialized (1)`.
- **Events:** none.
- **Notes:** replaces any previous holder **silently** — there is no two-step
  confirmation, so a typo'd address loses the role until re-granted.

### `revoke_role`

```rust
fn revoke_role(env, role: Symbol, address: Address)
```

- **Audience:** Admin (root admin key)
- **Auth:** `require_admin`.
- **Stability:** Operational
- **Returns:** —
- **Panics:** `NotInitialized (1)`; `RoleHolderMismatch (14)` if `address` is
  not the current holder of `role`.
- **Events:** none.
- **Notes:** revoking an unassigned role is a no-op. A role with no holder is
  simply unassigned — nobody can act under it until re-granted.

### `has_role`

```rust
fn has_role(env, role: Symbol, address: Address) -> bool
```

- **Audience:** Integrator / Admin (public view)
- **Auth:** none (public read).
- **Stability:** Operational
- **Returns:** `true` iff `address` is the current holder of `role`.
- **Panics:** none (returns `false` if role storage is missing).
- **Events:** none.

### `migrate_record`

```rust
fn migrate_record(env, holder: Address, credential_type: Symbol)
```

- **Audience:** Admin (`admin` role)
- **Auth:** `require_role("admin")`.
- **Stability:** Operational
- **Returns:** —
- **Panics:** `RoleNotHeld (13)`; `ProofNotFound (6)` if no record exists.
- **Events:** none.
- **Notes:** one-record migration from the legacy 4-field `ProofRecord` (no
  `issuer`, no `vk_version`) to the current 6-field layout. Idempotent —
  records already in the current shape are a no-op. Migrated records get
  `issuer: None` (fail closed under any `trusted_issuers` filter) and
  `vk_version: 0`. See `MIGRATION_RUNBOOK.md`.

### `migrate_data`

```rust
fn migrate_data(env)
```

- **Audience:** Admin (root admin key)
- **Auth:** root admin `require_auth` (reads `DataKey::Admin` directly — note
  this is the root admin key, which can diverge from the `admin` *role* holder
  after `grant_role` rotations).
- **Stability:** Operational
- **Returns:** —
- **Panics:** `NotInitialized (1)`.
- **Events:** none (the source comment anticipates one; none is published
  today — the migration timestamp is the audit trail).
- **Notes:** forward-compatible hook for future schema migrations. Currently
  records `LastMigrationTimestamp` and re-asserts the current schema version.

### `bump_claim`

```rust
fn bump_claim(env, holder: Address, credential_type: Symbol)
```

- **Audience:** Admin / Integrator (permissionless maintenance)
- **Auth:** none — anyone may bump a *valid* claim's storage TTL.
- **Stability:** Operational
- **Returns:** —
- **Panics:** `ProofNotFound (6)` if the record is missing, revoked, or expired.
- **Events:** none.
- **Notes:** extends the record's persistent-entry lifetime to
  `max(90 days, time until expiry)` without changing the claim. Useful for
  keepers keeping long-lived claims readable. See [STORAGE_TTL.md](./STORAGE_TTL.md)
  for full details on the storage lifetime model, rent fees, and archived vs expired state behavior.

## 7. Introspection (public views)

All of these are permissionless, emit no events, and never require auth.

### `version`

```rust
fn version(env) -> u32
```

- **Audience:** Integrator (public view)
- **Auth:** none (public read).
- **Stability:** Operational
- **Returns:** encoded contract version `(major·10⁶)+(minor·10³)+patch`
  (currently `1_000_000`, i.e. 1.0.0).
- **Panics:** never.
- **Events:** none.
- **Notes:** constant — read from contract bytecode, not storage.

### `admin`

```rust
fn admin(env) -> Address
```

- **Audience:** Integrator / Admin (public view)
- **Auth:** none (public read).
- **Stability:** Operational
- **Returns:** the current root admin address.
- **Panics:** `NotInitialized (1)` if no admin is stored.
- **Events:** none.

### `pending_admin`

```rust
fn pending_admin(env) -> Option<Address>
```

- **Audience:** Integrator / Admin (public view)
- **Auth:** none (public read).
- **Stability:** Operational
- **Returns:** the pending `propose_admin` candidate, or `None` if no proposal
  is pending.
- **Panics:** never.
- **Events:** none.

### `verifier_address`

```rust
fn verifier_address(env) -> Address
```

- **Audience:** Integrator (public view)
- **Auth:** none (public read).
- **Stability:** Operational
- **Returns:** the address of the CredentialVerifier contract submissions are
  forwarded to.
- **Panics:** `NotInitialized (1)` if unset.
- **Events:** none.

### `issuer_registry_address`

```rust
fn issuer_registry_address(env) -> Address
```

- **Audience:** Integrator (public view)
- **Auth:** none (public read).
- **Stability:** Operational
- **Returns:** the address of the IssuerRegistry contract used for issuer
  trust and key checks.
- **Panics:** `NotInitialized (1)` if unset.
- **Events:** none.

### `proof_record_schema_version`

```rust
fn proof_record_schema_version(env) -> u32
```

- **Audience:** Integrator / Admin (public view)
- **Auth:** none (public read).
- **Stability:** Operational
- **Returns:** the current `ProofRecord` schema version (defaults to `1`);
  used to detect when data migrations are needed.
- **Panics:** never.
- **Events:** none.

### `last_migration_timestamp`

```rust
fn last_migration_timestamp(env) -> u64
```

- **Audience:** Integrator / Admin (public view)
- **Auth:** none (public read).
- **Stability:** Operational
- **Returns:** unix seconds of the last data migration (`migrate_data` or
  `upgrade`), or `0` if none has occurred. Useful for audit trails and
  monitoring schema evolution.
- **Panics:** never.
- **Events:** none.

## 8. Stable integration surface vs operation surface

**Build on these — treat as ABI-frozen:**

| Operation | Function(s) | Audience |
|-----------|-------------|----------|
| Submit / refresh claims | `submit_proof`, `submit_proofs`, `submit_aggregate_proof` | Holder |
| Verify a claim | `is_verified`, `check_claim`, `get_record`, `claim_expiry` | Integrator |
| Consent-scoped reads | `grant_verification`, `revoke_verification`, `check_delegated_verification` | Holder / Integrator |
| Revoke | `revoke_proof`, `revoke_all` (holder), `revoke` (issuer) | Holder / Issuer |

**Operational / governance — may evolve between minor versions:**

`__constructor`, `upgrade`, `pause`, `unpause`, `propose_admin`,
`accept_admin`, `cancel_admin_proposal`, `grant_role`, `revoke_role`,
`has_role`, `migrate_record`, `migrate_data`, `bump_claim`, and the
introspection views in §7.

## 9. Events quick reference

| Topics | Payload | Emitted by |
|--------|---------|------------|
| `("proof_reg", "submitted", credential_type)` | `EventProofSubmitted { holder, issuer, verified_at, expiry }` | `submit_proof`, `submit_proofs`, `submit_aggregate_proof` |
| `("proof_reg", "revoked", credential_type)` | `EventProofRevoked { holder, issuer, revoked_at }` | `revoke` |
| `("proof_reg", "paused")` | `EventPaused { admin, paused_at }` | `pause` |
| `("proof_reg", "unpaused")` | `EventUnpaused { admin, unpaused_at }` | `unpause` |
| `("proof_reg", "upgraded")` | `EventContractUpgraded { admin, new_wasm_hash, upgraded_at, from_version, to_version }` | `upgrade` |
| `("proof_reg", "adm_prop")` | `Address` (proposed admin) | `propose_admin` |
| `("proof_reg", "adm_acc")` | `Address` (new admin) | `accept_admin` |
| `("proof_reg", "adm_canc")` | unit | `cancel_admin_proposal` |
| `("proof_reg", "dlg_grant", credential_type)` | `EventVerificationGranted { holder, verifier, expiry }` | `grant_verification` |
| `("proof_reg", "dlg_revok", credential_type)` | `EventVerificationRevoked { holder, verifier }` | `revoke_verification` |

Full payload/field documentation: [EVENTS.md](EVENTS.md).

## 10. Error codes

| Code | Variant | Meaning |
|------|---------|---------|
| 1 | `NotInitialized` | A required instance-storage entry (admin, verifier, issuer registry, roles) is missing. |
| 2 | `VerificationFailed` | The ZK proof did not verify against CredentialVerifier. |
| 3 | `NotAuthorized` | `revoke` called by an issuer that is not the issuer stored on the record. |
| 4 | `IssuerNotTrusted` | The issuer is not registered for that credential type (or no longer trusted). |
| 5 | `IssuerKeyMismatch` | The pubkey in `public_inputs` does not match a registered/current issuer key. |
| 6 | `ProofNotFound` | No record exists for `(holder, credential_type)` — or it is revoked/expired where that matters (`bump_claim`). |
| 7 | `BatchTooLarge` | More than 5 entries in `submit_proofs`. |
| 8 | `BatchEmpty` | Zero entries in `submit_proofs`. |
| 9 | `DuplicateCredentialType` | The batch contains two entries for the same credential type. |
| 10 | `AggregateLayoutInvalid` | Aggregate arity/layout does not match the circuit's public inputs. |
| 11 | `SubmissionsPaused` | New submissions are paused. |
| 12 | `InvalidExpiry` | `expiry` is in the past or more than 365 days out. |
| 13 | `RoleNotHeld` | The required role has no holder (or the caller is not its holder). |
| 14 | `RoleHolderMismatch` | `revoke_role` named an address that is not the current role holder. |
| 15 | `NoPendingAdmin` | `accept_admin` called without a pending `propose_admin`. |

Client-side friendly messages: `frontend/lib/contract-errors.ts`
(`PROOF_REGISTRY_ERRORS`). Cross-contract failures can also surface
IssuerRegistry / CredentialVerifier error codes — see
[contract-error-codes.md](contract-error-codes.md).

## Drift protection

This document is checked against the contract source by
`scripts/check-api-reference.mjs`, which runs in CI (and via
`make check-api-reference`): every public entrypoint in
`contracts/proof_registry/src/lib.rs` must have a `### \`fn_name\`` section
here with **Audience**, **Auth** and **Panics** lines, no stale sections may
remain, and every `Error` variant must appear in the §10 table. If you add,
remove or rename an entrypoint, update this file in the same PR — CI will fail
otherwise.

# Contract Storage TTL & State Archival Strategy

This document defines the storage lifetime model, Time-To-Live (TTL) configuration, rent management, and state archival behavior across all StellarCred Soroban smart contracts.

---

## 1. Overview & Stellar State Archival Model

Soroban smart contracts use a state archival model where persistent and temporary ledger entries have an associated TTL (measured in ledgers, where 1 ledger ≈ 5 seconds). Every persistent storage entry incurs ongoing state rent. If an entry's TTL is not extended before it reaches 0, the entry is archived by the network:
- **Active State**: The entry exists in active ledger state and can be read or mutated by contract invocations.
- **Archived State**: The entry is moved to archival storage. Contract read operations return empty (`None`), and writes targeting the entry without prior restoration fail or create a fresh entry. An archived entry can be restored using a dedicated Soroban state restoration transaction.
- **Credential Expiry vs. Storage Lapse**: A credential's validity expiry (`expiry` timestamp) is an application-level constraint set by the issuer. Storage TTL is a ledger-level resource constraint. These operate on **two independent clocks**.

---

## 2. Storage Lifetime Model Per Contract

### 2.1 `ProofRegistry`

The `ProofRegistry` stores cached zero-knowledge proof verification records and verification delegations in persistent storage.

| Constant | Value (Ledgers) | Equivalent Time | Purpose |
| :--- | :--- | :--- | :--- |
| `DAY_IN_LEDGERS` | `17,280` | 1 day (at 5s/ledger) | Baseline ledger count for 24 hours. |
| `PROOF_BUMP_THRESHOLD` | `17,280` | 1 day | Minimum remaining TTL before an extension triggers. |
| `PROOF_TTL` | `1,555,200` | 90 days | Default persistent storage TTL for proof records. |
| `MAX_CREDENTIAL_TTL_SECS` | `31,536,000` | 365 days (1 year) | Maximum allowable credential validity window. |

#### Storage Keys & Lifetimes

- **Proof Records (`DataKey::Proof(holder, credential_type)`)**:
  - **Type**: Persistent storage.
  - **Payload**: `ProofRecord { verified_at, expiry, threshold, revoked, issuer, vk_version }`.
  - **Initial TTL**: `max(PROOF_TTL, ceil((expiry - now) / 5))`. If a credential's expiry is 180 days out, the initial storage TTL matches the full 180 days.
  - **Who Extends**:
    - **On Submission**: Automatically extended on `submit_proof`, `submit_proof_batch`, and `submit_proofs_batch`.
    - **On Read**: Automatically extended when calling `claim_expiry`.
    - **Holder Maintenance**: Any caller (typically the holder or their wallet agent) can call `bump_claim(holder, credential_type)` to extend rent without submitting a new proof.
    - **On Issuer Revocation**: Extended when an issuer marks a record as revoked.
- **Delegation Grants (`DataKey::Delegation(holder, verifier, credential_type)`)**:
  - **Type**: Persistent storage.
  - **Payload**: `u64` (delegation expiry timestamp).
  - **Initial TTL**: Set through delegation `expiry` via `bump_ttl`.
  - **Who Extends**: The holder by re-calling `grant_verification`.

#### Cost Model

- State rent is paid in **XLM** through Soroban transaction resource fees (`extend_ttl_op` footprint).
- Cost is proportional to entry byte size (approx. 128 bytes for `ProofRecord`) multiplied by the number of ledgers extended.
- Transaction submitters (holders, verifiers, or dApps) pay the fee at the time of submission or bumping.

---

### 2.2 `CredentialVerifier`

The `CredentialVerifier` stores UltraHonk verifying keys (VKs) and version pointers.

| Constant | Value (Ledgers) | Equivalent Time | Purpose |
| :--- | :--- | :--- | :--- |
| `VK_BUMP_THRESHOLD` | `17,280` | 1 day | Threshold for extending VK entries. |
| `VK_TTL` | `1,555,200` | 90 days | Storage TTL for verifying keys. |

#### Storage Keys & Lifetimes

- **Verifying Keys (`DataKey::Vk(credential_type, version)`)**:
  - **Type**: Persistent storage.
  - **Payload**: `Bytes` (UltraHonk VK bytecode, ~1,500 bytes).
  - **Who Extends**: Admin on registration (`register_vk`), update (`update_vk`), and via `refresh_latest_version_ttl(credential_type)`.
- **Latest Version Pointer (`DataKey::LatestVersion(credential_type)`)**:
  - **Type**: Persistent storage.
  - **Payload**: `u32`.
  - **Who Extends**: Admin on registration, update, or `refresh_latest_version_ttl`.

---

### 2.3 `IssuerRegistry`

The `IssuerRegistry` tracks authorized issuer public keys, metadata, and key rotation histories.

| Constant | Value (Ledgers) | Equivalent Time | Purpose |
| :--- | :--- | :--- | :--- |
| `BUMP_THRESHOLD` | `17,280` | 1 day | Threshold for extending issuer entries. |
| `ENTRY_TTL` | `1,555,200` | 90 days | Persistent storage TTL for issuer entries. |

#### Storage Keys & Lifetimes

- **Issuer Records (`DataKey::Issuer(issuer)`)**: Extended on `register_issuer`, `rotate_issuer_key`, `revoke_issuer`, and `set_issuer_metadata`.
- **Issuer Key History (`DataKey::IssuerKeys(issuer)`)**: Extended during key rotation and by admin calling `refresh_issuer_keys_ttl(issuer)`.
- **Issuer List & Count (`DataKey::IssuerList(index)`, `DataKey::IssuerCount`)**: Extended on new issuer registration.

---

### 2.4 `GatedPool`

The `GatedPool` maintains user deposit balances.

| Constant | Value (Ledgers) | Equivalent Time | Purpose |
| :--- | :--- | :--- | :--- |
| `BALANCE_BUMP_THRESHOLD` | `17,280` | 1 day | Minimum remaining TTL for user balance entries. |
| `BALANCE_TTL` | `1,555,200` | 90 days | Storage TTL for user balances. |

#### Storage Keys & Lifetimes

- **User Balance (`DataKey::Balance(user)`)**:
  - **Type**: Persistent storage.
  - **Payload**: `i128`.
  - **Who Extends**: Automatically extended on `deposit` and `withdraw`.

---

## 3. Observable Behavior: Archived State vs. Expired State

Understanding the difference between an **Archived Entry** (storage TTL lapsed) and an **Expired Credential** (application time elapsed) is critical for downstream protocols and UI clients:

| Operation | Active Valid Claim | Active Expired Claim (`now >= expiry`) | Archived / Lapsed Entry (`TTL == 0`) |
| :--- | :--- | :--- | :--- |
| `is_verified` | `(true, verified_at, expiry)` | `(false, verified_at, expiry)` | `(false, 0, 0)` |
| `check_claim` | `true` | `false` | `false` |
| `get_record` | `Some(ProofRecord)` | `Some(ProofRecord)` *(records expiry)* | `None` |
| `claim_expiry` | `expiry` *(bumps TTL)* | `expiry` *(bumps TTL)* | `0` |
| `bump_claim` | Succeeds (extends TTL) | Panics (`Error::ProofNotFound`) | Panics (`Error::ProofNotFound`) |
| `check_delegated_verification` | `(true, verified_at, expiry)` | `(false, verified_at, expiry)` | `(false, 0, 0)` |

### Key Distinctions for Integrators:
1. **Differentiating "Never Submitted / Archived" from "Submitted & Expired"**:
   - When querying `is_verified`, an archived entry returns `(false, 0, 0)` because the storage record no longer exists in active state.
   - An expired claim that is still present in storage returns `(false, verified_at, expiry)` with `expiry > 0`. This allows verifiers and indexers to confirm that a valid proof was once submitted, even after its validity window has passed.
2. **Maintenance Responsibility**:
   - Holders wishing to keep historical proof verification records accessible on-chain past 90 days without re-proving must call `bump_claim(holder, credential_type)` periodically or ensure verifiers call `claim_expiry`.
   - If an entry lapses into archival state, the holder must either restore the persistent entry via a Stellar archival restoration transaction or re-prove and submit a fresh proof.

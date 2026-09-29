# StellarCred Contract Events Schema

This document authoritatively specifies every event emitted by StellarCred's Soroban contracts, their exact topic structure, payload data types, emission triggers, and stability guarantees for off-chain indexers and protocol integrators.

---

## Architecture & Topic Convention

All StellarCred contract events follow a deterministic, structured topic tuple convention:

```text
( contract: Symbol, action: Symbol[, credential_type: Symbol] )
```

### Topic Structure

| Topic Index | Field | Type | Description |
|---|---|---|---|
| `topics[0]` | `contract` | `Symbol` | Contract identifier: `"proof_reg"`, `"iss_reg"`, `"cred_ver"`, or `"gate_pool"`. |
| `topics[1]` | `action` | `Symbol` | Operation verb describing the event action (e.g. `"submitted"`, `"revoked"`, `"paused"`, `"unpaused"`, `"register"`, `"vk_set"`, `"vk_pruned"`, `"deposit"`, `"withdraw"`). |
| `topics[2]` | `credential_type` | `Symbol` | *(Optional)* The credential type involved (e.g. `"kyc"`, `"age"`, `"income"`, `"funds"`, `"jurisdiction"`, `"accreditation"`, `"employment"`). Included for credential-scoped events; omitted (tuple length 2) for system- or global-scoped events. |

### Payload Serialization

All event data payloads are typed `#[contracttype]` structs serialized using Soroban's canonical XDR encoding. Payloads can be decoded deterministically using `@stellar/stellar-sdk`'s `scValToNative` or standard XDR deserializers.

---

## Complete Event Catalog

| Contract | Event | Topics Tuple | Payload Struct | Emitting Method(s) | Authorization |
|---|---|---|---|---|---|
| `ProofRegistry` | `submitted` | `("proof_reg", "submitted", <credential_type>)` | `EventProofSubmitted` | `submit_proof`, `submit_proofs`, `submit_aggregate_proof` | Holder |
| `ProofRegistry` | `revoked` | `("proof_reg", "revoked", <credential_type>)` | `EventProofRevoked` | `revoke` | Issuer |
| `ProofRegistry` | `paused` | `("proof_reg", "paused")` | `EventPaused` | `pause` | Admin |
| `ProofRegistry` | `unpaused` | `("proof_reg", "unpaused")` | `EventUnpaused` | `unpause` | Admin |
| `ProofRegistry` | `adm_prop` | `("proof_reg", "adm_prop")` | `Address` | `propose_admin` | Admin |
| `ProofRegistry` | `adm_acc` | `("proof_reg", "adm_acc")` | `Address` | `accept_admin` | Pending admin |
| `ProofRegistry` | `adm_canc` | `("proof_reg", "adm_canc")` | `()` | `cancel_admin_proposal` | Admin |
| `IssuerRegistry` | `register` | `("iss_reg", "register")` | `EventIssuerRegistered` | `register_issuer` | Admin |
| `IssuerRegistry` | `revoked` | `("iss_reg", "revoked")` | `EventIssuerRevoked` | `revoke_issuer` | Admin |
| `IssuerRegistry` | `key_rot` | `("iss_reg", "key_rot")` | `EventIssuerKeyRotated` | `rotate_issuer_key` | Admin |
| `IssuerRegistry` | `key_revk` | `("iss_reg", "key_revk")` | `EventIssuerKeyRevoked` | `revoke_issuer_key` | Admin |
| `IssuerRegistry` | `adm_prop` | `("iss_reg", "adm_prop")` | `Address` | `propose_admin` | Admin |
| `IssuerRegistry` | `adm_acc` | `("iss_reg", "adm_acc")` | `Address` | `accept_admin` | Pending admin |
| `IssuerRegistry` | `adm_canc` | `("iss_reg", "adm_canc")` | `()` | `cancel_admin_proposal` | Admin |
| `CredentialVerifier` | `vk_set` | `("cred_ver", "vk_set", <credential_type>)` | `EventVkSet` | `set_vk` | Admin |
| `CredentialVerifier` | `vk_pruned` | `("cred_ver", "vk_pruned", <credential_type>)` | `EventVkPruned` | `prune_version` | Admin |
| `CredentialVerifier` | `adm_prop` | `("cred_ver", "adm_prop")` | `Address` | `propose_admin` | Admin |
| `CredentialVerifier` | `adm_acc` | `("cred_ver", "adm_acc")` | `Address` | `accept_admin` | Pending admin |
| `CredentialVerifier` | `adm_canc` | `("cred_ver", "adm_canc")` | `()` | `cancel_admin_proposal` | Admin |
| `GatedPool` | `deposit` | `("gate_pool", "deposit")` | `EventDeposit` | `deposit` | Caller |
| `GatedPool` | `withdraw` | `("gate_pool", "withdraw")` | `EventWithdraw` | `withdraw` | Caller |

---

## Contract Event Specifications

### 1. ProofRegistry (`contract = "proof_reg"`)

#### `proof_reg.submitted` — Proof Verified and Stored

Emitted when a zero-knowledge proof is cryptographically verified against the registered issuer's public key and cached in persistent storage.

- **Topics:** `("proof_reg", "submitted", <credential_type>)`
  - `topics[0]`: `symbol_short!("proof_reg")` (`Symbol("proof_reg")`)
  - `topics[1]`: `symbol_short!("submitted")` (`Symbol("submitted")`)
  - `topics[2]`: `<credential_type>` (`Symbol`)
- **Payload (`EventProofSubmitted`):**
  ```rust
  pub struct EventProofSubmitted {
      pub holder: Address,
      pub issuer: Address,
      pub verified_at: u64,
      pub expiry: u64,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `holder` | `Address` | Stellar address of the credential holder whose proof was verified. |
  | `issuer` | `Address` | Address of the registered issuer that signed the credential commitment. |
  | `verified_at` | `u64` | Ledger timestamp (seconds) when the proof was verified and recorded. |
  | `expiry` | `u64` | Ledger timestamp (seconds) when the cached proof expires. |
- **When it fires:**
  - `submit_proof`: Emitted once on successful verification and storage.
  - `submit_proofs` (batch): Emitted once for each valid proof entry in the batch after all entries succeed.
  - `submit_aggregate_proof`: Emitted once for each credential type proved in the aggregate proof.

---

#### `proof_reg.revoked` — Issuer Revocation

Emitted when a trusted issuer explicitly revokes a holder's cached proof for a credential type.

- **Topics:** `("proof_reg", "revoked", <credential_type>)`
  - `topics[0]`: `symbol_short!("proof_reg")` (`Symbol("proof_reg")`)
  - `topics[1]`: `symbol_short!("revoked")` (`Symbol("revoked")`)
  - `topics[2]`: `<credential_type>` (`Symbol`)
- **Payload (`EventProofRevoked`):**
  ```rust
  pub struct EventProofRevoked {
      pub holder: Address,
      pub issuer: Address,
      pub revoked_at: u64,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `holder` | `Address` | Stellar address of the holder whose proof was revoked. |
  | `issuer` | `Address` | Address of the registered issuer executing the revocation. |
  | `revoked_at` | `u64` | Ledger timestamp (seconds) when the revocation was executed. |
- **When it fires:**
  - `revoke(issuer, holder, credential_type)`: Emitted when the registered issuer marks the proof record as revoked.

#### `proof_reg.self_rev` — Holder Self-Revocation

Emitted when a holder removes one or all of their cached proofs.

- **Topics:** `("proof_reg", "self_rev", <credential_type>)`
- **Payload (`EventHolderRevoked`):**
  ```rust
  pub struct EventHolderRevoked {
      pub holder: Address,
      pub revoked_at: u64,
  }
  ```
- **When it fires:**
  - `revoke_proof`: Emitted when the holder removes an existing proof.
  - `revoke_all`: Emitted once for each existing proof removed.

---

#### `proof_reg.paused` — Submissions Paused

Emitted when protocol administration pauses new proof submissions.

- **Topics:** `("proof_reg", "paused")`
  - `topics[0]`: `symbol_short!("proof_reg")` (`Symbol("proof_reg")`)
  - `topics[1]`: `symbol_short!("paused")` (`Symbol("paused")`)
- **Payload (`EventPaused`):**
  ```rust
  pub struct EventPaused {
      pub admin: Address,
      pub paused_at: u64,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `admin` | `Address` | Admin address that paused submissions. |
  | `paused_at` | `u64` | Ledger timestamp (seconds) when paused. |
- **When it fires:**
  - `pause()`: Admin pauses submissions.

---

#### `proof_reg.unpaused` — Submissions Unpaused

Emitted when protocol administration resumes proof submissions.

- **Topics:** `("proof_reg", "unpaused")`
  - `topics[0]`: `symbol_short!("proof_reg")` (`Symbol("proof_reg")`)
  - `topics[1]`: `symbol_short!("unpaused")` (`Symbol("unpaused")`)
- **Payload (`EventUnpaused`):**
  ```rust
  pub struct EventUnpaused {
      pub admin: Address,
      pub unpaused_at: u64,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `admin` | `Address` | Admin address that resumed submissions. |
  | `unpaused_at` | `u64` | Ledger timestamp (seconds) when unpaused. |
- **When it fires:**
  - `unpause()`: Admin unpauses submissions.

---

#### `proof_reg.adm_prop` — Admin Transfer Proposed

Emitted when the root admin proposes a new admin address (#343). The proposal
sits in instance storage until the proposed address accepts it, a newer
proposal overwrites it, or the root admin cancels it.

- **Topics:** `("proof_reg", "adm_prop")`
  - `topics[0]`: `symbol_short!("proof_reg")` (`Symbol("proof_reg")`)
  - `topics[1]`: `symbol_short!("adm_prop")` (`Symbol("adm_prop")`)
- **Payload:** `Address` — the proposed new root admin.
- **When it fires:**
  - `propose_admin(new_admin)`: Root admin proposes a new admin. Overwrites any existing pending proposal.
- **Monitoring:** an unexpected proposal signals a pending governance change — verify the proposed address is intended before it accepts.

---

#### `proof_reg.adm_acc` — Admin Transfer Accepted

Emitted when the pending admin candidate accepts the transfer (#343). On
acceptance the candidate becomes the new root admin AND inherits every role the
outgoing admin held; the outgoing admin loses all privileged access.

- **Topics:** `("proof_reg", "adm_acc")`
  - `topics[0]`: `symbol_short!("proof_reg")` (`Symbol("proof_reg")`)
  - `topics[1]`: `symbol_short!("adm_acc")` (`Symbol("adm_acc")`)
- **Payload:** `Address` — the address that accepted and is now root admin.
- **When it fires:**
  - `accept_admin()`: Pending candidate accepts the proposed transfer.

---

#### `proof_reg.adm_canc` — Admin Proposal Cancelled

Emitted when the root admin cancels a pending admin proposal (#343). No
transfer takes place and the pending entry is cleared.

- **Topics:** `("proof_reg", "adm_canc")`
  - `topics[0]`: `symbol_short!("proof_reg")` (`Symbol("proof_reg")`)
  - `topics[1]`: `symbol_short!("adm_canc")` (`Symbol("adm_canc")`)
- **Payload:** `()` — empty.
- **When it fires:**
  - `cancel_admin_proposal()`: Root admin cancels the pending proposal.

---

#### Non-Event Operations in ProofRegistry

| Function | Description | Reason No Event Emitted |
|---|---|---|
| `upgrade` | Contract bytecode upgrade | Handled directly by Soroban's WASM deployer host function (`update_current_contract_wasm`). |
| `bump_claim` | Storage TTL extension | Maintenance operation renewing persistent entry rent. |
| `migrate_record` | Legacy storage shape migration | Internal migration upgrading legacy storage formats to current `ProofRecord` structure. |

---

### 2. IssuerRegistry (`contract = "iss_reg"`)

#### `iss_reg.register` — Issuer Registered or Updated

Emitted when an issuer is registered or their public key/credential types are updated.

- **Topics:** `("iss_reg", "register")`
  - `topics[0]`: `symbol_short!("iss_reg")` (`Symbol("iss_reg")`)
  - `topics[1]`: `symbol_short!("register")` (`Symbol("register")`)
- **Payload (`EventIssuerRegistered`):**
  ```rust
  pub struct EventIssuerRegistered {
      pub issuer: Address,
      pub pubkey: BytesN<64>,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `issuer` | `Address` | Stellar address of the newly registered or updated issuer. |
  | `pubkey` | `BytesN<64>` | The issuer's secp256k1 public key (`x ‖ y`, 32 bytes each). |
- **When it fires:**
  - `register_issuer(issuer_id, pubkey, credential_types)`: Admin registers or updates an issuer.

---

#### `iss_reg.revoked` — Issuer Revoked

Emitted when an issuer is revoked by administration.

- **Topics:** `("iss_reg", "revoked")`
  - `topics[0]`: `symbol_short!("iss_reg")` (`Symbol("iss_reg")`)
  - `topics[1]`: `symbol_short!("revoked")` (`Symbol("revoked")`)
- **Payload (`EventIssuerRevoked`):**
  ```rust
  pub struct EventIssuerRevoked {
      pub issuer: Address,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `issuer` | `Address` | Address of the revoked issuer. |
- **When it fires:**
  - `revoke_issuer(issuer_id)`: Admin marks an issuer as revoked.

---

#### `iss_reg.key_rot` — Issuer Signing Key Rotated

Emitted when an admin rotates an issuer's signing key. The previous key is
retired with a validity window so credentials it already signed keep verifying;
new issuance uses the new key.

- **Topics:** `("iss_reg", "key_rot")`
  - `topics[0]`: `symbol_short!("iss_reg")` (`Symbol("iss_reg")`)
  - `topics[1]`: `symbol_short!("key_rot")` (`Symbol("key_rot")`)
- **Payload (`EventIssuerKeyRotated`):**
  ```rust
  pub struct EventIssuerKeyRotated {
      pub issuer: Address,
      pub old_pubkey: BytesN<64>,
      pub new_pubkey: BytesN<64>,
      pub old_key_valid_until: u64,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `issuer` | `Address` | Issuer whose key set changed. |
  | `old_pubkey` | `BytesN<64>` | Key that stopped being the current signing key. |
  | `new_pubkey` | `BytesN<64>` | Key that is current from now on. |
  | `old_key_valid_until` | `u64` | Ledger timestamp after which `old_pubkey` stops validating submissions (inclusive). |
- **When it fires:**
  - `rotate_issuer_key(issuer_id, new_pubkey, old_key_valid_until)`: Admin rotates the key, retiring the old one with a validity window.
- **Monitoring:** ticket for review — confirm the window covers the issuer's outstanding credential expiries and that the signing environment was cut over to `new_pubkey`. An unscheduled rotation should be treated as an incident.

---

#### `iss_reg.key_revk` — Issuer Signing Key Revoked

Emitted when an admin emergency-revokes one of an issuer's signing keys. Unlike
a rotation, the key stops validating immediately, regardless of its validity
window.

- **Topics:** `("iss_reg", "key_revk")`
  - `topics[0]`: `symbol_short!("iss_reg")` (`Symbol("iss_reg")`)
  - `topics[1]`: `symbol_short!("key_revk")` (`Symbol("key_revk")`)
- **Payload (`EventIssuerKeyRevoked`):**
  ```rust
  pub struct EventIssuerKeyRevoked {
      pub issuer: Address,
      pub pubkey: BytesN<64>,
      pub was_current: bool,
      pub revoked_at: u64,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `issuer` | `Address` | Issuer whose key set changed. |
  | `pubkey` | `BytesN<64>` | The key that was killed. |
  | `was_current` | `bool` | `true` when it was the current signing key — the issuer cannot issue until an admin rotates to a new key. `false` when it was a retired key still inside its window. |
  | `revoked_at` | `u64` | Ledger timestamp at which the revocation took effect. |
- **When it fires:**
  - `revoke_issuer_key(issuer_id, pubkey)`: Admin emergency-revokes a key, e.g. on suspected compromise.
- **Monitoring:** page immediately — either a compromise or a broken rotation.

---

#### `iss_reg.adm_prop` — Admin Transfer Proposed

Emitted when the root admin proposes a new admin address (#342). The proposal
sits in instance storage until the proposed address accepts it, a newer
proposal overwrites it, or the root admin cancels it.

- **Topics:** `("iss_reg", "adm_prop")`
  - `topics[0]`: `symbol_short!("iss_reg")` (`Symbol("iss_reg")`)
  - `topics[1]`: `symbol_short!("adm_prop")` (`Symbol("adm_prop")`)
- **Payload:** `Address` — the proposed new root admin.
- **When it fires:**
  - `propose_admin(new_admin)`: Root admin proposes a new admin. Overwrites any existing pending proposal.
- **Monitoring:** an unexpected proposal signals a pending governance change — verify the proposed address is intended before it accepts.

---

#### `iss_reg.adm_acc` — Admin Transfer Accepted

Emitted when the pending admin candidate accepts the transfer (#342). On
acceptance the candidate becomes the new root admin AND inherits every role the
outgoing admin held; the outgoing admin loses all privileged access.

- **Topics:** `("iss_reg", "adm_acc")`
  - `topics[0]`: `symbol_short!("iss_reg")` (`Symbol("iss_reg")`)
  - `topics[1]`: `symbol_short!("adm_acc")` (`Symbol("adm_acc")`)
- **Payload:** `Address` — the address that accepted and is now root admin.
- **When it fires:**
  - `accept_admin()`: Pending candidate accepts the proposed transfer.

---

#### `iss_reg.adm_canc` — Admin Proposal Cancelled

Emitted when the root admin cancels a pending admin proposal (#342). No
transfer takes place and the pending entry is cleared.

- **Topics:** `("iss_reg", "adm_canc")`
  - `topics[0]`: `symbol_short!("iss_reg")` (`Symbol("iss_reg")`)
  - `topics[1]`: `symbol_short!("adm_canc")` (`Symbol("adm_canc")`)
- **Payload:** `()` — empty.
- **When it fires:**
  - `cancel_admin_proposal()`: Root admin cancels the pending proposal.

---

#### Non-Event Operations in IssuerRegistry

| Function | Description | Reason No Event Emitted |
|---|---|---|
| `set_issuer_metadata` | Optional name, URL, logo metadata | Stored directly in persistent entry `DataKey::IssuerMetadata(issuer)` for read-only lookups. |
| `refresh_issuer_keys_ttl` | Extends the lifetime of an issuer's record and key history | Lifetime maintenance only; it changes no issuer state that the events above report. |

Key rotation and revocation are covered above; see
[ISSUER_KEY_ROTATION.md](ISSUER_KEY_ROTATION.md) for the operational procedure.

---

### 3. CredentialVerifier (`contract = "cred_ver"`)

#### `cred_ver.vk_set` — Verification Key Registered

Emitted when a verification key (VK) is registered for a circuit.

- **Topics:** `("cred_ver", "vk_set", <credential_type>)`
  - `topics[0]`: `symbol_short!("cred_ver")` (`Symbol("cred_ver")`)
  - `topics[1]`: `symbol_short!("vk_set")` (`Symbol("vk_set")`)
  - `topics[2]`: `<credential_type>` (`Symbol`)
- **Payload (`EventVkSet`):**
  ```rust
  pub struct EventVkSet {
      pub admin: Address,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `admin` | `Address` | Admin address that registered the verification key. |
- **When it fires:**
  - `set_vk(credential_type, version, vk)`: Admin registers a validated UltraHonk VK.

---

#### `cred_ver.vk_pruned` — Obsolete Verification Key Pruned

Emitted when deprecated VK bytes are permanently pruned from storage after the mandatory 90-day safety delay.

- **Topics:** `("cred_ver", "vk_pruned", <credential_type>)`
  - `topics[0]`: `symbol_short!("cred_ver")` (`Symbol("cred_ver")`)
  - `topics[1]`: `symbol_short!("vk_pruned")` (`Symbol("vk_pruned")`)
  - `topics[2]`: `<credential_type>` (`Symbol`)
- **Payload (`EventVkPruned`):**
  ```rust
  pub struct EventVkPruned {
      pub admin: Address,
      pub version: u32,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `admin` | `Address` | Admin address executing the pruning. |
  | `version` | `u32` | Version number of the pruned verification key. |
- **When it fires:**
  - `prune_version(credential_type, version)`: Admin prunes deprecated VK bytes.

---

#### `cred_ver.adm_prop` — Admin Transfer Proposed

Emitted when the root admin proposes a new admin address (#342). The proposal
sits in instance storage until the proposed address accepts it, a newer
proposal overwrites it, or the root admin cancels it.

- **Topics:** `("cred_ver", "adm_prop")`
  - `topics[0]`: `symbol_short!("cred_ver")` (`Symbol("cred_ver")`)
  - `topics[1]`: `symbol_short!("adm_prop")` (`Symbol("adm_prop")`)
- **Payload:** `Address` — the proposed new root admin.
- **When it fires:**
  - `propose_admin(new_admin)`: Root admin proposes a new admin. Overwrites any existing pending proposal.
- **Monitoring:** an unexpected proposal signals a pending governance change — verify the proposed address is intended before it accepts.

---

#### `cred_ver.adm_acc` — Admin Transfer Accepted

Emitted when the pending admin candidate accepts the transfer (#342). On
acceptance the candidate becomes the new root admin AND inherits every role the
outgoing admin held; the outgoing admin loses all privileged access.

- **Topics:** `("cred_ver", "adm_acc")`
  - `topics[0]`: `symbol_short!("cred_ver")` (`Symbol("cred_ver")`)
  - `topics[1]`: `symbol_short!("adm_acc")` (`Symbol("adm_acc")`)
- **Payload:** `Address` — the address that accepted and is now root admin.
- **When it fires:**
  - `accept_admin()`: Pending candidate accepts the proposed transfer.

---

#### `cred_ver.adm_canc` — Admin Proposal Cancelled

Emitted when the root admin cancels a pending admin proposal (#342). No
transfer takes place and the pending entry is cleared.

- **Topics:** `("cred_ver", "adm_canc")`
  - `topics[0]`: `symbol_short!("cred_ver")` (`Symbol("cred_ver")`)
  - `topics[1]`: `symbol_short!("adm_canc")` (`Symbol("adm_canc")`)
- **Payload:** `()` — empty.
- **When it fires:**
  - `cancel_admin_proposal()`: Root admin cancels the pending proposal.

---

#### Non-Event Operations in CredentialVerifier

| Function | Description | Reason No Event Emitted |
|---|---|---|
| `deprecate_version` | Marks VK version as deprecated | Updates persistent status flag `DeprecatedVersion` without event emission. |
| `refresh_latest_version_ttl` | Extends TTL of latest pointer and VK blob | Maintenance rent-renewal operation. |
| `verify_proof` | Stateless cryptographic verification | Pure read-only computation returning boolean result. |

---

### 4. GatedPool (`contract = "gate_pool"`)

#### `gate_pool.deposit` — Gated Deposit

Emitted when a caller successfully deposits into the pool after passing the KYC/claim gate.

- **Topics:** `("gate_pool", "deposit")`
  - `topics[0]`: `symbol_short!("gate_pool")` (`Symbol("gate_pool")`)
  - `topics[1]`: `symbol_short!("deposit")` (`Symbol("deposit")`)
- **Payload (`EventDeposit`):**
  ```rust
  pub struct EventDeposit {
      pub caller: Address,
      pub amount: i128,
      pub new_balance: i128,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `caller` | `Address` | Address depositing funds into the pool. |
  | `amount` | `i128` | Amount deposited. |
  | `new_balance` | `i128` | Caller's resulting balance after deposit. |
- **When it fires:**
  - `deposit(caller, amount)`: Verified caller deposits into pool.

---

#### `gate_pool.withdraw` — Balance Withdrawal

Emitted when a caller withdraws from their balance.

- **Topics:** `("gate_pool", "withdraw")`
  - `topics[0]`: `symbol_short!("gate_pool")` (`Symbol("gate_pool")`)
  - `topics[1]`: `symbol_short!("withdraw")` (`Symbol("withdraw")`)
- **Payload (`EventWithdraw`):**
  ```rust
  pub struct EventWithdraw {
      pub caller: Address,
      pub amount: i128,
      pub new_balance: i128,
  }
  ```
  | Field | Type | Description |
  |---|---|---|
  | `caller` | `Address` | Address withdrawing funds. |
  | `amount` | `i128` | Amount withdrawn. |
  | `new_balance` | `i128` | Caller's resulting balance after withdrawal. |
- **When it fires:**
  - `withdraw(caller, amount)`: Balance owner withdraws from pool.

---

## Credential Types Reference

| Symbol | Rust Construction | Public Input Threshold Field | Description |
|---|---|---|---|
| `kyc` | `symbol_short!("kyc")` | None | Identity verification by an accredited KYC provider. |
| `age` | `symbol_short!("age")` | `threshold_years` (Field 66) | Proof that holder's age meets or exceeds a threshold. |
| `income` | `symbol_short!("income")` | `threshold` (Field 65) | Annual income threshold verification. |
| `funds` | `symbol_short!("funds")` | `threshold` (Field 65) | Liquid balance threshold verification. |
| `jurisdiction` | `Symbol::new(env, "jurisdiction")` | None | Country / regional jurisdiction allowlist compliance. |
| `accreditation` | `Symbol::new(env, "accreditation")` | `threshold` (Field 65) | Accredited investor status verification. |
| `employment` | `Symbol::new(env, "employment")` | `threshold` (Field 65) | Employer / employment credential verification. |

---

## Indexer Subscription & Filtering Guide

Off-chain indexers (e.g. `services/indexer`) monitor events using Soroban RPC `getEvents` or Horizon `/contracts/{id}/events`.

### RPC Filter Patterns

```javascript
// 1. All proof submissions across all credential types:
{
  filters: [{
    type: "contract",
    contractIds: [PROOF_REGISTRY_ID],
    topics: [["AAAAEQAAAAAJcHJvb2ZfcmVn", "AAAAEQAAAAAJc3VibWl0dGVk"]] // ["proof_reg", "submitted"]
  }]
}

// 2. KYC proof submissions specifically:
{
  filters: [{
    type: "contract",
    contractIds: [PROOF_REGISTRY_ID],
    topics: [["AAAAEQAAAAAJcHJvb2ZfcmVn", "AAAAEQAAAAAJc3VibWl0dGVk", "AAAAEQAAAANreWM="]] // ["proof_reg", "submitted", "kyc"]
  }]
}

// 3. All issuer registrations:
{
  filters: [{
    type: "contract",
    contractIds: [ISSUER_REGISTRY_ID],
    topics: [["AAAAEQAAAAdpc3NfcmVn", "AAAAEQAAAAhyZWdpc3Rlcg=="]] // ["iss_reg", "register"]
  }]
}

// 4. Gated pool deposits:
{
  filters: [{
    type: "contract",
    contractIds: [GATED_POOL_ID],
    topics: [["AAAAEQAAAApnYXRlX3Bvb2w=", "AAAAEQAAAAdkZXBvc2l0"]] // ["gate_pool", "deposit"]
  }]
}
```

### Type Deserialization Mapping

| Soroban SDK Rust Type | Soroban ScVal XDR | JavaScript / SDK Type |
|---|---|---|
| `Address` | `ScVal::Address` | `string` (Stellar StrKey `G...` or `C...`) |
| `Symbol` | `ScVal::Symbol` | `string` |
| `u64` | `ScVal::U64` | `number` / `bigint` (Unix timestamp in seconds) |
| `u32` | `ScVal::U32` | `number` |
| `i128` | `ScVal::I128` | `bigint` / `string` |
| `BytesN<64>` | `ScVal::Bytes` | `Buffer` / `Uint8Array` (64 bytes hex) |

---

## Schema Stability Guarantees & Drift Prevention

1. **Immutable Topic Schemas**: Topic position and symbol values are guaranteed stable across contract upgrades.
2. **Deterministic Payload Layout**: Field names, types, and ordering in `#[contracttype]` structs are preserved.
3. **Continuous Drift Protection**: Contract test suites in `contracts/*/src/test.rs` assert exact topic tuples and serialized payload structures against this document on every build and CI run.

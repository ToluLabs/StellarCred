# StellarCred Contract Events

This document enumerates every event emitted by StellarCred's Soroban contracts,
their topic convention, and their payload fields.

---

## Topic Convention

All events follow this three-element topic tuple:

```
( contract: Symbol, action: Symbol, credential_type: Symbol )
```

| Field | Description |
|---|---|
| `contract` | A short symbol identifying the emitting contract (see per-contract sections below). |
| `action` | A verb describing what happened (e.g. `submitted`, `revoked`, `registered`, `vk_set`). |
| `credential_type` | The credential type involved (e.g. `kyc`, `age`, `income`, `funds`, `jurisdiction`). Omitted (tuple length 2) for events that are not credential-type-specific. |

Payloads are typed `#[contracttype]` structs, serialized by the Soroban SDK.

> **Why this convention?** An indexer (see issue #74) can filter events by the
> first two topic elements to subscribe to all events of a given action across
> all credential types, or add the third element to narrow to one type.

---

## ProofRegistry (`contract = "proof_reg"`)

### `proof_reg.submitted` — Proof submitted and cached

Emitted by `submit_proof` (once) and `submit_proofs_batch` (once per proof in the batch) when a proof passes issuer trust, key binding, and cryptographic verification.

**Topics:** `("proof_reg", "submitted", <credential_type>)`

**Payload — `EventProofSubmitted`:**

| Field | Type | Description |
|---|---|---|
| `holder` | `Address` | The address whose proof was verified. |
| `issuer` | `Address` | The issuer that signed the credential commitment. |
| `verified_at` | `u64` | Ledger timestamp (seconds) at which the proof was stored. |
| `expiry` | `u64` | Ledger timestamp (seconds) supplied by the holder as the proof's expiry. |

---

### `proof_reg.revoked` — Issuer-initiated proof revocation

Emitted by `revoke` when a registered issuer marks a holder's proof as revoked. The on-chain record is preserved for audit; `is_verified` will return `false` for the affected holder from this point on.

**Topics:** `("proof_reg", "revoked", <credential_type>)`

**Payload — `EventProofRevoked`:**

| Field | Type | Description |
|---|---|---|
| `holder` | `Address` | The holder whose proof was revoked. |
| `issuer` | `Address` | The issuer that performed the revocation. |
| `revoked_at` | `u64` | Ledger timestamp (seconds) at which the revocation was recorded. |

> **Note:** Holder self-revocation via `revoke_proof` removes the record entirely
> and does not emit an event (no issuer is involved).

---

## IssuerRegistry (`contract = "iss_reg"`)

### `iss_reg.register` — Issuer registered or updated

Emitted by `register_issuer` (admin-only) when a new issuer is added to the registry, or when an existing issuer's record is overwritten (credential-type list update). Note that `register_issuer` cannot change an issuer's signing key — use `rotate_issuer_key`, below.

**Topics:** `("iss_reg", "register")`

> Third topic (credential type) is omitted because a single registration covers
> multiple credential types.

**Payload — `EventIssuerRegistered`:**

| Field | Type | Description |
|---|---|---|
| `issuer` | `Address` | The address of the newly registered (or updated) issuer. |
| `pubkey` | `BytesN<64>` | The issuer's secp256k1 public key (x ‖ y, 32 bytes each). |

---

### `iss_reg.revoked` — Issuer revoked

Emitted by `revoke_issuer` (admin-only) when an issuer is marked as revoked. Existing on-chain proof records are not modified; however, any subsequent `is_valid_issuer` call for the revoked address will return `false`, and new proofs signed by the revoked issuer will be rejected by `ProofRegistry`.

**Topics:** `("iss_reg", "revoked")`

**Payload — `EventIssuerRevoked`:**

| Field | Type | Description |
|---|---|---|
| `issuer` | `Address` | The address of the revoked issuer. |

---

### `iss_reg.key_rot` — Issuer signing key rotated

Emitted by `rotate_issuer_key` (admin-only) when an issuer moves to a new secp256k1 signing key. **Not** a revocation: the outgoing key stays verifiable until `previous_valid_until`, so credentials already issued under it keep working. New issuance uses `new_pubkey`.

**Topics:** `("iss_reg", "key_rot")`

**Payload — `EventIssuerKeyRotated`:**

| Field | Type | Description |
|---|---|---|
| `issuer` | `Address` | The issuer whose signing key changed. |
| `previous_pubkey` | `BytesN<64>` | The key that was in use before this rotation. |
| `new_pubkey` | `BytesN<64>` | The key that is in use after this rotation. |
| `previous_valid_until` | `u64` | Ledger timestamp at which `previous_pubkey` stops being accepted. Credentials verified under it must be submitted before then. |

> Consumers should treat this as a schedule trigger, not an alert: the correct
> response is to confirm issuance has moved to `new_pubkey` and, once
> `previous_valid_until` passes, that no traffic still presents the old key.

---

### `iss_reg.key_rev` — Issuer signing key revoked

Emitted by `revoke_issuer_key` (admin-only) when a single signing key is emergency-revoked. Takes effect immediately, ignoring any validity window — this is the compromise response, as distinct from the graceful retirement in `iss_reg.key_rot`. The call is idempotent, so the event is emitted only on an actual state change.

**Topics:** `("iss_reg", "key_rev")`

**Payload — `EventIssuerKeyRevoked`:**

| Field | Type | Description |
|---|---|---|
| `issuer` | `Address` | The issuer that owned the key. |
| `pubkey` | `BytesN<64>` | The revoked key. |
| `revoked_at` | `u64` | Ledger timestamp (seconds) at which the key was revoked. |

> A revoked key can never be reinstated by a later rotation. Note this does not
> retroactively invalidate `ProofRecord`s already cached by `ProofRegistry`;
> those expire on their own `expiry` or can be cleared with `revoke_proof`.

See the [issuer key rotation runbook](ISSUER_KEY_ROTATION.md) for the full
operational procedure.

---

## CredentialVerifier (`contract = "cred_ver"`)

### `cred_ver.vk_set` — Verification key registered or replaced

Emitted by `set_vk` (admin-only) when a circuit verification key is stored or replaced. A new credential type becomes verifiable once its VK is set here.

**Topics:** `("cred_ver", "vk_set", <credential_type>)`

**Payload — `EventVkSet`:**

| Field | Type | Description |
|---|---|---|
| `admin` | `Address` | The admin address that authorized the VK update. |

---

## GatedPool

GatedPool is a demo contract that consumes `ProofRegistry` results. It does not
emit events of its own; its state changes (deposits and withdrawals) are fully
auditable via the Soroban transaction ledger.

---

## Credential Types Reference

| Symbol | `symbol_short!` | Threshold field | Notes |
|---|---|---|---|
| `kyc` | `symbol_short!("kyc")` | None | Know-Your-Customer verification. |
| `age` | `symbol_short!("age")` | `threshold_years` (field 66) | Age >= N years. |
| `income` | `symbol_short!("income")` | `threshold` (field 65) | Annual income >= N. |
| `funds` | `symbol_short!("funds")` | `threshold` (field 65) | On-chain balance >= N. |
| `jurisdiction` | `Symbol::new(env, "jurisdiction")` | None | Permitted jurisdiction check. |
| `accreditation` | `Symbol::new(env, "accreditation")` | `threshold` (field 65) | Accredited investor threshold. |

> Symbols longer than 9 characters (e.g. `jurisdiction`, `accreditation`) cannot
> use `symbol_short!` and must be constructed with `Symbol::new(env, "...")`.

---

## Indexer Integration Notes

An off-chain indexer can subscribe to contract events using the following filter logic:

```
// All proof submissions for any credential type:
filter: topics[0] == "proof_reg" AND topics[1] == "submitted"

// Only KYC proof submissions:
filter: topics[0] == "proof_reg" AND topics[1] == "submitted" AND topics[2] == "kyc"

// All issuer registrations:
filter: topics[0] == "iss_reg" AND topics[1] == "register"

// All VK updates across credential types:
filter: topics[0] == "cred_ver" AND topics[1] == "vk_set"
```

Payload structs are XDR-encoded via the Soroban SDK's `#[contracttype]` derive.
Decode them using the Stellar SDK's `xdr` layer or the `@stellar/stellar-sdk`
JavaScript package with the contract's ABI.

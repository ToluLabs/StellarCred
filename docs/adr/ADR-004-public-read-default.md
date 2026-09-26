# ADR-004: Public-by-default verification reads

**Status:** Accepted  
**Relevant code:** `contracts/proof_registry/src/lib.rs` (`is_verified`, `check_claim`, `get_record`, `claim_expiry`)

---

## Context

Once a holder has submitted a proof, protocols need to query whether that holder satisfies a credential requirement. The system must decide who can read the `ProofRegistry` state and under what conditions.

The read access model is distinct from submission authorization (ADR-003). A holder who publishes a proof on-chain is making a public claim. The question is whether the system should place additional gates on who can verify that claim.

---

## Decision

Verification reads are **public with no access control**. Any address — including contracts, dApp front-ends, and off-chain readers — can call `is_verified`, `check_claim`, `get_record`, and `claim_expiry` without any authentication requirement. There is no allow-list of authorized readers and no per-holder permission check.

```rust
// contracts/proof_registry/src/lib.rs
pub fn is_verified(env: Env, holder: Address, credential_type: Symbol, ...) -> (bool, u64, u64) {
    // no require_auth() — any caller may read
    match env.storage().persistent().get::<_, ProofRecord>(&DataKey::Proof(holder, credential_type)) {
        Some(r) => { /* ... */ }
        None => (false, 0, 0),
    }
}
```

Protocols that want to restrict which issuers they accept can pass a `trusted_issuers` filter to `is_verified` and `check_claim`, but this is a caller-supplied preference, not a registry-level gate.

---

## Alternatives considered

### 1. Read access gated by holder permission

A holder could register an allow-list of addresses (or a merkle root of allowed addresses) that are permitted to read their proof status. Reads from unlisted addresses would return `false` or revert.

**Why rejected — on-chain state is already public.** Soroban persistent storage entries are readable by anyone with access to the Stellar network's ledger data, regardless of what the contract's entry points enforce. A contract-level gate on `is_verified` would block callers from the contract ABI, but not from a direct ledger state read. Implementing a permission gate gives a false sense of privacy without providing a real one. The design therefore makes the model explicit: a submitted proof is a public on-chain claim, and the holder controls disclosure by deciding whether to submit in the first place (ADR-003).

**Why rejected — composability cost.** Gated reads would break the primary use case: protocols checking a holder's status during a transaction. A protocol's Soroban contract cannot be on a dynamic allow-list managed by each holder; the allow-list lookup would require an additional contract call per user, and updating allow-lists before every protocol interaction would be impractical.

### 2. Read access gated by the protocol's contract address

Only contracts registered in a protocol allow-list could call `is_verified`. Unregistered dApps could not query the registry.

**Why rejected — defeats permissionless composability.** A core goal of publishing credentials on-chain is that any protocol can check them without asking the credential system for permission first. A protocol allow-list would require each new integration to go through an admin approval step, re-introducing the centralization that on-chain credentials are meant to eliminate. It would also prevent tooling like explorers, SDKs, and analytics dashboards from reading credential status.

**Why rejected — same ledger-read problem.** Any protocol that can read Stellar ledger state can read the underlying storage entry regardless of the contract-level gate.

### 3. Encrypted on-chain state with holder-issued decryption keys

Proof records could be stored encrypted, with holders issuing time-limited decryption keys to specific protocols.

**Why rejected — complexity and key management.** This would require an off-chain key distribution mechanism, a decryption step on the protocol side, and a revocation model for decryption keys. It would also make the credential system unusable for on-chain protocol logic (smart contracts cannot decrypt data without access to a key). The privacy benefit is marginal because the underlying boolean (does this address satisfy credential X?) is the only information published; the raw credential value and salt remain private regardless (see ADR-002).

---

## Consequences

**What this makes true:**
- Any protocol can integrate with StellarCred permissionlessly. No admin registration or approval step is required before a contract can call `check_claim`.
- The `@stellarcred/sdk` can call `is_verified` from any front-end without authentication, enabling simple one-line integration for protocol dApps.
- The privacy model is honest: a holder who submits a proof is making a public on-chain claim, and the system documents this clearly rather than providing a misleading gate.

**What this makes harder:**
- A holder cannot retroactively make their credential status invisible to specific observers after submitting a proof. The only way to remove proof status from the registry is to call `revoke_proof`, which deletes the record entirely and makes the status false for everyone, not just certain observers.
- Protocols cannot build "exclusive" credential networks where only registered verifiers can check status. Such a model requires an off-chain or application-layer gate, not a registry-level one.

**What this does not affect:**
- The privacy of the underlying credential. The commitment, salt, signature, and raw credential value (date of birth, income amount, etc.) are never stored on-chain. Only the verification status (a boolean), the issuer address, the threshold (for parameterised types), and the expiry are public. These are the minimum necessary for a protocol to make an access-control decision.

**If this decision were revisited:**
- Adding a contract-level read gate would require adding `require_auth()` calls (or an allow-list lookup) to `is_verified` and `check_claim`. It would break all existing SDK integrations and require protocol developers to modify their integration code. It would also require communicating clearly that the gate is a contract-level convenience and not a true privacy guarantee, given that ledger state is always readable.
- A selective-disclosure model where holders reveal only what each protocol needs (rather than a shared registry) would require a fundamentally different architecture — likely moving from a shared registry to per-interaction ZK proofs presented directly to each protocol contract.

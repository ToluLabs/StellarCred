# ADR-003: Holder-authorized proof submission

**Status:** Accepted  
**Relevant code:** `contracts/proof_registry/src/lib.rs` (`submit_proof`, `submit_proofs`, `submit_aggregate_proof`)

---

## Context

A proof must reach `ProofRegistry` on-chain before any protocol can check a holder's credential status. The system must decide who is authorized to call `submit_proof` on behalf of a holder, and who controls when and whether a proof is submitted.

The question has practical privacy implications beyond just "who pays the fee". The act of submitting a proof for a specific credential type, at a specific time, to a specific contract, is a chain event. Who controls that disclosure matters for the holder's privacy.

---

## Decision

Proof submission is **holder-authorized**. Every submission entry point (`submit_proof`, `submit_proofs`, `submit_aggregate_proof`) calls `holder.require_auth()` as the first authenticated operation. The holder's wallet must sign the transaction; no other party can submit a proof on a holder's behalf without that signature.

```rust
// contracts/proof_registry/src/lib.rs
pub fn submit_proof(env: Env, holder: Address, ...) {
    holder.require_auth();
    // ...
}
```

The issuer is not involved in the on-chain submission step. Issuers only produce and sign credentials off-chain; they have no on-chain role in the proof lifecycle after the credential is issued.

---

## Alternatives considered

### 1. Issuer-submitted proofs

The issuer, having just completed identity verification, submits the proof on the holder's behalf. This would allow "one-click" onboarding where the holder never interacts with the blockchain directly.

**Why rejected — holder consent and disclosure control.** A holder's credential status becoming visible on-chain is a privacy-relevant event. An issuer-submitted model would mean the issuer decides when and for which protocols the holder's credential is published, not the holder. The holder has already disclosed their identity to the issuer for verification purposes; they should not also be compelled to have their credential status published on-chain as a side effect. Holder authorization ensures that the act of making a credential public is a deliberate choice by the person it belongs to.

**Why rejected — reduced issuer attack surface.** If the issuer can submit proofs, a compromised issuer account could publish proof records for any holder with any credential type (subject to the signature check), potentially exposing credential status for holders who never intended to publish. Removing the issuer from the submission path limits the blast radius of an issuer compromise.

### 2. Anyone can submit a valid proof for any holder

Any party that possesses a valid proof and public inputs for a holder could submit it, without requiring the holder's authorization. This is the model used by some Ethereum L2 sequencers for relaying user operations.

**Why rejected — disclosure without consent.** A third party submitting a proof on behalf of a holder would make the holder's credential status visible on-chain without the holder's knowledge or agreement. Even if the proof itself is valid and the underlying credential is genuine, the holder's right to decide whether and when to disclose their credential status is a core part of the privacy model. An observer watching the chain could not distinguish a holder-initiated submission from a third-party-initiated one, which undermines the holder's ability to selectively disclose.

**Why rejected — replay surface.** If any party can submit, a credential obtained by one holder could be submitted for a different holder address if public inputs were not bound tightly enough to the holder address. Requiring the holder to sign prevents this class of attack without any additional binding in the circuit.

### 3. Protocol-gated submission (protocol calls submit on behalf of holder)

A protocol dApp that wants to verify a holder would call `submit_proof` as part of its own transaction, acting as the submitter.

**Why rejected — consent and timing.** This would mean the protocol decides when a holder's credential is published, possibly without an explicit confirmation step for the holder. It also creates a dependency where the protocol's contract must be trusted not to submit credentials beyond what the holder agreed to reveal in that interaction.

---

## Consequences

**What this makes true:**
- Credential disclosure is holder-controlled. A holder can have a perfectly valid credential and choose never to submit it on-chain. Nothing is disclosed until the holder actively decides to prove.
- The holder controls which credential types they submit and to which registries. A holder proving KYC to one protocol does not automatically expose the same status to others.
- Issuers have no on-chain role after credential issuance. Issuer key compromise does not give an attacker the ability to submit proofs; they would also need to control a holder's wallet.

**What this makes harder:**
- Gasless or sponsored submission flows require the holder's wallet signature, which means a relay-based approach (where a third party pays the fee) must use a signature-based authorization mechanism (e.g. Soroban's invoker abstraction or a separate authorization envelope). It cannot be done by simply calling `submit_proof` from a different account.
- There is no way for an issuer to proactively push a proof record on-chain for a holder (e.g. as part of a bulk issuance event). Each holder must individually submit.

**If this decision were revisited:**
- Enabling issuer-submitted proofs would require removing `holder.require_auth()` and replacing it with a different authorization model (e.g. a holder-signed permit included in the call arguments, or an allow-list of authorized submitters per holder). The circuit itself does not need to change, but the contract's security boundary would shift significantly.
- Adding an optional "authorized submitter" address that the holder can pre-approve would allow gasless relay flows without removing holder consent. This would be an additive change to `ProofRegistry` rather than a replacement.

# ADR-001: In-circuit secp256k1 signature verification

**Status:** Accepted  
**Relevant code:** `circuits/lib/src/lib.nr` (`assert_committed_and_signed`), `contracts/proof_registry/src/lib.rs` (`submit_proof`)

---

## Context

Every credential in StellarCred is backed by an issuer signature over a Poseidon2 commitment. The system must guarantee that a valid on-chain proof is evidence that a specific registered issuer endorsed a specific credential — and nothing weaker than that.

There are two places a secp256k1 signature could be checked: inside the Noir circuit (as a ZK constraint), or on-chain inside the Soroban contract (as a plain ECDSA verification call). The choice determines both the soundness of the proof and the on-chain privacy properties of the holder.

---

## Decision

The issuer's secp256k1 signature is verified **inside the Noir circuit** using `std::ecdsa_secp256k1::verify_signature`. The signature bytes (`sig: [u8; 64]`) are a **private** witness: they appear in the circuit's input but never in the public inputs and are therefore never visible on-chain.

The issuer's public key (`issuer_x`, `issuer_y`) is a **public** input so the `ProofRegistry` contract can check it against `IssuerRegistry` after proof verification. The combination of the two checks — in-circuit signature validity plus on-chain registry lookup — is what makes a valid proof mean "a trusted issuer signed this credential".

The implementation lives in one place: `circuits/lib/src/lib.nr::assert_committed_and_signed`. Every credential circuit calls this function; none re-implements it.

---

## Alternatives considered

### 1. Verify the signature on-chain only

The signature would be passed as a call argument to `submit_proof`, and the contract would run a native secp256k1 check.

**Why rejected — soundness.** The on-chain verifier only sees the proof's public inputs. If the signature is not a ZK constraint, there is no cryptographic link between the proof and the issuer's endorsement. A holder could construct a circuit witness that satisfies every threshold assertion using a credential of their own invention, sign the commitment with their own key, and submit a valid proof. The contract would check "this key is in IssuerRegistry" and fail — but only because the submitted key doesn't match. If an attacker also controls an account in the registry, the entire trust model collapses. Checking the signature in-circuit makes a valid proof *itself* the evidence of issuer endorsement, not a separate call argument that can be swapped.

**Why rejected — privacy.** Publishing the signature on-chain makes a holder's proofs permanently linkable. The same credential generates the same signature every time. A holder who proves KYC to five different protocols in five separate transactions would have all five proofs traceable to a single credential by anyone watching the chain, defeating the purpose of zero-knowledge proofs. Keeping the signature as a private witness means the holder proves the signature *exists* without ever showing it.

### 2. Verify the signature on-chain and accept a privacy trade-off

Some deployments prioritize auditability over holder privacy and might prefer an on-chain signature check. This could be a valid design for a different credential system, but it is not compatible with the privacy guarantee that StellarCred explicitly makes (identity data never reaches the chain). Accepting the privacy trade-off would change the threat model documented in `docs/THREAT_MODEL.md`.

### 3. Use a different signature scheme (e.g. EdDSA / BLS)

EdDSA over Jubjub is native to the BN254 scalar field and is far cheaper in constraints than secp256k1. BLS offers signature aggregation.

**Why rejected.** Issuers sign credentials off-chain using standard wallet tooling and Node.js crypto libraries (see `frontend/packages/issuer`). Both secp256k1 and the Ethereum-style signing workflow are universally supported; Jubjub and BLS are not available in most standard toolchains without adding a dependency specifically for this purpose. Switching would require replacing the issuer signing stack and all existing credentials. The cost in constraints (secp256k1 is roughly 10× more expensive than Jubjub in-circuit) is accepted as the price of compatibility.

---

## Consequences

**What this makes true:**
- A valid proof is cryptographic evidence that a registered issuer signed the exact commitment the proof is about. Neither the signature nor the raw credential secret leaves the holder's browser.
- Holder proofs for the same underlying credential are unlinkable to each other because the signature is never published.
- The on-chain contract only needs to verify that the *public key* in the proof's public inputs is registered; it does not perform any cryptographic operation on the signature.

**What this makes harder:**
- Rotating an issuer key invalidates all existing proofs derived from the old key. Holders must re-prove after a key rotation. The `IssuerRegistry.register_issuer` function supports overwriting a key, but there is no automatic re-issuance path.
- Debugging a proof failure is harder because the signature is not visible. A holder whose proof fails on-chain cannot easily distinguish "wrong issuer key" from "malformed signature" without running the circuit locally.
- Adding a new signature scheme requires a change to `circuits/lib/src/lib.nr`, which invalidates every deployed verification key and requires re-proving all existing credentials (see ADR-005 on VK stability).

**If this decision were revisited:**
- Moving to on-chain signature verification would require removing the `sig` private input from every credential circuit, passing `sig` as a call parameter to `submit_proof`, and adding a Soroban ECDSA call. It would also require updating the threat model to reflect that credential signatures are now public on-chain data.
- Switching to EdDSA/Jubjub would require replacing the issuer signing code, updating `assert_committed_and_signed` in `circuits/lib/src/lib.nr`, and re-issuing all credentials.

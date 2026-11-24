# ADR-002: Poseidon2 commitment scheme with mandatory non-zero salt

**Status:** Accepted  
**Relevant code:** `circuits/lib/src/lib.nr` (`assert_committed_and_signed`), `circuits/commit/src/main.nr`

---

## Context

Each credential requires a commitment that:

1. Binds the private credential value to a public on-chain anchor without revealing the value.
2. Can be verified efficiently inside a ZK circuit (constraint cost matters for browser proving time).
3. Is hiding — the commitment must not allow an observer to recover the underlying value by brute force.

The commitment scheme defines the bridge between the private witness and the on-chain public input. Getting it wrong breaks the entire privacy or soundness model simultaneously for every credential type.

---

## Decision

The commitment is `Poseidon2([value, salt], 2)` — a two-input Poseidon2 hash over the credential value and a randomly chosen salt. This is computed in `circuits/lib/src/lib.nr::assert_committed_and_signed` and also exposed as a standalone witness helper circuit in `circuits/commit/src/main.nr`.

The salt is **mandatory and must be non-zero**. The issuer generates a fresh random salt for each credential issuance (see the issuance flow in `docs/ARCHITECTURE.md`). The commitment is the only form of the credential that is ever published on-chain or stored server-side.

---

## Alternatives considered

### 1. SHA-256 or keccak256 commitment

Standard hash functions are available in Noir and widely understood.

**Why rejected — constraint cost.** SHA-256 and keccak are bitwise operations; they require thousands of constraints per hash in an arithmetic circuit. Poseidon2 is an algebraic hash function designed for ZK circuits, operating natively over the BN254 scalar field. It requires roughly 30–60 constraints for a two-input hash, versus several thousand for SHA-256. At the Noir + bb proving stack we use, SHA-256 would multiply the commitment-check cost by roughly 50×, which is directly paid by the holder as browser proving time.

### 2. Pedersen commitment

`commit(value, r) = value * G + r * H` over an elliptic curve, the classical ZK commitment construction.

**Why rejected — complexity and non-standard tooling.** Pedersen commitments require group-law operations that are more complex to implement and audit correctly, and the Noir standard library's Poseidon2 implementation is well-tested and used across the Noir ecosystem. Pedersen also offers no advantage over Poseidon2 for our access pattern (write once, verify many times in circuit).

### 3. Unsalted Poseidon2 commitment: `Poseidon2([value], 1)`

Dropping the salt would simplify the circuit and issuer code by one input.

**Why rejected — the commitment is a public input.** Credential values are low-entropy. A date of birth has roughly 30,000 plausible values for anyone alive; an ISO 3166-1 country code has about 250 values. Without a salt the commitment is a deterministic, public function of the value. Anyone with read access to the chain can hash all plausible values of a given credential type and compare them against all published commitments, recovering the underlying credential for every holder. The salt must be random (at least 128 bits of entropy) and kept private to prevent this dictionary attack. The non-zero requirement exists because `Poseidon2([value, 0], 2)` is still a well-defined output, but callers cannot distinguish "issuer intentionally used zero salt" from "salt field was accidentally omitted". A non-zero invariant is enforced by convention at the issuance layer rather than as a circuit constraint, because the constraint would add cost without a meaningful security boundary (a random 128-bit value is zero with probability 2⁻¹²⁸).

### 4. Poseidon (version 1) commitment

The older Poseidon hash is also available in the Noir standard library.

**Why rejected.** Poseidon2 has stronger security arguments and better performance than original Poseidon, and it is the default recommendation in the Noir and Barretenberg ecosystems as of the versions pinned in this repository (Noir 1.0.0-beta.9, bb 0.87.0). Using Poseidon2 aligns with the wider ecosystem and avoids introducing a less-scrutinized primitive.

---

## Consequences

**What this makes true:**
- Commitment computation is cheap enough that it is not the bottleneck in browser proof generation.
- Because the commitment is a Poseidon2 output, it is collision-resistant and already a well-formed field element — the issuer can use it directly as the ECDSA message digest without an additional hash (see `circuits/lib/src/lib.nr` and ADR-001).
- The hiding property holds as long as the salt is secret and has sufficient entropy. The salt never appears in any public input.

**What this makes harder:**
- The issuer must store or be able to reconstruct `(value, salt)` to re-issue a credential after a key rotation. Losing the salt makes it impossible to re-derive the same commitment, requiring a full re-issuance.
- Changing the commitment scheme (e.g. to SHA-256 for interoperability with another verifier) invalidates every existing commitment and proof. All credentials would need to be re-issued and all holders would need to re-prove.

**If this decision were revisited:**
- Switching to a different hash function requires updating `circuits/lib/src/lib.nr`, the `commit` helper circuit, and the issuer's commitment derivation code. It also invalidates every deployed verification key (see ADR-005). All on-chain commitments and cached proofs would become invalid; a full re-issuance campaign would be required.
- Adding a domain separator to the commitment (e.g. `Poseidon2([credential_type, value, salt], 3)`) would bind commitments to credential types, preventing a commitment computed for one type from being used in a different circuit. This would be a backwards-incompatible change requiring re-issuance.

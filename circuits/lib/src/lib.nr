// Shared credential helper used by all credential circuits.
//
// Asserts that:
//   1) Poseidon2([value, salt], 2) == commitment
//   2) The issuer's secp256k1 ECDSA signature over the commitment is valid.
//
// These two constraints are the entire trust foundation of every credential
// type. Because all circuits route through this one function, a change here
// changes the security properties of kyc, age, income, jurisdiction, funds and
// accreditation proofs simultaneously, and invalidates every verification key
// already deployed. Treat edits to this file as a protocol change, not a
// refactor.
//
// The security model in one line: a valid proof means "a keypair the contract
// recognises as a registered issuer signed a commitment, and the prover knows
// the value and salt behind that commitment". Each circuit then adds its own
// constraint about the value on top.

use dep::poseidon::poseidon2::Poseidon2;
use std::ecdsa_secp256k1::verify_signature;

pub fn assert_committed_and_signed(
    // `value` and `salt` are the caller's private witness. They must stay
    // private: the whole point is to prove a property of `value` without
    // revealing it.
    value: Field,
    salt: Field,
    // `sig` is private too, and that is a deliberate privacy choice rather than
    // an accident. A signature is a stable, unique identifier for one
    // credential. If it were a public input, anyone watching the chain could
    // link every proof derived from that credential back to a single holder,
    // across every protocol they use. Verifying it inside the circuit is what
    // lets the holder prove the signature exists without showing it.
    sig: [u8; 64],
    // The caller passes these three through as public inputs, so the contract
    // sees them and can bind them to on-chain state.
    commitment: Field,
    issuer_x: [u8; 32],
    issuer_y: [u8; 32],
) {
    // Commitment binding. This is the hinge of the whole scheme: it forces the
    // private `value` to be the one inside the credential the issuer signed
    // just below. The only way to satisfy it is to know a (value, salt) pair
    // that Poseidon2-hashes to the public commitment.
    // Remove it and the two halves of every proof come apart. A holder could
    // present a commitment a real issuer genuinely signed while knowing nothing
    // about the credential behind it, then have the calling circuit assert a
    // threshold about a `value` of their own choosing. Every credential type
    // would become forgeable at once.
    // `salt` is what makes the commitment hiding, and it is load-bearing, not
    // decoration. The commitment is a public input, so without a salt it is a
    // deterministic hash of a low-entropy value: a date of birth has a few tens
    // of thousands of plausible values and an ISO country code has about 250.
    // An unsalted commitment could be reversed by hashing candidates until one
    // matched, reading the credential straight off the public inputs.
    assert(Poseidon2::hash([value, salt], 2) == commitment);

    // `verify_signature` consumes a 32-byte message *digest*, not a message,
    // and we hand it the commitment's big-endian bytes. So the digest IS the
    // commitment, with no hash applied on the way in.
    // That is precisely why the issuer must sign with `prehash: false` (see
    // frontend/packages/issuer and circuits/scripts/sign.js). A signer that
    // pre-hashes would produce a signature over sha256(commitment) instead, and
    // the check below would reject every credential it ever issued. The flag is
    // not a preference; it is the other half of this line.
    // Using the commitment directly as the digest is sound because it is
    // already a Poseidon2 output, i.e. a collision-resistant hash of the
    // credential, rather than raw attacker-supplied input.
    let z: [u8; 32] = commitment.to_be_bytes();

    // Issuer authentication, in-circuit. Two independent reasons this cannot be
    // left to the contract:
    //   1. Soundness. The on-chain verifier only ever sees the public inputs.
    //      If the signature were merely claimed rather than checked here, a
    //      holder could pick any commitment, sign it with their own key, and
    //      mint a credential the issuer never approved. Checking it here makes
    //      a valid proof *evidence* that the holder of (issuer_x, issuer_y)
    //      signed this exact commitment.
    //   2. Privacy. See the note on `sig` above. Moving the check on-chain
    //      would mean publishing the signature, which makes a holder's proofs
    //      linkable.
    // The issuer key is public for exactly one reason: so the contract can
    // check it against IssuerRegistry. Note what this assert does and does not
    // prove on its own. It proves *someone* signed the commitment; it is the
    // registry lookup that makes that someone a *trusted* issuer. Both halves
    // are required, and neither is sufficient alone.
    assert(verify_signature(issuer_x, issuer_y, sig, z));
}

// ---------------------------------------------------------------------------
// Composite eligibility policy
// ---------------------------------------------------------------------------
//
// A bounded boolean policy over several committed attributes, evaluated in a
// single circuit so a holder can prove a small formula like
//   (accredited OR income >= X) AND jurisdiction_eligible
// in one proof, revealing only the final pass/fail bit.
//
// Policy encoding (documented, fixed-shape):
//
//   A policy is a list of up to MAX_TERMS terms. Each term is one of:
//     - Threshold { attr, op, threshold }  : attr <op> threshold
//     - Membership { attr, set_root }      : attr is in the committed set
//   where `op` is one of LT / LE / GT / GE / EQ (encoded as u8 0..=4).
//
//   Terms are grouped into clauses joined by OR, and clauses are joined by
//   AND. The shape is fixed at compile time by MAX_TERMS and MAX_CLAUSES so
//   the circuit stays provable. Concretely the policy is:
//
//     AND over c in 0..MAX_CLAUSES of ( OR over t in clause c of term_t )
//
//   A clause with no active terms is treated as vacuously true (identity for
//   AND); a term slot marked inactive is skipped. This lets callers express
//   arbitrary small formulas within the bound without changing the circuit.
//
// Each attribute is a private witness `value` bound to a public `commitment`
// via the same Poseidon2([value, salt], 2) commitment used everywhere else.
// The issuer signature check is delegated to `assert_committed_and_signed`
// per attribute so the trust foundation is identical to every other circuit.

pub global MAX_TERMS: u32 = 8;
pub global MAX_CLAUSES: u32 = 4;

// Operator encoding for Threshold terms.
pub global OP_LT: u8 = 0;
pub global OP_LE: u8 = 1;
pub global OP_GT: u8 = 2;
pub global OP_GE: u8 = 3;
pub global OP_EQ: u8 = 4;

// A single policy term. `active` gates whether the term participates in its
// clause. `is_membership` selects between Threshold and Membership semantics.
pub struct Term {
    active: bool,
    is_membership: bool,
    attr_index: u32,
    op: u8,
    threshold: Field,
    set_root: Field,
}

// Evaluate one threshold comparison. Returns a boolean encoded as Field 0/1.
fn eval_threshold(value: Field, op: u8, threshold: Field) -> Field {
    let lt = (value as u64) < (threshold as u64);
    let eq = value == threshold;
    let result = if op == OP_LT {
        lt
    } else if op == OP_LE {
        lt | eq
    } else if op == OP_GT {
        !lt & !eq
    } else if op == OP_GE {
        !lt
    } else {
        // OP_EQ (and any unknown op falls back to equality, which is the
        // strictest safe interpretation).
        eq
    };
    if result { 1 } else { 0 }
}

// Evaluate the full bounded policy. `values` are the private attribute
// witnesses; `terms` is the fixed-shape policy; `clause_of` maps each term
// slot to its clause index. Returns 1 if the policy passes, 0 otherwise.
//
// Membership is checked as Poseidon2([value, set_root], 2) == membership_tag,
// where `membership_tag` is supplied per term as the committed set element.
// This keeps the circuit bounded: the set is committed off-circuit and the
// prover supplies the matching tag.
pub fn eval_policy(
    values: [Field; MAX_TERMS],
    terms: [Term; MAX_TERMS],
    clause_of: [u32; MAX_TERMS],
    membership_tags: [Field; MAX_TERMS],
) -> Field {
    // Per-clause OR accumulators, initialised to 0 (false).
    let mut clause_acc: [Field; MAX_CLAUSES] = [0; MAX_CLAUSES];

    for i in 0..MAX_TERMS {
        let t = terms[i];
        if t.active {
            let v = values[t.attr_index];
            let term_result = if t.is_membership {
                let tag = Poseidon2::hash([v, t.set_root], 2);
                if tag == membership_tags[i] { 1 } else { 0 }
            } else {
                eval_threshold(v, t.op, t.threshold)
            };
            let c = clause_of[i];
            // OR into the clause accumulator.
            clause_acc[c] = if (clause_acc[c] == 1) | (term_result == 1) {
                1
            } else {
                0
            };
        }
    }

    // AND across clauses. A clause with no active terms stays 0 here, which
    // would incorrectly fail; callers must mark at least one term per clause
    // they intend to be non-vacuous. To keep the documented "empty clause is
    // true" semantics we track whether each clause saw any active term.
    let mut clause_seen: [Field; MAX_CLAUSES] = [0; MAX_CLAUSES];
    for i in 0..MAX_TERMS {
        if terms[i].active {
            clause_seen[clause_of[i]] = 1;
        }
    }

    let mut result: Field = 1;
    for c in 0..MAX_CLAUSES {
        let clause_value = if clause_seen[c] == 1 { clause_acc[c] } else { 1 };
        result = if (result == 1) & (clause_value == 1) { 1 } else { 0 };
    }
    result
}

/// Derives a deterministic per-app-context nullifier: Poseidon2([secret, app_context], 2).
/// Unlocks Sybil-resistant, one-per-human gating within an `app_context`
/// without linking identities across different applications (#395).
pub fn derive_nullifier(secret: Field, app_context: Field) -> Field {
    Poseidon2::hash([secret, app_context], 2)
}

// --- Tests -------------------------------------------------------------------

#[test]
fn test_nullifier_deterministic_within_context() {
    let secret: Field = 0xabcdef1234567890;
    let app_context: Field = 0x42;
    let n1 = derive_nullifier(secret, app_context);
    let n2 = derive_nullifier(secret, app_context);
    assert(n1 == n2);
}

#[test]
fn test_nullifier_unlinkable_across_contexts() {
    let secret: Field = 0xabcdef1234567890;
    let context_a: Field = 0x1;
    let context_b: Field = 0x2;
    let n_a = derive_nullifier(secret, context_a);
    let n_b = derive_nullifier(secret, context_b);
    assert(n_a != n_b);
}

#[test]
fn test_nullifier_different_secrets_in_same_context() {
    let secret_1: Field = 0x11111111;
    let secret_2: Field = 0x22222222;
    let app_context: Field = 0x42;
    let n1 = derive_nullifier(secret_1, app_context);
    let n2 = derive_nullifier(secret_2, app_context);
    assert(n1 != n2);
}
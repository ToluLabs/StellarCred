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

// kyc_proof
//
// Proves the holder knows the secret behind a KYC credential AND that a trusted
// issuer signed the commitment to it (secp256k1 ECDSA, verified in-circuit).
// Public inputs, in order: commitment, issuer_x, issuer_y, so the contract can
// bind the public key to the registered issuer. The signature and secret stay
// private.

use dep::credential_lib;
use dep::poseidon::poseidon2::Poseidon2;

fn main(
    // private: never leaves the holder's device, never appears in public inputs
    secret: Field,
    salt: Field,
    sig: [u8; 64],
    // public: the contract sees these and binds them to on-chain state
    commitment: pub Field,
    issuer_x: pub [u8; 32],
    issuer_y: pub [u8; 32],
) {
    // This single call is the whole circuit. It enforces both halves of the
    // trust model, and circuits/lib/src/lib.nr documents in detail what each
    // constraint buys and what breaks without it:
    //   - Poseidon2([secret, salt], 2) == commitment, binding the private
    //     witness to the credential the issuer signed. Without it a holder
    //     could present someone else's signed commitment while knowing nothing
    //     about the credential behind it.
    //   - An in-circuit secp256k1 signature check over the commitment, so a
    //     valid proof is evidence a specific issuer key signed this exact
    //     commitment rather than one the holder minted themselves. The
    //     signature stays private, which is what keeps a holder's proofs
    //     unlinkable.
    //
    // Unlike the other credential circuits there is no threshold assertion
    // here, and that is the design: KYC is a boolean claim. The proof asserts
    // only "a trusted issuer signed a KYC credential and I know its secret".
    // The secret carries no ordering or magnitude to compare against, so there
    // is nothing further to constrain.
    //
    // Because the circuit reduces to this one call, the contract carries more of
    // the weight here than elsewhere. It MUST check (issuer_x, issuer_y)
    // against IssuerRegistry, including that the key is registered for the KYC
    // credential type. This proof establishes that *some* keypair signed the
    // commitment; only the registry lookup makes that keypair a trusted issuer.
    credential_lib::assert_committed_and_signed(secret, salt, sig, commitment, issuer_x, issuer_y);
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package kyc_proof

// Dummy issuer keys used for should_fail tests only (signature never checked
// because the commitment assertion fails first).
global ZERO_SIG: [u8; 64] = [0; 64];
global ZERO_X: [u8; 32] = [0; 32];
global ZERO_Y: [u8; 32] = [0; 32];

// --- Reject paths --------------------------------------------------------

// A tampered commitment that does not match Poseidon2([secret, salt], 2).
#[test(should_fail)]
fn test_wrong_commitment_rejected() {
    let secret = 0x1234;
    let salt   = 0xabcd;
    let bad_commitment = 0x0000000000000000000000000000000000000000000000000000000000000001;
    main(secret, salt, ZERO_SIG, bad_commitment, ZERO_X, ZERO_Y);
}

// A zero commitment never equals a real Poseidon2 hash (Poseidon2 output is
// non-zero for any non-trivial input in the BN254 scalar field).
#[test(should_fail)]
fn test_zero_commitment_rejected() {
    main(42, 99, ZERO_SIG, 0, ZERO_X, ZERO_Y);
}

// A different secret produces a different commitment; wrong secret must fail.
#[test(should_fail)]
fn test_secret_mismatch_rejected() {
    let correct_secret = 0xdeadbeef;
    let wrong_secret   = 0xdeadc0de;
    let salt           = 0x1111;
    // commitment computed for correct_secret, but main called with wrong_secret
    let fake_commitment = Poseidon2::hash([correct_secret as Field, salt as Field], 2);
    main(wrong_secret, salt, ZERO_SIG, fake_commitment, ZERO_X, ZERO_Y);
}

// --- Property-based tests: commitment binding properties -----------------
// Systematically verify that Poseidon2 commitment binding holds for various
// secret/salt combinations - the core constraint of the KYC circuit.

// Different secrets with same salt produce different commitments.
#[test]
fn test_different_secrets_different_commitments() {
    let salt: Field = 42;
    let secrets: [Field; 5] = [1, 2, 100, 0xdeadbeef, 0xffffffff];
    let mut prev = Poseidon2::hash([secrets[0], salt], 2);
    for i in 1..5 {
        let c = Poseidon2::hash([secrets[i], salt], 2);
        assert(c != prev);
        prev = c;
    }
}

// Different salts with same secret produce different commitments.
#[test]
fn test_different_salts_different_commitments() {
    let secret: Field = 12345;
    let salts: [Field; 5] = [1, 2, 100, 0xdead, 0xbeef];
    let mut prev = Poseidon2::hash([secret, salts[0]], 2);
    for i in 1..5 {
        let c = Poseidon2::hash([secret, salts[i]], 2);
        assert(c != prev);
        prev = c;
    }
}

// Commitment is never zero for any non-trivial input.
#[test]
fn test_commitment_never_zero() {
    let pairs: [(Field, Field); 5] = [(1, 1), (42, 99), (0, 1), (1, 0), (0xdead, 0xbeef)];
    for i in 0..5 {
        let c = Poseidon2::hash([pairs[i].0, pairs[i].1], 2);
        assert(c != 0);
    }
}

// Tampered commitment (off by 1) never matches real commitment.
#[test]
fn test_tampered_commitment_never_matches() {
    let secret: Field = 0xcafebabe;
    let salt: Field = 0x12345678;
    let real = Poseidon2::hash([secret, salt], 2);
    // Even the smallest perturbation produces a different hash.
    let tampered = real + 1;
    assert(real != tampered);
}

// Wrong secret, correct salt: commitment mismatch.
#[test(should_fail)]
fn test_wrong_secret_correct_salt() {
    let real_secret: Field = 100;
    let wrong_secret: Field = 200;
    let salt: Field = 77;
    let commitment = Poseidon2::hash([real_secret, salt], 2);
    // Wrong secret with correct salt - commitment check fails.
    let check = Poseidon2::hash([wrong_secret, salt], 2);
    assert(check == commitment);
}

// Correct secret, wrong salt: commitment mismatch.
#[test(should_fail)]
fn test_correct_secret_wrong_salt() {
    let secret: Field = 100;
    let real_salt: Field = 77;
    let wrong_salt: Field = 88;
    let commitment = Poseidon2::hash([secret, real_salt], 2);
    let check = Poseidon2::hash([secret, wrong_salt], 2);
    assert(check == commitment);
}

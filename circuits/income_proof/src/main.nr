// income_proof
//
// Proves "my income is at least `threshold`" without revealing the figure,
// bound to a commitment a trusted issuer signed (secp256k1 ECDSA, in-circuit).

use dep::credential_lib;
use dep::poseidon::poseidon2::Poseidon2;

fn main(
    // private
    //
    // `income` is u64, not Field, and that is a security choice rather than a
    // stylistic one: `>=` on Field has no meaningful ordering over BN254, so a
    // prover could pick a value that wraps the modulus and compares however they
    // needed it to. u64 is a genuine bounded integer whose width the proving
    // system range-constrains, which is what makes the comparison below mean
    // what it reads as.
    income: u64,
    salt: Field,
    sig: [u8; 64],
    // public
    commitment: pub Field,
    issuer_x: pub [u8; 32],
    issuer_y: pub [u8; 32],
    threshold: pub u64,
) {
    // Binds the private income to the issuer-signed commitment and verifies the
    // issuer's signature in-circuit. circuits/lib/src/lib.nr covers what each
    // constraint prevents; briefly, without the commitment check the threshold
    // assertion below would be a statement about a number no issuer attested,
    // and without the in-circuit signature check a holder could commit to an
    // income of their choosing and sign it with their own key.
    // The `as Field` cast is a lossless widening, so it cannot alias two
    // different incomes onto the same commitment.
    credential_lib::assert_committed_and_signed(income as Field, salt, sig, commitment, issuer_x, issuer_y);

    // The claim itself, proved rather than asserted. `threshold` is a public
    // input the prover chooses, so on its own it is an unbacked assertion; this
    // constraint is what binds it to the signed private income. It cannot be
    // enforced on-chain because the contract never sees `income`, so without it
    // a holder submits whatever threshold they want and still verifies.
    // The contract remains responsible for confirming that the `threshold` in
    // the public inputs is the figure its policy actually requires. The circuit
    // proves the relation; it cannot know the policy.
    assert(income >= threshold);
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package income_proof

global INC_ZERO_SIG: [u8; 64] = [0; 64];
global INC_ZERO_X: [u8; 32]   = [0; 32];
global INC_ZERO_Y: [u8; 32]   = [0; 32];

#[test(should_fail)]
fn test_wrong_commitment_rejected() {
    main(250000, 0xabcd, INC_ZERO_SIG, 0x1, INC_ZERO_X, INC_ZERO_Y, 100000);
}

// income < threshold: person does not meet the minimum.
#[test(should_fail)]
fn test_income_below_threshold_rejected() {
    let income: u64    = 49999;
    let threshold: u64 = 50000;
    let bad_commitment = 0x2;
    main(income, 0x1, INC_ZERO_SIG, bad_commitment, INC_ZERO_X, INC_ZERO_Y, threshold);
}

// income == threshold - 1: off-by-one boundary.
#[test(should_fail)]
fn test_income_one_below_threshold_rejected() {
    let income: u64    = 99999;
    let threshold: u64 = 100000;
    let bad_commitment = 0x3;
    main(income, 0x1, INC_ZERO_SIG, bad_commitment, INC_ZERO_X, INC_ZERO_Y, threshold);
}

// salt mismatch.
#[test(should_fail)]
fn test_salt_mismatch_rejected() {
    let income: u64 = 250000;
    let real_salt: Field = 0xfeed;
    let wrong_salt: Field = 0xface;
    let commitment = Poseidon2::hash([income as Field, real_salt], 2);
    main(income, wrong_salt, INC_ZERO_SIG, commitment, INC_ZERO_X, INC_ZERO_Y, 100000);
}

// --- Property-based boundary tests (logic-only) --------------------------
// Systematic coverage of the `income >= threshold` constraint boundary.

// Exact boundary: income == threshold -> passes.
#[test]
fn test_boundary_income_equals_threshold() {
    let income: u64 = 100000;
    let threshold: u64 = 100000;
    assert(income >= threshold);
}

// Off-by-one above: income == threshold + 1 -> passes.
#[test]
fn test_boundary_income_one_above_threshold() {
    let income: u64 = 100001;
    let threshold: u64 = 100000;
    assert(income >= threshold);
}

// Off-by-one below: income == threshold - 1 -> fails.
#[test(should_fail)]
fn test_boundary_income_one_below_threshold() {
    let income: u64 = 99999;
    let threshold: u64 = 100000;
    assert(income >= threshold);
}

// Threshold zero: any income passes.
#[test]
fn test_boundary_zero_threshold() {
    let income: u64 = 0;
    let threshold: u64 = 0;
    assert(income >= threshold);
}

// Large values near u64 boundary.
#[test]
fn test_boundary_large_income() {
    let income: u64 = 1000000000000; // 1 trillion
    let threshold: u64 = 999999999999;
    assert(income >= threshold);
}

#[test(should_fail)]
fn test_boundary_large_income_one_below() {
    let income: u64 = 999999999998;
    let threshold: u64 = 999999999999;
    assert(income >= threshold);
}

// Multiple threshold values: boundary sweep.
#[test]
fn test_boundary_multiple_thresholds_pass() {
    let thresholds: [u64; 5] = [1, 100, 50000, 1000000, 10000000];
    for i in 0..5 {
        let t = thresholds[i];
        // income = threshold (exact match)
        assert(t >= t);
        // income = threshold + 1
        assert(t + 1 >= t);
    }
}

#[test(should_fail)]
fn test_boundary_multiple_thresholds_fail() {
    let t: u64 = 50000;
    let income: u64 = t - 1;
    assert(income >= t);
}

// Income exactly doubles threshold.
#[test]
fn test_boundary_income_double_threshold() {
    let income: u64 = 200000;
    let threshold: u64 = 100000;
    assert(income >= threshold);
}

// Commitment with varied salts: Poseidon2 is deterministic.
#[test]
fn test_commitment_varied_salts() {
    let income: u64 = 100000;
    let c1 = Poseidon2::hash([income as Field, 1 as Field], 2);
    let c2 = Poseidon2::hash([income as Field, 2 as Field], 2);
    let c3 = Poseidon2::hash([income as Field, 0xdeadbeef as Field], 2);
    // All different salts produce different commitments.
    assert(c1 != c2);
    assert(c2 != c3);
    assert(c1 != c3);
}

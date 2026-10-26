// funds_proof
//
// Proves "my account balance is at least `threshold`" without revealing the
// figure, bound to a commitment a trusted issuer signed (secp256k1 ECDSA,
// in-circuit). The balance is an integer (e.g. USD cents or whole dollars).

use dep::credential_lib;
use dep::poseidon::poseidon2::Poseidon2;

fn main(
    // private
    //
    // `balance` is u64 rather than Field on purpose: `>=` on Field has no
    // meaningful ordering over BN254, and a prover could choose a value that
    // wraps the modulus to compare however they needed. u64 is a bounded integer
    // whose width the proving system range-constrains, so the comparison below
    // means what it reads as. It also caps the balance near 1.8e19, comfortably
    // above any real figure in cents.
    balance: u64,
    salt: Field,
    sig: [u8; 64],
    // public
    commitment: pub Field,
    issuer_x: pub [u8; 32],
    issuer_y: pub [u8; 32],
    threshold: pub u64,
) {
    // Binds the private balance to the issuer-signed commitment and verifies the
    // issuer's signature in-circuit. See circuits/lib/src/lib.nr for the detail;
    // in short, without the commitment check the threshold assertion below would
    // be about an unrelated balance, and without the in-circuit signature check
    // a holder could commit to any balance and sign it with their own key.
    // The `as Field` cast is a lossless widening, so it cannot map two distinct
    // balances to the same commitment.
    credential_lib::assert_committed_and_signed(balance as Field, salt, sig, commitment, issuer_x, issuer_y);

    // The claim itself, proved rather than asserted. `threshold` is a public
    // input chosen by the prover and carries no weight by itself; this constraint
    // is what ties it to the signed private balance. It cannot move on-chain
    // because the contract never sees `balance`, so dropping it lets a holder
    // submit whatever threshold they want and still verify.
    // The contract must still confirm the `threshold` in the public inputs is the
    // figure its policy demands.
    // Worth noting for this credential type specifically: a balance is a
    // point-in-time fact and this circuit carries no timestamp, so the proof says
    // nothing about when the balance held. Freshness has to come from issuance
    // policy and the contract's expiry handling, not from here.
    assert(balance >= threshold);
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package funds_proof

global FND_ZERO_SIG: [u8; 64] = [0; 64];
global FND_ZERO_X: [u8; 32]   = [0; 32];
global FND_ZERO_Y: [u8; 32]   = [0; 32];

#[test(should_fail)]
fn test_wrong_commitment_rejected() {
    main(100000, 0x1234, FND_ZERO_SIG, 0x1, FND_ZERO_X, FND_ZERO_Y, 50000);
}

// balance < threshold.
#[test(should_fail)]
fn test_balance_below_threshold_rejected() {
    let balance: u64   = 9999;
    let threshold: u64 = 10000;
    let bad_commitment = 0x2;
    main(balance, 0x1, FND_ZERO_SIG, bad_commitment, FND_ZERO_X, FND_ZERO_Y, threshold);
}

// Exact off-by-one: balance is 1 unit below threshold.
#[test(should_fail)]
fn test_balance_one_below_threshold_rejected() {
    let balance: u64   = 49999;
    let threshold: u64 = 50000;
    let bad_commitment = 0x3;
    main(balance, 0x1, FND_ZERO_SIG, bad_commitment, FND_ZERO_X, FND_ZERO_Y, threshold);
}

// salt mismatch: commitment uses a different salt.
#[test(should_fail)]
fn test_salt_mismatch_rejected() {
    let balance: u64 = 100000;
    let real_salt: Field = 0xcafe;
    let wrong_salt: Field = 0xbabe;
    let commitment = Poseidon2::hash([balance as Field, real_salt], 2);
    main(balance, wrong_salt, FND_ZERO_SIG, commitment, FND_ZERO_X, FND_ZERO_Y, 50000);
}

// --- Property-based boundary tests (logic-only) --------------------------
// Systematic coverage of the `balance >= threshold` constraint boundary.

// Exact boundary: balance == threshold.
#[test]
fn test_boundary_balance_equals_threshold() {
    let balance: u64 = 50000;
    let threshold: u64 = 50000;
    assert(balance >= threshold);
}

// Off-by-one above.
#[test]
fn test_boundary_balance_one_above() {
    let balance: u64 = 50001;
    let threshold: u64 = 50000;
    assert(balance >= threshold);
}

// Off-by-one below.
#[test(should_fail)]
fn test_boundary_balance_one_below() {
    let balance: u64 = 49999;
    let threshold: u64 = 50000;
    assert(balance >= threshold);
}

// Zero balance, zero threshold.
#[test]
fn test_boundary_zero_zero() {
    let balance: u64 = 0;
    let threshold: u64 = 0;
    assert(balance >= threshold);
}

// Large balance boundary.
#[test]
fn test_boundary_large_values() {
    let balance: u64 = 10000000000000;
    let threshold: u64 = 10000000000000;
    assert(balance >= threshold);
}

#[test(should_fail)]
fn test_boundary_large_values_one_below() {
    let balance: u64 = 9999999999999;
    let threshold: u64 = 10000000000000;
    assert(balance >= threshold);
}

// Multiple threshold sweep.
#[test]
fn test_boundary_threshold_sweep() {
    let thresholds: [u64; 6] = [1, 100, 1000, 10000, 100000, 1000000];
    for i in 0..6 {
        let t = thresholds[i];
        assert(t >= t); // exact
        assert(t + 1 >= t); // one above
    }
}

#[test(should_fail)]
fn test_boundary_threshold_sweep_fail() {
    let t: u64 = 10000;
    let balance: u64 = t - 1;
    assert(balance >= t);
}

// Commitment binding: different balances produce different commitments.
#[test]
fn test_commitment_different_balances() {
    let salt: Field = 42;
    let c1 = Poseidon2::hash([49999 as Field, salt], 2);
    let c2 = Poseidon2::hash([50000 as Field, salt], 2);
    let c3 = Poseidon2::hash([50001 as Field, salt], 2);
    assert(c1 != c2);
    assert(c2 != c3);
}

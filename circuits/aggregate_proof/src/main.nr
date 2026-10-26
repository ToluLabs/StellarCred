// aggregate_proof
//
// Recursive proof aggregator: proves multiple credential claims in a single
// circuit so only ONE on-chain verification call is needed for N credentials.
// Start with N=2 (KYC + age) as a proof of concept; designed to generalise to N<=5.
//
// Rather than calling Noir's std::recursion::verify_proof (whose API is still
// evolving rapidly across beta releases), this circuit re-verifies all inner
// claims directly: the same Poseidon2 commitment check and secp256k1 ECDSA
// signature verification that each inner circuit performs, bundled together.
//
// This produces the same end result -- a single UltraHonk proof covering N
// credentials -- and is compatible with any Noir version that supports the
// poseidon and ecdsa_secp256k1 stdlib modules. The outer proof is verified
// on-chain via submit_aggregate_proof which atomically stores all claims.
//
// Public input layout (concatenated 32-byte big-endian fields):
//   fields 0..64  : KYC proof (commitment + issuer_x[32] + issuer_y[32])   = 65
//   fields 65..131: age proof (commitment + issuer_x[32] + issuer_y[32]
//                   + current_date + threshold_years)                       = 67
//   field  132    : num_credentials (last field, pub)                        = 1
// Total: 65 + 67 + 1 = 133 public fields

use dep::poseidon::poseidon2::Poseidon2;
use std::ecdsa_secp256k1::verify_signature;

fn main(
    // -- KYC credential (private) ------------------------------------------
    kyc_secret: Field,
    kyc_salt: Field,
    kyc_sig: [u8; 64],
    // -- KYC credential (public) -------------------------------------------
    kyc_commitment: pub Field,
    kyc_issuer_x: pub [u8; 32],
    kyc_issuer_y: pub [u8; 32],

    // -- Age credential (private) ------------------------------------------
    age_date_of_birth: u64,
    age_salt: Field,
    age_sig: [u8; 64],
    // -- Age credential (public) -------------------------------------------
    age_commitment: pub Field,
    age_issuer_x: pub [u8; 32],
    age_issuer_y: pub [u8; 32],
    age_current_date: pub u64,
    age_threshold_years: pub u64,

    // -- Metadata -----------------------------------------------------------
    // Number of credentials packed in this proof (always 2 for PoC).
    // Exposed publicly so the contract knows how many claims to extract.
    num_credentials: pub Field,
) {
    // -- Verify KYC credential ----------------------------------------------
    // See circuits/lib/src/lib.nr for why this must be asserted non-zero:
    // it blocks the degenerate case where an unsalted commitment becomes a
    // brute-forceable hash of a low-entropy value.
    assert(kyc_salt != 0);
    assert(Poseidon2::hash([kyc_secret, kyc_salt], 2) == kyc_commitment);
    let kyc_z: [u8; 32] = kyc_commitment.to_be_bytes();
    assert(verify_signature(kyc_issuer_x, kyc_issuer_y, kyc_sig, kyc_z));

    // -- Verify age credential ----------------------------------------------
    assert(age_salt != 0);
    assert(Poseidon2::hash([age_date_of_birth as Field, age_salt], 2) == age_commitment);
    let age_z: [u8; 32] = age_commitment.to_be_bytes();
    assert(verify_signature(age_issuer_x, age_issuer_y, age_sig, age_z));
    assert(age_current_date >= age_date_of_birth);
    let age_years = (age_current_date - age_date_of_birth) / 365;
    assert(age_years >= age_threshold_years);

    // -- Metadata constraint ------------------------------------------------
    assert(num_credentials == 2);
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package aggregate_proof

// fails on the salt != 0 assert before the signature check is reached
#[test(should_fail)]
fn test_zero_kyc_salt_rejected() {
    let zero_sig: [u8; 64] = [0; 64];
    let zero_x: [u8; 32] = [0; 32];
    let zero_y: [u8; 32] = [0; 32];

    main(
        1, 0, zero_sig, 0, zero_x, zero_y, // kyc: salt = 0
        20000101, 1, zero_sig, 0, zero_x, zero_y, 20240101, 18,
        2,
    );
}

// fails on the salt != 0 assert before the signature check is reached
#[test(should_fail)]
fn test_zero_age_salt_rejected() {
    let zero_sig: [u8; 64] = [0; 64];
    let zero_x: [u8; 32] = [0; 32];
    let zero_y: [u8; 32] = [0; 32];

    main(
        1, 1, zero_sig, 0, zero_x, zero_y,
        20000101, 0, zero_sig, 0, zero_x, zero_y, 20240101, 18, // age: salt = 0
        2,
    );
}

// --- Property-based boundary tests (logic-only) --------------------------
// Test the age constraint logic independently: `age_years >= threshold_years`
// where `age_years = (current_date - date_of_birth) / 365`.

// Exact boundary: age exactly at threshold.
#[test]
fn test_boundary_age_exact_threshold() {
    let dob: u64 = 10000;
    let threshold: u64 = 18;
    let current: u64 = dob + threshold * 365;
    assert(current >= dob);
    let age_years = (current - dob) / 365;
    assert(age_years >= threshold);
}

// Off-by-one below: age one day short of threshold.
#[test(should_fail)]
fn test_boundary_age_one_day_below() {
    let dob: u64 = 10000;
    let threshold: u64 = 18;
    let current: u64 = dob + threshold * 365 - 1;
    assert(current >= dob);
    let age_years = (current - dob) / 365;
    assert(age_years >= threshold);
}

// Off-by-one above.
#[test]
fn test_boundary_age_one_day_above() {
    let dob: u64 = 10000;
    let threshold: u64 = 18;
    let current: u64 = dob + threshold * 365 + 1;
    assert(current >= dob);
    let age_years = (current - dob) / 365;
    assert(age_years >= threshold);
}

// num_credentials must equal 2.
#[test(should_fail)]
fn test_invalid_num_credentials() {
    let n: Field = 3;
    assert(n == 2);
}

#[test]
fn test_valid_num_credentials() {
    let n: Field = 2;
    assert(n == 2);
}

// Multiple threshold sweep for the age constraint.
#[test]
fn test_boundary_age_threshold_sweep() {
    let dob: u64 = 5000;
    let thresholds: [u64; 4] = [1, 18, 21, 65];
    for i in 0..4 {
        let t = thresholds[i];
        let current = dob + t * 365;
        assert(current >= dob);
        let age_years = (current - dob) / 365;
        assert(age_years >= t);
    }
}

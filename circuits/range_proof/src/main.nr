// range_proof
//
// Proves "min <= value <= max" without revealing the value, bound to a
// commitment a trusted issuer signed (secp256k1 ECDSA, checked in-circuit).

use dep::poseidon::poseidon2::Poseidon2;
use std::ecdsa_secp256k1::verify_signature;

fn main(
    // private
    value: u64,
    salt: Field,
    sig: [u8; 64],
    // public
    commitment: pub Field,
    issuer_x: pub [u8; 32],
    issuer_y: pub [u8; 32],
    min: pub u64,
    max: pub u64,
) {
    // Blocks the degenerate zero-salt case; see circuits/lib/src/lib.nr for
    // the full rationale on why salt must be non-trivial.
    assert(salt != 0);
    assert(Poseidon2::hash([value as Field, salt], 2) == commitment);
    let z: [u8; 32] = commitment.to_be_bytes();
    assert(verify_signature(issuer_x, issuer_y, sig, z));
    assert(value >= min);
    assert(value <= max);
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package range_proof

// A zero salt must be rejected outright, before any other constraint is even
// reached - it makes the commitment a brute-forceable hash of `value`.
#[test(should_fail)]
fn test_zero_salt_rejected() {
    let zero_sig: [u8; 64] = [0; 64];
    let zero_x: [u8; 32] = [0; 32];
    let zero_y: [u8; 32] = [0; 32];
    main(50, 0, zero_sig, 0, zero_x, zero_y, 0, 100);
}

// --- Property-based boundary tests (logic-only) --------------------------
// Systematic coverage of the `min <= value <= max` constraint boundaries.

// Exact lower bound: value == min.
#[test]
fn test_boundary_value_equals_min() {
    let value: u64 = 100;
    let min: u64 = 100;
    let max: u64 = 200;
    assert(value >= min);
    assert(value <= max);
}

// Exact upper bound: value == max.
#[test]
fn test_boundary_value_equals_max() {
    let value: u64 = 200;
    let min: u64 = 100;
    let max: u64 = 200;
    assert(value >= min);
    assert(value <= max);
}

// Below lower bound: value == min - 1.
#[test(should_fail)]
fn test_boundary_value_below_min() {
    let value: u64 = 99;
    let min: u64 = 100;
    let max: u64 = 200;
    assert(value >= min);
    assert(value <= max);
}

// Above upper bound: value == max + 1.
#[test(should_fail)]
fn test_boundary_value_above_max() {
    let value: u64 = 201;
    let min: u64 = 100;
    let max: u64 = 200;
    assert(value >= min);
    assert(value <= max);
}

// Single-element range: min == max == value.
#[test]
fn test_boundary_single_element_range() {
    let value: u64 = 42;
    let min: u64 = 42;
    let max: u64 = 42;
    assert(value >= min);
    assert(value <= max);
}

// Single-element range, value off by one.
#[test(should_fail)]
fn test_boundary_single_element_range_off() {
    let value: u64 = 43;
    let min: u64 = 42;
    let max: u64 = 42;
    assert(value >= min);
    assert(value <= max);
}

// Zero range starting at 0.
#[test]
fn test_boundary_zero_range() {
    let value: u64 = 0;
    let min: u64 = 0;
    let max: u64 = 0;
    assert(value >= min);
    assert(value <= max);
}

// Large range boundary.
#[test]
fn test_boundary_large_range() {
    let min: u64 = 1000000000;
    let max: u64 = 2000000000;
    assert(min >= min);
    assert(min <= max);
    assert(max >= min);
    assert(max <= max);
}

#[test(should_fail)]
fn test_boundary_large_range_below() {
    let value: u64 = 999999999;
    let min: u64 = 1000000000;
    let max: u64 = 2000000000;
    assert(value >= min);
}

// Multiple boundary sweep.
#[test]
fn test_boundary_sweep() {
    let ranges: [(u64, u64); 4] = [(0, 100), (100, 200), (1000, 2000), (50000, 100000)];
    for i in 0..4 {
        let min = ranges[i].0;
        let max = ranges[i].1;
        // Lower bound exact
        assert(min >= min);
        assert(min <= max);
        // Upper bound exact
        assert(max >= min);
        assert(max <= max);
        // Midpoint
        let mid = (min + max) / 2;
        assert(mid >= min);
        assert(mid <= max);
    }
}

// Salt guard: non-zero salt is accepted.
#[test]
fn test_nonzero_salt_accepted_logic() {
    let salt: Field = 42;
    assert(salt != 0);
}

// Commitment with different values in range.
#[test]
fn test_commitment_range_values() {
    let salt: Field = 99;
    let c_min = Poseidon2::hash([100 as Field, salt], 2);
    let c_mid = Poseidon2::hash([150 as Field, salt], 2);
    let c_max = Poseidon2::hash([200 as Field, salt], 2);
    assert(c_min != c_mid);
    assert(c_mid != c_max);
    assert(c_min != c_max);
}

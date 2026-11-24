// commit
//
// Helper circuit used only by the issuer to compute a credential commitment:
// commitment = Poseidon2([value, salt], 2). Executed (witness only) in the
// browser to derive the commitment, never proven. Every credential circuit
// binds to a commitment of this exact shape, so the issuer can use this one
// helper for all credential types.

use dep::poseidon::poseidon2::Poseidon2;

fn main(value: Field, salt: Field) -> pub Field {
    // Defense-in-depth: catch a degenerate zero salt at commitment-computation
    // time (issuance), not just at proof time in the downstream credential
    // circuits. See circuits/lib/src/lib.nr for the full rationale.
    assert(salt != 0);
    Poseidon2::hash([value, salt], 2)
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package commit
// The commit circuit has no signature; all tests are fully deterministic.

// Poseidon2 is deterministic: same inputs must always yield the same commitment.
#[test]
fn test_commitment_is_deterministic() {
    let c1 = main(42, 99);
    let c2 = main(42, 99);
    assert(c1 == c2);
}

// Different values must produce different commitments (collision-resistance).
// Salt must be non-zero (see below), so both calls use the same nonzero salt.
#[test]
fn test_different_values_produce_different_commitments() {
    let c1 = main(1, 7);
    let c2 = main(2, 7);
    assert(c1 != c2);
}

// Different salts must produce different commitments (binding).
#[test]
fn test_different_salts_produce_different_commitments() {
    let c1 = main(42, 1);
    let c2 = main(42, 2);
    assert(c1 != c2);
}

// Commitment for (0, salt) must be non-zero (Poseidon2 output is never zero
// for any input in the BN254 scalar field under the standard parameters).
// value = 0 is fine here - it's `salt` that must never be zero, and this test
// uses a nonzero one.
#[test]
fn test_zero_value_non_zero_commitment() {
    let c = main(0, 7);
    assert(c != 0);
}

// A zero salt must be rejected outright - this is the fix for the
// salt-entropy issue: a zero (or otherwise degenerate) salt makes the
// commitment a brute-forceable hash of a low-entropy value.
#[test(should_fail)]
fn test_zero_salt_rejected() {
    let _ = main(42, 0);
}

// Large field-element values are accepted without overflow.
#[test]
fn test_large_inputs_accepted() {
    // max u64 cast to Field
    let big: Field = 0xffffffffffffffff;
    let c = main(big, big);
    assert(c != 0);
}

// --- Property-based boundary tests ---------------------------------------
// Systematic coverage of the commitment function Poseidon2([value, salt], 2).

// Wide sweep: many different (value, salt) pairs produce non-zero commitments.
#[test]
fn test_property_many_pairs_nonzero() {
    let values: [Field; 5] = [0, 1, 42, 1000000, 0xffffffffffffffff];
    let salts: [Field; 5] = [1, 7, 99, 0xdead, 0xbeef];
    for i in 0..5 {
        for j in 0..5 {
            let c = main(values[i], salts[j]);
            assert(c != 0);
        }
    }
}

// Collision resistance: no two distinct (value, salt) pairs collide in a sweep.
#[test]
fn test_property_no_collisions_in_sweep() {
    let c1 = main(1, 1);
    let c2 = main(1, 2);
    let c3 = main(2, 1);
    let c4 = main(2, 2);
    let c5 = main(100, 100);
    let c6 = main(100, 101);
    assert(c1 != c2);
    assert(c1 != c3);
    assert(c1 != c4);
    assert(c2 != c3);
    assert(c2 != c4);
    assert(c3 != c4);
    assert(c5 != c6);
    assert(c1 != c5);
}

// Boundary values: 0 and 1 for both value and salt.
#[test]
fn test_property_boundary_values() {
    let c01 = main(0, 1);
    let c10 = main(1, 1);
    let c11 = main(1, 1);
    // Same inputs produce same output.
    assert(c10 == c11);
    // Different value produces different output.
    assert(c01 != c10);
}

// Sequential salts produce sequential distinct commitments.
#[test]
fn test_property_sequential_salts_distinct() {
    let value: Field = 42;
    let mut prev = main(value, 1);
    for s in 2..10 {
        let c = main(value, s as Field);
        assert(c != prev);
        prev = c;
    }
}

// Sequential values produce sequential distinct commitments.
#[test]
fn test_property_sequential_values_distinct() {
    let salt: Field = 7;
    let mut prev = main(0, salt);
    for v in 1..10 {
        let c = main(v as Field, salt);
        assert(c != prev);
        prev = c;
    }
}

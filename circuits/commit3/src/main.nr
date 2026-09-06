// commit3
//
// Helper circuit used only by the issuer to compute an employment credential
// commitment of the form:
//   commitment = Poseidon2::hash([status, seniority, salt], 3)
// so the issuer's signature binds both the "is employed" tag AND the
// holder's specific tenure (otherwise a holder could self-select any
// seniority >= min_seniority and satisfy the circuit constraint). Executed
// (witness only) in the browser to derive the commitment; never proven.
//
// Most credential types use the 2-arity `commit` helper instead. This one
// exists solely so employment can commit to two preimage values.

use dep::poseidon::poseidon2::Poseidon2;

fn main(status: Field, seniority: Field, salt: Field) -> pub Field {
    // Defense-in-depth: catch a degenerate zero salt at commitment-computation
    // time (issuance), not just at proof time in employment_proof. See
    // circuits/lib/src/lib.nr for the full rationale.
    assert(salt != 0);
    Poseidon2::hash([status, seniority, salt], 3)
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package commit3

#[test]
fn test_commitment_is_deterministic() {
    let c1 = main(1, 5, 7);
    let c2 = main(1, 5, 7);
    assert(c1 == c2);
}

#[test(should_fail)]
fn test_zero_salt_rejected() {
    let _ = main(1, 5, 0);
}

// --- Property-based boundary tests ---------------------------------------

// Different (status, seniority) pairs produce different commitments.
#[test]
fn test_different_pairs_different_commitments() {
    let salt: Field = 11;
    let c1 = main(1, 5, salt);
    let c2 = main(1, 6, salt);
    let c3 = main(2, 5, salt);
    let c4 = main(0, 5, salt);
    assert(c1 != c2);
    assert(c1 != c3);
    assert(c1 != c4);
    assert(c2 != c3);
}

// Same inputs always produce same output.
#[test]
fn test_deterministic_across_calls() {
    let c1 = main(1, 10, 42);
    let c2 = main(1, 10, 42);
    let c3 = main(1, 10, 42);
    assert(c1 == c2);
    assert(c2 == c3);
}

// Salt binding: same (status, seniority) with different salts.
#[test]
fn test_salt_binding() {
    let c1 = main(1, 5, 11);
    let c2 = main(1, 5, 22);
    let c3 = main(1, 5, 33);
    assert(c1 != c2);
    assert(c2 != c3);
    assert(c1 != c3);
}

// Commitment is never zero.
#[test]
fn test_commitment_never_zero() {
    let c1 = main(1, 1, 1);
    let c2 = main(100, 50, 99);
    let c3 = main(0, 0, 1);
    assert(c1 != 0);
    assert(c2 != 0);
    assert(c3 != 0);
}

// Wide sweep: various status and seniority values.
#[test]
fn test_property_wide_sweep() {
    let salt: Field = 7;
    let c1 = main(0, 0, salt);
    let c2 = main(1, 0, salt);
    let c3 = main(0, 1, salt);
    let c4 = main(255, 50, salt);
    assert(c1 != c2);
    assert(c1 != c3);
    assert(c2 != c3);
    assert(c4 != c1);
}

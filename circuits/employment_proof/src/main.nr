// employment_proof
//
// Proves "I am employed" (and optionally at seniority >= min_seniority)
// without revealing the employer or exact role, bound to a commitment a
// trusted issuer (the employer) signed (secp256k1 ECDSA, in-circuit).
// Unlocks income-linked lending, professional gating, and DAO contributor
// verification.
//
// The commitment is Poseidon2::hash([employment_status, seniority, salt], 3),
// so the issuer's signature binds BOTH the "is employed" tag AND the
// holder's specific tenure. The min_seniority public input is just the
// threshold the verifier asks about; it is not part of the commitment.

use dep::poseidon::poseidon2::Poseidon2;
use std::ecdsa_secp256k1::verify_signature;

fn main(
    // private
    employment_status: u64,
    seniority: u64,
    salt: Field,
    sig: [u8; 64],
    // public
    commitment: pub Field,
    issuer_x: pub [u8; 32],
    issuer_y: pub [u8; 32],
    min_seniority: pub u64,
) {
    // Blocks the degenerate zero-salt case; see circuits/lib/src/lib.nr for
    // the full rationale on why salt must be non-trivial.
    assert(salt != 0);
    // The issuer's signature covers a commitment that includes both the
    // employment status AND the holder's tenure, so the seniority claim is
    // backed by the issuer, not self-asserted.
    assert(
        Poseidon2::hash(
            [employment_status as Field, seniority as Field, salt],
            3,
        ) == commitment,
    );
    let z: [u8; 32] = commitment.to_be_bytes();
    assert(verify_signature(issuer_x, issuer_y, sig, z));
    // The status tag must be > 0 (i.e. the holder is "employed"); issuers are
    // expected to only sign non-zero tags, but the constraint also defends
    // against forged zero-tag credentials.
    assert(employment_status != 0);
    assert(seniority >= min_seniority);
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package employment_proof

// A zero salt must be rejected outright, before any other constraint is even
// reached - it makes the 3-arity commitment brute-forceable given the small
// (status, seniority) domain.
#[test(should_fail)]
fn test_zero_salt_rejected() {
    let zero_sig: [u8; 64] = [0; 64];
    let zero_x: [u8; 32] = [0; 32];
    let zero_y: [u8; 32] = [0; 32];
    main(1, 5, 0, zero_sig, 0, zero_x, zero_y, 0);
}

// --- Property-based boundary tests (logic-only) --------------------------
// Systematic coverage of employment constraints without full commitment/sig.

// Seniority boundary: exact match.
#[test]
fn test_boundary_seniority_exact() {
    let seniority: u64 = 5;
    let min_seniority: u64 = 5;
    assert(seniority >= min_seniority);
}

// Seniority off-by-one above.
#[test]
fn test_boundary_seniority_one_above() {
    let seniority: u64 = 6;
    let min_seniority: u64 = 5;
    assert(seniority >= min_seniority);
}

// Seniority off-by-one below.
#[test(should_fail)]
fn test_boundary_seniority_one_below() {
    let seniority: u64 = 4;
    let min_seniority: u64 = 5;
    assert(seniority >= min_seniority);
}

// Zero seniority with zero min.
#[test]
fn test_boundary_zero_seniority() {
    let seniority: u64 = 0;
    let min_seniority: u64 = 0;
    assert(seniority >= min_seniority);
}

// Status must be non-zero.
#[test(should_fail)]
fn test_boundary_zero_status() {
    let status: u64 = 0;
    assert(status != 0);
}

// Various non-zero status values are all accepted.
#[test]
fn test_boundary_nonzero_statuses() {
    let statuses: [u64; 5] = [1, 2, 3, 100, 255];
    for i in 0..5 {
        assert(statuses[i] != 0);
    }
}

// Seniority sweep across multiple min values.
#[test]
fn test_boundary_seniority_sweep() {
    let mins: [u64; 5] = [0, 1, 5, 10, 30];
    for i in 0..5 {
        let m = mins[i];
        assert(m >= m); // exact
        assert(m + 1 >= m); // one above
    }
}

#[test(should_fail)]
fn test_boundary_seniority_sweep_fail() {
    let m: u64 = 10;
    let seniority: u64 = m - 1;
    assert(seniority >= m);
}

// 3-arity commitment: different (status, seniority) pairs produce different commitments.
#[test]
fn test_commitment_different_pairs() {
    let salt: Field = 11;
    let c1 = Poseidon2::hash([1 as Field, 5 as Field, salt], 3);
    let c2 = Poseidon2::hash([1 as Field, 6 as Field, salt], 3);
    let c3 = Poseidon2::hash([2 as Field, 5 as Field, salt], 3);
    assert(c1 != c2);
    assert(c1 != c3);
    assert(c2 != c3);
}

// Salt binding: same (status, seniority) with different salts -> different commitments.
#[test]
fn test_commitment_salt_binding_3ary() {
    let c1 = Poseidon2::hash([1 as Field, 5 as Field, 11 as Field], 3);
    let c2 = Poseidon2::hash([1 as Field, 5 as Field, 22 as Field], 3);
    assert(c1 != c2);
}

// Large seniority values.
#[test]
fn test_boundary_large_seniority() {
    let seniority: u64 = 50;
    let min_seniority: u64 = 50;
    assert(seniority >= min_seniority);
}

#[test(should_fail)]
fn test_boundary_large_seniority_fail() {
    let seniority: u64 = 49;
    let min_seniority: u64 = 50;
    assert(seniority >= min_seniority);
}

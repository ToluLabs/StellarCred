// date_range
//
// Proves "the credential I hold was issued between `window_start` and
// `window_end`" without revealing the issuance date, bound to a commitment a
// trusted issuer signed (secp256k1 ECDSA, checked in-circuit). Dates are days
// since the Unix epoch.
//
// This is the freshness half of the credential story: age_proof says "the
// signed date is at least N years before today", this circuit says "the signed
// date is inside this window" - enough to prove a credential is recent, or that
// it falls in a reporting period, while the exact day stays private.

use dep::credential_lib;
use dep::poseidon::poseidon2::Poseidon2;

fn main(
    // private
    issued_at: u64,
    salt: Field,
    sig: [u8; 64],
    // public
    commitment: pub Field,
    issuer_x: pub [u8; 32],
    issuer_y: pub [u8; 32],
    window_start: pub u64,
    window_end: pub u64,
) {
    // Blocks the degenerate zero-salt case; see circuits/lib/src/lib.nr for the
    // full rationale. An issuance date is a few tens of thousands of plausible
    // days, so an unsalted commitment is reversible by hashing candidates.
    assert(salt != 0);

    // Binds the private date to the issuer-signed commitment and checks the
    // issuer's signature in-circuit. Without it the range assertion below would
    // be about a date the issuer never saw. The `as Field` cast is lossless
    // widening, so it cannot map two dates onto one commitment.
    credential_lib::assert_committed_and_signed(issued_at as Field, salt, sig, commitment, issuer_x, issuer_y);

    assert_date_in_range(issued_at, window_start, window_end);
}

// The claim itself, proved rather than asserted: `window_start <= issued_at <=
// window_end`, inclusive on both bounds.
//
// This constraint is the only thing tying the public window to the signed
// private date, and it cannot move on-chain: the contract never sees
// `issued_at`, so it has nothing to compare against. Drop it and a holder can
// submit any window they like and the proof still verifies.
//
// Both bounds are prover-supplied public inputs, so the circuit proves the
// relation, not the policy. A verifier that means "issued in the last 90 days"
// must itself check `window_start`/`window_end` against ledger time and refuse
// a window wider than its policy allows - an unbounded window is trivially
// satisfiable and proves nothing.
fn assert_date_in_range(issued_at: u64, window_start: u64, window_end: u64) {
    // Rejects the inverted window instead of letting it silently match nothing,
    // which would otherwise look like a valid proof of an empty set.
    assert(window_start <= window_end);
    assert(issued_at >= window_start);
    assert(issued_at <= window_end);
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package date_range

global DATE_RANGE_ZERO_SIG: [u8; 64] = [0; 64];
global DATE_RANGE_ZERO_X: [u8; 32] = [0; 32];
global DATE_RANGE_ZERO_Y: [u8; 32] = [0; 32];

// --- Reject paths --------------------------------------------------------

// Commitment does not match the Poseidon2 hash of (issued_at, salt).
#[test(should_fail)]
fn test_wrong_commitment_rejected() {
    main(3650, 12345, DATE_RANGE_ZERO_SIG, 0x1, DATE_RANGE_ZERO_X, DATE_RANGE_ZERO_Y, 3000, 4000);
}

// A zero salt must be rejected outright - it makes the commitment a
// brute-forceable hash of the issuance date.
#[test(should_fail)]
fn test_zero_salt_rejected() {
    main(3650, 0, DATE_RANGE_ZERO_SIG, 0x1, DATE_RANGE_ZERO_X, DATE_RANGE_ZERO_Y, 3000, 4000);
}

// Salt mismatch: commitment computed with a different salt.
#[test(should_fail)]
fn test_salt_mismatch_rejected() {
    let issued_at: u64 = 3650;
    let real_salt: Field = 0xdead;
    let wrong_salt: Field = 0xbeef;
    let commitment = Poseidon2::hash([issued_at as Field, real_salt], 2);
    main(issued_at, wrong_salt, DATE_RANGE_ZERO_SIG, commitment, DATE_RANGE_ZERO_X, DATE_RANGE_ZERO_Y, 3000, 4000);
}

// --- Window boundary tests (logic-only, no sig) --------------------------

// Exact lower bound: issued_at == window_start.
#[test]
fn test_start_boundary_included() {
    assert_date_in_range(3000, 3000, 4000);
}

// Exact upper bound: issued_at == window_end.
#[test]
fn test_end_boundary_included() {
    assert_date_in_range(4000, 3000, 4000);
}

#[test]
fn test_date_inside_window() {
    assert_date_in_range(3650, 3000, 4000);
}

// One day before the window.
#[test(should_fail)]
fn test_date_before_window_rejected() {
    assert_date_in_range(2999, 3000, 4000);
}

// One day after the window.
#[test(should_fail)]
fn test_date_after_window_rejected() {
    assert_date_in_range(4001, 3000, 4000);
}

#[test(should_fail)]
fn test_inverted_window_rejected() {
    assert_date_in_range(3500, 4000, 3000);
}

// Degenerate single-day window: only that exact day satisfies it.
#[test]
fn test_single_day_window_included() {
    assert_date_in_range(3650, 3650, 3650);
}

#[test(should_fail)]
fn test_single_day_window_off_by_one_rejected() {
    assert_date_in_range(3651, 3650, 3650);
}

// Sweep of dates around the edges of one window.
#[test]
fn test_window_sweep() {
    let start: u64 = 20000;
    let end: u64 = 20009;
    assert_date_in_range(start, start, end);
    assert_date_in_range(start + 1, start, end);
    assert_date_in_range(end, start, end);
}

#[test(should_fail)]
fn test_window_sweep_just_before() {
    let start: u64 = 20000;
    let end: u64 = 20009;
    assert_date_in_range(start - 1, start, end);
}

#[test(should_fail)]
fn test_window_sweep_just_after() {
    let start: u64 = 20000;
    let end: u64 = 20009;
    assert_date_in_range(end + 1, start, end);
}

// Epoch and large-date boundaries, to confirm nothing is special-cased near 0
// or near the top of the u64 range the dates live in.
#[test]
fn test_epoch_and_large_dates() {
    assert_date_in_range(0, 0, 100);
    assert_date_in_range(2000000000, 1000000000, 3000000000);
}

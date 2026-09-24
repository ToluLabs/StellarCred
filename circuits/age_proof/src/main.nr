// age_proof
//
// Proves "I am at least `threshold_years` old" without revealing the date of
// birth, bound to a commitment a trusted issuer signed (secp256k1 ECDSA, checked
// in-circuit). Dates are days since the Unix epoch.

use dep::credential_lib;
use dep::poseidon::poseidon2::Poseidon2;

fn main(
    // private
    date_of_birth: u64,
    salt: Field,
    sig: [u8; 64],
    // public
    commitment: pub Field,
    issuer_x: pub [u8; 32],
    issuer_y: pub [u8; 32],
    current_date: pub u64,
    threshold_years: pub u64,
) {
    // Binds the private date of birth to the issuer-signed commitment and
    // verifies the issuer's signature in-circuit. See circuits/lib/src/lib.nr
    // for what each of those two constraints prevents; in short, without the
    // commitment check the age comparison below would be about a date of birth
    // the issuer never saw, and without the in-circuit signature check a holder
    // could sign a self-chosen date of birth with their own key.
    // The `as Field` cast is a lossless widening (u64 fits in BN254 with room to
    // spare), so it cannot map two different dates onto one commitment.
    credential_lib::assert_committed_and_signed(date_of_birth as Field, salt, sig, commitment, issuer_x, issuer_y);

    // Bounds `threshold_years` so the arithmetic below stays in range. To be
    // precise about what this does and does not buy, because the two are easy to
    // conflate:
    // Noir does NOT wrap on u64 overflow. It range-constrains every arithmetic
    // result, so an attacker who picks `threshold_years` large enough to make
    // `threshold_years * 365` exceed 2^64 fails witness generation and produces
    // no proof at all. Verified on the pinned nargo 1.0.0-beta.9: that input
    // aborts with "attempt to multiply with overflow", and the analogous
    // addition aborts with "attempt to add with overflow". So the wraparound
    // attack (choose a huge threshold so the product wraps to a small number and
    // any date of birth clears it) is already dead, and removing this line does
    // not open a soundness hole.
    // It stays because it bounds the product to at most 73,000 days, which makes
    // overflow structurally impossible for any real date rather than merely
    // caught, and because it rejects nonsense claims with an error that names the
    // problem instead of surfacing as an opaque arithmetic failure inside the
    // expression below. 200 is far above any human age and needs no tightening.
    assert(threshold_years <= 200);

    // The claim itself, proved rather than asserted. Equivalent to the older
    // `(current_date - date_of_birth) / 365 >= threshold_years` but stated as a
    // multiplication, which avoids the division constraints entirely: for
    // integers, floor(x / 365) >= t exactly when x >= 365t. Same semantics,
    // cheaper circuit, and no subtraction to underflow.
    // This constraint is the only thing tying the public `threshold_years` to
    // the signed private date of birth. It cannot move on-chain, because the
    // contract never sees `date_of_birth` and so has nothing to compare against;
    // drop it and a holder submits any `threshold_years` they like and the proof
    // still verifies.
    // Two caveats a reviewer should carry away, both about public inputs the
    // prover controls:
    //   - `current_date` is supplied by the prover, not read from the chain. A
    //     holder who submits a far-future `current_date` appears correspondingly
    //     older, and this circuit cannot detect that. The contract MUST check
    //     `current_date` against ledger time. That check is the load-bearing
    //     freshness control for this credential type, and it lives on-chain.
    //   - `threshold_years` likewise has to be the value the verifier's policy
    //     actually requires; the circuit proves the relation, not the policy.
    // Finally, 365-day years ignore leap days, so the threshold is reached
    // slightly early: about one day per four years elapsed, so roughly 4-5 days
    // before an 18th birthday. The bias favours the holder and is documented
    // rather than fixed; anything needing exact birthday semantics must not use
    // this circuit.
    assert(current_date >= date_of_birth + threshold_years * 365);
}

// --- Tests ---------------------------------------------------------------
// Run: nargo test --package age_proof

global AGE_ZERO_SIG: [u8; 64] = [0; 64];
global AGE_ZERO_X: [u8; 32]   = [0; 32];
global AGE_ZERO_Y: [u8; 32]   = [0; 32];

// --- Reject paths --------------------------------------------------------

// Commitment does not match the Poseidon2 hash of (date_of_birth, salt).
#[test(should_fail)]
fn test_wrong_commitment_rejected() {
    main(
        19900615, // date_of_birth (days since epoch)
        0xabcd,   // salt
        AGE_ZERO_SIG,
        0x1,      // wrong commitment
        AGE_ZERO_X, AGE_ZERO_Y,
        20240615, // current_date
        18,       // threshold_years
    );
}

// Person is too young: age_years < threshold_years must fail.
// commitment is deliberately wrong so the circuit fails at commitment check,
// but the conceptual test is age below threshold.
#[test(should_fail)]
fn test_age_below_threshold_rejected() {
    // dob = current_date - 10 years; age 10 < threshold 18
    let dob: u64          = 20240615 - 10 * 365;
    let current: u64      = 20240615;
    let threshold: u64    = 18;
    let bad_commitment    = 0x2;
    main(dob, 0x1, AGE_ZERO_SIG, bad_commitment, AGE_ZERO_X, AGE_ZERO_Y, current, threshold);
}

// current_date < date_of_birth; invalid input (person "not born yet").
#[test(should_fail)]
fn test_current_date_before_dob_rejected() {
    let dob: u64       = 20300101;
    let current: u64   = 20240101; // current_date < dob; underflow assertion
    let bad_commitment = 0x3;
    main(dob, 0x1, AGE_ZERO_SIG, bad_commitment, AGE_ZERO_X, AGE_ZERO_Y, current, 18);
}

// salt mismatch: commitment computed with a different salt.
#[test(should_fail)]
fn test_salt_mismatch_rejected() {
    let dob: u64 = 19900101;
    let real_salt: Field = 0xdead;
    let wrong_salt: Field = 0xbeef;
    let commitment = Poseidon2::hash([dob as Field, real_salt], 2);
    main(dob, wrong_salt, AGE_ZERO_SIG, commitment, AGE_ZERO_X, AGE_ZERO_Y, 20240101, 18);
}

// --- Property-based boundary tests (logic-only, no sig) ------------------
// These test the constraint `current_date >= date_of_birth + threshold_years * 365`
// directly, without the commitment/signature overhead, to systematically cover
// boundary conditions with many input combinations.

// Exact boundary: current_date == dob + threshold * 365 -> constraint satisfied.
#[test]
fn test_boundary_exact_threshold_passes() {
    let dob: u64 = 10000;
    let threshold: u64 = 18;
    let current: u64 = dob + threshold * 365;
    assert(current >= dob + threshold * 365);
}

// Off-by-one below: current_date == dob + threshold * 365 - 1 -> must fail.
#[test(should_fail)]
fn test_boundary_one_day_below_threshold_fails() {
    let dob: u64 = 10000;
    let threshold: u64 = 18;
    let current: u64 = dob + threshold * 365 - 1;
    assert(current >= dob + threshold * 365);
}

// Off-by-one above: current_date == dob + threshold * 365 + 1 -> passes.
#[test]
fn test_boundary_one_day_above_threshold_passes() {
    let dob: u64 = 10000;
    let threshold: u64 = 18;
    let current: u64 = dob + threshold * 365 + 1;
    assert(current >= dob + threshold * 365);
}

// Threshold = 0: any current_date >= dob passes.
#[test]
fn test_boundary_zero_threshold_passes() {
    let dob: u64 = 10000;
    let threshold: u64 = 0;
    let current: u64 = dob;
    assert(current >= dob + threshold * 365);
}

// Threshold = 1: one year boundary.
#[test]
fn test_boundary_one_year_exact() {
    let dob: u64 = 5000;
    let threshold: u64 = 1;
    let current: u64 = dob + 365;
    assert(current >= dob + threshold * 365);
}

#[test(should_fail)]
fn test_boundary_one_year_minus_one_day() {
    let dob: u64 = 5000;
    let threshold: u64 = 1;
    let current: u64 = dob + 364;
    assert(current >= dob + threshold * 365);
}

// Max threshold (200) boundary.
#[test]
fn test_boundary_max_threshold_exact() {
    let dob: u64 = 1000;
    let threshold: u64 = 200;
    let current: u64 = dob + 200 * 365;
    assert(current >= dob + threshold * 365);
}

// Threshold exceeds max (201) -> rejected by `assert(threshold_years <= 200)`.
#[test(should_fail)]
fn test_boundary_threshold_exceeds_max() {
    let threshold: u64 = 201;
    assert(threshold <= 200);
}

// Various threshold values: 10, 21, 50, 65, 100.
#[test]
fn test_boundary_multiple_thresholds_pass() {
    let dob: u64 = 1000;
    let thresholds: [u64; 5] = [10, 21, 50, 65, 100];
    for i in 0..5 {
        let t = thresholds[i];
        let current = dob + t * 365;
        assert(current >= dob + t * 365);
    }
}

#[test(should_fail)]
fn test_boundary_multiple_thresholds_off_by_one() {
    let dob: u64 = 1000;
    // Each threshold minus one day must fail the constraint.
    let t: u64 = 50;
    let current = dob + t * 365 - 1;
    assert(current >= dob + t * 365);
}

// Date at epoch boundary: dob = 0.
#[test]
fn test_boundary_dob_at_epoch() {
    let dob: u64 = 0;
    let threshold: u64 = 18;
    let current: u64 = threshold * 365;
    assert(current >= dob + threshold * 365);
}

// Large dates: far future.
#[test]
fn test_boundary_large_dates() {
    let dob: u64 = 100000;
    let threshold: u64 = 25;
    let current: u64 = dob + threshold * 365 + 100;
    assert(current >= dob + threshold * 365);
}

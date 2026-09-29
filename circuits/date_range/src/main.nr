// Proves that an issuer-attested issuance date is no more than
// `max_age_days` old without revealing the exact date.

use dep::credential_lib;

fn assert_within_date_range(issuance_date: u64, current_date: u64, max_age_days: u64) {
    // This also prevents subtraction underflow for future-dated credentials.
    assert(current_date >= issuance_date);
    assert(current_date - issuance_date <= max_age_days);
}

fn main(
    // private
    issuance_date: u64,
    salt: Field,
    sig: [u8; 64],
    // public
    commitment: pub Field,
    issuer_x: pub [u8; 32],
    issuer_y: pub [u8; 32],
    current_date: pub u64,
    max_age_days: pub u64,
) {
    // The signed commitment prevents the holder from substituting a newer date.
    credential_lib::assert_committed_and_signed(
        issuance_date as Field,
        salt,
        sig,
        commitment,
        issuer_x,
        issuer_y,
    );
    assert_within_date_range(issuance_date, current_date, max_age_days);
}

#[test]
fn accepts_recent_and_boundary_dates() {
    assert_within_date_range(100, 100, 0);
    assert_within_date_range(100, 190, 90);
}

#[test(should_fail)]
fn rejects_stale_date() {
    assert_within_date_range(100, 191, 90);
}

#[test(should_fail)]
fn rejects_future_issuance_date() {
    assert_within_date_range(101, 100, 90);
}

#![cfg(test)]

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env,
};

fn setup(env: &Env) -> (Address, IssuerRegistryClient<'_>) {
    let admin = Address::generate(env);
    let contract_id = env.register(IssuerRegistry, (admin.clone(),));
    (admin, IssuerRegistryClient::new(env, &contract_id))
}

#[test]
fn register_and_query() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    let types = vec![&env, symbol_short!("kyc"), symbol_short!("age")];

    client.register_issuer(&issuer, &pubkey, &types);

    assert_eq!(client.get_issuer_pubkey(&issuer), pubkey);
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("age")));
    assert!(!client.is_valid_issuer(&issuer, &symbol_short!("income")));
}

#[test]
fn get_issuers_lists_registered() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer_a = Address::generate(&env);
    let issuer_b = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    let types = vec![&env, symbol_short!("kyc")];

    client.register_issuer(&issuer_a, &pubkey, &types);
    client.register_issuer(&issuer_b, &pubkey, &types);

    let listed = client.get_issuers();
    assert_eq!(listed.len(), 2);
    assert!(listed.contains(&issuer_a));
    assert!(listed.contains(&issuer_b));
    assert_eq!(client.get_issuer(&issuer_a).pubkey, pubkey);
}

#[test]
fn revoked_issuer_is_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 64]);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));

    client.revoke_issuer(&issuer);
    assert!(!client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
}

#[test]
fn unknown_issuer_is_invalid() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let stranger = Address::generate(&env);
    assert!(!client.is_valid_issuer(&stranger, &symbol_short!("kyc")));
}

// ── Property-based tests ──────────────────────────────────

/// Property: A revoked issuer is never valid for any credential type.
/// Once `revoke_issuer` is called, `is_valid_issuer` must return false
/// for all credential types, regardless of what the issuer was trusted for.
#[test]
fn prop_revoked_issuer_never_valid() {
    let config = proptest::test_runner::Config {
        cases: 10,
        ..proptest::test_runner::Config::default()
    };
    let mut runner = proptest::test_runner::TestRunner::new(config);
    runner
        .run(&(0u64..u64::MAX, 0u64..u64::MAX), |(_seed_a, _seed_b)| {
            let env = Env::default();
            env.mock_all_auths();
            let (_admin, client) = setup(&env);

            let issuer = Address::generate(&env);
            let pubkey = BytesN::from_array(&env, &[1u8; 64]);
            client.register_issuer(
                &issuer,
                &pubkey,
                &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
            );

            // Issuer is valid before revocation.
            assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
            assert!(client.is_valid_issuer(&issuer, &symbol_short!("age")));

            // Revoke the issuer.
            client.revoke_issuer(&issuer);

            // After revocation, issuer must be invalid for all types.
            let kyc_valid = client.is_valid_issuer(&issuer, &symbol_short!("kyc"));
            let age_valid = client.is_valid_issuer(&issuer, &symbol_short!("age"));

            prop_assert!(!kyc_valid, "Revoked issuer should not be valid for kyc");
            prop_assert!(!age_valid, "Revoked issuer should not be valid for age");
            Ok(())
        })
        .unwrap();
}

/// Property: An unregistered issuer is never valid.
/// For any randomly generated address that has not been registered in the
/// IssuerRegistry, `is_valid_issuer` must return false for all credential types.
#[test]
fn prop_unregistered_issuer_never_valid() {
    let config = proptest::test_runner::Config {
        cases: 10,
        ..proptest::test_runner::Config::default()
    };
    let mut runner = proptest::test_runner::TestRunner::new(config);
    runner
        .run(&(0u64..u64::MAX), |_seed| {
            let env = Env::default();
            env.mock_all_auths();
            let (_admin, client) = setup(&env);

            // Address::generate creates a unique address not registered
            // in the IssuerRegistry.
            let unregistered = Address::generate(&env);

            prop_assert!(
                !client.is_valid_issuer(&unregistered, &symbol_short!("kyc")),
                "Unregistered issuer should never be valid"
            );
            prop_assert!(
                !client.is_valid_issuer(&unregistered, &symbol_short!("age")),
                "Unregistered issuer should never be valid for any type"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn set_and_get_issuer_metadata() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    let types = vec![&env, symbol_short!("kyc")];
    client.register_issuer(&issuer, &pubkey, &types);

    // No metadata set yet.
    let meta = client.get_issuer_metadata(&issuer);
    assert!(meta.is_none());

    // Set name + url, leave logo as None.
    client.set_issuer_metadata(
        &issuer,
        &Some(String::from_str(&env, "Test Issuer")),
        &Some(String::from_str(&env, "https://example.com")),
        &None,
    );

    let meta = client.get_issuer_metadata(&issuer).unwrap();
    assert_eq!(meta.name, Some(String::from_str(&env, "Test Issuer")));
    assert_eq!(
        meta.url,
        Some(String::from_str(&env, "https://example.com"))
    );
    assert!(meta.logo.is_none());

    // Update to add logo and change name.
    client.set_issuer_metadata(
        &issuer,
        &Some(String::from_str(&env, "Updated Issuer")),
        &None,
        &Some(String::from_str(&env, "https://example.com/logo.png")),
    );

    let meta = client.get_issuer_metadata(&issuer).unwrap();
    assert_eq!(meta.name, Some(String::from_str(&env, "Updated Issuer")));
    assert!(meta.url.is_none());
    assert_eq!(
        meta.logo,
        Some(String::from_str(&env, "https://example.com/logo.png"))
    );
}

#[test]
fn get_issuer_metadata_returns_none_for_unknown() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let stranger = Address::generate(&env);
    let meta = client.get_issuer_metadata(&stranger);
    assert!(meta.is_none());
}

// ── Pagination tests (#287) ──────────────────────────────────────────────────

#[test]
fn issuer_count_tracks_registrations() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    assert_eq!(client.issuer_count(), 0);

    let pubkey = BytesN::from_array(&env, &[1u8; 64]);
    let types = vec![&env, symbol_short!("kyc")];

    let a = Address::generate(&env);
    client.register_issuer(&a, &pubkey, &types);
    assert_eq!(client.issuer_count(), 1);

    let b = Address::generate(&env);
    client.register_issuer(&b, &pubkey, &types);
    assert_eq!(client.issuer_count(), 2);

    // Re-registering an existing issuer must not inflate the count.
    client.register_issuer(&a, &pubkey, &types);
    assert_eq!(client.issuer_count(), 2);
}

#[test]
fn get_issuers_page_returns_correct_slice() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let pubkey = BytesN::from_array(&env, &[2u8; 64]);
    let types = vec![&env, symbol_short!("kyc")];

    // Register 5 issuers.
    let mut issuers: Vec<Address> = Vec::new(&env);
    for _ in 0..5 {
        let addr = Address::generate(&env);
        client.register_issuer(&addr, &pubkey, &types);
        issuers.push_back(addr);
    }

    // First page of 2.
    let page0 = client.get_issuers_page(&0, &2);
    assert_eq!(page0.len(), 2);
    assert_eq!(page0.get(0).unwrap(), issuers.get(0).unwrap());
    assert_eq!(page0.get(1).unwrap(), issuers.get(1).unwrap());

    // Second page of 2.
    let page1 = client.get_issuers_page(&2, &2);
    assert_eq!(page1.len(), 2);
    assert_eq!(page1.get(0).unwrap(), issuers.get(2).unwrap());
    assert_eq!(page1.get(1).unwrap(), issuers.get(3).unwrap());

    // Last partial page.
    let page2 = client.get_issuers_page(&4, &2);
    assert_eq!(page2.len(), 1);
    assert_eq!(page2.get(0).unwrap(), issuers.get(4).unwrap());
}

#[test]
fn get_issuers_page_out_of_bounds_returns_empty() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    // No issuers at all.
    let page = client.get_issuers_page(&0, &5);
    assert_eq!(page.len(), 0);

    // Register one, then request past the end.
    let pubkey = BytesN::from_array(&env, &[3u8; 64]);
    client.register_issuer(
        &Address::generate(&env),
        &pubkey,
        &vec![&env, symbol_short!("kyc")],
    );
    let page = client.get_issuers_page(&10, &5);
    assert_eq!(page.len(), 0);
}

#[test]
fn get_issuers_page_limit_cap_is_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let pubkey = BytesN::from_array(&env, &[4u8; 64]);
    let types = vec![&env, symbol_short!("kyc")];

    // Register 25 issuers.
    for _ in 0..25 {
        client.register_issuer(&Address::generate(&env), &pubkey, &types);
    }

    // Requesting 100 must be silently capped at MAX_PAGE_SIZE (20).
    let page = client.get_issuers_page(&0, &100);
    assert_eq!(page.len(), 20);
}

#[test]
fn get_issuers_page_after_revocation_is_consistent() {
    // Revocation marks an issuer as revoked but does NOT remove it from the
    // enumeration list — pagination must remain gap-free, and callers can
    // filter revoked issuers via get_issuer(...).revoked.
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let pubkey = BytesN::from_array(&env, &[5u8; 64]);
    let types = vec![&env, symbol_short!("kyc")];

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    client.register_issuer(&a, &pubkey, &types);
    client.register_issuer(&b, &pubkey, &types);
    client.register_issuer(&c, &pubkey, &types);

    client.revoke_issuer(&b);

    // All three addresses are still in the list — no gaps.
    assert_eq!(client.issuer_count(), 3);
    let page = client.get_issuers_page(&0, &10);
    assert_eq!(page.len(), 3);

    // The revoked issuer is identifiable via get_issuer.
    assert!(client.get_issuer(&b).revoked);
    assert!(!client.get_issuer(&a).revoked);
    assert!(!client.get_issuer(&c).revoked);
}

#[test]
#[should_panic]
fn set_issuer_metadata_requires_admin() {
    let env = Env::default();
    // Do NOT call mock_all_auths() – require_admin() will reject the call.
    let (_admin, client) = setup(&env);
    let issuer = Address::generate(&env);
    client.set_issuer_metadata(&issuer, &Some(String::from_str(&env, "x")), &None, &None);
}

// ── Issuer key rotation / revocation tests (#544) ─────────────────────────

/// Overlap window used across the rotation tests: long enough that "still
/// inside the window" is unambiguous, short enough to jump past in a test.
const OVERLAP: u64 = 7 * 86_400;

fn mk(env: &Env, seed: u8) -> BytesN<64> {
    BytesN::from_array(env, &[seed; 64])
}

#[test]
fn registered_key_is_tracked_and_valid() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let pubkey = mk(&env, 7);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);

    assert!(client.is_issuer_key_valid(&issuer, &pubkey));

    let keys = client.get_issuer_keys(&issuer);
    assert_eq!(keys.len(), 1);
    let recorded = keys.get(0).unwrap();
    assert_eq!(recorded.pubkey, pubkey);
    // The registered key is the issuer's current key: open-ended, never revoked.
    assert_eq!(recorded.valid_until, None);
    assert!(!recorded.revoked);
    assert_eq!(recorded.revoked_at, None);
}

#[test]
fn unknown_issuer_key_is_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    client.register_issuer(&issuer, &mk(&env, 7), &vec![&env, symbol_short!("kyc")]);

    assert!(!client.is_issuer_key_valid(&issuer, &mk(&env, 8)));
    assert!(!client.is_issuer_key_valid(&Address::generate(&env), &mk(&env, 7)));
}

#[test]
fn rotation_keeps_outstanding_credential_key_valid() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let old_key = mk(&env, 1);
    let new_key = mk(&env, 2);
    client.register_issuer(&issuer, &old_key, &vec![&env, symbol_short!("kyc")]);

    client.rotate_issuer_key(&issuer, &new_key, &OVERLAP);

    // The new key is current ...
    assert!(client.is_issuer_key_valid(&issuer, &new_key));
    // ... and the old key still verifies outstanding credentials. This is the
    // regression #544 is about: before rotation support, the registry only held
    // one key, so rotating silently broke every credential already issued.
    assert!(client.is_issuer_key_valid(&issuer, &old_key));

    // `Issuer::pubkey` still reports the current key, so existing indexers,
    // UIs and the SDK keep working without changes.
    assert_eq!(client.get_issuer_pubkey(&issuer), new_key);

    let old_record = client.get_issuer_key(&issuer, &old_key).unwrap();
    assert_eq!(old_record.valid_until, Some(1_000 + OVERLAP));
    assert!(!old_record.revoked);
    assert_eq!(client.get_issuer_keys(&issuer).len(), 2);
}

#[test]
fn old_key_stops_being_valid_once_the_overlap_closes() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let old_key = mk(&env, 1);
    let new_key = mk(&env, 2);
    client.register_issuer(&issuer, &old_key, &vec![&env, symbol_short!("kyc")]);
    client.rotate_issuer_key(&issuer, &new_key, &OVERLAP);

    // One second before the window closes the old key is still honoured.
    env.ledger()
        .with_mut(|li| li.timestamp = 1_000 + OVERLAP - 1);
    assert!(client.is_issuer_key_valid(&issuer, &old_key));

    // The window is exclusive at its end: at the boundary the old key is gone,
    // while the new key is unaffected.
    env.ledger().with_mut(|li| li.timestamp = 1_000 + OVERLAP);
    assert!(!client.is_issuer_key_valid(&issuer, &old_key));
    assert!(client.is_issuer_key_valid(&issuer, &new_key));
}

#[test]
fn emergency_revocation_invalidates_a_key_immediately() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let compromised = mk(&env, 1);
    let new_key = mk(&env, 2);
    client.register_issuer(&issuer, &compromised, &vec![&env, symbol_short!("kyc")]);
    client.rotate_issuer_key(&issuer, &new_key, &OVERLAP);

    // Mid-window, before any emergency: the old key is still good.
    env.ledger().with_mut(|li| li.timestamp = 1_000 + 1);
    assert!(client.is_issuer_key_valid(&issuer, &compromised));

    // Revocation ignores the remaining overlap entirely.
    client.revoke_issuer_key(&issuer, &compromised);

    env.ledger().with_mut(|li| li.timestamp = 1_000 + 2);
    assert!(!client.is_issuer_key_valid(&issuer, &compromised));
    // The current key is untouched by a revocation of a different key.
    assert!(client.is_issuer_key_valid(&issuer, &new_key));

    let record = client.get_issuer_key(&issuer, &compromised).unwrap();
    assert!(record.revoked);
    assert_eq!(record.revoked_at, Some(1_000 + 1));
}

#[test]
fn revoking_the_current_key_stops_it_being_accepted() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let key = mk(&env, 5);
    client.register_issuer(&issuer, &key, &vec![&env, symbol_short!("kyc")]);
    client.revoke_issuer_key(&issuer, &key);

    // This is the case that would be unsafe if validity fell back to
    // `Issuer::pubkey`: the revoked key is still the issuer's registered key.
    assert!(!client.is_issuer_key_valid(&issuer, &key));
}

#[test]
fn revocation_is_idempotent() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let key = mk(&env, 5);
    client.register_issuer(&issuer, &key, &vec![&env, symbol_short!("kyc")]);

    env.ledger().with_mut(|li| li.timestamp = 1_000);
    client.revoke_issuer_key(&issuer, &key);
    // An emergency runbook must be safe to re-run.
    env.ledger().with_mut(|li| li.timestamp = 2_000);
    client.revoke_issuer_key(&issuer, &key);

    let record = client.get_issuer_key(&issuer, &key).unwrap();
    // The original revocation timestamp is preserved, not advanced.
    assert!(record.revoked);
    assert_eq!(record.revoked_at, Some(1_000));
}

#[test]
fn revoked_key_cannot_be_reinstated_by_rotation() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let burned = mk(&env, 1);
    let other = mk(&env, 2);
    client.register_issuer(&issuer, &burned, &vec![&env, symbol_short!("kyc")]);
    client.rotate_issuer_key(&issuer, &other, &OVERLAP);
    client.revoke_issuer_key(&issuer, &burned);

    // Rotation is not a recovery path for a compromised key.
    let res = client.try_rotate_issuer_key(&issuer, &burned, &OVERLAP);
    assert!(res.is_err());
    assert!(!client.is_issuer_key_valid(&issuer, &burned));
}

#[test]
fn rotation_does_not_extend_an_already_closing_window() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let key_a = mk(&env, 1);
    let key_b = mk(&env, 2);
    let key_c = mk(&env, 3);
    client.register_issuer(&issuer, &key_a, &vec![&env, symbol_short!("kyc")]);

    client.rotate_issuer_key(&issuer, &key_b, &1_000);
    client.rotate_issuer_key(&issuer, &key_c, &9_000);

    // key_a keeps the earlier deadline; only the key actually being rotated out
    // gets the new window.
    assert_eq!(
        client.get_issuer_key(&issuer, &key_a).unwrap().valid_until,
        Some(2_000)
    );
    assert_eq!(
        client.get_issuer_key(&issuer, &key_b).unwrap().valid_until,
        Some(10_000)
    );
    assert_eq!(
        client.get_issuer_key(&issuer, &key_c).unwrap().valid_until,
        None
    );
}

#[test]
fn rotating_back_reuses_the_existing_key_slot() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let key_a = mk(&env, 1);
    let key_b = mk(&env, 2);
    client.register_issuer(&issuer, &key_a, &vec![&env, symbol_short!("kyc")]);

    client.rotate_issuer_key(&issuer, &key_b, &OVERLAP);
    client.rotate_issuer_key(&issuer, &key_a, &OVERLAP);

    // key_a was re-promoted rather than added as a new entry, so the index
    // stays at two keys and no slot is consumed.
    assert_eq!(client.get_issuer_keys(&issuer).len(), 2);
    assert!(client.is_issuer_key_valid(&issuer, &key_a));
    assert_eq!(client.get_issuer_pubkey(&issuer), key_a);
}

#[test]
fn rotation_backfills_a_pre_upgrade_issuer_with_no_history() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let legacy_key = mk(&env, 4);
    let new_key = mk(&env, 5);
    client.register_issuer(&issuer, &legacy_key, &vec![&env, symbol_short!("kyc")]);

    // Simulate state written before key tracking existed: drop the key index so
    // only the `Issuer` struct remains.
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&DataKey::IssuerKeys(issuer.clone()));
    });

    client.rotate_issuer_key(&issuer, &new_key, &OVERLAP);

    // The legacy key is back-filled inside its window rather than being
    // silently orphaned.
    assert!(client.is_issuer_key_valid(&issuer, &legacy_key));
    let record = client.get_issuer_key(&issuer, &legacy_key).unwrap();
    assert_eq!(record.valid_from, 0);
    assert_eq!(record.valid_until, Some(1_000 + OVERLAP));
}

#[test]
fn re_registering_an_issuer_preserves_its_key_history() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let old_key = mk(&env, 1);
    let new_key = mk(&env, 2);
    client.register_issuer(&issuer, &old_key, &vec![&env, symbol_short!("kyc")]);
    client.rotate_issuer_key(&issuer, &new_key, &OVERLAP);

    // A common admin operation: widening the issuer's credential types. This
    // must not disturb the rotation history.
    client.register_issuer(
        &issuer,
        &new_key,
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
    );

    assert!(client.is_issuer_key_valid(&issuer, &old_key));
    assert!(client.is_issuer_key_valid(&issuer, &new_key));
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("age")));
    assert_eq!(client.get_issuer_keys(&issuer).len(), 2);
}

#[test]
fn register_issuer_cannot_be_used_to_change_the_signing_key() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let old_key = mk(&env, 1);
    let new_key = mk(&env, 2);
    client.register_issuer(&issuer, &old_key, &vec![&env, symbol_short!("kyc")]);

    // The legacy path has no overlap parameter, so allowing it to swap the key
    // would reintroduce exactly the bug rotation support fixes.
    let res = client.try_register_issuer(&issuer, &new_key, &vec![&env, symbol_short!("kyc")]);
    assert!(res.is_err());
    assert_eq!(client.get_issuer_pubkey(&issuer), old_key);
}

#[test]
fn revoked_issuer_rejects_all_of_its_keys() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let old_key = mk(&env, 1);
    let new_key = mk(&env, 2);
    client.register_issuer(&issuer, &old_key, &vec![&env, symbol_short!("kyc")]);
    client.rotate_issuer_key(&issuer, &new_key, &OVERLAP);
    client.revoke_issuer(&issuer);

    assert!(!client.is_issuer_key_valid(&issuer, &old_key));
    assert!(!client.is_issuer_key_valid(&issuer, &new_key));
}

#[test]
fn key_history_is_bounded() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    client.register_issuer(&issuer, &mk(&env, 1), &vec![&env, symbol_short!("kyc")]);
    client.rotate_issuer_key(&issuer, &mk(&env, 2), &OVERLAP);
    client.rotate_issuer_key(&issuer, &mk(&env, 3), &OVERLAP);
    client.rotate_issuer_key(&issuer, &mk(&env, 4), &OVERLAP);
    assert_eq!(client.get_issuer_keys(&issuer).len(), 4);

    // A fifth key would exceed MAX_KEYS_PER_ISSUER.
    let res = client.try_rotate_issuer_key(&issuer, &mk(&env, 5), &OVERLAP);
    assert!(res.is_err());
    assert_eq!(client.get_issuer_keys(&issuer).len(), 4);
}

#[test]
fn rotation_rejects_unusable_overlap_windows() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    client.register_issuer(&issuer, &mk(&env, 1), &vec![&env, symbol_short!("kyc")]);

    // Zero-length window: use revoke_issuer_key instead.
    let zero = client.try_rotate_issuer_key(&issuer, &mk(&env, 2), &0);
    assert!(zero.is_err());

    // Beyond MAX_OVERLAP_SECS.
    let too_long = client.try_rotate_issuer_key(&issuer, &mk(&env, 2), &u64::MAX);
    assert!(too_long.is_err());

    // Rotating to the key already in use.
    let noop = client.try_rotate_issuer_key(&issuer, &mk(&env, 1), &OVERLAP);
    assert!(noop.is_err());

    assert_eq!(client.get_issuer_pubkey(&issuer), mk(&env, 1));
}

#[test]
fn revoking_an_untracked_key_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    client.register_issuer(&issuer, &mk(&env, 1), &vec![&env, symbol_short!("kyc")]);

    let res = client.try_revoke_issuer_key(&issuer, &mk(&env, 9));
    assert!(res.is_err());
}

#[test]
fn rotation_requires_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);
    let issuer = Address::generate(&env);
    let key = mk(&env, 1);
    client.register_issuer(&issuer, &key, &vec![&env, symbol_short!("kyc")]);

    // Drop the blanket auth mock so the admin's authorization is unavailable.
    let res = client
        .mock_auths(&[])
        .try_rotate_issuer_key(&issuer, &mk(&env, 2), &OVERLAP);
    assert!(res.is_err());
    // State is untouched: the old key is still current.
    assert_eq!(client.get_issuer_pubkey(&issuer), key);
}

#[test]
fn key_revocation_requires_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);
    let issuer = Address::generate(&env);
    let key = mk(&env, 1);
    client.register_issuer(&issuer, &key, &vec![&env, symbol_short!("kyc")]);

    let res = client.mock_auths(&[]).try_revoke_issuer_key(&issuer, &key);
    assert!(res.is_err());
    assert!(client.is_issuer_key_valid(&issuer, &key));
}

// ── Metadata length-boundary tests (#340) ──────────────────────────────────

/// Helper: generate a Soroban String of exactly `len` bytes.
fn str_of_len(env: &Env, len: u32) -> String {
    // Build via Bytes (which has push_back), then convert to String.
    let mut bytes = Bytes::new(env);
    for _ in 0..len {
        bytes.push_back(b'a');
    }
    String::from(&bytes)
}

#[test]
fn metadata_at_max_length_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);

    // Exactly at the limits: name=64, url=256, logo=256.
    let name = str_of_len(&env, 64);
    let url = str_of_len(&env, 256);
    let logo = str_of_len(&env, 256);

    client.set_issuer_metadata(
        &issuer,
        &Some(name.clone()),
        &Some(url.clone()),
        &Some(logo.clone()),
    );

    let meta = client.get_issuer_metadata(&issuer).unwrap();
    assert_eq!(meta.name, Some(name));
    assert_eq!(meta.url, Some(url));
    assert_eq!(meta.logo, Some(logo));
}

#[test]
#[should_panic(expected = "Contract, #3")]
fn metadata_name_over_limit_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);

    // name = 65 bytes, one over the 64-byte limit.
    client.set_issuer_metadata(&issuer, &Some(str_of_len(&env, 65)), &None, &None);
}

#[test]
#[should_panic(expected = "Contract, #3")]
fn metadata_url_over_limit_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);

    // url = 257 bytes, one over the 256-byte limit.
    client.set_issuer_metadata(&issuer, &None, &Some(str_of_len(&env, 257)), &None);
}

#[test]
#[should_panic(expected = "Contract, #3")]
fn metadata_logo_over_limit_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);

    // logo = 257 bytes, one over the 256-byte limit.
    client.set_issuer_metadata(&issuer, &None, &None, &Some(str_of_len(&env, 257)));
}

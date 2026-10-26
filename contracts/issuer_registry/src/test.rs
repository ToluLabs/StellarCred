use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    vec, Address, Bytes, BytesN, Env, IntoVal, Symbol,
};
use test_support::{deploy_issuer_registry, IssuerRegistryClient};

// Deployment lives in the shared `test_support` harness; this suite is about
// issuer records and roles, so the rest of each test is the scenario itself.

#[test]
fn register_and_query() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);
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
            let (_admin, client) = deploy_issuer_registry(&env);

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
            let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);
    let stranger = Address::generate(&env);
    let meta = client.get_issuer_metadata(&stranger);
    assert!(meta.is_none());
}

// ── Pagination tests (#287) ──────────────────────────────────────────────────

#[test]
fn issuer_count_tracks_registrations() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);
    let issuer = Address::generate(&env);
    client.set_issuer_metadata(&issuer, &Some(String::from_str(&env, "x")), &None, &None);
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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

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
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);

    // logo = 257 bytes, one over the 256-byte limit.
    client.set_issuer_metadata(&issuer, &None, &None, &Some(str_of_len(&env, 257)));
}

// ── Event schema & drift tests (Issue #429) ──────────────────────────────────

#[test]
fn register_issuer_emits_expected_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    let types = vec![&env, symbol_short!("kyc"), symbol_short!("age")];

    client.register_issuer(&issuer, &pubkey, &types);

    assert_eq!(
        env.events().all().filter_by_contract(&client.address),
        vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("iss_reg"), symbol_short!("register")).into_val(&env),
                EventIssuerRegistered {
                    issuer: issuer.clone(),
                    pubkey: pubkey.clone(),
                }
                .into_val(&env),
            ),
        ],
    );
}

#[test]
fn revoke_issuer_emits_expected_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 64]);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);

    // Drain the register event
    let _ = env.events().all();

    client.revoke_issuer(&issuer);

    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events,
        vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("iss_reg"), symbol_short!("revoked")).into_val(&env),
                EventIssuerRevoked { issuer }.into_val(&env),
            ),
        ],
    );
}

#[test]
fn set_issuer_metadata_emits_no_events() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);

    let expected = vec![
        &env,
        (
            client.address.clone(),
            (symbol_short!("iss_reg"), symbol_short!("register")).into_val(&env),
            EventIssuerRegistered {
                issuer: issuer.clone(),
                pubkey,
            }
            .into_val(&env),
        ),
    ];
    assert_eq!(
        env.events().all().filter_by_contract(&client.address),
        expected
    );

    client.set_issuer_metadata(
        &issuer,
        &Some(String::from_str(&env, "Acme Corp")),
        &Some(String::from_str(&env, "https://acme.org")),
        &None,
    );

    // Setting metadata updates persistent storage directly and does not emit new events
    assert_eq!(
        env.events().all().filter_by_contract(&client.address),
        vec![&env]
    );
}

// ── RBAC tests (Issue #123) ─────────────────────────────────────────────────

#[test]
fn constructor_seeds_admin_role() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = deploy_issuer_registry(&env);

    assert!(client.has_role(&symbol_short!("admin"), &admin));
    let stranger = Address::generate(&env);
    assert!(!client.has_role(&symbol_short!("admin"), &stranger));
}

#[test]
fn admin_can_grant_and_revoke_roles() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let delegate = Address::generate(&env);
    let other = Address::generate(&env);

    client.grant_role(&symbol_short!("admin"), &delegate);
    assert!(client.has_role(&symbol_short!("admin"), &delegate));

    // Re-granting moves the role to the new holder.
    client.grant_role(&symbol_short!("admin"), &other);
    assert!(!client.has_role(&symbol_short!("admin"), &delegate));
    assert!(client.has_role(&symbol_short!("admin"), &other));

    // Revoking an address that is not the current holder is rejected.
    let res = client.try_revoke_role(&symbol_short!("admin"), &delegate);
    assert!(res.is_err());

    client.revoke_role(&symbol_short!("admin"), &other);
    assert!(!client.has_role(&symbol_short!("admin"), &other));

    // Revoking an unassigned role is a harmless no-op.
    let res = client.try_revoke_role(&symbol_short!("admin"), &other);
    assert!(res.is_ok());
}

#[test]
fn grant_revoke_require_root_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let delegate = Address::generate(&env);

    // No auths mocked → the root admin's required auth fails.
    let res = client
        .mock_auths(&[])
        .try_grant_role(&symbol_short!("admin"), &delegate);
    assert!(res.is_err());
    let res = client
        .mock_auths(&[])
        .try_revoke_role(&symbol_short!("admin"), &delegate);
    assert!(res.is_err());
}

#[test]
fn register_issuer_requires_admin_role() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = deploy_issuer_registry(&env);
    let contract_id = client.address.clone();
    let delegate = Address::generate(&env);
    let stranger = Address::generate(&env);

    client.grant_role(&symbol_short!("admin"), &delegate);

    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    let issuer = Address::generate(&env);
    let types = vec![&env, symbol_short!("kyc")];
    let args = (issuer.clone(), pubkey.clone(), types.clone());

    // The admin-role holder can register an issuer…
    client
        .mock_auths(&[MockAuth {
            address: &delegate,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "register_issuer",
                args: args.clone().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .register_issuer(&issuer, &pubkey, &types);
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));

    // …a non-holder cannot.
    let res = client
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "register_issuer",
                args: args.into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_register_issuer(&issuer, &pubkey, &types);
    assert!(res.is_err());

    // The root admin (Admin key holder) can re-grant the role to themselves.
    client.grant_role(&symbol_short!("admin"), &admin);
    assert!(client.has_role(&symbol_short!("admin"), &admin));
}

#[test]
fn revoke_issuer_requires_admin_role() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let delegate = Address::generate(&env);

    // Delegate the admin role and register an issuer as the delegate.
    client.grant_role(&symbol_short!("admin"), &delegate);
    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    let types = vec![&env, symbol_short!("kyc")];
    client.register_issuer(&issuer, &pubkey, &types);
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));

    // Revoke the delegated role; the former holder can no longer revoke issuers.
    client.revoke_role(&symbol_short!("admin"), &delegate);
    let res = client
        .mock_auths(&[MockAuth {
            address: &delegate,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "revoke_issuer",
                args: (&issuer,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_revoke_issuer(&issuer);
    assert!(res.is_err());
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
}

#[test]
fn set_issuer_metadata_requires_admin_role() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let delegate = Address::generate(&env);
    let stranger = Address::generate(&env);

    // Register an issuer first so metadata has a target.
    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    client.register_issuer(&issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);

    // Delegate the admin role.
    client.grant_role(&symbol_short!("admin"), &delegate);

    let args = (
        issuer.clone(),
        Some(String::from_str(&env, "Delegate Issuer")),
        None::<String>,
        None::<String>,
    );

    // The admin-role holder can set metadata…
    client
        .mock_auths(&[MockAuth {
            address: &delegate,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "set_issuer_metadata",
                args: args.clone().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_issuer_metadata(
            &issuer,
            &Some(String::from_str(&env, "Delegate Issuer")),
            &None,
            &None,
        );
    assert_eq!(
        client.get_issuer_metadata(&issuer).unwrap().name,
        Some(String::from_str(&env, "Delegate Issuer"))
    );

    // …a non-holder cannot.
    let res = client
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "set_issuer_metadata",
                args: args.into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_issuer_metadata(
            &issuer,
            &Some(String::from_str(&env, "Sneaky")),
            &None,
            &None,
        );
    assert!(res.is_err());
    // Metadata unchanged.
    assert_eq!(
        client.get_issuer_metadata(&issuer).unwrap().name,
        Some(String::from_str(&env, "Delegate Issuer"))
    );
}

#[test]
fn has_role_is_a_public_view() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = deploy_issuer_registry(&env);
    let delegate = Address::generate(&env);

    // Readable with zero mocked auths — no authorization required.
    assert!(client
        .mock_auths(&[])
        .has_role(&symbol_short!("admin"), &admin));
    assert!(!client
        .mock_auths(&[])
        .has_role(&symbol_short!("admin"), &delegate));

    client.grant_role(&Symbol::new(&env, "issuer_manager"), &delegate);
    assert!(client.has_role(&Symbol::new(&env, "issuer_manager"), &delegate));
}

#[test]
fn register_issuer_by_unmocked_admin_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 64]);
    let res = client.mock_auths(&[]).try_register_issuer(
        &issuer,
        &pubkey,
        &vec![&env, symbol_short!("kyc")],
    );
    assert!(res.is_err());
    assert!(!client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
}

// ── Two-step admin transfer tests (#342) ────────────────────────────────────

#[test]
fn propose_admin_by_non_admin_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let new_admin = Address::generate(&env);

    // A non-admin cannot even propose a new admin.
    let res = client.mock_auths(&[]).try_propose_admin(&new_admin);
    assert!(res.is_err());
    // No pending proposal was created.
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn accept_admin_without_pending_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = deploy_issuer_registry(&env);

    let res = client.try_accept_admin();
    assert!(res.is_err());
    // Admin unchanged.
    assert_eq!(client.admin(), admin);
}

#[test]
fn propose_then_accept_transfers_admin_and_roles() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = deploy_issuer_registry(&env);
    let new_admin = Address::generate(&env);

    // No pending proposal initially.
    assert_eq!(client.pending_admin(), None);

    client.propose_admin(&new_admin);
    assert_eq!(client.pending_admin(), Some(new_admin.clone()));
    // Still the old admin — nothing has moved yet.
    assert_eq!(client.admin(), admin);

    client.accept_admin();

    // Now the transfer has taken effect.
    assert_eq!(client.admin(), new_admin);
    assert_eq!(client.pending_admin(), None);

    // The admin role moved to the new admin…
    assert!(client.has_role(&symbol_short!("admin"), &new_admin));

    // …and the old admin no longer holds it.
    assert!(!client.has_role(&symbol_short!("admin"), &admin));
}

#[test]
fn accept_by_wrong_address_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = deploy_issuer_registry(&env);
    let new_admin = Address::generate(&env);
    let wrong = Address::generate(&env);

    client.propose_admin(&new_admin);

    // Only the proposed address can accept — not any authenticated address.
    let res = client
        .mock_auths(&[MockAuth {
            address: &wrong,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_accept_admin();
    assert!(res.is_err());
    // Admin unchanged, proposal still pending.
    assert_eq!(client.admin(), admin);
    assert_eq!(client.pending_admin(), Some(new_admin));
}

#[test]
fn cancel_admin_proposal_clears_pending() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let new_admin = Address::generate(&env);

    client.propose_admin(&new_admin);
    assert_eq!(client.pending_admin(), Some(new_admin.clone()));

    client.cancel_admin_proposal();
    assert_eq!(client.pending_admin(), None);

    // Accept after cancel must fail.
    let res = client.try_accept_admin();
    assert!(res.is_err());
}

#[test]
fn propose_admin_overwrites_pending() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);

    client.propose_admin(&first);
    assert_eq!(client.pending_admin(), Some(first.clone()));

    // Second proposal overwrites the first — no cancel required.
    client.propose_admin(&second);
    assert_eq!(client.pending_admin(), Some(second.clone()));

    client.accept_admin();
    assert_eq!(client.admin(), second);
}

#[test]
fn post_rotation_new_admin_can_perform_ops() {
    let env = Env::default();
    env.mock_all_auths();
    let (_old_admin, client) = deploy_issuer_registry(&env);
    let new_admin = Address::generate(&env);

    // Propose and accept the rotation.
    client.propose_admin(&new_admin);
    client.accept_admin();

    // New admin can register an issuer.
    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    let types = vec![&env, symbol_short!("kyc")];

    client
        .mock_auths(&[MockAuth {
            address: &new_admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "register_issuer",
                args: (issuer.clone(), pubkey.clone(), types.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .register_issuer(&issuer, &pubkey, &types);

    assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
}

#[test]
fn post_rotation_old_admin_cannot_perform_ops() {
    let env = Env::default();
    env.mock_all_auths();
    let (old_admin, client) = deploy_issuer_registry(&env);
    let new_admin = Address::generate(&env);

    // Propose and accept the rotation.
    client.propose_admin(&new_admin);
    client.accept_admin();

    // Old admin can NO LONGER register an issuer.
    let issuer = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 64]);
    let types = vec![&env, symbol_short!("kyc")];

    let res = client
        .mock_auths(&[MockAuth {
            address: &old_admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "register_issuer",
                args: (issuer.clone(), pubkey.clone(), types.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_register_issuer(&issuer, &pubkey, &types);
    assert!(res.is_err());
}

#[test]
fn propose_admin_emits_expected_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let new_admin = Address::generate(&env);

    // Drain the initial setup events (none for IssuerRegistry setup).
    let _ = env.events().all();

    client.propose_admin(&new_admin);

    assert_eq!(
        env.events().all().filter_by_contract(&client.address),
        vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("iss_reg"), symbol_short!("adm_prop")).into_val(&env),
                new_admin.into_val(&env),
            ),
        ],
    );
}

#[test]
fn accept_admin_emits_expected_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let new_admin = Address::generate(&env);

    client.propose_admin(&new_admin);

    // Drain events emitted by the proposal.
    let _ = env.events().all();

    client.accept_admin();

    assert_eq!(
        env.events().all().filter_by_contract(&client.address),
        vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("iss_reg"), symbol_short!("adm_acc")).into_val(&env),
                new_admin.into_val(&env),
            ),
        ],
    );
}

#[test]
fn cancel_admin_proposal_emits_expected_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);
    let new_admin = Address::generate(&env);

    client.propose_admin(&new_admin);

    // Drain events emitted by the proposal.
    let _ = env.events().all();

    client.cancel_admin_proposal();

    assert_eq!(
        env.events().all().filter_by_contract(&client.address),
        vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("iss_reg"), symbol_short!("adm_canc")).into_val(&env),
                ().into_val(&env),
            ),
        ],
    );
}

// ── Issuer key sets: rotation and revocation ────────────────────────────────
//
// `T0` is an arbitrary non-zero ledger timestamp so windows are not measured
// from the genesis timestamp; `WINDOW` is the grace period a rotation grants the
// key it retires.
const T0: u64 = 1_700_000_000;
const WINDOW: u64 = 90 * 24 * 60 * 60;
/// Last ledger on which a key retired at `T0` with a `WINDOW`-long validity
/// window still verifies.
const T0_WINDOW_END: u64 = T0 + WINDOW;

fn key(seed: u8) -> [u8; 64] {
    [seed; 64]
}

fn register_k0(env: &Env, client: &IssuerRegistryClient<'_>, issuer: &Address) -> BytesN<64> {
    let k0 = BytesN::from_array(env, &key(1));
    client.register_issuer(issuer, &k0, &vec![env, symbol_short!("kyc")]);
    k0
}

/// Rotation keeps a retired key valid for its whole window, which is what stops
/// a key change from invalidating the credentials already issued under it.
#[test]
fn rotate_issuer_key_keeps_retired_key_valid_within_window() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let k1 = BytesN::from_array(&env, &key(2));

    client.rotate_issuer_key(&issuer, &k1, &(T0 + WINDOW));

    // New issuance uses the new key.
    assert_eq!(client.get_issuer_pubkey(&issuer), k1);
    assert!(client.is_valid_issuer_key(&issuer, &k1));

    // The retired key still verifies: outstanding credentials survive.
    assert!(client.is_valid_issuer_key(&issuer, &k0));
    // Including on the final ledger of its window.
    env.ledger().set_timestamp(T0 + WINDOW);
    assert!(client.is_valid_issuer_key(&issuer, &k0));

    // The window is recorded with the retirement timestamp.
    let keys = client.get_issuer_keys(&issuer);
    assert_eq!(keys.len(), 2);
    let retired = keys.get(1).unwrap();
    assert_eq!(retired.pubkey, k0);
    assert_eq!(retired.retired_at, T0);
    assert_eq!(retired.valid_until, T0_WINDOW_END);
    assert!(!retired.revoked);
}

/// One ledger past the window the retired key stops validating; the current
/// key is unaffected.
#[test]
fn rotated_out_key_stops_validating_after_window() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let k1 = BytesN::from_array(&env, &key(2));
    client.rotate_issuer_key(&issuer, &k1, &(T0 + WINDOW));

    env.ledger().set_timestamp(T0 + WINDOW + 1);
    assert!(!client.is_valid_issuer_key(&issuer, &k0));
    assert!(client.is_valid_issuer_key(&issuer, &k1));
    // Trust for the credential type is untouched by rotation.
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
}

#[test]
fn rotate_issuer_key_emits_expected_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let k1 = BytesN::from_array(&env, &key(2));

    // Drain the register event.
    let _ = env.events().all();
    client.rotate_issuer_key(&issuer, &k1, &(T0 + WINDOW));

    assert_eq!(
        env.events().all().filter_by_contract(&client.address),
        vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("iss_reg"), symbol_short!("key_rot")).into_val(&env),
                EventIssuerKeyRotated {
                    issuer,
                    old_pubkey: k0,
                    new_pubkey: k1,
                    old_key_valid_until: T0 + WINDOW,
                }
                .into_val(&env),
            ),
        ],
    );
}

#[test]
#[should_panic(expected = "Contract, #11")]
fn rotate_issuer_key_rejects_the_current_key() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);

    client.rotate_issuer_key(&issuer, &k0, &(T0 + WINDOW));
}

#[test]
#[should_panic(expected = "Contract, #8")]
fn rotate_issuer_key_rejects_reuse_of_a_retired_key() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    client.rotate_issuer_key(&issuer, &BytesN::from_array(&env, &key(2)), &(T0 + WINDOW));

    // Re-installing k0 would revive the credentials signed with it.
    client.rotate_issuer_key(&issuer, &k0, &(T0 + 2 * WINDOW));
}

#[test]
#[should_panic(expected = "Contract, #10")]
fn rotate_issuer_key_rejects_a_window_that_already_closed() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    register_k0(&env, &client, &issuer);

    client.rotate_issuer_key(&issuer, &BytesN::from_array(&env, &key(2)), &T0);
}

#[test]
#[should_panic(expected = "Contract, #10")]
fn rotate_issuer_key_rejects_a_window_beyond_the_cap() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    register_k0(&env, &client, &issuer);

    client.rotate_issuer_key(
        &issuer,
        &BytesN::from_array(&env, &key(2)),
        &(T0 + MAX_KEY_RETENTION_SECS + 1),
    );
}

#[test]
#[should_panic(expected = "Contract, #9")]
fn rotate_issuer_key_fails_once_the_history_is_full() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    register_k0(&env, &client, &issuer);

    // Every rotation retires a key that stays inside its window, so the history
    // fills up to the cap and the next rotation has nowhere to go.
    for i in 0..MAX_RETIRED_KEYS {
        let next = BytesN::from_array(&env, &key(2 + i as u8));
        client.rotate_issuer_key(&issuer, &next, &(T0 + WINDOW));
    }
    let full = BytesN::from_array(&env, &key(2 + MAX_RETIRED_KEYS as u8));
    client.rotate_issuer_key(&issuer, &full, &(T0 + WINDOW));
}

/// Retired keys are pruned once their window closes, so an issuer with a long
/// lifetime can keep rotating.
#[test]
fn expired_keys_are_pruned_and_do_not_block_future_rotations() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let k1 = BytesN::from_array(&env, &key(2));
    let k2 = BytesN::from_array(&env, &key(3));

    // k0 is retired with a window that closes before the next rotation.
    client.rotate_issuer_key(&issuer, &k1, &(T0 + 100));
    env.ledger().set_timestamp(T0 + 200);
    client.rotate_issuer_key(&issuer, &k2, &(T0 + 300));

    let keys = client.get_issuer_keys(&issuer);
    assert_eq!(keys.len(), 2);
    assert_eq!(keys.get(0).unwrap().pubkey, k2);
    assert_eq!(keys.get(1).unwrap().pubkey, k1);
    assert!(!client.is_valid_issuer_key(&issuer, &k0));
}

/// Emergency revocation of a retired key is immediate: the difference from
/// rotation is that the window is ignored.
#[test]
fn revoke_issuer_key_kills_a_retired_key_inside_its_window() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let k1 = BytesN::from_array(&env, &key(2));
    client.rotate_issuer_key(&issuer, &k1, &(T0 + WINDOW));

    // Drain the rotation event.
    let _ = env.events().all();
    client.revoke_issuer_key(&issuer, &k0);

    assert!(!client.is_valid_issuer_key(&issuer, &k0));
    // The replacement key and the issuer's trust are untouched.
    assert!(client.is_valid_issuer_key(&issuer, &k1));
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
}

/// Emergency revocation of the CURRENT key is immediate too: the issuer's
/// trust dies until a rotation to a fresh key restores it, and the revocation
/// emits `key_revk` with `was_current: true`.
#[test]
fn revoke_issuer_key_kills_current_key_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let k1 = BytesN::from_array(&env, &key(2));
    let k2 = BytesN::from_array(&env, &key(3));
    client.rotate_issuer_key(&issuer, &k1, &(T0 + WINDOW));

    // Drain the rotation event.
    let _ = env.events().all();
    client.revoke_issuer_key(&issuer, &k1);
    // Captured before the read-only checks below: a subsequent query starts a
    // fresh invocation and discards the recorded events.
    let events = env.events().all().filter_by_contract(&client.address);

    assert!(!client.is_valid_issuer_key(&issuer, &k1));
    assert!(!client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
    // k0 was retired, not revoked: its credentials are unaffected.
    assert!(client.is_valid_issuer_key(&issuer, &k0));

    assert_eq!(
        events,
        vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("iss_reg"), symbol_short!("key_revk")).into_val(&env),
                EventIssuerKeyRevoked {
                    issuer: issuer.clone(),
                    pubkey: k1.clone(),
                    was_current: true,
                    revoked_at: T0,
                }
                .into_val(&env),
            ),
        ],
    );

    // Rotating to a fresh key restores issuance; the revoked key stays dead.
    client.rotate_issuer_key(&issuer, &k2, &(T0 + WINDOW));
    assert!(client.is_valid_issuer_key(&issuer, &k2));
    assert!(client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
    assert!(!client.is_valid_issuer_key(&issuer, &k1));

    let keys = client.get_issuer_keys(&issuer);
    assert_eq!(keys.len(), 3);
    assert_eq!(keys.get(0).unwrap().pubkey, k2);
    assert!(!keys.get(0).unwrap().revoked);
    assert!(!keys.get(1).unwrap().revoked); // k0
    assert!(keys.get(2).unwrap().revoked); // k1, revoked at retirement
}

#[test]
#[should_panic(expected = "Contract, #6")]
fn revoke_issuer_key_rejects_an_unknown_key() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    register_k0(&env, &client, &issuer);

    client.revoke_issuer_key(&issuer, &BytesN::from_array(&env, &key(9)));
}

#[test]
#[should_panic(expected = "Contract, #7")]
fn revoke_issuer_key_rejects_a_second_revocation() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    client.revoke_issuer_key(&issuer, &k0);
    client.revoke_issuer_key(&issuer, &k0);
}

#[test]
#[should_panic(expected = "Contract, #6")]
fn revoke_issuer_key_rejects_a_key_whose_window_closed() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    client.rotate_issuer_key(&issuer, &BytesN::from_array(&env, &key(2)), &(T0 + WINDOW));

    env.ledger().set_timestamp(T0 + WINDOW + 1);
    // The key already validates nothing, so there is nothing to revoke.
    client.revoke_issuer_key(&issuer, &k0);
}

/// Revoking the issuer kills every key it ever held.
#[test]
fn full_issuer_revocation_invalidates_the_whole_key_set() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let k1 = BytesN::from_array(&env, &key(2));
    client.rotate_issuer_key(&issuer, &k1, &(T0 + WINDOW));

    client.revoke_issuer(&issuer);

    assert!(!client.is_valid_issuer(&issuer, &symbol_short!("kyc")));
    assert!(!client.is_valid_issuer_key(&issuer, &k0));
    assert!(!client.is_valid_issuer_key(&issuer, &k1));
    // The key set itself is still readable for audit purposes.
    assert_eq!(client.get_issuer_keys(&issuer).len(), 2);
}

#[test]
fn get_issuer_keys_reports_the_current_key_first() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    // An issuer that never rotated has exactly one key: the current one.
    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let keys = client.get_issuer_keys(&issuer);
    assert_eq!(keys.len(), 1);
    assert_eq!(keys.get(0).unwrap().pubkey, k0);
    assert_eq!(keys.get(0).unwrap().retired_at, 0);
    assert_eq!(keys.get(0).unwrap().valid_until, 0);
    assert!(!keys.get(0).unwrap().revoked);
    assert!(client.is_valid_issuer_key(&issuer, &k0));

    // Unknown issuers have no key set.
    assert!(client.get_issuer_keys(&Address::generate(&env)).is_empty());
}

#[test]
fn refresh_issuer_keys_ttl_keeps_the_key_history_readable() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let k1 = BytesN::from_array(&env, &key(2));
    client.rotate_issuer_key(&issuer, &k1, &(T0 + WINDOW));

    // Drain the rotation event: a refresh must not emit one.
    let _ = env.events().all();
    client.refresh_issuer_keys_ttl(&issuer);
    assert!(env
        .events()
        .all()
        .filter_by_contract(&client.address)
        .events()
        .is_empty());

    assert_eq!(client.get_issuer_keys(&issuer).len(), 2);
    assert!(client.is_valid_issuer_key(&issuer, &k0));
    assert!(client.is_valid_issuer_key(&issuer, &k1));
}

#[test]
#[should_panic(expected = "Contract, #2")]
fn refresh_issuer_keys_ttl_rejects_an_unknown_issuer() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);

    client.refresh_issuer_keys_ttl(&Address::generate(&env));
}

#[test]
fn refresh_issuer_keys_ttl_requires_admin_role() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    register_k0(&env, &client, &issuer);

    let res = client.mock_auths(&[]).try_refresh_issuer_keys_ttl(&issuer);
    assert!(res.is_err());
}

#[test]
#[should_panic(expected = "Contract, #12")]
fn register_issuer_rejects_a_pubkey_change() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);

    // This used to silently invalidate every credential signed with k0.
    client.register_issuer(
        &issuer,
        &BytesN::from_array(&env, &key(2)),
        &vec![&env, symbol_short!("kyc")],
    );
    assert_eq!(client.get_issuer_pubkey(&issuer), k0);
}

/// Re-registration is still the way to update credential types; only the pubkey
/// is pinned.
#[test]
fn register_issuer_still_updates_credential_types_with_the_same_key() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    assert!(!client.is_valid_issuer(&issuer, &symbol_short!("age")));

    client.register_issuer(
        &issuer,
        &k0,
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
    );

    assert!(client.is_valid_issuer(&issuer, &symbol_short!("age")));
    assert_eq!(client.get_issuer_pubkey(&issuer), k0);
}

#[test]
fn rotate_issuer_key_requires_admin_role() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);
    let contract_id = client.address.clone();

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);
    let k1 = BytesN::from_array(&env, &key(2));
    let args = (issuer.clone(), k1.clone(), T0_WINDOW_END);

    let delegate = Address::generate(&env);
    let stranger = Address::generate(&env);
    client.grant_role(&symbol_short!("admin"), &delegate);

    // The admin-role holder can rotate.
    client
        .mock_auths(&[MockAuth {
            address: &delegate,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "rotate_issuer_key",
                args: args.clone().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .rotate_issuer_key(&issuer, &k1, &(T0 + WINDOW));
    assert_eq!(client.get_issuer_pubkey(&issuer), k1);

    // A non-holder cannot.
    let res = client
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "rotate_issuer_key",
                args: args.into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_rotate_issuer_key(&issuer, &k1, &(T0 + WINDOW));
    assert!(res.is_err());
    assert_eq!(client.get_issuer_pubkey(&issuer), k1);
    // k0 was still retired, so its window is open.
    assert!(client.is_valid_issuer_key(&issuer, &k0));
}

#[test]
fn revoke_issuer_key_requires_admin_role() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let (_admin, client) = deploy_issuer_registry(&env);

    let issuer = Address::generate(&env);
    let k0 = register_k0(&env, &client, &issuer);

    // No admin authorisation at all: the revocation must not go through.
    let res = client.mock_auths(&[]).try_revoke_issuer_key(&issuer, &k0);
    assert!(res.is_err());
    assert!(client.is_valid_issuer_key(&issuer, &k0));

    // The admin role holder can.
    client.revoke_issuer_key(&issuer, &k0);
    assert!(!client.is_valid_issuer_key(&issuer, &k0));
}

/// Property: a retired key is valid throughout its window and invalid on the
/// very next ledger, for any window length the contract accepts.
#[test]
fn prop_retired_key_is_valid_only_within_its_window() {
    let config = proptest::test_runner::Config {
        cases: 10,
        ..proptest::test_runner::Config::default()
    };
    let mut runner = proptest::test_runner::TestRunner::new(config);
    runner
        .run(&(1u64..MAX_KEY_RETENTION_SECS,), |(window,)| {
            let env = Env::default();
            env.mock_all_auths();
            env.ledger().set_timestamp(T0);
            let (_admin, client) = deploy_issuer_registry(&env);

            let issuer = Address::generate(&env);
            let k0 = register_k0(&env, &client, &issuer);
            let k1 = BytesN::from_array(&env, &key(2));
            client.rotate_issuer_key(&issuer, &k1, &(T0 + window));

            env.ledger().set_timestamp(T0 + window);
            prop_assert!(
                client.is_valid_issuer_key(&issuer, &k0),
                "Retired key must still verify on the last ledger of its window"
            );

            env.ledger().set_timestamp(T0 + window + 1);
            prop_assert!(
                !client.is_valid_issuer_key(&issuer, &k0),
                "Retired key must stop verifying past its window"
            );
            prop_assert!(
                client.is_valid_issuer_key(&issuer, &k1),
                "Current key must stay valid after a rotation"
            );
            Ok(())
        })
        .unwrap();
}

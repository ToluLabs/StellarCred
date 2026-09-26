use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    vec, Address, Bytes, BytesN, Env, IntoVal, Symbol,
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
    client.set_issuer_metadata(
        &issuer,
        &Some(str_of_len(&env, 65)),
        &None,
        &None,
    );
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
    client.set_issuer_metadata(
        &issuer,
        &None,
        &Some(str_of_len(&env, 257)),
        &None,
    );
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
    client.set_issuer_metadata(
        &issuer,
        &None,
        &None,
        &Some(str_of_len(&env, 257)),
    );
}

// ── Event schema & drift tests (Issue #429) ──────────────────────────────────

#[test]
fn register_issuer_emits_expected_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

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
    let (_admin, client) = setup(&env);

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
                EventIssuerRevoked {
                    issuer,
                }
                .into_val(&env),
            ),
        ],
    );
}

#[test]
fn set_issuer_metadata_emits_no_events() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

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
    assert_eq!(env.events().all().filter_by_contract(&client.address), expected);

    client.set_issuer_metadata(
        &issuer,
        &Some(String::from_str(&env, "Acme Corp")),
        &Some(String::from_str(&env, "https://acme.org")),
        &None,
    );

    // Setting metadata updates persistent storage directly and does not emit new events
    assert_eq!(env.events().all().filter_by_contract(&client.address), vec![&env]);
}

// ── RBAC tests (Issue #123) ─────────────────────────────────────────────────

#[test]
fn constructor_seeds_admin_role() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);

    assert!(client.has_role(&symbol_short!("admin"), &admin));
    let stranger = Address::generate(&env);
    assert!(!client.has_role(&symbol_short!("admin"), &stranger));
}

#[test]
fn admin_can_grant_and_revoke_roles() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);
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
    let (_admin, client) = setup(&env);
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
    let (admin, client) = setup(&env);
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
    let (_admin, client) = setup(&env);
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
    let (_admin, client) = setup(&env);
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
    let (admin, client) = setup(&env);
    let delegate = Address::generate(&env);

    // Readable with zero mocked auths — no authorization required.
    assert!(client.mock_auths(&[]).has_role(&symbol_short!("admin"), &admin));
    assert!(!client.mock_auths(&[]).has_role(&symbol_short!("admin"), &delegate));

    client.grant_role(&Symbol::new(&env, "issuer_manager"), &delegate);
    assert!(client.has_role(&Symbol::new(&env, "issuer_manager"), &delegate));
}

#[test]
fn register_issuer_by_unmocked_admin_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

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

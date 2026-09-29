use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    vec, Address, Env, IntoVal,
};
use test_support::{Contracts, GatedPoolClient, FUNDS, KYC};

// Deploy-and-wire, register-issuer, set-vk, and build-valid-submission all
// live in `test_support`. The artifacts are still the real checked-in
// UltraHonk fixtures, so the KYC gate exercises genuine verification.

/// A deployed stack plus a GatedPool gated on `required_type`, and the issuer
/// trusted for the demo KYC/funds fixtures (both signed by the same key).
struct Pool {
    c: Contracts,
    pool: GatedPoolClient<'static>,
    issuer: Address,
}

fn deploy_with_gate(env: &Env, required_type: &str, min_threshold: Option<u64>) -> Pool {
    let c = Contracts::deploy(env);
    let issuer = c.register_issuer_for(env, &KYC, &["kyc", "funds"]);
    c.enable_vks(env, &[&KYC, &FUNDS]);
    let pool = c.deploy_pool(env, required_type, min_threshold);
    Pool { c, pool, issuer }
}

fn deploy(env: &Env) -> Pool {
    deploy_with_gate(env, "kyc", None)
}

#[test]
fn deposit_blocked_without_kyc() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    let res = h.pool.try_deposit(&user, &100);
    assert!(res.is_err());
    assert_eq!(h.pool.get_balance(&user), 0);
}

#[test]
fn deposit_allowed_after_kyc() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
    h.pool.deposit(&user, &100);
    assert_eq!(h.pool.get_balance(&user), 100);
}

#[test]
fn gate_config_is_stored_and_threshold_gated_deposit_is_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy_with_gate(&env, "funds", Some(50_000));
    let user = Address::generate(&env);

    assert_eq!(h.pool.gate(), (symbol_short!("funds"), Some(50_000)));

    h.c.submit(&env, &user, &h.issuer, &FUNDS, 9999);
    h.pool.deposit(&user, &100);
    assert_eq!(h.pool.get_balance(&user), 100);

    let strict_h = deploy_with_gate(&env, "funds", Some(250_000));
    let strict_user = Address::generate(&env);
    strict_h.c.submit(&env, &strict_user, &strict_h.issuer, &FUNDS, 9999);
    let res = strict_h.pool.try_deposit(&strict_user, &100);
    assert!(res.is_err());
    assert_eq!(strict_h.pool.get_balance(&strict_user), 0);
}

#[test]
fn withdraw_is_open() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
    h.pool.deposit(&user, &100);
    h.pool.withdraw(&user, &40);
    assert_eq!(h.pool.get_balance(&user), 60);
}

#[test]
fn withdraw_exact_balance_leaves_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
    h.pool.deposit(&user, &100);
    h.pool.withdraw(&user, &100);

    assert_eq!(h.pool.get_balance(&user), 0);
}

#[test]
fn withdraw_rejects_zero_and_negative_amounts() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
    h.pool.deposit(&user, &100);

    assert!(h.pool.try_withdraw(&user, &0).is_err());
    assert!(h.pool.try_withdraw(&user, &-1).is_err());
    assert_eq!(h.pool.get_balance(&user), 100);
}

#[test]
fn withdraw_remains_available_after_kyc_expires() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    h.c.submit(&env, &user, &h.issuer, &KYC, 2);
    h.pool.deposit(&user, &100);

    env.ledger().with_mut(|li| li.timestamp = 3);
    assert!(!h.c.verify(&env, &user, &KYC));

    h.pool.withdraw(&user, &100);
    assert_eq!(h.pool.get_balance(&user), 0);
}

#[test]
fn withdraw_remains_available_after_kyc_is_revoked() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
    h.pool.deposit(&user, &100);
    h.c.registry.revoke(&h.issuer, &user, &symbol_short!("kyc"));
    assert!(!h.c.verify(&env, &user, &KYC));

    h.pool.withdraw(&user, &100);
    assert_eq!(h.pool.get_balance(&user), 0);
}

// ── Property-based tests ──────────────────────────────────

/// Property: Deposits are gated behind a valid KYC proof.
/// For any holder, if no valid KYC proof exists, deposit must fail.
/// After submitting a valid proof, deposit must succeed.
#[test]
fn prop_deposit_gated_by_kyc() {
    let config = proptest::test_runner::Config {
        cases: 10,
        ..proptest::test_runner::Config::default()
    };
    let mut runner = proptest::test_runner::TestRunner::new(config);
    runner
        .run(&(0u64..u64::MAX), |_seed| {
            let env = Env::default();
            env.mock_all_auths();
            let h = deploy(&env);
            let user = Address::generate(&env);

            // Without a KYC proof, deposit must be rejected.
            let res = h.pool.try_deposit(&user, &100);
            prop_assert!(res.is_err(), "Deposit without KYC must fail");
            prop_assert_eq!(h.pool.get_balance(&user), 0);

            // After getting KYC, deposit must succeed.
            h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
            h.pool.deposit(&user, &100);
            prop_assert_eq!(h.pool.get_balance(&user), 100);
            Ok(())
        })
        .unwrap();
}

#[test]
fn withdraw_rejects_amount_exceeding_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
    h.pool.deposit(&user, &100);

    let res = h.pool.try_withdraw(&user, &101);
    assert!(res.is_err());
    // Balance is unaffected by the rejected withdrawal.
    assert_eq!(h.pool.get_balance(&user), 100);
}

#[test]
fn registry_address_matches_constructor_provided_registry() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    assert_eq!(h.pool.registry_address(), h.c.registry.address);
}

#[test]
fn deposit_uses_constructor_provided_registry_not_an_unrelated_one() {
    // Deploys a SECOND, independent ProofRegistry (with its own issuer/verifier)
    // and proves KYC there for `user` — while the pool remains wired to the
    // FIRST registry from `deploy()`, where `user` has no proof. This proves the
    // gate actually consults the constructor-provided `registry` address, not
    // some other reachable/default registry.
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let other = deploy(&env);
    let user = Address::generate(&env);

    other.c.submit(&env, &user, &other.issuer, &KYC, 1_000_000);

    let res = h.pool.try_deposit(&user, &100);
    assert!(res.is_err());
    assert_eq!(h.pool.get_balance(&user), 0);

    // Sanity: the same proof against the pool's OWN registry succeeds.
    h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
    h.pool.deposit(&user, &100);
    assert_eq!(h.pool.get_balance(&user), 100);
}

#[test]
fn deposit_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
    h.pool.deposit(&user, &250);

    assert_eq!(
        env.events().all().filter_by_contract(&h.pool.address),
        vec![
            &env,
            (
                h.pool.address.clone(),
                (symbol_short!("gate_pool"), symbol_short!("deposit")).into_val(&env),
                EventDeposit {
                    caller: user.clone(),
                    amount: 250,
                    new_balance: 250,
                }
                .into_val(&env),
            ),
        ],
    );

    // Verify balance was updated
    assert_eq!(h.pool.get_balance(&user), 250);
}

#[test]
fn withdraw_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    h.c.submit(&env, &user, &h.issuer, &KYC, 1_000_000);
    h.pool.deposit(&user, &500);

    // Drain deposit events
    let _ = env.events().all();

    h.pool.withdraw(&user, &200);

    assert_eq!(
        env.events().all().filter_by_contract(&h.pool.address),
        vec![
            &env,
            (
                h.pool.address.clone(),
                (symbol_short!("gate_pool"), symbol_short!("withdraw")).into_val(&env),
                EventWithdraw {
                    caller: user.clone(),
                    amount: 200,
                    new_balance: 300,
                }
                .into_val(&env),
            ),
        ],
    );

    // Verify balance was updated
    assert_eq!(h.pool.get_balance(&user), 300);
}


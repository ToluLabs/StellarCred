use super::*;
use credential_verifier::{CredentialVerifier, CredentialVerifierClient};
use issuer_registry::{IssuerRegistry, IssuerRegistryClient};
use proof_registry::{ProofRegistry, ProofRegistryClient};
use proptest::prelude::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env, IntoVal, Symbol,
};

// Real UltraHonk artifacts, so the KYC gate exercises genuine verification.
const VK: &[u8] = include_bytes!("../../../fixtures/kyc/vk");
const PROOF: &[u8] = include_bytes!("../../../fixtures/kyc/proof");
const PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/kyc/public_inputs");
const FUNDS_VK: &[u8] = include_bytes!("../../../fixtures/funds/vk");
const FUNDS_PROOF: &[u8] = include_bytes!("../../../fixtures/funds/proof");
const FUNDS_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/funds/public_inputs");

// Issuer key (x || y) the fixtures were signed with, read from the proof's
// public inputs so the registered key matches what the proof attests to.
fn demo_pubkey(env: &Env) -> BytesN<64> {
    let mut arr = [0u8; 64];
    for i in 0..64usize {
        arr[i] = PUBLIC_INPUTS[(1 + i) * 32 + 31];
    }
    BytesN::from_array(env, &arr)
}

struct Harness {
    registry: ProofRegistryClient<'static>,
    pool: GatedPoolClient<'static>,
    issuer: Address,
}

fn deploy_with_gate(env: &Env, required_type: Symbol, min_threshold: Option<u64>) -> Harness {
    let admin = Address::generate(env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let issuer = Address::generate(env);
    IssuerRegistryClient::new(env, &ir_id).register_issuer(
        &issuer,
        &demo_pubkey(env),
        &vec![env, symbol_short!("kyc"), symbol_short!("funds")],
    );

    let verifier_id = env.register(CredentialVerifier, (admin.clone(),));
    let verifier = CredentialVerifierClient::new(env, &verifier_id);
    verifier.set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(env, VK));
    verifier.set_vk(
        &symbol_short!("funds"),
        &1u32,
        &Bytes::from_slice(env, FUNDS_VK),
    );

    let registry_id = env.register(ProofRegistry, (admin, verifier_id, ir_id));
    let pool_id = env.register(
        GatedPool,
        (registry_id.clone(), required_type, min_threshold),
    );

    Harness {
        registry: ProofRegistryClient::new(env, &registry_id),
        pool: GatedPoolClient::new(env, &pool_id),
        issuer,
    }
}

fn deploy(env: &Env) -> Harness {
    deploy_with_gate(env, symbol_short!("kyc"), None)
}

fn prove_kyc(env: &Env, h: &Harness, holder: &Address) {
    prove_kyc_until(env, h, holder, 1_000_000);
}

fn prove_kyc_until(env: &Env, h: &Harness, holder: &Address, expiry: u64) {
    h.registry.submit_proof(
        holder,
        &h.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(env, PROOF),
        &Bytes::from_slice(env, PUBLIC_INPUTS),
        &None,
        &expiry,
    );
}

fn prove_funds(env: &Env, h: &Harness, holder: &Address) {
    h.registry.submit_proof(
        holder,
        &h.issuer,
        &symbol_short!("funds"),
        &Bytes::from_slice(env, FUNDS_PROOF),
        &Bytes::from_slice(env, FUNDS_PUBLIC_INPUTS),
        &None,
        &9999,
    );
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

    prove_kyc(&env, &h, &user);
    h.pool.deposit(&user, &100);
    assert_eq!(h.pool.get_balance(&user), 100);
}

#[test]
fn gate_config_is_stored_and_threshold_gated_deposit_is_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy_with_gate(&env, symbol_short!("funds"), Some(50_000));
    let user = Address::generate(&env);

    assert_eq!(h.pool.gate(), (symbol_short!("funds"), Some(50_000)));

    prove_funds(&env, &h, &user);
    h.pool.deposit(&user, &100);
    assert_eq!(h.pool.get_balance(&user), 100);

    let strict_h = deploy_with_gate(&env, symbol_short!("funds"), Some(250_000));
    let strict_user = Address::generate(&env);
    prove_funds(&env, &strict_h, &strict_user);
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

    prove_kyc(&env, &h, &user);
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

    prove_kyc(&env, &h, &user);
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

    prove_kyc(&env, &h, &user);
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

    prove_kyc_until(&env, &h, &user, 2);
    h.pool.deposit(&user, &100);

    env.ledger().with_mut(|li| li.timestamp = 3);
    assert!(
        !h.registry
            .is_verified(&user, &symbol_short!("kyc"), &None)
            .0
    );

    h.pool.withdraw(&user, &100);
    assert_eq!(h.pool.get_balance(&user), 0);
}

#[test]
fn withdraw_remains_available_after_kyc_is_revoked() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    prove_kyc(&env, &h, &user);
    h.pool.deposit(&user, &100);
    h.registry.revoke(&h.issuer, &user, &symbol_short!("kyc"));
    assert!(
        !h.registry
            .is_verified(&user, &symbol_short!("kyc"), &None)
            .0
    );

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
            prove_kyc(&env, &h, &user);
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

    prove_kyc(&env, &h, &user);
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
    assert_eq!(h.pool.registry_address(), h.registry.address);
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

    prove_kyc(&env, &other, &user);

    let res = h.pool.try_deposit(&user, &100);
    assert!(res.is_err());
    assert_eq!(h.pool.get_balance(&user), 0);

    // Sanity: the same proof against the pool's OWN registry succeeds.
    prove_kyc(&env, &h, &user);
    h.pool.deposit(&user, &100);
    assert_eq!(h.pool.get_balance(&user), 100);
}

#[test]
fn deposit_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);

    prove_kyc(&env, &h, &user);
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

    prove_kyc(&env, &h, &user);
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


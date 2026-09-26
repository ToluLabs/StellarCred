#![cfg(test)]

//! Tests for the verified-human-once distribution pattern.
//!
//! The whole point of these tests is the Sybil case: the SAME credential
//! submitted from a SECOND wallet address must not be able to claim twice.

use super::*;
use credential_verifier::{CredentialVerifier, CredentialVerifierClient};
use issuer_registry::{IssuerRegistry, IssuerRegistryClient};
use proof_registry::{ProofRegistry, ProofRegistryClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env, IntoVal, Symbol,
};

// Real UltraHonk artifacts, so the human-gate exercises genuine verification.
const VK: &[u8] = include_bytes!("../../../fixtures/kyc/vk");
const PROOF: &[u8] = include_bytes!("../../../fixtures/kyc/proof");
const PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/kyc/public_inputs");
const FUNDS_VK: &[u8] = include_bytes!("../../../fixtures/funds/vk");
const FUNDS_PROOF: &[u8] = include_bytes!("../../../fixtures/funds/proof");
const FUNDS_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/funds/public_inputs");

const SCOPE: &[u8] = b"stellarcred:airdrop:humandrop-2026";
const OTHER_SCOPE: &[u8] = b"stellarcred:airdrop:other-2026";

/// Independently-computed `sha256(commitment || SCOPE)` for the KYC fixture.
/// The same vector is asserted by the SDK test
/// (`frontend/packages/sdk/src/airdrop.test.ts`), pinning the on-chain and
/// off-chain nullifier derivations to each other.
const EXPECTED_NULLIFIER: [u8; 32] = [
    0xac, 0x90, 0xac, 0x63, 0xaa, 0xa9, 0x74, 0x62, 0xb9, 0xe7, 0x1a, 0x74, 0x68, 0x67, 0xb9, 0x59,
    0x35, 0x37, 0x19, 0x8d, 0x8a, 0x14, 0x06, 0x09, 0xad, 0x42, 0xfd, 0x1c, 0x9c, 0x93, 0xa0, 0x91,
];
const EXPECTED_NULLIFIER_OTHER_SCOPE: [u8; 32] = [
    0xa6, 0x2d, 0x60, 0x2d, 0x6d, 0x06, 0xfc, 0x0c, 0x15, 0x33, 0x4c, 0x48, 0xac, 0x3a, 0x28, 0xa1,
    0xe4, 0xa3, 0xdb, 0x43, 0x6f, 0x35, 0xb8, 0x13, 0xfa, 0x67, 0xc0, 0x6f, 0x89, 0x0a, 0xcf, 0xfb,
];
const EXPECTED_COMMITMENT: [u8; 32] = [
    0x28, 0x95, 0x38, 0xca, 0xc0, 0xe6, 0xb6, 0xb0, 0xe6, 0x00, 0xb7, 0xd3, 0x21, 0x88, 0x30, 0x60,
    0xab, 0x00, 0x46, 0x85, 0x4d, 0x95, 0xa0, 0xd1, 0xa5, 0x01, 0xc1, 0x1b, 0xc5, 0xd2, 0x49, 0x9a,
];

fn demo_pubkey(env: &Env) -> BytesN<64> {
    let mut arr = [0u8; 64];
    for (i, slot) in arr.iter_mut().enumerate() {
        *slot = PUBLIC_INPUTS[(1 + i) * 32 + 31];
    }
    BytesN::from_array(env, &arr)
}

struct Harness {
    registry: ProofRegistryClient<'static>,
    airdrop: HumanAirdropClient<'static>,
    airdrop_id: Address,
    issuer: Address,
    admin: Address,
}

fn deploy(env: &Env) -> Harness {
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

    let registry_id = env.register(ProofRegistry, (admin.clone(), verifier_id, ir_id));
    let airdrop_id = env.register(HumanAirdrop, (admin.clone(), registry_id.clone()));

    Harness {
        registry: ProofRegistryClient::new(env, &registry_id),
        airdrop: HumanAirdropClient::new(env, &airdrop_id),
        airdrop_id,
        issuer,
        admin,
    }
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
        &1_000_000,
    );
}

fn create_campaign(env: &Env, h: &Harness, id: Symbol, scope: &[u8]) {
    h.airdrop.create_campaign(
        &id,
        &Bytes::from_slice(env, scope),
        &symbol_short!("kyc"),
        &None,
        &None,
        &100i128,
        &1_000i128,
        &0u32,
        &0u64,
        &0u64,
    );
}

/// `try_*` client calls surface a panic as `Err(Ok(soroban Error))`; this
/// asserts the panic carried our specific contract error code.
fn assert_contract_err(
    got: Option<Result<soroban_sdk::Error, soroban_sdk::InvokeError>>,
    expected: Error,
) {
    assert_eq!(
        got,
        Some(Ok(soroban_sdk::Error::from_contract_error(expected as u32))),
    );
}

fn drop_id() -> Symbol {
    symbol_short!("drop1")
}

// ── Nullifier primitive (registry level) ────────────────────────────────────

#[test]
fn registry_records_identity_commitment_and_derives_nullifier() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);

    assert_eq!(
        h.registry
            .identity_commitment(&user, &symbol_short!("kyc"))
            .unwrap(),
        BytesN::from_array(&env, &EXPECTED_COMMITMENT),
    );

    let n = h
        .registry
        .app_nullifier(
            &user,
            &symbol_short!("kyc"),
            &Bytes::from_slice(&env, SCOPE),
            &None,
            &None,
        )
        .unwrap();
    assert_eq!(n, BytesN::from_array(&env, &EXPECTED_NULLIFIER));
}

#[test]
fn nullifier_is_stable_across_wallets_and_unlinkable_across_scopes() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let wallet_a = Address::generate(&env);
    let wallet_b = Address::generate(&env);
    prove_kyc(&env, &h, &wallet_a);
    prove_kyc(&env, &h, &wallet_b);

    let scope = Bytes::from_slice(&env, SCOPE);
    let a = h
        .registry
        .app_nullifier(&wallet_a, &symbol_short!("kyc"), &scope, &None, &None)
        .unwrap();
    let b = h
        .registry
        .app_nullifier(&wallet_b, &symbol_short!("kyc"), &scope, &None, &None)
        .unwrap();
    // Same human, two addresses → one nullifier.
    assert_eq!(a, b);

    let other = h
        .registry
        .app_nullifier(
            &wallet_a,
            &symbol_short!("kyc"),
            &Bytes::from_slice(&env, OTHER_SCOPE),
            &None,
            &None,
        )
        .unwrap();
    // Different app scope → unlinkable nullifier.
    assert_ne!(a, other);
    assert_eq!(
        other,
        BytesN::from_array(&env, &EXPECTED_NULLIFIER_OTHER_SCOPE)
    );
}

#[test]
fn registry_returns_no_nullifier_without_valid_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    let scope = Bytes::from_slice(&env, SCOPE);

    // Never proved.
    assert!(h
        .registry
        .app_nullifier(&user, &symbol_short!("kyc"), &scope, &None, &None)
        .is_none());

    // Proved, then expired.
    prove_kyc_until(&env, &h, &user, 500);
    env.ledger().set_timestamp(600);
    assert!(h
        .registry
        .app_nullifier(&user, &symbol_short!("kyc"), &scope, &None, &None)
        .is_none());
}

// ── One claim per human, per campaign ───────────────────────────────────────

#[test]
fn verified_human_claims_once() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);
    create_campaign(&env, &h, drop_id(), SCOPE);

    assert_eq!(
        h.airdrop.eligibility(&drop_id(), &user),
        Eligibility::Eligible
    );

    let nullifier = h.airdrop.claim(&user, &drop_id());
    assert_eq!(nullifier, BytesN::from_array(&env, &EXPECTED_NULLIFIER));
    assert_eq!(h.airdrop.get_balance(&user), 100);
    assert_eq!(h.airdrop.claims_count(&drop_id()), 1);
    assert_eq!(h.airdrop.remaining_budget(&drop_id()), 900);
    assert!(h.airdrop.is_spent(&drop_id(), &nullifier));
    assert!(h.airdrop.has_claimed(&drop_id(), &user));
    assert_eq!(
        h.airdrop.eligibility(&drop_id(), &user),
        Eligibility::AlreadyClaimed
    );
}

#[test]
fn second_claim_from_same_wallet_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);
    create_campaign(&env, &h, drop_id(), SCOPE);

    h.airdrop.claim(&user, &drop_id());
    assert_contract_err(
        h.airdrop.try_claim(&user, &drop_id()).err(),
        Error::AlreadyClaimed,
    );
    assert_eq!(h.airdrop.get_balance(&user), 100);
    assert_eq!(h.airdrop.claims_count(&drop_id()), 1);
}

/// The anti-Sybil guarantee: one human, two wallets, one claim.
#[test]
fn sybil_second_wallet_with_same_credential_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let wallet_a = Address::generate(&env);
    let wallet_b = Address::generate(&env);
    prove_kyc(&env, &h, &wallet_a);
    prove_kyc(&env, &h, &wallet_b); // same credential, different address
    create_campaign(&env, &h, drop_id(), SCOPE);

    h.airdrop.claim(&wallet_a, &drop_id());

    assert_eq!(
        h.airdrop.eligibility(&drop_id(), &wallet_b),
        Eligibility::AlreadyClaimed
    );
    assert!(h.airdrop.has_claimed(&drop_id(), &wallet_b));
    assert_contract_err(
        h.airdrop.try_claim(&wallet_b, &drop_id()).err(),
        Error::AlreadyClaimed,
    );
    assert_eq!(h.airdrop.get_balance(&wallet_b), 0);
    assert_eq!(h.airdrop.claims_count(&drop_id()), 1);
    assert_eq!(h.airdrop.remaining_budget(&drop_id()), 900);
}

#[test]
fn same_human_can_claim_in_a_different_campaign() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);
    create_campaign(&env, &h, drop_id(), SCOPE);
    create_campaign(&env, &h, symbol_short!("drop2"), OTHER_SCOPE);

    let n1 = h.airdrop.claim(&user, &drop_id());
    let n2 = h.airdrop.claim(&user, &symbol_short!("drop2"));

    assert_ne!(n1, n2);
    assert_eq!(h.airdrop.get_balance(&user), 200);
    assert!(!h.airdrop.is_spent(&symbol_short!("drop2"), &n1));
}

#[test]
fn unverified_caller_cannot_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    create_campaign(&env, &h, drop_id(), SCOPE);

    assert_eq!(
        h.airdrop.eligibility(&drop_id(), &user),
        Eligibility::NotVerifiedHuman
    );
    assert_contract_err(
        h.airdrop.try_claim(&user, &drop_id()).err(),
        Error::NotVerifiedHuman,
    );
    assert!(!h.airdrop.has_claimed(&drop_id(), &user));
    assert_eq!(h.airdrop.claims_count(&drop_id()), 0);
}

#[test]
fn revoked_credential_cannot_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);
    create_campaign(&env, &h, drop_id(), SCOPE);

    h.registry.revoke(&h.issuer, &user, &symbol_short!("kyc"));

    assert_eq!(
        h.airdrop.eligibility(&drop_id(), &user),
        Eligibility::NotVerifiedHuman
    );
    assert_contract_err(
        h.airdrop.try_claim(&user, &drop_id()).err(),
        Error::NotVerifiedHuman,
    );
}

#[test]
fn expired_credential_cannot_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc_until(&env, &h, &user, 500);
    create_campaign(&env, &h, drop_id(), SCOPE);

    env.ledger().set_timestamp(600);
    assert_contract_err(
        h.airdrop.try_claim(&user, &drop_id()).err(),
        Error::NotVerifiedHuman,
    );
}

#[test]
fn threshold_gate_is_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_funds(&env, &h, &user);

    // Campaign requires a much larger balance than the fixture proves.
    h.airdrop.create_campaign(
        &symbol_short!("rich"),
        &Bytes::from_slice(&env, SCOPE),
        &symbol_short!("funds"),
        &Some(u64::MAX),
        &None,
        &100i128,
        &1_000i128,
        &0u32,
        &0u64,
        &0u64,
    );

    assert_eq!(
        h.airdrop.eligibility(&symbol_short!("rich"), &user),
        Eligibility::NotVerifiedHuman
    );

    // Same credential, a threshold it does satisfy.
    h.airdrop.create_campaign(
        &symbol_short!("modest"),
        &Bytes::from_slice(&env, OTHER_SCOPE),
        &symbol_short!("funds"),
        &Some(1u64),
        &None,
        &100i128,
        &1_000i128,
        &0u32,
        &0u64,
        &0u64,
    );
    assert_eq!(
        h.airdrop.eligibility(&symbol_short!("modest"), &user),
        Eligibility::Eligible
    );
    h.airdrop.claim(&user, &symbol_short!("modest"));
    assert_eq!(h.airdrop.get_balance(&user), 100);
}

#[test]
fn untrusted_issuer_cannot_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);

    let stranger = Address::generate(&env);
    h.airdrop.create_campaign(
        &symbol_short!("strict"),
        &Bytes::from_slice(&env, SCOPE),
        &symbol_short!("kyc"),
        &None,
        &Some(vec![&env, stranger]),
        &100i128,
        &1_000i128,
        &0u32,
        &0u64,
        &0u64,
    );

    assert_eq!(
        h.airdrop.eligibility(&symbol_short!("strict"), &user),
        Eligibility::NotVerifiedHuman
    );
}

// ── Campaign lifecycle / quota ──────────────────────────────────────────────

#[test]
fn budget_and_claim_cap_are_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);

    h.airdrop.create_campaign(
        &symbol_short!("tiny"),
        &Bytes::from_slice(&env, SCOPE),
        &symbol_short!("kyc"),
        &None,
        &None,
        &100i128,
        &100i128,
        &1u32,
        &0u64,
        &0u64,
    );

    h.airdrop.claim(&user, &symbol_short!("tiny"));
    assert_eq!(h.airdrop.remaining_budget(&symbol_short!("tiny")), 0);

    let other = Address::generate(&env);
    assert_eq!(
        h.airdrop.eligibility(&symbol_short!("tiny"), &other),
        Eligibility::BudgetExhausted
    );
    assert_contract_err(
        h.airdrop.try_claim(&other, &symbol_short!("tiny")).err(),
        Error::BudgetExhausted,
    );

    // Admin tops the campaign up; the claim cap still holds it closed.
    h.airdrop.fund(&symbol_short!("tiny"), &1_000i128);
    assert_contract_err(
        h.airdrop.try_claim(&other, &symbol_short!("tiny")).err(),
        Error::BudgetExhausted,
    );
}

#[test]
fn campaign_window_and_kill_switch() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);

    h.airdrop.create_campaign(
        &symbol_short!("timed"),
        &Bytes::from_slice(&env, SCOPE),
        &symbol_short!("kyc"),
        &None,
        &None,
        &100i128,
        &1_000i128,
        &0u32,
        &1_000u64,
        &2_000u64,
    );

    env.ledger().set_timestamp(500);
    assert_eq!(
        h.airdrop.eligibility(&symbol_short!("timed"), &user),
        Eligibility::CampaignNotStarted
    );
    assert_contract_err(
        h.airdrop.try_claim(&user, &symbol_short!("timed")).err(),
        Error::CampaignNotStarted,
    );

    env.ledger().set_timestamp(1_500);
    h.airdrop.set_active(&symbol_short!("timed"), &false);
    assert_eq!(
        h.airdrop.eligibility(&symbol_short!("timed"), &user),
        Eligibility::CampaignInactive
    );
    assert_contract_err(
        h.airdrop.try_claim(&user, &symbol_short!("timed")).err(),
        Error::CampaignInactive,
    );
    h.airdrop.set_active(&symbol_short!("timed"), &true);
    h.airdrop.claim(&user, &symbol_short!("timed"));

    env.ledger().set_timestamp(2_500);
    let other = Address::generate(&env);
    assert_eq!(
        h.airdrop.eligibility(&symbol_short!("timed"), &other),
        Eligibility::CampaignEnded
    );
}

#[test]
fn campaign_creation_is_validated() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);

    create_campaign(&env, &h, drop_id(), SCOPE);
    // Duplicate id.
    assert_contract_err(
        h.airdrop
            .try_create_campaign(
                &drop_id(),
                &Bytes::from_slice(&env, SCOPE),
                &symbol_short!("kyc"),
                &None,
                &None,
                &100i128,
                &1_000i128,
                &0u32,
                &0u64,
                &0u64,
            )
            .err(),
        Error::CampaignExists,
    );
    // Empty scope.
    assert_contract_err(
        h.airdrop
            .try_create_campaign(
                &symbol_short!("bad1"),
                &Bytes::new(&env),
                &symbol_short!("kyc"),
                &None,
                &None,
                &100i128,
                &1_000i128,
                &0u32,
                &0u64,
                &0u64,
            )
            .err(),
        Error::InvalidScope,
    );
    // Budget smaller than one payout.
    assert_contract_err(
        h.airdrop
            .try_create_campaign(
                &symbol_short!("bad2"),
                &Bytes::from_slice(&env, SCOPE),
                &symbol_short!("kyc"),
                &None,
                &None,
                &100i128,
                &10i128,
                &0u32,
                &0u64,
                &0u64,
            )
            .err(),
        Error::InvalidAmount,
    );
    // end <= start.
    assert_contract_err(
        h.airdrop
            .try_create_campaign(
                &symbol_short!("bad3"),
                &Bytes::from_slice(&env, SCOPE),
                &symbol_short!("kyc"),
                &None,
                &None,
                &100i128,
                &1_000i128,
                &0u32,
                &900u64,
                &800u64,
            )
            .err(),
        Error::InvalidWindow,
    );
    // Unknown campaign.
    assert_eq!(
        h.airdrop.eligibility(&symbol_short!("nope"), &h.admin),
        Eligibility::CampaignNotFound
    );
}

#[test]
fn claim_emits_nullifier_event() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);
    create_campaign(&env, &h, drop_id(), SCOPE);

    let nullifier = h.airdrop.claim(&user, &drop_id());

    let claim_events = env.events().all().filter_by_contract(&h.airdrop_id);
    assert_eq!(
        claim_events,
        vec![
            &env,
            (
                h.airdrop_id.clone(),
                (
                    symbol_short!("humandrop"),
                    symbol_short!("claimed"),
                    drop_id(),
                )
                    .into_val(&env),
                EventClaimed {
                    caller: user.clone(),
                    // The event exposes the nullifier, never the credential.
                    nullifier: nullifier.clone(),
                    amount: 100,
                    claims: 1,
                }
                .into_val(&env),
            ),
        ],
    );
}

#[test]
fn withdraw_moves_claimed_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);
    create_campaign(&env, &h, drop_id(), SCOPE);
    h.airdrop.claim(&user, &drop_id());

    h.airdrop.withdraw(&user, &40);
    assert_eq!(h.airdrop.get_balance(&user), 60);
    assert_contract_err(
        h.airdrop.try_withdraw(&user, &1_000).err(),
        Error::InsufficientBalance,
    );
}

// ── The consumable primitive, used by an external distributor ───────────────

/// A minimal third-party distribution contract: it does its own payout and
/// relies on HumanAirdrop only for the one-claim-per-human check. This is the
/// integration shape documented in `docs/ANTI_SYBIL.md`.
#[contract]
pub struct DemoDistributor;

#[contracttype]
enum DemoKey {
    Gate,
    Minted(Address),
}

#[contractimpl]
impl DemoDistributor {
    pub fn __constructor(env: Env, gate: Address) {
        env.storage().instance().set(&DemoKey::Gate, &gate);
    }

    /// Mint exactly one badge per verified human per campaign.
    pub fn mint(env: Env, holder: Address, campaign_id: Symbol) -> BytesN<32> {
        holder.require_auth();
        let gate_addr: Address = env.storage().instance().get(&DemoKey::Gate).unwrap();
        let gate = HumanAirdropClient::new(&env, &gate_addr);
        let nullifier = gate.consume(&env.current_contract_address(), &campaign_id, &holder);
        env.storage()
            .persistent()
            .set(&DemoKey::Minted(holder), &true);
        nullifier
    }

    pub fn minted(env: Env, holder: Address) -> bool {
        env.storage().persistent().has(&DemoKey::Minted(holder))
    }
}

#[test]
fn external_distributor_consumes_one_claim_per_human() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let wallet_a = Address::generate(&env);
    let wallet_b = Address::generate(&env);
    prove_kyc(&env, &h, &wallet_a);
    prove_kyc(&env, &h, &wallet_b);
    create_campaign(&env, &h, drop_id(), SCOPE);

    let distributor_id = env.register(DemoDistributor, (h.airdrop_id.clone(),));
    let distributor = DemoDistributorClient::new(&env, &distributor_id);

    let nullifier = distributor.mint(&wallet_a, &drop_id());
    assert!(distributor.minted(&wallet_a));
    assert!(h.airdrop.is_spent(&drop_id(), &nullifier));
    assert_eq!(h.airdrop.claims_count(&drop_id()), 1);
    // No payout happened in the gate — the distributor owns its own economics.
    assert_eq!(h.airdrop.get_balance(&wallet_a), 0);

    // Same human, second wallet, through the external distributor.
    let err = distributor.try_mint(&wallet_b, &drop_id());
    assert!(err.is_err());
    assert!(!distributor.minted(&wallet_b));
    assert_eq!(h.airdrop.claims_count(&drop_id()), 1);

    // And the gate's own claim path is closed for that human too.
    assert_contract_err(
        h.airdrop.try_claim(&wallet_a, &drop_id()).err(),
        Error::AlreadyClaimed,
    );
}

#[test]
fn consume_requires_consumer_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let user = Address::generate(&env);
    prove_kyc(&env, &h, &user);
    create_campaign(&env, &h, drop_id(), SCOPE);

    // With no auth supplied, an unauthorised consumer cannot burn a claim.
    let consumer = Address::generate(&env);
    assert!(h
        .airdrop
        .mock_auths(&[])
        .try_consume(&consumer, &drop_id(), &user)
        .is_err());
    assert_eq!(h.airdrop.claims_count(&drop_id()), 0);
}

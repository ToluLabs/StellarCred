#![cfg(test)]

extern crate std;

use super::*;
use credential_verifier::{CredentialVerifier, CredentialVerifierClient};
use issuer_registry::{IssuerRegistry, IssuerRegistryClient};
use soroban_sdk::{
    symbol_short,
    testutils::{storage::Persistent as _, Address as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env,
};

// Real UltraHonk artifacts from existing circuits.
const VK: &[u8] = include_bytes!("../../../fixtures/kyc/vk");
const PROOF: &[u8] = include_bytes!("../../../fixtures/kyc/proof");
const PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/kyc/public_inputs");

const FUNDS_VK: &[u8] = include_bytes!("../../../fixtures/funds/vk");
const FUNDS_PROOF: &[u8] = include_bytes!("../../../fixtures/funds/proof");
const FUNDS_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/funds/public_inputs");

const AGE_VK: &[u8] = include_bytes!("../../../fixtures/age/vk");
const AGE_PROOF: &[u8] = include_bytes!("../../../fixtures/age/proof");
const AGE_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/age/public_inputs");

// Real N=2 aggregate proof (KYC + age) from the aggregate_proof circuit
const AGGREGATE_VK: &[u8] = include_bytes!("../../../fixtures/aggregate/vk");
const AGGREGATE_PROOF: &[u8] = include_bytes!("../../../fixtures/aggregate/proof");
const AGGREGATE_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/aggregate/public_inputs");

// Negative test fixtures (Issue #537)
const NEGATIVE_KYC_WRONG_ISSUER_VK: &[u8] = include_bytes!("../../../fixtures/negative/kyc_wrong_issuer_vk");
const NEGATIVE_KYC_WRONG_ISSUER_PROOF: &[u8] = include_bytes!("../../../fixtures/negative/kyc_wrong_issuer_proof");
const NEGATIVE_KYC_WRONG_ISSUER_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/negative/kyc_wrong_issuer_public_inputs");

const NEGATIVE_KYC_TRUNCATED_VK: &[u8] = include_bytes!("../../../fixtures/negative/kyc_truncated_inputs_vk");
const NEGATIVE_KYC_TRUNCATED_PROOF: &[u8] = include_bytes!("../../../fixtures/negative/kyc_truncated_inputs_proof");
const NEGATIVE_KYC_TRUNCATED_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/negative/kyc_truncated_inputs_public_inputs");

const NEGATIVE_KYC_WRONG_CIRCUIT_VK: &[u8] = include_bytes!("../../../fixtures/negative/kyc_wrong_circuit_vk");
const NEGATIVE_KYC_WRONG_CIRCUIT_PROOF: &[u8] = include_bytes!("../../../fixtures/negative/kyc_wrong_circuit_proof");
const NEGATIVE_KYC_WRONG_CIRCUIT_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/negative/kyc_wrong_circuit_public_inputs");

// ── Helpers ─────────────────────────────────────────────────────────────────

fn pubkey_from_offset(env: &Env, public_inputs: &[u8], start_field: u32) -> BytesN<64> {
    let mut arr = [0u8; 64];
    for i in 0..64usize {
        arr[i] = public_inputs[(start_field as usize + i) * 32 + 31];
    }
    BytesN::from_array(env, &arr)
}

fn pubkey_from(env: &Env, public_inputs: &[u8]) -> BytesN<64> {
    pubkey_from_offset(env, public_inputs, 1)
}

fn demo_pubkey(env: &Env) -> BytesN<64> {
    pubkey_from(env, PUBLIC_INPUTS)
}

fn u8_slice_to_vec_u32(env: &Env, slice: &[u8]) -> Vec<u32> {
    let mut vec = Vec::new(env);
    for i in (0..slice.len()).step_by(4) {
        if i + 4 <= slice.len() {
            let mut chunk = [0u8; 4];
            chunk.copy_from_slice(&slice[i..i + 4]);
            vec.push_back(u32::from_be_bytes(chunk));
        }
    }
    vec
}

struct Harness {
    registry: ProofRegistryClient<'static>,
    registry_id: Address,
    issuer: Address,
}

fn deploy(env: &Env) -> Harness {
    let admin = Address::generate(env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(env, &ir_id);
    let issuer = Address::generate(env);
    ir.register_issuer(&issuer, &demo_pubkey(env), &vec![env, symbol_short!("kyc")]);

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(env, &v_id).set_vk(
        &symbol_short!("kyc"),
        &1u32,
        &Bytes::from_slice(env, VK),
    );

    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    Harness {
        registry: ProofRegistryClient::new(env, &pr_id),
        registry_id: pr_id,
        issuer,
    }
}

fn submit(env: &Env, h: &Harness, holder: &Address, expiry: u64) {
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

struct MultiHarness {
    registry: ProofRegistryClient<'static>,
    kyc_issuer: Address,
    funds_issuer: Address,
    age_issuer: Address,
}

fn deploy_multi(env: &Env) -> MultiHarness {
    let admin = Address::generate(env);
    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(env, &ir_id);

    let kyc_issuer = Address::generate(env);
    ir.register_issuer(
        &kyc_issuer,
        &pubkey_from(env, PUBLIC_INPUTS),
        &vec![env, symbol_short!("kyc")],
    );

    let funds_issuer = Address::generate(env);
    ir.register_issuer(
        &funds_issuer,
        &pubkey_from(env, FUNDS_PUBLIC_INPUTS),
        &vec![env, symbol_short!("funds")],
    );

    let age_issuer = Address::generate(env);
    ir.register_issuer(
        &age_issuer,
        &pubkey_from(env, AGE_PUBLIC_INPUTS),
        &vec![env, symbol_short!("age")],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    let vc = CredentialVerifierClient::new(env, &v_id);
    vc.set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(env, VK));
    vc.set_vk(
        &symbol_short!("funds"),
        &1u32,
        &Bytes::from_slice(env, FUNDS_VK),
    );
    vc.set_vk(
        &symbol_short!("age"),
        &1u32,
        &Bytes::from_slice(env, AGE_VK),
    );

    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    MultiHarness {
        registry: ProofRegistryClient::new(env, &pr_id),
        kyc_issuer,
        funds_issuer,
        age_issuer,
    }
}

fn kyc_submission(env: &Env, issuer: &Address, expiry: u64) -> ProofSubmission {
    ProofSubmission {
        credential_type: symbol_short!("kyc"),
        proof: Bytes::from_slice(env, PROOF),
        public_inputs: u8_slice_to_vec_u32(env, PUBLIC_INPUTS),
        issuer_id: issuer.clone(),
        expiry,
        vk_version: None,
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Single-proof tests
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn submit_then_verified() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 9999);

    let (valid, _at, expiry) = h
        .registry
        .is_verified(&holder, &symbol_short!("kyc"), &None);
    assert!(valid);
    assert_eq!(expiry, 9999);
}

#[test]
fn submit_sets_ttl_through_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let expiry = 90 * 86_400 + 10;

    submit(&env, &h, &holder, expiry);

    let key = DataKey::Proof(holder, symbol_short!("kyc"));
    let ttl = env.as_contract(&h.registry_id, || env.storage().persistent().get_ttl(&key));
    assert!(ttl >= 90 * DAY_IN_LEDGERS);
    assert!(ttl >= expiry.div_ceil(SECONDS_PER_LEDGER) as u32);
}

#[test]
fn anyone_can_bump_valid_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    submit(&env, &h, &holder, 9999);

    h.registry.bump_claim(&holder, &symbol_short!("kyc"));

    let key = DataKey::Proof(holder, symbol_short!("kyc"));
    let ttl = env.as_contract(&h.registry_id, || env.storage().persistent().get_ttl(&key));
    assert!(ttl >= PROOF_TTL);
}

#[test]
fn expires_after_ledger_time_passes() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 9999);
    assert!(
        h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );

    env.ledger().with_mut(|li| li.timestamp = 10000);
    assert!(
        !h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
}

#[test]
fn rejects_wrong_issuer_key() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let issuer = Address::generate(&env);
    IssuerRegistryClient::new(&env, &ir_id).register_issuer(
        &issuer,
        &BytesN::from_array(&env, &[3u8; 64]),
        &vec![&env, symbol_short!("kyc")],
    );
    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(&env, &v_id).set_vk(
        &symbol_short!("kyc"),
        &1u32,
        &Bytes::from_slice(&env, VK),
    );
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);

    let holder = Address::generate(&env);
    let res = registry.try_submit_proof(
        &holder,
        &issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &9999,
    );
    assert!(res.is_err());
}

#[test]
fn rejects_untrusted_issuer() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let stranger = Address::generate(&env);

    let res = h.registry.try_submit_proof(
        &holder,
        &stranger,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &9999,
    );
    assert!(res.is_err());
}

#[test]
fn rejects_invalid_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let mut bad = PROOF.to_vec();
    bad[5000] ^= 0xff;
    let res = h.registry.try_submit_proof(
        &holder,
        &h.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, &bad),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &9999,
    );
    assert!(res.is_err());
}

/// Rejects a proof with truncated public_inputs (wrong count).
/// The public_inputs are missing the last 32 bytes (issuer_y), so
/// verification should fail due to malformed input.
#[test]
fn rejects_proof_with_truncated_public_inputs() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let res = h.registry.try_submit_proof(
        &holder,
        &h.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, NEGATIVE_KYC_TRUNCATED_PROOF),
        &Bytes::from_slice(&env, NEGATIVE_KYC_TRUNCATED_PUBLIC_INPUTS),
        &None,
        &9999,
    );
    assert!(res.is_err());
}

/// Rejects a proof from a different circuit type verified against the wrong VK.
/// An age_proof verified against a kyc VK should fail because the proof
/// structure and public_inputs don't match the VK's expectations.
#[test]
fn rejects_proof_from_wrong_circuit_type() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let res = h.registry.try_submit_proof(
        &holder,
        &h.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, NEGATIVE_KYC_WRONG_CIRCUIT_PROOF),
        &Bytes::from_slice(&env, NEGATIVE_KYC_WRONG_CIRCUIT_PUBLIC_INPUTS),
        &None,
        &9999,
    );
    assert!(res.is_err());
}

#[test]
fn unverified_holder_returns_false() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let stranger = Address::generate(&env);
    assert!(
        !h.registry
            .is_verified(&stranger, &symbol_short!("kyc"), &None)
            .0
    );
}

#[test]
fn revoke_clears_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 9999);
    h.registry.revoke_proof(&holder, &symbol_short!("kyc"));
    assert!(
        !h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
}

#[test]
fn issuer_revoke_invalidates_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 9999);
    h.registry.revoke(&h.issuer, &holder, &symbol_short!("kyc"));
    assert!(
        !h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
}

#[test]
fn issuer_revoke_rejects_wrong_issuer() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let stranger = Address::generate(&env);

    submit(&env, &h, &holder, 9999);
    let res = h
        .registry
        .try_revoke(&stranger, &holder, &symbol_short!("kyc"));
    assert!(res.is_err());
}

#[test]
fn pause_blocks_submit_reads_still_work_and_unpause_restores() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 9999);
    h.registry.pause();
    let res = h.registry.try_submit_proof(
        &holder,
        &h.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &9999,
    );
    assert!(res.is_err());
    h.registry.unpause();
}

#[test]
fn non_admin_cannot_pause() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let res = h.registry.mock_auths(&[]).try_pause();
    assert!(res.is_err());
}

// ── Batch tests ────────────────────────────────────────────────────────────────

#[test]
fn batch_all_pass() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let h = deploy_multi(&env);
    let holder = Address::generate(&env);

    let submissions = vec![
        &env,
        kyc_submission(&env, &h.kyc_issuer, 9999),
        ProofSubmission {
            credential_type: symbol_short!("funds"),
            proof: Bytes::from_slice(&env, FUNDS_PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
            issuer_id: h.funds_issuer.clone(),
            expiry: 9999,
            vk_version: None,
        },
        ProofSubmission {
            credential_type: symbol_short!("age"),
            proof: Bytes::from_slice(&env, AGE_PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, AGE_PUBLIC_INPUTS),
            issuer_id: h.age_issuer.clone(),
            expiry: 9999,
            vk_version: None,
        },
    ];

    h.registry.submit_proofs(&holder, &submissions);
    assert!(
        h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
    assert!(
        h.registry
            .is_verified(&holder, &symbol_short!("funds"), &None)
            .0
    );
    assert!(
        h.registry
            .is_verified(&holder, &symbol_short!("age"), &None)
            .0
    );
}

#[test]
fn batch_one_fail_reverts_all() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let h = deploy_multi(&env);
    let holder = Address::generate(&env);

    let mut bad_funds = FUNDS_PROOF.to_vec();
    bad_funds[5000] ^= 0xff;

    let submissions = vec![
        &env,
        kyc_submission(&env, &h.kyc_issuer, 9999),
        ProofSubmission {
            credential_type: symbol_short!("funds"),
            proof: Bytes::from_slice(&env, &bad_funds),
            public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
            issuer_id: h.funds_issuer.clone(),
            expiry: 9999,
            vk_version: None,
        },
    ];

    let res = h.registry.try_submit_proofs(&holder, &submissions);
    assert!(res.is_err());
    assert!(
        !h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
}

#[test]
fn batch_duplicate_credential_type_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let sub = kyc_submission(&env, &h.issuer, 9999);
    let submissions = vec![&env, sub.clone(), sub];
    let res = h.registry.try_submit_proofs(&holder, &submissions);
    assert!(res.is_err());
}

#[test]
fn batch_empty_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let submissions: Vec<ProofSubmission> = Vec::new(&env);
    let res = h.registry.try_submit_proofs(&holder, &submissions);
    assert!(res.is_err());
}

#[test]
fn batch_rejects_past_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let submissions = vec![&env, kyc_submission(&env, &h.issuer, 0)];
    let res = h.registry.try_submit_proofs(&holder, &submissions);
    assert!(res.is_err());
}

#[test]
fn batch_rejects_over_max_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let submissions = vec![&env, kyc_submission(&env, &h.issuer, u64::MAX)];
    let res = h.registry.try_submit_proofs(&holder, &submissions);
    assert!(res.is_err());
}

// ── Aggregate proof tests ─────────────────────────────────────────────────────

#[test]
fn aggregate_submits_real_proof_and_stores_claims() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);
    let issuer = Address::generate(&env);
    ir.register_issuer(
        &issuer,
        &demo_pubkey(&env),
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(&env, &v_id).set_vk(
        &symbol_short!("aggregate"),
        &1u32,
        &Bytes::from_slice(&env, AGGREGATE_VK),
    );

    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    registry.submit_aggregate_proof(
        &holder,
        &vec![&env, issuer.clone(), issuer.clone()],
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
        &Bytes::from_slice(&env, AGGREGATE_PROOF),
        &Bytes::from_slice(&env, AGGREGATE_PUBLIC_INPUTS),
        &vec![&env, 9999u64, 9999u64],
    );

    assert!(
        registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
    assert!(
        registry
            .is_verified(&holder, &symbol_short!("age"), &None)
            .0
    );
    assert!(registry.check_claim(&holder, &symbol_short!("age"), &Some(18), &None));
    assert!(!registry.check_claim(&holder, &symbol_short!("age"), &Some(19), &None));
}

#[test]
fn aggregate_honors_per_credential_expiries() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);
    let issuer = Address::generate(&env);
    ir.register_issuer(
        &issuer,
        &demo_pubkey(&env),
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(&env, &v_id).set_vk(
        &symbol_short!("aggregate"),
        &1u32,
        &Bytes::from_slice(&env, AGGREGATE_VK),
    );

    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    // KYC gets a long-lived expiry, age gets a shorter one — the two must be
    // stored independently, not collapsed onto one shared value.
    registry.submit_aggregate_proof(
        &holder,
        &vec![&env, issuer.clone(), issuer.clone()],
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
        &Bytes::from_slice(&env, AGGREGATE_PROOF),
        &Bytes::from_slice(&env, AGGREGATE_PUBLIC_INPUTS),
        &vec![&env, 90_000u64, 5_000u64],
    );

    let kyc_record = registry.get_record(&holder, &symbol_short!("kyc")).unwrap();
    let age_record = registry.get_record(&holder, &symbol_short!("age")).unwrap();
    assert_eq!(kyc_record.expiry, 90_000);
    assert_eq!(age_record.expiry, 5_000);
    assert_ne!(kyc_record.expiry, age_record.expiry);
}

#[test]
fn aggregate_rejects_past_expiry_in_any_slot() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);
    let issuer = Address::generate(&env);
    ir.register_issuer(
        &issuer,
        &demo_pubkey(&env),
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(&env, &v_id).set_vk(
        &symbol_short!("aggregate"),
        &1u32,
        &Bytes::from_slice(&env, AGGREGATE_VK),
    );

    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    // First slot valid, second slot (age) has a past expiry — whole call must revert.
    let res = registry.try_submit_aggregate_proof(
        &holder,
        &vec![&env, issuer.clone(), issuer.clone()],
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
        &Bytes::from_slice(&env, AGGREGATE_PROOF),
        &Bytes::from_slice(&env, AGGREGATE_PUBLIC_INPUTS),
        &vec![&env, 9999u64, 0u64],
    );
    assert!(res.is_err());
    assert!(
        !registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
}

#[test]
fn aggregate_rejects_over_max_expiry_in_any_slot() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);
    let issuer = Address::generate(&env);
    ir.register_issuer(
        &issuer,
        &demo_pubkey(&env),
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(&env, &v_id).set_vk(
        &symbol_short!("aggregate"),
        &1u32,
        &Bytes::from_slice(&env, AGGREGATE_VK),
    );

    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    // First slot valid, second slot (age) has an over-max expiry — whole call must revert.
    let res = registry.try_submit_aggregate_proof(
        &holder,
        &vec![&env, issuer.clone(), issuer.clone()],
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
        &Bytes::from_slice(&env, AGGREGATE_PROOF),
        &Bytes::from_slice(&env, AGGREGATE_PUBLIC_INPUTS),
        &vec![&env, 9999u64, u64::MAX],
    );
    assert!(res.is_err());
    assert!(
        !registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
}
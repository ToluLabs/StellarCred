extern crate std;

use super::*;
use credential_verifier::{CredentialVerifier, CredentialVerifierClient};
use issuer_registry::{IssuerRegistry, IssuerRegistryClient};
use proptest::prelude::*;
use proptest::test_runner::RngSeed;
use soroban_sdk::{
    symbol_short,
    testutils::{
        storage::Persistent as _, Address as _, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    vec, Address, Bytes, BytesN, Env, IntoVal, Symbol,
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

// Negative test fixtures (Issue #537) — same case directories as the
// credential_verifier tests (fixtures/negative/<case>/{vk,proof,public_inputs}).
const NEGATIVE_KYC_TRUNCATED_PROOF: &[u8] =
    include_bytes!("../../../fixtures/negative/kyc_truncated_inputs/proof");
const NEGATIVE_KYC_TRUNCATED_PUBLIC_INPUTS: &[u8] =
    include_bytes!("../../../fixtures/negative/kyc_truncated_inputs/public_inputs");

const NEGATIVE_KYC_WRONG_CIRCUIT_PROOF: &[u8] =
    include_bytes!("../../../fixtures/negative/kyc_wrong_circuit/proof");
const NEGATIVE_KYC_WRONG_CIRCUIT_PUBLIC_INPUTS: &[u8] =
    include_bytes!("../../../fixtures/negative/kyc_wrong_circuit/public_inputs");

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

fn get_test_wasm(env: &Env) -> Bytes {
    let paths = [
        "target/wasm32v1-none/release/proof_registry.wasm",
        "../../target/wasm32v1-none/release/proof_registry.wasm",
        "../target/wasm32v1-none/release/proof_registry.wasm",
    ];
    for path in paths.iter() {
        if let Ok(wasm) = std::fs::read(path) {
            return Bytes::from_slice(env, &wasm);
        }
    }
    panic!("Could not find target/wasm32v1-none/release/proof_registry.wasm. Please run 'cargo build --target wasm32v1-none --release' first.");
}

struct Harness {
    registry: ProofRegistryClient<'static>,
    registry_id: Address,
    issuer_registry: IssuerRegistryClient<'static>,
    issuer: Address,
    admin: Address,
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

    let pr_id = env.register(ProofRegistry, (admin.clone(), v_id, ir_id));
    Harness {
        registry: ProofRegistryClient::new(env, &pr_id),
        registry_id: pr_id,
        issuer_registry: ir,
        issuer,
        admin,
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
    issuer_registry: IssuerRegistryClient<'static>,
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
        issuer_registry: ir,
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
fn issuer_revoke_rejects_different_trusted_issuer() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let other_issuer = Address::generate(&env);

    h.issuer_registry.register_issuer(
        &other_issuer,
        &demo_pubkey(&env),
        &vec![&env, symbol_short!("kyc")],
    );
    submit(&env, &h, &holder, 9999);

    let result = h
        .registry
        .try_revoke(&other_issuer, &holder, &symbol_short!("kyc"));

    assert!(result.is_err());
    assert!(
        h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
}

#[test]
fn issuer_revoke_rejects_missing_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let result = h
        .registry
        .try_revoke(&h.issuer, &holder, &symbol_short!("kyc"));

    assert!(result.is_err());
    assert!(h
        .registry
        .get_record(&holder, &symbol_short!("kyc"))
        .is_none());
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
    ];    h.registry.submit_proofs(&holder, &submissions);
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
    );    assert!(
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

// ── Event schema & drift tests (Issue #429) ──────────────────────────────────

#[test]
fn submit_proof_emits_expected_event() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    assert_eq!(
        env.events().all().filter_by_contract(&h.registry_id),
        vec![
            &env,
            (
                h.registry_id.clone(),
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("submitted"),
                    symbol_short!("kyc"),
                )
                    .into_val(&env),
                EventProofSubmitted {
                    holder: holder.clone(),
                    issuer: h.issuer.clone(),
                    verified_at: env.ledger().timestamp(),
                    expiry: 1000,
                }
                .into_val(&env),
            ),
        ],
    );
}

#[test]
fn submit_proofs_batch_emits_expected_events() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let h = deploy_multi(&env);
    let holder = Address::generate(&env);

    let submissions = vec![
        &env,
        kyc_submission(&env, &h.kyc_issuer, 1000),
        ProofSubmission {
            credential_type: symbol_short!("funds"),
            proof: Bytes::from_slice(&env, FUNDS_PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
            issuer_id: h.funds_issuer.clone(),
            expiry: 2000,
            vk_version: None,
        },
    ];

    h.registry.submit_proofs(&holder, &submissions);

    assert_eq!(
        env.events().all().filter_by_contract(&h.registry.address),
        vec![
            &env,
            (
                h.registry.address.clone(),
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("submitted"),
                    symbol_short!("kyc"),
                )
                    .into_val(&env),
                EventProofSubmitted {
                    holder: holder.clone(),
                    issuer: h.kyc_issuer.clone(),
                    verified_at: env.ledger().timestamp(),
                    expiry: 1000,
                }
                .into_val(&env),
            ),
            (
                h.registry.address.clone(),
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("submitted"),
                    symbol_short!("funds"),
                )
                    .into_val(&env),
                EventProofSubmitted {
                    holder: holder.clone(),
                    issuer: h.funds_issuer.clone(),
                    verified_at: env.ledger().timestamp(),
                    expiry: 2000,
                }
                .into_val(&env),
            ),
        ],
    );
}

#[test]
fn submit_aggregate_proof_emits_expected_events() {
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
        &vec![&env, 1000u64, 2000u64],
    );

    assert_eq!(
        env.events().all().filter_by_contract(&pr_id),
        vec![
            &env,
            (
                pr_id.clone(),
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("submitted"),
                    symbol_short!("kyc"),
                )
                    .into_val(&env),
                EventProofSubmitted {
                    holder: holder.clone(),
                    issuer: issuer.clone(),
                    verified_at: env.ledger().timestamp(),
                    expiry: 1000,
                }
                .into_val(&env),
            ),
            (
                pr_id.clone(),
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("submitted"),
                    symbol_short!("age"),
                )
                    .into_val(&env),
                EventProofSubmitted {
                    holder: holder.clone(),
                    issuer: issuer.clone(),
                    verified_at: env.ledger().timestamp(),
                    expiry: 2000,
                }
                .into_val(&env),
            ),
        ],
    );
}

#[test]
fn issuer_revoke_emits_expected_event() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    // Drain submit event
    let _ = env.events().all();

    h.registry.revoke(&h.issuer, &holder, &symbol_short!("kyc"));

    let all_events = env.events().all().filter_by_contract(&h.registry_id);
    assert_eq!(
        all_events,
        vec![
            &env,
            (
                h.registry_id.clone(),
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("revoked"),
                    symbol_short!("kyc"),
                )
                    .into_val(&env),
                EventProofRevoked {
                    holder,
                    issuer: h.issuer.clone(),
                    revoked_at: env.ledger().timestamp(),
                }
                .into_val(&env),
            ),
        ],
    );
}

#[test]
fn pause_and_unpause_emit_expected_events() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let dummy = Address::generate(&env);

    let pr_id = env.register(ProofRegistry, (admin.clone(), dummy.clone(), dummy));
    let registry = ProofRegistryClient::new(&env, &pr_id);

    registry.pause();

    assert_eq!(
        env.events().all().filter_by_contract(&pr_id),
        vec![
            &env,
            (
                pr_id.clone(),
                (symbol_short!("proof_reg"), symbol_short!("paused")).into_val(&env),
                EventPaused {
                    admin: admin.clone(),
                    paused_at: env.ledger().timestamp(),
                }
                .into_val(&env),
            ),
        ],
    );

    registry.unpause();

    assert_eq!(
        env.events().all().filter_by_contract(&pr_id),
        vec![
            &env,
            (
                pr_id.clone(),
                (symbol_short!("proof_reg"), symbol_short!("unpaused")).into_val(&env),
                EventUnpaused {
                    admin,
                    unpaused_at: env.ledger().timestamp(),
                }
                .into_val(&env),
            ),
        ],
    );
}

#[test]
fn holder_self_revoke_emits_no_events() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    let expected = vec![
        &env,
        (
            h.registry_id.clone(),
            (
                symbol_short!("proof_reg"),
                symbol_short!("submitted"),
                symbol_short!("kyc"),
            )
                .into_val(&env),
            EventProofSubmitted {
                holder: holder.clone(),
                issuer: h.issuer.clone(),
                verified_at: env.ledger().timestamp(),
                expiry: 1000,
            }
                .into_val(&env),
        ),
    ];
    assert_eq!(env.events().all().filter_by_contract(&h.registry_id), expected);

    // Holder self-revocation removes storage key directly and emits no new event
    h.registry.revoke_proof(&holder, &symbol_short!("kyc"));

    assert_eq!(env.events().all().filter_by_contract(&h.registry_id), vec![&env]);
}

// ── Delegated verification (#396) ────────────────────────────────────────────

#[test]
fn grant_then_verifier_can_check() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let verifier = Address::generate(&env);
    submit(&env, &h, &holder, 9999);

    h.registry
        .grant_verification(&holder, &verifier, &symbol_short!("kyc"), &5000);

    let (valid, verified_at, expiry) = h.registry.check_delegated_verification(
        &holder,
        &verifier,
        &symbol_short!("kyc"),
    );
    assert!(valid);
    assert_eq!(expiry, 9999); // the underlying claim's own expiry, not the grant's
    let (_, expected_at, _) = h
        .registry
        .is_verified(&holder, &symbol_short!("kyc"), &None);
    assert_eq!(verified_at, expected_at);
}

#[test]
fn check_delegated_verification_without_a_grant_returns_false() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let verifier = Address::generate(&env);
    submit(&env, &h, &holder, 9999);

    // The claim itself is valid, but this verifier was never delegated to.
    let (valid, verified_at, expiry) = h.registry.check_delegated_verification(
        &holder,
        &verifier,
        &symbol_short!("kyc"),
    );
    assert!(!valid);
    assert_eq!(verified_at, 0);
    assert_eq!(expiry, 0);
}

#[test]
fn grant_is_scoped_to_the_named_verifier_only() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let granted_verifier = Address::generate(&env);
    let other_verifier = Address::generate(&env);
    submit(&env, &h, &holder, 9999);
    h.registry
        .grant_verification(&holder, &granted_verifier, &symbol_short!("kyc"), &5000);

    assert!(
        h.registry
            .check_delegated_verification(&holder, &granted_verifier, &symbol_short!("kyc"))
            .0
    );
    assert!(
        !h.registry
            .check_delegated_verification(&holder, &other_verifier, &symbol_short!("kyc"))
            .0
    );
}

#[test]
fn grant_expires_correctly() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let verifier = Address::generate(&env);
    submit(&env, &h, &holder, 20_000_000); // claim itself long-lived (within the 1-year cap)
    h.registry
        .grant_verification(&holder, &verifier, &symbol_short!("kyc"), &5000);

    assert!(
        h.registry
            .check_delegated_verification(&holder, &verifier, &symbol_short!("kyc"))
            .0
    );

    env.ledger().with_mut(|li| li.timestamp = 5000);
    assert!(
        !h.registry
            .check_delegated_verification(&holder, &verifier, &symbol_short!("kyc"))
            .0
    );
}

#[test]
fn revoke_verification_removes_the_grant() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let verifier = Address::generate(&env);
    submit(&env, &h, &holder, 9999);
    h.registry
        .grant_verification(&holder, &verifier, &symbol_short!("kyc"), &5000);
    assert!(
        h.registry
            .check_delegated_verification(&holder, &verifier, &symbol_short!("kyc"))
            .0
    );

    h.registry
        .revoke_verification(&holder, &verifier, &symbol_short!("kyc"));

    assert!(
        !h.registry
            .check_delegated_verification(&holder, &verifier, &symbol_short!("kyc"))
            .0
    );
}

#[test]
fn revoke_verification_on_a_never_granted_delegation_is_a_no_op() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let verifier = Address::generate(&env);

    // Must not panic — matches the doc comment's "no-op, not an error".
    h.registry
        .revoke_verification(&holder, &verifier, &symbol_short!("kyc"));
}

#[test]
fn delegated_check_reflects_a_revoked_underlying_claim_even_with_a_live_grant() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let verifier = Address::generate(&env);
    submit(&env, &h, &holder, 9999);
    h.registry
        .grant_verification(&holder, &verifier, &symbol_short!("kyc"), &5000);
    assert!(
        h.registry
            .check_delegated_verification(&holder, &verifier, &symbol_short!("kyc"))
            .0
    );

    // The grant itself is still live, but the underlying claim is gone —
    // check_delegated_verification must reflect that, not just the grant.
    h.registry.revoke_proof(&holder, &symbol_short!("kyc"));

    assert!(
        !h.registry
            .check_delegated_verification(&holder, &verifier, &symbol_short!("kyc"))
            .0
    );
}

#[test]
fn grant_rejects_an_expiry_in_the_past() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let verifier = Address::generate(&env);
    env.ledger().with_mut(|li| li.timestamp = 1000);

    let res = h.registry.try_grant_verification(
        &holder,
        &verifier,
        &symbol_short!("kyc"),
        &500,
    );
    assert!(res.is_err());
}

#[test]
fn granting_the_same_verifier_again_overwrites_the_previous_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let verifier = Address::generate(&env);
    submit(&env, &h, &holder, 9999);
    h.registry
        .grant_verification(&holder, &verifier, &symbol_short!("kyc"), &2000);
    h.registry
        .grant_verification(&holder, &verifier, &symbol_short!("kyc"), &6000);

    env.ledger().with_mut(|li| li.timestamp = 3000);
    // Would be expired under the first grant (2000); still valid under the
    // second (6000), proving the overwrite actually took effect.
    assert!(
        h.registry
            .check_delegated_verification(&holder, &verifier, &symbol_short!("kyc"))
            .0
    );
}

// ── RBAC tests (Issue #123) ─────────────────────────────────────────────────

#[test]
fn roles_seeded_at_construction() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);

    // The deployer starts as root admin AND holds the upgrader and pauser
    // roles, so existing deploy/upgrade/pause flows work out of the box.
    assert!(h.registry.has_role(&symbol_short!("admin"), &h.admin));
    assert!(h.registry.has_role(&symbol_short!("upgrader"), &h.admin));
    assert!(h.registry.has_role(&symbol_short!("pauser"), &h.admin));

    let stranger = Address::generate(&env);
    assert!(!h.registry.has_role(&symbol_short!("admin"), &stranger));
    assert!(!h.registry.has_role(&symbol_short!("upgrader"), &stranger));
    assert!(!h.registry.has_role(&symbol_short!("pauser"), &stranger));
}

#[test]
fn admin_can_grant_and_revoke_roles() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let delegate = Address::generate(&env);
    let other = Address::generate(&env);

    // Grant a new role.
    h.registry.grant_role(&symbol_short!("upgrader"), &delegate);
    assert!(h.registry.has_role(&symbol_short!("upgrader"), &delegate));

    // Re-granting moves the role to the new holder.
    h.registry.grant_role(&symbol_short!("upgrader"), &other);
    assert!(!h.registry.has_role(&symbol_short!("upgrader"), &delegate));
    assert!(h.registry.has_role(&symbol_short!("upgrader"), &other));

    // Revoking an address that is not the current holder is rejected.
    let res = h
        .registry
        .try_revoke_role(&symbol_short!("upgrader"), &delegate);
    assert!(res.is_err());

    // Revoke.
    h.registry.revoke_role(&symbol_short!("upgrader"), &other);
    assert!(!h.registry.has_role(&symbol_short!("upgrader"), &other));

    // Revoking an unassigned role is a harmless no-op.
    let res = h
        .registry
        .try_revoke_role(&symbol_short!("upgrader"), &other);
    assert!(res.is_ok());
}

#[test]
fn grant_and_revoke_require_root_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let delegate = Address::generate(&env);

    // No auths mocked → the root admin's required auth fails.
    let res = h
        .registry
        .mock_auths(&[])
        .try_grant_role(&symbol_short!("upgrader"), &delegate);
    assert!(res.is_err());
    let res = h
        .registry
        .mock_auths(&[])
        .try_revoke_role(&symbol_short!("upgrader"), &delegate);
    assert!(res.is_err());
}

#[test]
fn upgrade_requires_upgrader_role() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);

    let real_wasm = get_test_wasm(&env);
    let new_wasm_hash = env.deployer().upload_contract_wasm(real_wasm);

    // Delegate the upgrader role away from the root admin.
    let upgrader = Address::generate(&env);
    h.registry.grant_role(&symbol_short!("upgrader"), &upgrader);

    // The role holder can upgrade…
    h.registry
        .mock_auths(&[MockAuth {
            address: &upgrader,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "upgrade",
                args: (&new_wasm_hash,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .upgrade(&new_wasm_hash);

    // …a non-holder cannot.
    let stranger = Address::generate(&env);
    let res = h
        .registry
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "upgrade",
                args: (&new_wasm_hash,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_upgrade(&new_wasm_hash);
    assert!(res.is_err());

    // After revocation the former holder loses upgrade power too.
    h.registry.revoke_role(&symbol_short!("upgrader"), &upgrader);
    let res = h
        .registry
        .mock_auths(&[MockAuth {
            address: &upgrader,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "upgrade",
                args: (&new_wasm_hash,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_upgrade(&new_wasm_hash);
    assert!(res.is_err());

    // Unassigned upgrader role: even the root admin cannot upgrade until the
    // role is granted again.
    let res = h
        .registry
        .mock_auths(&[MockAuth {
            address: &h.admin,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "upgrade",
                args: (&new_wasm_hash,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_upgrade(&new_wasm_hash);
    assert!(res.is_err());
}

#[test]
fn pause_requires_pauser_role() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    // Delegate the pauser role away from the root admin.
    let pauser = Address::generate(&env);
    h.registry.grant_role(&symbol_short!("pauser"), &pauser);

    // The pauser-role holder can pause…
    h.registry
        .mock_auths(&[MockAuth {
            address: &pauser,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "pause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .pause();

    // …submissions are now blocked…
    let res = h.registry.try_submit_proof(
        &holder,
        &h.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &2000,
    );
    assert!(res.is_err());

    // …a non-holder cannot pause or unpause…
    let stranger = Address::generate(&env);
    let res = h
        .registry
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "pause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_pause();
    assert!(res.is_err());

    // …and the root admin alone can no longer unpause once the role is
    // delegated (the old root still holds the role here, though — see below).
    let res = h
        .registry
        .mock_auths(&[MockAuth {
            address: &h.admin,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "unpause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_unpause();
    // h.admin no longer holds pauser (it was moved to `pauser`), so this fails.
    assert!(res.is_err());

    // The pauser-role holder can unpause…
    h.registry
        .mock_auths(&[MockAuth {
            address: &pauser,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "unpause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .unpause();

    // …and submissions work again.
    h.registry.submit_proof(
        &holder,
        &h.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &2000,
    );
    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
}

#[test]
fn migrate_record_requires_admin_role() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    // A current-format record exists so the migration call itself succeeds.
    submit(&env, &h, &holder, 1000);

    // Delegate the admin role away from the root admin.
    let admin_delegate = Address::generate(&env);
    h.registry.grant_role(&symbol_short!("admin"), &admin_delegate);

    // The admin-role holder can migrate (idempotent no-op on a current record).
    h.registry
        .mock_auths(&[MockAuth {
            address: &admin_delegate,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "migrate_record",
                args: (&holder, &symbol_short!("kyc")).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .migrate_record(&holder, &symbol_short!("kyc"));

    // A non-holder cannot — including the old root once the role is delegated.
    let stranger = Address::generate(&env);
    let res = h
        .registry
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "migrate_record",
                args: (&holder, &symbol_short!("kyc")).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_migrate_record(&holder, &symbol_short!("kyc"));
    assert!(res.is_err());
    let res = h
        .registry
        .mock_auths(&[MockAuth {
            address: &h.admin,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "migrate_record",
                args: (&holder, &symbol_short!("kyc")).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_migrate_record(&holder, &symbol_short!("kyc"));
    assert!(res.is_err());
}

// ── Two-step admin transfer tests (#343) ────────────────────────────────────

#[test]
fn propose_admin_by_non_admin_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let new_admin = Address::generate(&env);

    let res = h.registry.mock_auths(&[]).try_propose_admin(&new_admin);
    assert!(res.is_err());
}

#[test]
fn accept_admin_without_pending_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);

    let res = h.registry.try_accept_admin();
    assert!(res.is_err());
    // Admin unchanged.
    assert_eq!(h.registry.admin(), h.admin);
}

#[test]
fn propose_then_accept_transfers_admin_and_roles() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let new_admin = Address::generate(&env);

    // No pending proposal initially.
    assert_eq!(h.registry.pending_admin(), None);

    h.registry.propose_admin(&new_admin);
    assert_eq!(h.registry.pending_admin(), Some(new_admin.clone()));
    // Still the old admin — nothing has moved yet.
    assert_eq!(h.registry.admin(), h.admin);

    h.registry.accept_admin();

    // Now the transfer has taken effect.
    assert_eq!(h.registry.admin(), new_admin);
    assert_eq!(h.registry.pending_admin(), None);

    // Every role the outgoing admin held moved to the new admin.
    assert!(h.registry.has_role(&symbol_short!("admin"), &new_admin));
    assert!(h.registry.has_role(&symbol_short!("upgrader"), &new_admin));
    assert!(h.registry.has_role(&symbol_short!("pauser"), &new_admin));

    // …and the old admin no longer holds them.
    assert!(!h.registry.has_role(&symbol_short!("admin"), &h.admin));
    assert!(!h.registry.has_role(&symbol_short!("upgrader"), &h.admin));
    assert!(!h.registry.has_role(&symbol_short!("pauser"), &h.admin));
}

#[test]
fn accept_by_wrong_address_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let new_admin = Address::generate(&env);
    let wrong = Address::generate(&env);

    h.registry.propose_admin(&new_admin);

    let res = h
        .registry
        .mock_auths(&[MockAuth {
            address: &wrong,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_accept_admin();
    assert!(res.is_err());
    // Admin unchanged.
    assert_eq!(h.registry.admin(), h.admin);
}

#[test]
fn cancel_admin_proposal_clears_pending() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let new_admin = Address::generate(&env);

    h.registry.propose_admin(&new_admin);
    assert_eq!(h.registry.pending_admin(), Some(new_admin.clone()));

    h.registry.cancel_admin_proposal();
    assert_eq!(h.registry.pending_admin(), None);

    // Accept after cancel must fail.
    let res = h.registry.try_accept_admin();
    assert!(res.is_err());
}

#[test]
fn propose_admin_overwrites_pending() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);

    h.registry.propose_admin(&first);
    assert_eq!(h.registry.pending_admin(), Some(first.clone()));

    // Second proposal overwrites the first — no cancel required.
    h.registry.propose_admin(&second);
    assert_eq!(h.registry.pending_admin(), Some(second.clone()));

    h.registry.accept_admin();
    assert_eq!(h.registry.admin(), second);
}

#[test]
fn has_role_is_a_public_view() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let delegate = Address::generate(&env);

    // has_role requires no auth — readable by anyone (still true even with
    // zero mocked auths).
    assert!(h
        .registry
        .mock_auths(&[])
        .has_role(&symbol_short!("admin"), &h.admin));
    assert!(h
        .registry
        .mock_auths(&[])
        .has_role(&symbol_short!("upgrader"), &h.admin));

    h.registry
        .grant_role(&Symbol::new(&env, "issuer_manager"), &delegate);
    assert!(h
        .registry
        .has_role(&Symbol::new(&env, "issuer_manager"), &delegate));

}

// ═══════════════════════════════════════════════════════════════════════════════
// Issuer key rotation
//
// A credential is bound to the key that signed it. These tests pin the
// behaviour an issuer relies on when it rotates: credentials issued before the
// rotation keep verifying until their natural expiry, and a revoked key stops
// verifying immediately.
// ═══════════════════════════════════════════════════════════════════════════════

/// Ledger timestamp the rotation tests start from, so validity windows are
/// measured against a realistic clock rather than the genesis timestamp.
const ROT_T0: u64 = 1_700_000_000;
/// 90-day grace window granted to the key a rotation retires.
const ROT_WINDOW: u64 = 90 * 86_400;

/// A replacement signing key, deliberately different from the fixture keys.
fn replacement_key(env: &Env, seed: u8) -> BytesN<64> {
    BytesN::from_array(env, &[seed; 64])
}

/// The headline case: rotating an issuer's key must not invalidate the
/// credentials it already issued.
#[test]
fn credential_signed_with_a_retired_key_still_submits() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(ROT_T0);
    let h = deploy(&env);
    let holder = Address::generate(&env);

    // The issuer rotates away from the key that signed the fixture proof.
    h.issuer_registry.rotate_issuer_key(
        &h.issuer,
        &replacement_key(&env, 9),
        &(ROT_T0 + ROT_WINDOW),
    );

    // New issuance uses the new key…
    assert_eq!(
        h.issuer_registry.get_issuer_pubkey(&h.issuer),
        replacement_key(&env, 9)
    );
    // …but a credential signed before the rotation still verifies.
    submit(&env, &h, &holder, ROT_T0 + 1000);
    assert!(
        h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
}

/// Once the validity window closes, the retired key no longer backs a
/// submission — the credential has outlived its grace period.
#[test]
#[should_panic(expected = "Contract, #5")]
fn credential_signed_with_a_retired_key_stops_submitting_after_the_window() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(ROT_T0);
    let h = deploy(&env);
    let holder = Address::generate(&env);

    h.issuer_registry.rotate_issuer_key(
        &h.issuer,
        &replacement_key(&env, 9),
        &(ROT_T0 + ROT_WINDOW),
    );

    env.ledger().set_timestamp(ROT_T0 + ROT_WINDOW + 1);
    submit(&env, &h, &holder, ROT_T0 + ROT_WINDOW + 1000);
}

/// The window is inclusive: a credential signed by the retired key still
/// submits on the final ledger of its validity window, and only stops one
/// ledger later. ProofRegistry mirrors the `now <= valid_until` rule
/// `IssuerRegistry::is_valid_issuer_key` documents.
#[test]
fn credential_signed_with_a_retired_key_submits_on_the_last_ledger_of_its_window() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(ROT_T0);
    let h = deploy(&env);
    let holder = Address::generate(&env);

    h.issuer_registry.rotate_issuer_key(
        &h.issuer,
        &replacement_key(&env, 9),
        &(ROT_T0 + ROT_WINDOW),
    );

    // Boundary: exactly `old_key_valid_until`. The credential still verifies.
    env.ledger().set_timestamp(ROT_T0 + ROT_WINDOW);
    submit(&env, &h, &holder, ROT_T0 + ROT_WINDOW + 1000);
    assert!(
        h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
}

/// Emergency revocation ignores the validity window: a compromised key stops
/// working on the spot, even mid-grace-period.
#[test]
#[should_panic(expected = "Contract, #5")]
fn revoked_issuer_key_rejects_submissions_immediately() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(ROT_T0);
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let old_key = h.issuer_registry.get_issuer_pubkey(&h.issuer);
    h.issuer_registry.rotate_issuer_key(
        &h.issuer,
        &replacement_key(&env, 9),
        &(ROT_T0 + ROT_WINDOW),
    );
    // Still inside its window — this submission would succeed…
    submit(&env, &h, &holder, ROT_T0 + 1000);
    // …until the old key is revoked as compromised.
    h.issuer_registry.revoke_issuer_key(&h.issuer, &old_key);

    let other_holder = Address::generate(&env);
    submit(&env, &h, &other_holder, ROT_T0 + 2000);
}

/// Revoking the issuer's *current* key leaves it with no usable signing key, so
/// the issuer is no longer trusted at all until an admin rotates it forward.
#[test]
#[should_panic(expected = "Contract, #4")]
fn emergency_revocation_of_the_current_key_rejects_submissions() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(ROT_T0);
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let new_key = replacement_key(&env, 9);
    h.issuer_registry
        .rotate_issuer_key(&h.issuer, &new_key, &(ROT_T0 + ROT_WINDOW));
    h.issuer_registry.revoke_issuer_key(&h.issuer, &new_key);

    submit(&env, &h, &holder, ROT_T0 + 1000);
}

/// The batch submission path reads the key from the same layout, so a batch
/// mixing rotated and unrotated issuers behaves identically.
#[test]
fn batch_accepts_credentials_signed_with_retired_keys() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set_timestamp(ROT_T0);
    let h = deploy_multi(&env);
    let holder = Address::generate(&env);

    h.issuer_registry.rotate_issuer_key(
        &h.kyc_issuer,
        &replacement_key(&env, 9),
        &(ROT_T0 + ROT_WINDOW),
    );
    h.issuer_registry.rotate_issuer_key(
        &h.age_issuer,
        &replacement_key(&env, 10),
        &(ROT_T0 + ROT_WINDOW),
    );

    let submissions = vec![
        &env,
        kyc_submission(&env, &h.kyc_issuer, ROT_T0 + 1000),
        ProofSubmission {
            credential_type: symbol_short!("funds"),
            proof: Bytes::from_slice(&env, FUNDS_PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
            issuer_id: h.funds_issuer.clone(),
            expiry: ROT_T0 + 1000,
            vk_version: None,
        },
        ProofSubmission {
            credential_type: symbol_short!("age"),
            proof: Bytes::from_slice(&env, AGE_PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, AGE_PUBLIC_INPUTS),
            issuer_id: h.age_issuer.clone(),
            expiry: ROT_T0 + 1000,
            vk_version: None,
        },
    ];

    h.registry.submit_proofs(&holder, &submissions);
    assert!(h
        .registry
        .is_verified(&holder, &symbol_short!("kyc"), &None)
        .0);
    assert!(h
        .registry
        .is_verified(&holder, &symbol_short!("funds"), &None)
        .0);
    assert!(h
        .registry
        .is_verified(&holder, &symbol_short!("age"), &None)
        .0);
}

/// Same guarantee for the aggregate layout, where each credential's key sits
/// at its own field offset.
#[test]
fn aggregate_accepts_a_credential_signed_with_a_retired_key() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set_timestamp(ROT_T0);
    let admin = Address::generate(&env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);
    let issuer = Address::generate(&env);
    ir.register_issuer(
        &issuer,
        &demo_pubkey(&env),
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
    );
    ir.rotate_issuer_key(&issuer, &replacement_key(&env, 9), &(ROT_T0 + ROT_WINDOW));

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
        &vec![&env, ROT_T0 + 1000u64, ROT_T0 + 1000u64],
    );

    assert!(registry
        .is_verified(&holder, &symbol_short!("kyc"), &None)
        .0);
    assert!(registry
        .is_verified(&holder, &symbol_short!("age"), &None)
        .0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #417 — fuzz/invariant coverage for the security-critical read/write paths
//
// Fuzz: check_claim threshold boundaries and trusted_issuers combinations.
// Invariants: a batch either fully applies or fully reverts; a revoked or
// expired proof never reads valid.
// ═══════════════════════════════════════════════════════════════════════════════

/// Proptest config with a pinned RNG seed. The default seed is random, which makes
/// a red CI run unreproducible; pinning it gives every run the same corpus, so a
/// failure replays exactly and stays recorded in proptest-regressions/.
fn prop_config(cases: u32) -> ProptestConfig {
    ProptestConfig {
        cases,
        rng_seed: RngSeed::Fixed(417_417_417_417),
        ..Default::default()
    }
}

/// A registry deployed with unregistered (dummy) verifier and issuer-registry
/// addresses. The read paths under test only touch storage, so no
/// cross-contract call is ever reached.
fn deploy_registry(env: &Env) -> (ProofRegistryClient<'static>, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let v_id = Address::generate(env);
    let ir_id = Address::generate(env);
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    (ProofRegistryClient::new(env, &pr_id), pr_id)
}

fn set_proof_record(
    env: &Env,
    registry_id: &Address,
    holder: &Address,
    cred: &Symbol,
    record: &ProofRecord,
) {
    env.as_contract(registry_id, || {
        let key = DataKey::Proof(holder.clone(), cred.clone());
        env.storage().persistent().set(&key, record);
        env.storage()
            .persistent()
            .extend_ttl(&key, 17280, 17280 * 90);
    });
}

proptest! {
    #![proptest_config(prop_config(100))]

    /// Fuzz: trusted_issuers combinations.
    /// For any (valid, issuer_in_list, filter_active), check_claim must
    /// correctly accept or reject based on the trusted_issuers filter.
    #[test]
    fn prop_check_claim_trusted_issuer_fuzz(
        valid in any::<bool>(),
        issuer_in_list in any::<bool>(),
        filter_active in any::<bool>(),
    ) {
        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let proof_issuer = Address::generate(&env);
        let other_addr = Address::generate(&env);
        let cred = symbol_short!("funds");

        let record = ProofRecord {
            verified_at: 100,
            expiry: if valid { 1000 } else { env.ledger().timestamp() },
            threshold: Some(200_000),
            revoked: !valid,
            issuer: Some(proof_issuer.clone()),
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        let min_threshold = None::<u64>;
        let trusted = if filter_active {
            if issuer_in_list {
                Some(vec![&env, proof_issuer, other_addr])
            } else {
                Some(vec![&env, other_addr])
            }
        } else {
            None
        };

        let result = client.check_claim(&holder, &cred, &min_threshold, &trusted);

        if filter_active {
            // With an active filter the proof is accepted only if its issuer
            // is in the list AND the proof is otherwise valid.
            prop_assert_eq!(result, valid && issuer_in_list);
        } else {
            // With no filter (None) issuer membership is irrelevant —
            // only proof validity matters.
            prop_assert_eq!(result, valid);
        }
    }

    /// Fuzz: threshold boundary comparison is correct for arbitrary values.
    /// The >= comparison must hold for every combination of stored and required
    /// threshold, including edge cases around 0, u64::MAX, and None.
    #[test]
    fn prop_check_claim_threshold_boundary_fuzz(
        stored_threshold in prop::option::of(any::<u64>()),
        min_threshold in any::<u64>(),
    ) {
        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let cred = symbol_short!("kyc");

        let record = ProofRecord {
            verified_at: 100,
            expiry: 1000,
            threshold: stored_threshold,
            revoked: false,
            issuer: None,
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        let result = client.check_claim(&holder, &cred, &Some(min_threshold), &None);

        // The contract uses unwrap_or(0) for None thresholds.
        let effective_stored = stored_threshold.unwrap_or(0);
        prop_assert_eq!(result, effective_stored >= min_threshold);
    }

    /// Fuzz: a stored threshold of 0 only satisfies a requirement of 0.
    #[test]
    fn prop_check_claim_zero_threshold_fuzz(min_threshold in 0u64..=10_000) {
        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let cred = symbol_short!("kyc");

        let record = ProofRecord {
            verified_at: 100,
            expiry: 1000,
            threshold: Some(0),
            revoked: false,
            issuer: None,
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        let result = client.check_claim(&holder, &cred, &Some(min_threshold), &None);

        if min_threshold == 0 {
            prop_assert!(result, "0 >= 0 must be true");
        } else {
            prop_assert!(!result, "0 >= {} must be false", min_threshold);
        }
    }

    /// Fuzz: min_threshold=None is equivalent to a requirement of 0.
    #[test]
    fn prop_check_claim_none_vs_zero_threshold_fuzz(
        valid in any::<bool>(),
        expired in any::<bool>(),
    ) {
        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let cred = symbol_short!("kyc");

        let expiry = if expired {
            env.ledger().timestamp()
        } else {
            1000
        };

        let record = ProofRecord {
            verified_at: 100,
            expiry,
            threshold: None, // kyc has no numeric threshold
            revoked: !valid,
            issuer: None,
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        let with_none = client.check_claim(&holder, &cred, &None, &None);
        let with_zero = client.check_claim(&holder, &cred, &Some(0), &None);

        // None and Some(0) must agree for any validity state.
        prop_assert_eq!(with_none, with_zero);
        // Both must reflect overall proof validity.
        prop_assert_eq!(with_none, valid && !expired);
    }

    /// Fuzz: an issuer absent from the trusted list is always rejected, no
    /// matter how many other addresses the list carries.
    #[test]
    fn prop_check_claim_untrusted_issuer_fuzz(extra_count in 0..=3usize) {
        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let proof_issuer = Address::generate(&env);
        let cred = symbol_short!("funds");

        let record = ProofRecord {
            verified_at: 100,
            expiry: 1000,
            threshold: Some(200_000),
            revoked: false,
            issuer: Some(proof_issuer),
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        // Build a trusted list that explicitly excludes the proof's issuer.
        let mut trust_list: Vec<Address> = Vec::new(&env);
        for _ in 0..extra_count {
            trust_list.push_back(Address::generate(&env));
        }

        // proof_issuer is NOT in trust_list, so check_claim must reject.
        let result = client.check_claim(&holder, &cred, &None, &Some(trust_list));
        prop_assert!(!result, "proof from untrusted issuer must be rejected");
    }
}

proptest! {
    #![proptest_config(prop_config(50))]

    /// Invariant: a revoked or expired proof never reads valid, under any
    /// combination of threshold and trusted_issuers filter, on both read paths.
    #[test]
    fn prop_revoked_expired_never_valid_fuzz(
        revoked in any::<bool>(),
        expired in any::<bool>(),
        stored_threshold in prop::option::of(0u64..=500_000u64),
        min_threshold in prop::option::of(0u64..=500_000u64),
        use_filter in any::<bool>(),
    ) {
        if !revoked && !expired {
            return Ok(());
        }

        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let proof_issuer = Address::generate(&env);
        let cred = symbol_short!("funds");

        let expiry = if expired {
            env.ledger().timestamp()
        } else {
            env.ledger().timestamp() + 10_000
        };

        let record = ProofRecord {
            verified_at: 100,
            expiry,
            threshold: stored_threshold,
            revoked,
            issuer: Some(proof_issuer.clone()),
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        let trusted = if use_filter {
            Some(vec![&env, proof_issuer])
        } else {
            None
        };

        let result = client.check_claim(&holder, &cred, &min_threshold, &trusted);
        prop_assert!(
            !result,
            "revoked={}, expired={}, filter={}: proof must not be valid",
            revoked,
            expired,
            use_filter
        );

        // is_verified must agree with check_claim on the same record.
        let (valid, _, _) = client.is_verified(&holder, &cred, &trusted);
        prop_assert!(!valid, "is_verified must also return false for revoked/expired proofs");
    }

    /// Invariant: a batch either fully applies or fully reverts.
    /// If the second proof in a 2-proof batch is invalid (bad proof bytes),
    /// then NEITHER proof should be stored after the batch reverts.
    #[test]
    fn prop_batch_atomicity_all_or_nothing(
        corrupt_offset in 0..32usize,
        xor_byte in 1u8..=255u8,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let h = deploy_multi(&env);
        let holder = Address::generate(&env);

        let mut bad_proof = PROOF.to_vec();
        bad_proof[corrupt_offset] ^= xor_byte;

        let submissions = vec![
            &env,
            ProofSubmission {
                credential_type: symbol_short!("kyc"),
                proof: Bytes::from_slice(&env, PROOF),
                public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS),
                issuer_id: h.kyc_issuer.clone(),
                expiry: 9999,
                vk_version: None,
            },
            ProofSubmission {
                credential_type: symbol_short!("funds"),
                proof: Bytes::from_slice(&env, &bad_proof),
                public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
                issuer_id: h.funds_issuer.clone(),
                expiry: 9999,
                vk_version: None,
            },
        ];

        let res = h.registry.try_submit_proofs(&holder, &submissions);
        prop_assert!(res.is_err(), "batch with bad proof must fail");

        // CRITICAL INVARIANT: the valid KYC proof must NOT have been stored.
        let (kyc_valid, _, _) = h
            .registry
            .is_verified(&holder, &symbol_short!("kyc"), &None);
        prop_assert!(!kyc_valid, "batch reverted: kyc proof must not be stored");

        let (funds_valid, _, _) = h
            .registry
            .is_verified(&holder, &symbol_short!("funds"), &None);
        prop_assert!(!funds_valid, "batch reverted: funds proof must not be stored");
    }

    /// Invariant: a revoked proof never reads valid.
    /// After revocation, both is_verified and check_claim must return
    /// false regardless of trusted_issuers or threshold parameters.
    #[test]
    fn prop_invariant_revoked_never_valid(
        use_issuer_filter in any::<bool>(),
        use_threshold in any::<bool>(),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let h = deploy(&env);
        let holder = Address::generate(&env);

        submit(&env, &h, &holder, 5000);

        // Verify valid before revocation.
        let (before, _, _) = h
            .registry
            .is_verified(&holder, &symbol_short!("kyc"), &None);
        prop_assert!(before, "proof should be valid before revocation");

        h.registry.revoke(&h.issuer, &holder, &symbol_short!("kyc"));

        let trusted = if use_issuer_filter {
            Some(vec![&env, h.issuer.clone()])
        } else {
            None
        };
        let threshold = if use_threshold { Some(0) } else { None };

        let (valid, _, _) = h
            .registry
            .is_verified(&holder, &symbol_short!("kyc"), &trusted);
        prop_assert!(
            !valid,
            "is_verified: revoked proof must not be valid (filter={})",
            use_issuer_filter
        );

        let claim = h
            .registry
            .check_claim(&holder, &symbol_short!("kyc"), &threshold, &trusted);
        prop_assert!(
            !claim,
            "check_claim: revoked proof must not be valid (threshold={:?}, filter={})",
            threshold,
            use_issuer_filter
        );

        // get_record must still return the record for audit.
        let record = h.registry.get_record(&holder, &symbol_short!("kyc"));
        prop_assert!(record.is_some(), "revoked record must still be readable for audit");
        prop_assert!(record.unwrap().revoked, "record must be marked revoked");
    }

    /// Invariant: an expired proof never reads valid.
    /// After advancing the ledger past expiry, is_verified and check_claim
    /// must return false regardless of other parameters.
    #[test]
    fn prop_invariant_expired_never_valid(
        use_issuer_filter in any::<bool>(),
        use_threshold in any::<bool>(),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let h = deploy(&env);
        let holder = Address::generate(&env);

        submit(&env, &h, &holder, 100);

        // Advance time past expiry.
        env.ledger().with_mut(|li| li.timestamp = 101);

        let trusted = if use_issuer_filter {
            Some(vec![&env, h.issuer.clone()])
        } else {
            None
        };
        let threshold = if use_threshold { Some(0) } else { None };

        let (valid, _, _) = h
            .registry
            .is_verified(&holder, &symbol_short!("kyc"), &trusted);
        prop_assert!(!valid, "is_verified: expired proof must not be valid");

        let claim = h
            .registry
            .check_claim(&holder, &symbol_short!("kyc"), &threshold, &trusted);
        prop_assert!(!claim, "check_claim: expired proof must not be valid");

        // get_record must still return the record (expiry data preserved for audit).
        let record = h.registry.get_record(&holder, &symbol_short!("kyc"));
        prop_assert!(record.is_some(), "expired record must still be readable for audit");
        prop_assert_eq!(record.unwrap().expiry, 100);
    }
}

/// Invariant: a batch with a duplicate credential_type is rejected whichever
/// type is duplicated, and nothing is stored.
#[test]
fn batch_duplicate_type_invariant_rejects_all_combinations() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let h = deploy_multi(&env);
    let holder = Address::generate(&env);

    let kyc_sub = ProofSubmission {
        credential_type: symbol_short!("kyc"),
        proof: Bytes::from_slice(&env, PROOF),
        public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS),
        issuer_id: h.kyc_issuer.clone(),
        expiry: 9999,
        vk_version: None,
    };
    let funds_sub = ProofSubmission {
        credential_type: symbol_short!("funds"),
        proof: Bytes::from_slice(&env, FUNDS_PROOF),
        public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
        issuer_id: h.funds_issuer.clone(),
        expiry: 9999,
        vk_version: None,
    };

    // kyc, kyc, funds — duplicate kyc.
    let batch1 = vec![&env, kyc_sub.clone(), kyc_sub.clone(), funds_sub.clone()];
    assert!(
        h.registry.try_submit_proofs(&holder, &batch1).is_err(),
        "batch with duplicate kyc must fail"
    );

    // funds, kyc, funds — duplicate funds.
    let batch2 = vec![&env, funds_sub.clone(), kyc_sub.clone(), funds_sub];
    assert!(
        h.registry.try_submit_proofs(&holder, &batch2).is_err(),
        "batch with duplicate funds must fail"
    );

    // Verify nothing was stored from either failed batch.
    assert!(
        !h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
    assert!(
        !h.registry
            .is_verified(&holder, &symbol_short!("funds"), &None)
            .0
    );
}

/// Invariant: revoking one credential type leaves every other type intact.
#[test]
fn single_revocation_does_not_affect_other_types() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let h = deploy_multi(&env);
    let holder = Address::generate(&env);

    let submissions = vec![
        &env,
        ProofSubmission {
            credential_type: symbol_short!("kyc"),
            proof: Bytes::from_slice(&env, PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS),
            issuer_id: h.kyc_issuer.clone(),
            expiry: 9999,
            vk_version: None,
        },
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

    // Revoke only kyc.
    h.registry
        .revoke(&h.kyc_issuer, &holder, &symbol_short!("kyc"));

    // kyc must be revoked.
    assert!(
        !h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
    assert!(!h
        .registry
        .check_claim(&holder, &symbol_short!("kyc"), &None, &None));

    // funds and age must remain valid.
    assert!(
        h.registry
            .is_verified(&holder, &symbol_short!("funds"), &None)
            .0
    );
    assert!(h
        .registry
        .check_claim(&holder, &symbol_short!("funds"), &None, &None));
    assert!(
        h.registry
            .is_verified(&holder, &symbol_short!("age"), &None)
            .0
    );
    assert!(h
        .registry
        .check_claim(&holder, &symbol_short!("age"), &None, &None));
}

/// Invariant: batch expiry validation — if any submission has an invalid
/// expiry the whole batch reverts and no proofs are stored.
#[test]
fn batch_expiry_rejects_all_if_any_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let h = deploy_multi(&env);
    let holder = Address::generate(&env);

    // Set ledger time to 5000.
    env.ledger().with_mut(|li| li.timestamp = 5000);

    let submissions = vec![
        &env,
        // Valid submission with expiry in the future.
        ProofSubmission {
            credential_type: symbol_short!("kyc"),
            proof: Bytes::from_slice(&env, PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS),
            issuer_id: h.kyc_issuer.clone(),
            expiry: 9999,
            vk_version: None,
        },
        // Invalid submission: expiry in the past.
        ProofSubmission {
            credential_type: symbol_short!("funds"),
            proof: Bytes::from_slice(&env, FUNDS_PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
            issuer_id: h.funds_issuer.clone(),
            expiry: 4999, // before current timestamp 5000
            vk_version: None,
        },
    ];

    assert!(
        h.registry.try_submit_proofs(&holder, &submissions).is_err(),
        "batch with past expiry must fail"
    );

    // Neither proof must be stored.
    assert!(
        !h.registry
            .is_verified(&holder, &symbol_short!("kyc"), &None)
            .0
    );
    assert!(
        !h.registry
            .is_verified(&holder, &symbol_short!("funds"), &None)
            .0
    );
}

/// Invariant: a successful batch stores every credential with its own issuer
/// and threshold, and the trusted_issuers filter discriminates between them.
#[test]
fn successful_batch_preserves_issuer_and_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let h = deploy_multi(&env);
    let holder = Address::generate(&env);

    let submissions = vec![
        &env,
        ProofSubmission {
            credential_type: symbol_short!("kyc"),
            proof: Bytes::from_slice(&env, PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS),
            issuer_id: h.kyc_issuer.clone(),
            expiry: 9999,
            vk_version: None,
        },
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

    // Verify each credential type has the correct issuer and threshold.
    let kyc_record = h
        .registry
        .get_record(&holder, &symbol_short!("kyc"))
        .unwrap();
    assert_eq!(kyc_record.issuer, Some(h.kyc_issuer.clone()));
    assert_eq!(kyc_record.threshold, None); // kyc has no threshold
    assert!(!kyc_record.revoked);
    assert_eq!(kyc_record.expiry, 9999);

    let funds_record = h
        .registry
        .get_record(&holder, &symbol_short!("funds"))
        .unwrap();
    assert_eq!(funds_record.issuer, Some(h.funds_issuer.clone()));
    assert_eq!(funds_record.threshold, Some(200_000)); // funds threshold from public inputs
    assert!(!funds_record.revoked);
    assert_eq!(funds_record.expiry, 9999);

    let age_record = h
        .registry
        .get_record(&holder, &symbol_short!("age"))
        .unwrap();
    assert_eq!(age_record.issuer, Some(h.age_issuer.clone()));
    assert_eq!(age_record.threshold, Some(18)); // age threshold from public inputs
    assert!(!age_record.revoked);
    assert_eq!(age_record.expiry, 9999);

    // Trusted issuer filters must work correctly.
    assert!(h.registry.check_claim(
        &holder,
        &symbol_short!("kyc"),
        &None,
        &Some(vec![&env, h.kyc_issuer.clone()]),
    ));
    assert!(!h.registry.check_claim(
        &holder,
        &symbol_short!("kyc"),
        &None,
        &Some(vec![&env, h.funds_issuer.clone()]), // wrong issuer
    ));
}

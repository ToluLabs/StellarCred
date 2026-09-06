extern crate std;

use super::*;
use credential_verifier::{CredentialVerifier, CredentialVerifierClient};
use issuer_registry::{IssuerRegistry, IssuerRegistryClient};
use soroban_sdk::{
    symbol_short,

    testutils::{storage::Persistent as _, Address as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env,

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

// ── Per-app nullifier tests (anti-Sybil distribution) ───────────────────────

const AIRDROP_SCOPE: &[u8] = b"stellarcred:airdrop:humandrop-2026";

/// `sha256(commitment || AIRDROP_SCOPE)` for the KYC fixture, computed
/// independently of the contract. The SDK asserts the same vector in
/// `frontend/packages/sdk/src/airdrop.test.ts`.
const EXPECTED_NULLIFIER: [u8; 32] = [
    0xac, 0x90, 0xac, 0x63, 0xaa, 0xa9, 0x74, 0x62, 0xb9, 0xe7, 0x1a, 0x74, 0x68, 0x67, 0xb9, 0x59,
    0x35, 0x37, 0x19, 0x8d, 0x8a, 0x14, 0x06, 0x09, 0xad, 0x42, 0xfd, 0x1c, 0x9c, 0x93, 0xa0, 0x91,
];

#[test]
fn submit_records_the_identity_commitment() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    submit(&env, &h, &holder, 9999);

    let mut expected = [0u8; 32];
    expected.copy_from_slice(&PUBLIC_INPUTS[0..32]);
    assert_eq!(
        h.registry
            .identity_commitment(&holder, &symbol_short!("kyc"))
            .unwrap(),
        BytesN::from_array(&env, &expected),
    );
}

#[test]
fn app_nullifier_matches_the_expected_vector_and_is_wallet_independent() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let wallet_a = Address::generate(&env);
    let wallet_b = Address::generate(&env);
    submit(&env, &h, &wallet_a, 9999);
    submit(&env, &h, &wallet_b, 9999);

    let scope = Bytes::from_slice(&env, AIRDROP_SCOPE);
    let a = h
        .registry
        .app_nullifier(&wallet_a, &symbol_short!("kyc"), &scope, &None, &None)
        .unwrap();
    let b = h
        .registry
        .app_nullifier(&wallet_b, &symbol_short!("kyc"), &scope, &None, &None)
        .unwrap();

    assert_eq!(a, BytesN::from_array(&env, &EXPECTED_NULLIFIER));
    // One human, two wallets, one nullifier — the anti-Sybil property.
    assert_eq!(a, b);

    // A different scope yields an unlinkable value.
    let other = h
        .registry
        .app_nullifier(
            &wallet_a,
            &symbol_short!("kyc"),
            &Bytes::from_slice(&env, b"stellarcred:airdrop:other-2026"),
            &None,
            &None,
        )
        .unwrap();
    assert_ne!(a, other);
}

#[test]
fn app_nullifier_requires_a_currently_valid_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let scope = Bytes::from_slice(&env, AIRDROP_SCOPE);

    // Never submitted.
    assert!(h
        .registry
        .app_nullifier(&holder, &symbol_short!("kyc"), &scope, &None, &None)
        .is_none());

    submit(&env, &h, &holder, 1_000);
    assert!(h
        .registry
        .app_nullifier(&holder, &symbol_short!("kyc"), &scope, &None, &None)
        .is_some());

    // Issuer-restricted to somebody else.
    let stranger = Address::generate(&env);
    assert!(h
        .registry
        .app_nullifier(
            &holder,
            &symbol_short!("kyc"),
            &scope,
            &None,
            &Some(vec![&env, stranger]),
        )
        .is_none());

    // Revoked by the issuer.
    h.registry.revoke(&h.issuer, &holder, &symbol_short!("kyc"));
    assert!(h
        .registry
        .app_nullifier(&holder, &symbol_short!("kyc"), &scope, &None, &None)
        .is_none());

    // Expired.
    submit(&env, &h, &holder, 1_000);
    env.ledger().set_timestamp(2_000);
    assert!(h
        .registry
        .app_nullifier(&holder, &symbol_short!("kyc"), &scope, &None, &None)
        .is_none());
}

#[test]
fn holder_revocation_clears_the_recorded_commitment() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    submit(&env, &h, &holder, 9999);

    h.registry.revoke_proof(&holder, &symbol_short!("kyc"));
    assert!(h
        .registry
        .identity_commitment(&holder, &symbol_short!("kyc"))
        .is_none());
    assert!(h
        .registry
        .app_nullifier(
            &holder,
            &symbol_short!("kyc"),
            &Bytes::from_slice(&env, AIRDROP_SCOPE),
            &None,
            &None,
        )
        .is_none());
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

#![cfg(test)]

extern crate std;

use super::*;
use credential_verifier::{CredentialVerifier, CredentialVerifierClient};
use issuer_registry::{IssuerRegistry, IssuerRegistryClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    vec, Address, BytesN, Bytes, Env, IntoVal,
};

// Real UltraHonk artifacts (kyc_proof circuit, Noir beta.9 + bb 0.87.0), so
// submit_proof exercises genuine on-chain verification through the verifier.
const VK: &[u8] = include_bytes!("../../../fixtures/kyc/vk");
const PROOF: &[u8] = include_bytes!("../../../fixtures/kyc/proof");
const PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/kyc/public_inputs");

// funds_proof fixture: proves balance >= 200_000 (threshold stored in public inputs).
const FUNDS_VK: &[u8] = include_bytes!("../../../fixtures/funds/vk");
const FUNDS_PROOF: &[u8] = include_bytes!("../../../fixtures/funds/proof");
const FUNDS_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/funds/public_inputs");

// age_proof fixture: proves age >= 18 years (threshold_years in public inputs).
const AGE_VK: &[u8] = include_bytes!("../../../fixtures/age/vk");
const AGE_PROOF: &[u8] = include_bytes!("../../../fixtures/age/proof");
const AGE_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/age/public_inputs");


// Extract the issuer secp256k1 key (x || y) from any fixture's public inputs
// (fields 1..65, low byte of each 32-byte field).
fn pubkey_from(env: &Env, public_inputs: &[u8]) -> BytesN<64> {
    let mut arr = [0u8; 64];
    for i in 0..64usize {
        arr[i] = public_inputs[(1 + i) * 32 + 31];
    }
    BytesN::from_array(env, &arr)
}

fn demo_pubkey(env: &Env) -> BytesN<64> {
    pubkey_from(env, PUBLIC_INPUTS)
}

fn u8_slice_to_vec_u32(env: &Env, slice: &[u8]) -> Vec<u32> {
    let mut vec = Vec::new(env);
    for i in (0..slice.len()).step_by(4) {
        if i + 4 <= slice.len() {
            let mut chunk = [0u8; 4];
            chunk.copy_from_slice(&slice[i..i+4]);
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
    issuer: Address,
    admin: Address,
}

fn deploy(env: &Env) -> Harness {
    let admin = Address::generate(env);

    // IssuerRegistry with one issuer trusted for kyc.
    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(env, &ir_id);
    let issuer = Address::generate(env);
    ir.register_issuer(
        &issuer,
        &demo_pubkey(env),
        &vec![env, symbol_short!("kyc")],
    );

    // CredentialVerifier with the kyc VK.
    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(env, &v_id)
        .set_vk(&symbol_short!("kyc"), &Bytes::from_slice(env, VK));

    let pr_id = env.register(ProofRegistry, (admin.clone(), v_id, ir_id));
    Harness {
        registry: ProofRegistryClient::new(env, &pr_id),
        registry_id: pr_id,
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
        &expiry,
    );
}

#[test]
fn submit_then_verified() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    let (valid, _at, expiry) = h.registry.is_verified(&holder, &symbol_short!("kyc"));
    assert!(valid);
    assert_eq!(expiry, 1000);
}

#[test]
fn expires_after_ledger_time_passes() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000); // valid until ts=1000
    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc")).0);

    // Advance ledger time past the expiry.
    env.ledger().with_mut(|li| li.timestamp = 2000);
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
}

#[test]
fn rejects_wrong_issuer_key() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    // Register the issuer with a DIFFERENT key than the one the proof was signed
    // with, so the public-input pubkey will not match.
    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let issuer = Address::generate(&env);
    IssuerRegistryClient::new(&env, &ir_id).register_issuer(
        &issuer,
        &BytesN::from_array(&env, &[3u8; 64]),
        &vec![&env, symbol_short!("kyc")],
    );
    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(&env, &v_id)
        .set_vk(&symbol_short!("kyc"), &Bytes::from_slice(&env, VK));
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);

    let holder = Address::generate(&env);
    let res = registry.try_submit_proof(
        &holder,
        &issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &1000,
    );
    assert!(res.is_err());
    assert!(!registry.is_verified(&holder, &symbol_short!("kyc")).0);
}

#[test]
fn rejects_untrusted_issuer() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let stranger = Address::generate(&env); // not registered

    let res = h.registry.try_submit_proof(
        &holder,
        &stranger,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &1000,
    );
    assert!(res.is_err());
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
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
        &1000,
    );
    assert!(res.is_err());
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
}

#[test]
fn unverified_holder_returns_false() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let stranger = Address::generate(&env);
    assert!(!h.registry.is_verified(&stranger, &symbol_short!("kyc")).0);
}

#[test]
fn revoke_clears_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    h.registry.revoke_proof(&holder, &symbol_short!("kyc"));
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
}

#[test]
fn issuer_revoke_invalidates_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
    assert!(h.registry.check_claim(&holder, &symbol_short!("kyc"), &None));

    h.registry.revoke(&h.issuer, &holder, &symbol_short!("kyc"));

    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
    assert!(!h.registry.check_claim(&holder, &symbol_short!("kyc"), &None));
    // Expiry data preserved for audit even though proof is no longer valid.
    let (_valid, _at, expiry) = h.registry.is_verified(&holder, &symbol_short!("kyc"));
    assert_eq!(expiry, 1000);
}

#[test]
fn issuer_revoke_rejects_wrong_issuer() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let stranger = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    let res = h.registry.try_revoke(&stranger, &holder, &symbol_short!("kyc"));
    assert!(res.is_err());
    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
}

#[test]
fn issuer_revoke_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    h.registry.revoke(&h.issuer, &holder, &symbol_short!("kyc"));

    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                h.registry_id.clone(),
                (symbol_short!("revoked"),).into_val(&env),
                (
                    holder.clone(),
                    symbol_short!("kyc"),
                    h.issuer.clone(),
                    env.ledger().timestamp()
                )
                    .into_val(&env),
            ),
        ],
    );
}

// ── check_claim / threshold tests ────────────────────────────────────────────

#[test]
fn check_claim_no_threshold_matches_is_verified() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    // check_claim with no min_threshold should behave like is_verified.
    assert!(h.registry.check_claim(&holder, &symbol_short!("kyc"), &None));
}

#[test]
fn funds_threshold_stored_and_checked() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    // Wire up a fresh harness for the funds credential type.
    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);
    let issuer = Address::generate(&env);
    ir.register_issuer(
        &issuer,
        &pubkey_from(&env, FUNDS_PUBLIC_INPUTS),
        &vec![&env, symbol_short!("funds")],
    );
    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(&env, &v_id)
        .set_vk(&symbol_short!("funds"), &Bytes::from_slice(&env, FUNDS_VK));
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    // funds fixture proves balance >= 200_000.
    registry.submit_proof(
        &holder,
        &issuer,
        &symbol_short!("funds"),
        &Bytes::from_slice(&env, FUNDS_PROOF),
        &Bytes::from_slice(&env, FUNDS_PUBLIC_INPUTS),
        &9999,
    );

    // A protocol requiring <= the proved threshold passes.
    assert!(registry.check_claim(&holder, &symbol_short!("funds"), &Some(200_000)));
    assert!(registry.check_claim(&holder, &symbol_short!("funds"), &Some(50_000)));
    assert!(registry.check_claim(&holder, &symbol_short!("funds"), &None));

    // A protocol requiring MORE than was proved fails.
    assert!(!registry.check_claim(&holder, &symbol_short!("funds"), &Some(250_000)));
}

#[test]
fn age_threshold_stored_and_checked() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);
    let issuer = Address::generate(&env);
    ir.register_issuer(
        &issuer,
        &pubkey_from(&env, AGE_PUBLIC_INPUTS),
        &vec![&env, symbol_short!("age")],
    );
    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(&env, &v_id)
        .set_vk(&symbol_short!("age"), &Bytes::from_slice(&env, AGE_VK));
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    // age fixture proves age >= 18.
    registry.submit_proof(
        &holder,
        &issuer,
        &symbol_short!("age"),
        &Bytes::from_slice(&env, AGE_PROOF),
        &Bytes::from_slice(&env, AGE_PUBLIC_INPUTS),
        &9999,
    );

    // Protocols requiring <= 18 pass.
    assert!(registry.check_claim(&holder, &symbol_short!("age"), &Some(18)));
    assert!(registry.check_claim(&holder, &symbol_short!("age"), &Some(16)));

    // A protocol requiring age >= 21 fails — the proof only covers >= 18.
    assert!(!registry.check_claim(&holder, &symbol_short!("age"), &Some(21)));
}

// ── submit_proofs_batch tests ─────────────────────────────────────────────────

/// Helper: build a ProofSubmission for the kyc fixture.
fn kyc_submission(env: &Env, issuer: &Address, expiry: u64) -> ProofSubmission {
    ProofSubmission {
        credential_type: symbol_short!("kyc"),
        proof: Bytes::from_slice(env, PROOF),
        public_inputs: u8_slice_to_vec_u32(env, PUBLIC_INPUTS),
        issuer_id: issuer.clone(),
        expiry,
    }
}

/// Deploy a harness that registers a single issuer for all three credential
/// types (kyc, funds, age) with the correct keys, and registers all three VKs
/// in the verifier. Used by batch tests that need multiple credential types.
struct MultiHarness {
    registry: ProofRegistryClient<'static>,
    kyc_issuer: Address,
    funds_issuer: Address,
    age_issuer: Address,
    admin: Address,
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
    vc.set_vk(&symbol_short!("kyc"), &Bytes::from_slice(env, VK));
    vc.set_vk(&symbol_short!("funds"), &Bytes::from_slice(env, FUNDS_VK));
    vc.set_vk(&symbol_short!("age"), &Bytes::from_slice(env, AGE_VK));

    let pr_id = env.register(ProofRegistry, (admin.clone(), v_id, ir_id));
    MultiHarness {
        registry: ProofRegistryClient::new(env, &pr_id),
        kyc_issuer,
        funds_issuer,
        age_issuer,
        admin,
    }
}

/// All proofs in the batch are valid — every credential should be stored.
#[test]
fn batch_all_pass() {
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
        },
        ProofSubmission {
            credential_type: symbol_short!("funds"),
            proof: Bytes::from_slice(&env, FUNDS_PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
            issuer_id: h.funds_issuer.clone(),
            expiry: 9999,
        },
        ProofSubmission {
            credential_type: symbol_short!("age"),
            proof: Bytes::from_slice(&env, AGE_PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, AGE_PUBLIC_INPUTS),
            issuer_id: h.age_issuer.clone(),
            expiry: 9999,
        },
    ];

    h.registry.submit_proofs_batch(&holder, &submissions);

    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
    assert!(h.registry.is_verified(&holder, &symbol_short!("funds")).0);
    assert!(h.registry.is_verified(&holder, &symbol_short!("age")).0);
}

/// If one proof in the batch is invalid, the entire call reverts.
/// Nothing should be stored for any credential.
#[test]
fn batch_one_fail_reverts_all() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let h = deploy_multi(&env);
    let holder = Address::generate(&env);

    // Corrupt the funds proof so it will fail verification.
    let mut bad_funds = FUNDS_PROOF.to_vec();
    bad_funds[5000] ^= 0xff;

    let submissions = vec![
        &env,
        ProofSubmission {
            credential_type: symbol_short!("kyc"),
            proof: Bytes::from_slice(&env, PROOF),
            public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS),
            issuer_id: h.kyc_issuer.clone(),
            expiry: 9999,
        },
        ProofSubmission {
            credential_type: symbol_short!("funds"),
            proof: Bytes::from_slice(&env, &bad_funds),
            public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
            issuer_id: h.funds_issuer.clone(),
            expiry: 9999,
        },
    ];

    let res = h.registry.try_submit_proofs_batch(&holder, &submissions);
    assert!(res.is_err());

    // The valid kyc proof must NOT have been stored because the batch reverted.
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
    assert!(!h.registry.is_verified(&holder, &symbol_short!("funds")).0);
}

/// Exactly MAX_BATCH_SIZE (5) submissions — should succeed.
/// Uses 5 distinct credential types to satisfy the duplicate-type guard.
#[test]
fn batch_max_size_boundary_accepts_five() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    // Five distinct symbols — same kyc proof/VK reused for all of them.
    let types = [
        symbol_short!("kyc"),
        symbol_short!("funds"),
        symbol_short!("age"),
        symbol_short!("income"),
        symbol_short!("juris"),
    ];

    let admin = Address::generate(&env);
    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);
    let issuer = Address::generate(&env);
    // Register issuer for all 5 types in a single call (repeated calls overwrite).
    ir.register_issuer(
        &issuer,
        &pubkey_from(&env, PUBLIC_INPUTS),
        &vec![&env, types[0].clone(), types[1].clone(), types[2].clone(), types[3].clone(), types[4].clone()],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    let vc = CredentialVerifierClient::new(&env, &v_id);
    // Register the kyc VK under all 5 type symbols.
    for t in types.iter() {
        vc.set_vk(t, &Bytes::from_slice(&env, VK));
    }

    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    // Build a batch of exactly 5 submissions, each with a unique type.
    let submissions = vec![
        &env,
        ProofSubmission { credential_type: types[0].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999 },
        ProofSubmission { credential_type: types[1].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999 },
        ProofSubmission { credential_type: types[2].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999 },
        ProofSubmission { credential_type: types[3].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999 },
        ProofSubmission { credential_type: types[4].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999 },
    ];

    // Must not panic — 5 distinct types is within the allowed maximum.
    registry.submit_proofs_batch(&holder, &submissions);
    assert!(registry.is_verified(&holder, &types[0]).0);
    assert!(registry.is_verified(&holder, &types[4]).0);
}



/// Six submissions must be rejected with BatchTooLarge.
#[test]
fn batch_exceeds_max_size_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);
    let issuer = Address::generate(&env);
    ir.register_issuer(
        &issuer,
        &pubkey_from(&env, PUBLIC_INPUTS),
        &vec![&env, symbol_short!("kyc")],
    );
    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(&env, &v_id)
        .set_vk(&symbol_short!("kyc"), &Bytes::from_slice(&env, VK));
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    let sub = kyc_submission(&env, &issuer, 9999);
    let submissions = vec![
        &env,
        sub.clone(),
        sub.clone(),
        sub.clone(),
        sub.clone(),
        sub.clone(),
        sub,
    ];

    let res = registry.try_submit_proofs_batch(&holder, &submissions);
    assert!(res.is_err());
}

/// An empty batch must be rejected with BatchEmpty.
#[test]
fn batch_empty_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    let submissions: Vec<ProofSubmission> = Vec::new(&env);
    let res = registry.try_submit_proofs_batch(&holder, &submissions);
    assert!(res.is_err());
}

/// A batch with two entries sharing the same credential_type must be rejected.
#[test]
fn batch_duplicate_credential_type_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let sub = kyc_submission(&env, &h.issuer, 9999);
    // Two identical kyc entries — second would silently overwrite the first.
    let submissions = vec![&env, sub.clone(), sub];

    let res = h.registry.try_submit_proofs_batch(&holder, &submissions);
    assert!(res.is_err());
}

#[test]
fn upgrade_by_admin_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    
    let real_wasm = get_test_wasm(&env);
    let new_wasm_hash = env.deployer().upload_contract_wasm(real_wasm);
    
    h.registry.upgrade(&new_wasm_hash);
}

#[test]
fn upgrade_by_non_admin_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    
    let real_wasm = get_test_wasm(&env);
    let new_wasm_hash = env.deployer().upload_contract_wasm(real_wasm);
    
    let res = h.registry
        .mock_auths(&[])
        .try_upgrade(&new_wasm_hash);
    assert!(res.is_err());
}

#[test]
fn admin_transfer_works() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    
    let new_admin = Address::generate(&env);
    
    h.registry.set_admin(&new_admin);
    assert_eq!(h.registry.admin(), new_admin);
    
    let real_wasm = get_test_wasm(&env);
    let new_wasm_hash = env.deployer().upload_contract_wasm(real_wasm);
    
    // 1. Verify old admin (h.admin) can no longer upgrade:
    let res = h.registry
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

    // 2. Verify new admin can successfully upgrade:
    h.registry
        .mock_auths(&[MockAuth {
            address: &new_admin,
            invoke: &MockAuthInvoke {
                contract: &h.registry.address,
                fn_name: "upgrade",
                args: (&new_wasm_hash,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .upgrade(&new_wasm_hash);
}

#[test]
fn set_admin_by_non_admin_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let new_admin = Address::generate(&env);
    let res = h.registry
        .mock_auths(&[])
        .try_set_admin(&new_admin);
    assert!(res.is_err());
}

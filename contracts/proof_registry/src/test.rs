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
use proptest::prelude::*;

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

// Real N=2 aggregate proof (KYC + age) from the aggregate_proof circuit —
// generated via ./circuits/scripts/build.sh aggregate_proof. The inner
// credentials are signed by the demo issuer key, so the same issuer must be
// registered for both "kyc" and "age".
const AGGREGATE_VK: &[u8] = include_bytes!("../../../fixtures/aggregate/vk");
const AGGREGATE_PROOF: &[u8] = include_bytes!("../../../fixtures/aggregate/proof");
const AGGREGATE_PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/aggregate/public_inputs");

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Extract the issuer secp256k1 key from public inputs at a given field offset.
fn pubkey_from_offset(env: &Env, public_inputs: &[u8], start_field: u32) -> BytesN<64> {
    let mut arr = [0u8; 64];
    for i in 0..64usize {
        arr[i] = public_inputs[(start_field as usize + i) * 32 + 31];
    }
    BytesN::from_array(env, &arr)
}

/// Extract the issuer key from the standard single-proof layout (fields 1..65).
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
    issuer: Address,
    admin: Address,
}

fn deploy(env: &Env) -> Harness {
    let admin = Address::generate(env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(env, &ir_id);
    let issuer = Address::generate(env);
    ir.register_issuer(
        &issuer,
        &demo_pubkey(env),
        &vec![env, symbol_short!("kyc")],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(env, &v_id)
        .set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(env, VK));

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
        &None,
        &expiry,
    );
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

    submit(&env, &h, &holder, 1000);

    let (valid, _at, expiry) = h.registry.is_verified(&holder, &symbol_short!("kyc"), &None);
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
    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);

    env.ledger().with_mut(|li| li.timestamp = 2000);
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
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
    CredentialVerifierClient::new(&env, &v_id)
        .set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(&env, VK));
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
        &1000,
    );
    assert!(res.is_err());
    assert!(!registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
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
        &1000,
    );
    assert!(res.is_err());
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
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
        &1000,
    );
    assert!(res.is_err());
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
}

#[test]
fn unverified_holder_returns_false() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let stranger = Address::generate(&env);
    assert!(!h.registry.is_verified(&stranger, &symbol_short!("kyc"), &None).0);
}

#[test]
fn revoke_clears_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    h.registry.revoke_proof(&holder, &symbol_short!("kyc"));
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
}

#[test]
fn issuer_revoke_invalidates_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
    assert!(h.registry.check_claim(&holder, &symbol_short!("kyc"), &None, &None));

    h.registry.revoke(&h.issuer, &holder, &symbol_short!("kyc"));

    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
    assert!(!h.registry.check_claim(&holder, &symbol_short!("kyc"), &None, &None));
    // Expiry data preserved for audit even though proof is no longer valid.
    let (_valid, _at, expiry) = h.registry.is_verified(&holder, &symbol_short!("kyc"), &None);
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
    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
}

#[test]
fn issuer_revoke_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    // Assert the submitted event immediately after submit — the snapshot
    // framework drains env.events().all() after each contract invocation.
    submit(&env, &h, &holder, 1000);
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
                    issuer: h.issuer.clone(),
                    verified_at: env.ledger().timestamp(),
                    expiry: 1000,
                }
                .into_val(&env),
            ),
        ],
    );

    // Assert the revoked event immediately after revoke.
    h.registry.revoke(&h.issuer, &holder, &symbol_short!("kyc"));
    assert_eq!(
        env.events().all().filter_by_contract(&h.registry.address),
        vec![
            &env,
            (
                h.registry.address.clone(),
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("revoked"),
                    symbol_short!("kyc"),
                )
                    .into_val(&env),
                EventProofRevoked {
                    holder: holder.clone(),
                    issuer: h.issuer.clone(),
                    revoked_at: env.ledger().timestamp(),
                }
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
    assert!(h.registry.check_claim(&holder, &symbol_short!("kyc"), &None, &None));
}

// ── trusted_issuers tests ────────────────────────────────────────────────────

#[test]
fn check_claim_trusted_issuer_accepted() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let other_issuer = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    // The proof's issuer (h.issuer) is in the trusted list — accepted.
    assert!(h.registry.check_claim(
        &holder,
        &symbol_short!("kyc"),
        &None,
        &Some(vec![&env, h.issuer.clone(), other_issuer]),
    ));
}

#[test]
fn check_claim_untrusted_issuer_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let other_issuer = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    // The proof's issuer (h.issuer) is NOT in the trusted list — rejected, even
    // though the proof itself is otherwise valid and unexpired.
    assert!(!h.registry.check_claim(
        &holder,
        &symbol_short!("kyc"),
        &None,
        &Some(vec![&env, other_issuer]),
    ));
}

#[test]
fn check_claim_empty_trusted_list_rejects_all() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    // An empty Some([]) list has no members to match against — rejects every
    // issuer, including the one that actually signed the proof.
    let empty: Vec<Address> = Vec::new(&env);
    assert!(!h.registry.check_claim(
        &holder,
        &symbol_short!("kyc"),
        &None,
        &Some(empty),
    ));
}

#[test]
fn is_verified_trusted_issuer_accepted() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    let (valid, _at, expiry) = h.registry.is_verified(
        &holder,
        &symbol_short!("kyc"),
        &Some(vec![&env, h.issuer.clone()]),
    );
    assert!(valid);
    assert_eq!(expiry, 1000);
}

#[test]
fn is_verified_untrusted_issuer_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let other_issuer = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    // Rejected for validity, but verified_at/expiry are still returned for
    // audit — matching the existing revoked/expired behaviour.
    let (valid, _at, expiry) = h.registry.is_verified(
        &holder,
        &symbol_short!("kyc"),
        &Some(vec![&env, other_issuer]),
    );
    assert!(!valid);
    assert_eq!(expiry, 1000);
}

#[test]
fn check_claim_trusted_issuer_combines_with_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

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
        .set_vk(&symbol_short!("funds"), &1u32, &Bytes::from_slice(&env, FUNDS_VK));
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);
    let other_issuer = Address::generate(&env);

    registry.submit_proof(
        &holder,
        &issuer,
        &symbol_short!("funds"),
        &Bytes::from_slice(&env, FUNDS_PROOF),
        &Bytes::from_slice(&env, FUNDS_PUBLIC_INPUTS),
        &None,
        &9999,
    );

    // Trusted issuer + satisfied threshold — passes.
    assert!(registry.check_claim(
        &holder,
        &symbol_short!("funds"),
        &Some(50_000),
        &Some(vec![&env, issuer.clone()]),
    ));
    // Trusted issuer but unsatisfied threshold — fails.
    assert!(!registry.check_claim(
        &holder,
        &symbol_short!("funds"),
        &Some(250_000),
        &Some(vec![&env, issuer.clone()]),
    ));
    // Untrusted issuer, even with a satisfied threshold — fails.
    assert!(!registry.check_claim(
        &holder,
        &symbol_short!("funds"),
        &Some(50_000),
        &Some(vec![&env, other_issuer]),
    ));
}

#[test]
fn funds_threshold_stored_and_checked() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

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
        .set_vk(&symbol_short!("funds"), &1u32, &Bytes::from_slice(&env, FUNDS_VK));
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    registry.submit_proof(
        &holder,
        &issuer,
        &symbol_short!("funds"),
        &Bytes::from_slice(&env, FUNDS_PROOF),
        &Bytes::from_slice(&env, FUNDS_PUBLIC_INPUTS),
        &None,
        &9999,
    );

    // A protocol requiring <= the proved threshold passes.
    assert!(registry.check_claim(&holder, &symbol_short!("funds"), &Some(200_000), &None));
    assert!(registry.check_claim(&holder, &symbol_short!("funds"), &Some(50_000), &None));
    assert!(registry.check_claim(&holder, &symbol_short!("funds"), &None, &None));

    // A protocol requiring MORE than was proved fails.
    assert!(!registry.check_claim(&holder, &symbol_short!("funds"), &Some(250_000), &None));
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
        .set_vk(&symbol_short!("age"), &1u32, &Bytes::from_slice(&env, AGE_VK));
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    registry.submit_proof(
        &holder,
        &issuer,
        &symbol_short!("age"),
        &Bytes::from_slice(&env, AGE_PROOF),
        &Bytes::from_slice(&env, AGE_PUBLIC_INPUTS),
        &None,
        &9999,
    );

    // Protocols requiring <= 18 pass.
    assert!(registry.check_claim(&holder, &symbol_short!("age"), &Some(18), &None));
    assert!(registry.check_claim(&holder, &symbol_short!("age"), &Some(16), &None));

    // A protocol requiring age >= 21 fails — the proof only covers >= 18.
    assert!(!registry.check_claim(&holder, &symbol_short!("age"), &Some(21), &None));
}

// ── check_claim property & boundary fuzz tests (Issue #26) ───────────────────

use proptest::prelude::*;

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
        env.storage().persistent().extend_ttl(&key, 17280, 17280 * 90);
    });
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    #[test]
    fn prop_check_claim_stored_ge_required_returns_true(
        required in any::<u64>(),
        offset in any::<u64>(),
    ) {
        // Generate stored >= required via saturating add to cover entire u64 space without overflow
        let stored = required.saturating_add(offset);

        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let cred = symbol_short!("funds");

        let record = ProofRecord {
            verified_at: 100,
            expiry: 1000,
            threshold: Some(stored),
            revoked: false,
            issuer: None,
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        let res = client.check_claim(&holder, &cred, &Some(required), &None);
        prop_assert!(res);
    }

    #[test]
    fn prop_check_claim_stored_lt_required_returns_false(
        required in 1..=u64::MAX,
        delta in 1..=u64::MAX,
    ) {
        // Generate stored < required
        let diff = (delta % required).max(1);
        let stored = required - diff;

        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let cred = symbol_short!("funds");

        let record = ProofRecord {
            verified_at: 100,
            expiry: 1000,
            threshold: Some(stored),
            revoked: false,
            issuer: None,
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        let res = client.check_claim(&holder, &cred, &Some(required), &None);
        prop_assert!(!res);
    }

    #[test]
    fn prop_check_claim_none_required_returns_true_for_valid_proof(
        stored in prop::option::of(any::<u64>()),
    ) {
        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let cred = symbol_short!("kyc");

        let record = ProofRecord {
            verified_at: 100,
            expiry: 1000,
            threshold: stored,
            revoked: false,
            issuer: None,
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        let res = client.check_claim(&holder, &cred, &None, &None);
        prop_assert!(res);
    }

    #[test]
    fn prop_check_claim_expired_or_revoked_always_returns_false(
        stored in prop::option::of(any::<u64>()),
        required in prop::option::of(any::<u64>()),
        revoked in any::<bool>(),
        expired in any::<bool>(),
    ) {
        if !revoked && !expired {
            return Ok(());
        }

        let env = Env::default();
        let (client, reg_id) = deploy_registry(&env);
        let holder = Address::generate(&env);
        let cred = symbol_short!("funds");

        let expiry = if expired { env.ledger().timestamp() } else { env.ledger().timestamp() + 1000 };

        let record = ProofRecord {
            verified_at: 100,
            expiry,
            threshold: stored,
            revoked,
            issuer: None,
            vk_version: 0,
        };
        set_proof_record(&env, &reg_id, &holder, &cred, &record);

        let res = client.check_claim(&holder, &cred, &required, &None);
        prop_assert!(!res);
    }
}

#[test]
fn check_claim_boundary_values_exhaustive() {
    let env = Env::default();
    let (client, reg_id) = deploy_registry(&env);
    let cred = symbol_short!("funds");

    let boundaries = [0, 1, 2, u64::MAX / 2, u64::MAX - 1, u64::MAX];

    for &req in &boundaries {
        // Test exact match (stored == req) -> true
        {
            let holder = Address::generate(&env);
            let record = ProofRecord {
                verified_at: 100,
                expiry: 1000,
                threshold: Some(req),
                revoked: false,
                issuer: None,
                vk_version: 0,
            };
            set_proof_record(&env, &reg_id, &holder, &cred, &record);
            assert!(
                client.check_claim(&holder, &cred, &Some(req), &None),
                "Failed boundary stored == req for req={}", req
            );
        }

        // Test stored == req + 1 (if req < u64::MAX) -> true
        if req < u64::MAX {
            let stored = req + 1;
            let holder = Address::generate(&env);
            let record = ProofRecord {
                verified_at: 100,
                expiry: 1000,
                threshold: Some(stored),
                revoked: false,
                issuer: None,
                vk_version: 0,
            };
            set_proof_record(&env, &reg_id, &holder, &cred, &record);
            assert!(
                client.check_claim(&holder, &cred, &Some(req), &None),
                "Failed boundary stored == req + 1 for req={}", req
            );
        }

        // Test stored == req - 1 (if req > 0) -> false
        if req > 0 {
            let stored = req - 1;
            let holder = Address::generate(&env);
            let record = ProofRecord {
                verified_at: 100,
                expiry: 1000,
                threshold: Some(stored),
                revoked: false,
                issuer: None,
                vk_version: 0,
            };
            set_proof_record(&env, &reg_id, &holder, &cred, &record);
            assert!(
                !client.check_claim(&holder, &cred, &Some(req), &None),
                "Failed boundary stored == req - 1 for req={}", req
            );
        }
    }
}

#[test]
fn check_claim_stored_none_with_required_threshold() {
    let env = Env::default();
    let (client, reg_id) = deploy_registry(&env);
    let cred = symbol_short!("kyc");
    let holder1 = Address::generate(&env);
    let record1 = ProofRecord {
        verified_at: 100,
        expiry: 1000,
        threshold: None, // e.g. KYC proof without numeric threshold
        revoked: false,
        issuer: None,
        vk_version: 0,
    };
    set_proof_record(&env, &reg_id, &holder1, &cred, &record1);

    // None threshold defaults to 0 in unwrap_or(0).
    // So Some(0) returns true (0 >= 0), while Some(1) returns false (0 < 1).
    assert!(client.check_claim(&holder1, &cred, &Some(0), &None));
    assert!(!client.check_claim(&holder1, &cred, &Some(1), &None));
    assert!(!client.check_claim(&holder1, &cred, &Some(u64::MAX), &None));
}

// -- claim_expiry tests -----------------------------------------------------

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
    vc.set_vk(&symbol_short!("funds"), &1u32, &Bytes::from_slice(env, FUNDS_VK));
    vc.set_vk(&symbol_short!("age"), &1u32, &Bytes::from_slice(env, AGE_VK));

    let pr_id = env.register(ProofRegistry, (admin.clone(), v_id, ir_id));
    MultiHarness {
        registry: ProofRegistryClient::new(env, &pr_id),
        kyc_issuer,
        funds_issuer,
        age_issuer,
    }
}

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

    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
    assert!(h.registry.is_verified(&holder, &symbol_short!("funds"), &None).0);
    assert!(h.registry.is_verified(&holder, &symbol_short!("age"), &None).0);
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
            proof: Bytes::from_slice(&env, &bad_funds),
            public_inputs: u8_slice_to_vec_u32(&env, FUNDS_PUBLIC_INPUTS),
            issuer_id: h.funds_issuer.clone(),
            expiry: 9999,
            vk_version: None,
        },
    ];

    let res = h.registry.try_submit_proofs(&holder, &submissions);
    assert!(res.is_err());

    // The valid kyc proof must NOT have been stored because the batch reverted.
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
    assert!(!h.registry.is_verified(&holder, &symbol_short!("funds"), &None).0);
}

#[test]
fn batch_max_size_boundary_accepts_five() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
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
    ir.register_issuer(
        &issuer,
        &pubkey_from(&env, PUBLIC_INPUTS),
        &vec![&env, types[0].clone(), types[1].clone(), types[2].clone(), types[3].clone(), types[4].clone()],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    let vc = CredentialVerifierClient::new(&env, &v_id);
    for t in types.iter() {
        vc.set_vk(t, &1u32, &Bytes::from_slice(&env, VK));
    }

    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    let submissions = vec![
        &env,
        ProofSubmission { credential_type: types[0].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999, vk_version: None },
        ProofSubmission { credential_type: types[1].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999, vk_version: None },
        ProofSubmission { credential_type: types[2].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999, vk_version: None },
        ProofSubmission { credential_type: types[3].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999, vk_version: None },
        ProofSubmission { credential_type: types[4].clone(), proof: Bytes::from_slice(&env, PROOF), public_inputs: u8_slice_to_vec_u32(&env, PUBLIC_INPUTS), issuer_id: issuer.clone(), expiry: 9999, vk_version: None },
    ];

    // Must not panic — 5 distinct types is within the allowed maximum.
    registry.submit_proofs(&holder, &submissions);
    assert!(registry.is_verified(&holder, &types[0], &None).0);
    assert!(registry.is_verified(&holder, &types[4], &None).0);
}

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
        .set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(&env, VK));
    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    let sub = kyc_submission(&env, &issuer, 9999);
    let submissions = vec![
        &env, sub.clone(), sub.clone(), sub.clone(), sub.clone(), sub.clone(), sub,
    ];

    let res = registry.try_submit_proofs(&holder, &submissions);
    assert!(res.is_err());
}

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
    let res = registry.try_submit_proofs(&holder, &submissions);
    assert!(res.is_err());
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

// ── revoke_all tests ──────────────────────────────────────────────────────────

#[test]
fn revoke_all_clears_submitted_proofs() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);

    let kyc_issuer = Address::generate(&env);
    ir.register_issuer(
        &kyc_issuer,
        &pubkey_from(&env, PUBLIC_INPUTS),
        &vec![&env, symbol_short!("kyc")],
    );
    let funds_issuer = Address::generate(&env);
    ir.register_issuer(
        &funds_issuer,
        &pubkey_from(&env, FUNDS_PUBLIC_INPUTS),
        &vec![&env, symbol_short!("funds")],
    );
    let age_issuer = Address::generate(&env);
    ir.register_issuer(
        &age_issuer,
        &pubkey_from(&env, AGE_PUBLIC_INPUTS),
        &vec![&env, symbol_short!("age")],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    let vc = CredentialVerifierClient::new(&env, &v_id);
    vc.set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(&env, VK));
    vc.set_vk(&symbol_short!("funds"), &1u32, &Bytes::from_slice(&env, FUNDS_VK));
    vc.set_vk(&symbol_short!("age"), &1u32, &Bytes::from_slice(&env, AGE_VK));

    let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
    let registry = ProofRegistryClient::new(&env, &pr_id);
    let holder = Address::generate(&env);

    registry.submit_proof(
        &holder,
        &kyc_issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &9999,
    );
    registry.submit_proof(
        &holder,
        &funds_issuer,
        &symbol_short!("funds"),
        &Bytes::from_slice(&env, FUNDS_PROOF),
        &Bytes::from_slice(&env, FUNDS_PUBLIC_INPUTS),
        &None,
        &9999,
    );
    registry.submit_proof(
        &holder,
        &age_issuer,
        &symbol_short!("age"),
        &Bytes::from_slice(&env, AGE_PROOF),
        &Bytes::from_slice(&env, AGE_PUBLIC_INPUTS),
        &None,
        &9999,
    );

    assert!(registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
    assert!(registry.is_verified(&holder, &symbol_short!("funds"), &None).0);
    assert!(registry.is_verified(&holder, &symbol_short!("age"), &None).0);

    registry.revoke_all(&holder);

    assert!(!registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
    assert!(!registry.is_verified(&holder, &symbol_short!("funds"), &None).0);
    assert!(!registry.is_verified(&holder, &symbol_short!("age"), &None).0);
}

// ── Aggregate proof tests ─────────────────────────────────────────────────────

/// Submits a REAL N=2 aggregate proof (KYC + age) generated by the
/// aggregate_proof circuit and verifies both claims are stored atomically,
/// with the age threshold extracted from the aggregate layout.
#[test]
fn aggregate_submits_real_proof_and_stores_claims() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let ir = IssuerRegistryClient::new(&env, &ir_id);

    // The aggregate circuit's inner credentials are both signed by the demo
    // issuer key, so one issuer trusted for kyc + age suffices.
    let issuer = Address::generate(&env);
    ir.register_issuer(
        &issuer,
        &demo_pubkey(&env),
        &vec![&env, symbol_short!("kyc"), symbol_short!("age")],
    );

    let v_id = env.register(CredentialVerifier, (admin.clone(),));
    let vc = CredentialVerifierClient::new(&env, &v_id);
    vc.set_vk(
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
        &9999,
    );

    // Both inner claims are verified after the single aggregate submission.
    assert!(registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
    assert!(registry.is_verified(&holder, &symbol_short!("age"), &None).0);

    // The age threshold (18) is extracted from the aggregate layout and
    // enforced by check_claim.
    assert!(registry.check_claim(&holder, &symbol_short!("age"), &Some(18), &None));
    assert!(!registry.check_claim(&holder, &symbol_short!("age"), &Some(19), &None));
}

// ── Admin / upgrade tests ────────────────────────────────────────────────────

#[test]
fn claim_expiry_returns_zero_for_nonexistent_proof() {
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
fn claim_expiry_returns_expiry_even_after_expired() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);

    let new_admin = Address::generate(&env);

    h.registry.set_admin(&new_admin);
    assert_eq!(h.registry.admin(), new_admin);

    let real_wasm = get_test_wasm(&env);
    let new_wasm_hash = env.deployer().upload_contract_wasm(real_wasm);

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

/// `Option<Address>` on `ProofRecord::issuer` does NOT make a record written
/// before that field existed readable. Soroban's derived struct decoding
/// unpacks the stored map by exact field count (`map_unpack_to_slice` errors
/// if the map has a different number of entries than the current struct has
/// fields) before it ever gets to per-field `Option`/`Void` handling — a
/// missing *key* is not the same as a present key with a `Void` value.
/// `Option` only lets `issuer` be explicitly absent within an
/// already-current-shape (5-entry) record. Redeploying this contract over
/// existing stored proofs therefore still requires a real migration; without
/// one, holders with pre-existing proofs must re-submit them.
#[test]
fn legacy_record_missing_issuer_key_fails_to_read() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    env.as_contract(&h.registry_id, || {
        let key = DataKey::Proof(holder.clone(), symbol_short!("kyc"));
        let legacy = LegacyProofRecord {
            verified_at: 500,
            expiry: 1000,
            threshold: None,
            revoked: false,
        };
        env.storage().persistent().set(&key, &legacy);
    });

    let result = h.registry.try_is_verified(&holder, &symbol_short!("kyc"), &None);
    assert!(result.is_err());
}
// ── Property-based tests ────────────────────────────────────────

/// Property: No proof from an unregistered issuer is ever accepted.
/// For any holder and unregistered issuer, submitting a proof must fail
/// and `is_verified` must return false.
#[test]
fn prop_unregistered_issuer_always_rejected() {
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
            let holder = Address::generate(&env);
            let unregistered = Address::generate(&env);

            let res = h.registry.try_submit_proof(
                &holder,
                &unregistered,
                &symbol_short!("kyc"),
                &Bytes::from_slice(&env, PROOF),
                &Bytes::from_slice(&env, PUBLIC_INPUTS),
                &None,
                &1000,
            );

            prop_assert!(res.is_err(), "Unregistered issuer should not be accepted");
            let (valid, _, _) = h.registry.is_verified(&holder, &symbol_short!("kyc"), &None);
            prop_assert!(!valid, "is_verified should return false for unregistered issuer");
            Ok(())
        })
        .unwrap();
}

/// Property: check_claim(threshold) is monotonic.
/// If `check_claim(&holder, &type, &Some(T), &None)` returns true,
/// then `check_claim(&holder, &type, &Some(T'), &None)` must also return true
/// for all T' <= T.
#[test]
fn prop_check_claim_monotonic_in_threshold() {
    let config = proptest::test_runner::Config {
        cases: 10,
        ..proptest::test_runner::Config::default()
    };
    let mut runner = proptest::test_runner::TestRunner::new(config);
    runner
        .run(&(0u64..500_000u64, 0u64..500_000u64), |(threshold_a, threshold_b)| {
            let env = Env::default();
            env.mock_all_auths();
            let admin = Address::generate(&env);

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
                .set_vk(&symbol_short!("funds"), &1u32, &Bytes::from_slice(&env, FUNDS_VK));

            let pr_id = env.register(ProofRegistry, (admin, v_id, ir_id));
            let registry = ProofRegistryClient::new(&env, &pr_id);
            let holder = Address::generate(&env);

            registry.submit_proof(
                &holder,
                &issuer,
                &symbol_short!("funds"),
                &Bytes::from_slice(&env, FUNDS_PROOF),
                &Bytes::from_slice(&env, FUNDS_PUBLIC_INPUTS),
                &None,
                &9999,
            );

            let t = std::cmp::min(threshold_a, threshold_b);
            let t_prime = std::cmp::max(threshold_a, threshold_b);

            let claim_at_t = registry.check_claim(&holder, &symbol_short!("funds"), &Some(t), &None);
            let claim_at_t_prime = registry.check_claim(
                &holder,
                &symbol_short!("funds"),
                &Some(t_prime),
                &None,
            );

            // Monotonicity: if the proof passes at a lower threshold T,
            // it must also pass at a higher threshold T' where T' <= T.
            if t <= 200_000 && t_prime <= 200_000 {
                prop_assert!(claim_at_t, "check_claim at T={} should be true", t);
                prop_assert!(
                    claim_at_t_prime,
                    "check_claim at T'={} should be true since T' <= T",
                    t_prime
                );
            }
            Ok(())
        })
        .unwrap();
}

/// Property: Expired claims always read as false.
/// If a proof's expiry is in the past relative to the current ledger timestamp,
/// both `is_verified` and `check_claim` must return false.
#[test]
fn prop_expired_claims_always_false() {
    let config = proptest::test_runner::Config {
        cases: 10,
        ..proptest::test_runner::Config::default()
    };
    let mut runner = proptest::test_runner::TestRunner::new(config);
    runner
        .run(&(0u64..1000u64), |expiry| {
            let env = Env::default();
            env.mock_all_auths();
            let h = deploy(&env);
            let holder = Address::generate(&env);

            // Soroban's default ledger timestamp starts at 1,
            // so any expiry value < current timestamp is in the past.
            h.registry.submit_proof(
                &holder,
                &h.issuer,
                &symbol_short!("kyc"),
                &Bytes::from_slice(&env, PROOF),
                &Bytes::from_slice(&env, PUBLIC_INPUTS),
                &None,
                &expiry,
            );

            // Move ledger time to expiry + 1 so the proof is expired.
            env.ledger().with_mut(|li| li.timestamp = expiry + 1);

            let (valid, _, _) = h.registry.is_verified(&holder, &symbol_short!("kyc"), &None);
            prop_assert!(!valid, "is_verified should return false for expired proof");

            let claim = h.registry.check_claim(&holder, &symbol_short!("kyc"), &None, &None);
            prop_assert!(!claim, "check_claim should return false for expired proof");
            Ok(())
        })
        .unwrap();
}

/// Property: Revoked claims always read as false.
/// If a proof is revoked, both `is_verified` and `check_claim` must return false,
/// even if the proof is not yet expired.
#[test]
fn prop_revoked_claims_always_false() {
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
            let holder = Address::generate(&env);

            // Submit a valid, non-expired proof with a far-future expiry.
            h.registry.submit_proof(
                &holder,
                &h.issuer,
                &symbol_short!("kyc"),
                &Bytes::from_slice(&env, PROOF),
                &Bytes::from_slice(&env, PUBLIC_INPUTS),
                &None,
                &5000,
            );

            // Verify it's valid before revocation.
            let (valid_before, _, _) = h.registry.is_verified(&holder, &symbol_short!("kyc"), &None);
            prop_assert!(valid_before, "Proof should be valid before revocation");

            // Revoke the proof.
            h.registry.revoke(&h.issuer, &holder, &symbol_short!("kyc"));

            // After revocation, is_verified must return false.
            let (valid_after, _, _) = h.registry.is_verified(&holder, &symbol_short!("kyc"), &None);
            prop_assert!(!valid_after, "is_verified should return false after revocation");

            // check_claim must also return false.
            let claim = h.registry.check_claim(&holder, &symbol_short!("kyc"), &None, &None);
            prop_assert!(!claim, "check_claim should return false after revocation");
            Ok(())
        })
        .unwrap();
}

// ── migrate_record tests ─────────────────────────────────────────────────────

/// After `migrate_record` rewrites a 4-field legacy record into the current
/// 5-field layout, `is_verified` reads it without panicking and returns the
/// original data.
#[test]
fn migrate_record_makes_legacy_readable() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    // Write a legacy 4-field record directly into the contract's storage.
    env.as_contract(&h.registry_id, || {
        let key = DataKey::Proof(holder.clone(), symbol_short!("kyc"));
        let legacy = LegacyProofRecord {
            verified_at: 500,
            expiry: 1000,
            threshold: None,
            revoked: false,
        };
        env.storage().persistent().set(&key, &legacy);
    });

    // Before migration, reading as ProofRecord panics.
    let before = h.registry.try_is_verified(&holder, &symbol_short!("kyc"), &None);
    assert!(before.is_err());

    // Admin migrates.
    h.registry.migrate_record(&holder, &symbol_short!("kyc"));

    // After migration the record is readable.
    let (valid, verified_at, expiry) =
        h.registry.is_verified(&holder, &symbol_short!("kyc"), &None);
    assert!(valid);
    assert_eq!(verified_at, 500);
    assert_eq!(expiry, 1000);
}

/// A migrated record has `issuer = None` so it must be rejected under an
/// active `trusted_issuers` filter.
#[test]
fn migrated_record_rejected_under_trusted_issuers() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    env.as_contract(&h.registry_id, || {
        let key = DataKey::Proof(holder.clone(), symbol_short!("kyc"));
        let legacy = LegacyProofRecord {
            verified_at: 500,
            expiry: 1000,
            threshold: None,
            revoked: false,
        };
        env.storage().persistent().set(&key, &legacy);
    });

    h.registry.migrate_record(&holder, &symbol_short!("kyc"));

    // Without a trusted_issuers filter the record is valid.
    assert!(h
        .registry
        .is_verified(&holder, &symbol_short!("kyc"), &None)
        .0);
    assert!(h
        .registry
        .check_claim(&holder, &symbol_short!("kyc"), &None, &None));

    // With a trusted_issuers filter the migrated record (issuer = None) is
    // rejected — fails closed.
    assert!(!h.registry.check_claim(
        &holder,
        &symbol_short!("kyc"),
        &None,
        &Some(vec![&env, h.issuer.clone()]),
    ));
    let (valid, _at, _expiry) = h.registry.is_verified(
        &holder,
        &symbol_short!("kyc"),
        &Some(vec![&env, h.issuer.clone()]),
    );
    assert!(!valid);
}

/// Only the contract admin may call `migrate_record`.
#[test]
fn migrate_record_only_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    env.as_contract(&h.registry_id, || {
        let key = DataKey::Proof(holder.clone(), symbol_short!("kyc"));
        let legacy = LegacyProofRecord {
            verified_at: 500,
            expiry: 1000,
            threshold: None,
            revoked: false,
        };
        env.storage().persistent().set(&key, &legacy);
    });

    // Call with no auth — must fail.
    let res = h
        .registry
        .mock_auths(&[])
        .try_migrate_record(&holder, &symbol_short!("kyc"));
    assert!(res.is_err());

    // Verify the legacy record is still unreadable (migration did NOT happen).
    let after = h.registry.try_is_verified(&holder, &symbol_short!("kyc"), &None);
    assert!(after.is_err());
}

/// Calling `migrate_record` on an already-migrated (5-field) record is a
/// no-op — the call succeeds without error.
#[test]
fn migrate_record_idempotent() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    // Submit a proof normally — this writes a 5-field current-format record.
    submit(&env, &h, &holder, 1000);
    assert!(h
        .registry
        .is_verified(&holder, &symbol_short!("kyc"), &None)
        .0);

    // Migrate on an already-current record — must succeed (no-op).
    h.registry.migrate_record(&holder, &symbol_short!("kyc"));

    // Record is still valid and unchanged.
    let (valid, _at, expiry) =
        h.registry.is_verified(&holder, &symbol_short!("kyc"), &None);
    assert!(valid);
    assert_eq!(expiry, 1000);
}

/// Calling `migrate_record` for a holder that has no stored proof must fail
/// with `ProofNotFound`.
#[test]
fn migrate_record_no_proof_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    let res = h
        .registry
        .try_migrate_record(&holder, &symbol_short!("kyc"));
    assert!(res.is_err());
}

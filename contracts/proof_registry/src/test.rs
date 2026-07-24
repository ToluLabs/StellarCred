#![cfg(test)]

use super::*;
use credential_verifier::{CredentialVerifier, CredentialVerifierClient};
use issuer_registry::{IssuerRegistry, IssuerRegistryClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _},
    vec, Address, BytesN, Bytes, Env,
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

struct Harness {
    registry: ProofRegistryClient<'static>,
    issuer: Address,
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
    let v_id = env.register(CredentialVerifier, (admin,));
    CredentialVerifierClient::new(env, &v_id)
        .set_vk(&symbol_short!("kyc"), &Bytes::from_slice(env, VK));

    let pr_id = env.register(ProofRegistry, (v_id, ir_id));
    Harness {
        registry: ProofRegistryClient::new(env, &pr_id),
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
    let v_id = env.register(CredentialVerifier, (admin,));
    CredentialVerifierClient::new(&env, &v_id)
        .set_vk(&symbol_short!("kyc"), &Bytes::from_slice(&env, VK));
    let pr_id = env.register(ProofRegistry, (v_id, ir_id));
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

// ── issuer revocation tests ──────────────────────────────────────────────────

#[test]
fn issuer_revoke_invalidates_before_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc")).0);

    h.registry.revoke(&holder, &symbol_short!("kyc"), &h.issuer);
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
}

#[test]
fn issuer_revoke_by_unregistered_issuer_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);
    let stranger = Address::generate(&env);

    submit(&env, &h, &holder, 1000);

    let res = h.registry.try_revoke(&holder, &symbol_short!("kyc"), &stranger);
    assert!(res.is_err());
    assert!(h.registry.is_verified(&holder, &symbol_short!("kyc")).0);
}

#[test]
fn check_claim_false_after_issuer_revoke() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    assert!(h.registry.check_claim(&holder, &symbol_short!("kyc"), &None));

    h.registry.revoke(&holder, &symbol_short!("kyc"), &h.issuer);
    assert!(!h.registry.check_claim(&holder, &symbol_short!("kyc"), &None));
}

#[test]
fn resubmit_after_issuer_revoke_clears_flag() {
    let env = Env::default();
    env.mock_all_auths();
    let h = deploy(&env);
    let holder = Address::generate(&env);

    submit(&env, &h, &holder, 1000);
    h.registry.revoke(&holder, &symbol_short!("kyc"), &h.issuer);
    assert!(!h.registry.is_verified(&holder, &symbol_short!("kyc")).0);

    submit(&env, &h, &holder, 2000);
    let (valid, _, expiry) = h.registry.is_verified(&holder, &symbol_short!("kyc"));
    assert!(valid);
    assert_eq!(expiry, 2000);
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
    let v_id = env.register(CredentialVerifier, (admin,));
    CredentialVerifierClient::new(&env, &v_id)
        .set_vk(&symbol_short!("funds"), &Bytes::from_slice(&env, FUNDS_VK));
    let pr_id = env.register(ProofRegistry, (v_id, ir_id));
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
    let v_id = env.register(CredentialVerifier, (admin,));
    CredentialVerifierClient::new(&env, &v_id)
        .set_vk(&symbol_short!("age"), &Bytes::from_slice(&env, AGE_VK));
    let pr_id = env.register(ProofRegistry, (v_id, ir_id));
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

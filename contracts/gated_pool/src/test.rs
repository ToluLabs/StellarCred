#![cfg(test)]

use super::*;
use credential_verifier::{CredentialVerifier, CredentialVerifierClient};
use issuer_registry::{IssuerRegistry, IssuerRegistryClient};
use proof_registry::{ProofRegistry, ProofRegistryClient};
use soroban_sdk::{symbol_short, testutils::Address as _, vec, Address, BytesN, Bytes, Env};

// Real UltraHonk artifacts, so the KYC gate exercises genuine verification.
const VK: &[u8] = include_bytes!("../../../fixtures/kyc/vk");
const PROOF: &[u8] = include_bytes!("../../../fixtures/kyc/proof");
const PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/kyc/public_inputs");

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

fn deploy(env: &Env) -> Harness {
    let admin = Address::generate(env);

    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let issuer = Address::generate(env);
    IssuerRegistryClient::new(env, &ir_id).register_issuer(
        &issuer,
        &demo_pubkey(env),
        &vec![env, symbol_short!("kyc")],
    );

    let verifier_id = env.register(CredentialVerifier, (admin.clone(),));
    CredentialVerifierClient::new(env, &verifier_id)
        .set_vk(&symbol_short!("kyc"), &Bytes::from_slice(env, VK));

    let registry_id = env.register(ProofRegistry, (admin, verifier_id, ir_id));
    let pool_id = env.register(GatedPool, (registry_id.clone(),));

    Harness {
        registry: ProofRegistryClient::new(env, &registry_id),
        pool: GatedPoolClient::new(env, &pool_id),
        issuer,
    }
}

fn prove_kyc(env: &Env, h: &Harness, holder: &Address) {
    h.registry.submit_proof(
        holder,
        &h.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(env, PROOF),
        &Bytes::from_slice(env, PUBLIC_INPUTS),
        &1_000_000,
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

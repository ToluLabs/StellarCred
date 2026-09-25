//! End-to-end integration tests: IssuerRegistry → CredentialVerifier →
//! ProofRegistry → GatedPool.
//!
//! Unlike the per-contract unit tests (which deploy at most a couple of live
//! dependencies), every test here deploys and wires **all four** contracts in a
//! single environment and drives the full protocol lifecycle through the public
//! client APIs only — no storage peeking, no mocked verification:
//!
//! ```text
//! IssuerRegistry ──is_valid_issuer/get_issuer_pubkey──▶ ProofRegistry
//! CredentialVerifier ──verify_proof──────────────────▶ ProofRegistry
//! ProofRegistry ──check_claim────────────────────────▶ GatedPool
//! ```
//!
//! Proofs are the real UltraHonk artifacts from `fixtures/kyc/` (Noir
//! 1.0.0-beta.9 + bb v0.87.0), so the on-chain BN254 verification path is
//! genuinely exercised. The issuer pubkey expected by ProofRegistry is read out
//! of the proof's public inputs (fields 1..65), mirroring what the circuits
//! embed.
//!
//! # Event mapping (documented sequence in the issue → actual events)
//!
//! The codebase's authoritative event catalog is `EVENTS.md`. The issue's
//! example sequence maps onto the real event names as follows:
//!
//! | Issue example name    | Actual event (topics)                                  |
//! |-----------------------|--------------------------------------------------------|
//! | IssuerRegistered      | `EventIssuerRegistered` ("iss_reg", "register")        |
//! | VerificationKeySet    | `EventVkSet` ("cred_ver", "vk_set", <type>)            |
//! | ProofSubmitted        | `EventProofSubmitted` ("proof_reg", "submitted", <t>)  |
//! | ClaimVerified         | (no event — observed via `is_verified`/`get_record`)   |
//! | DepositAccepted       | `EventDeposit` ("gate_pool", "deposit")                |
//! | ClaimRevoked          | `EventProofRevoked` ("proof_reg", "revoked", <type>)   |
//! | DepositRejected       | (no event — the gate panics with `NotKycVerified`)     |
//!
//! `env.events().all()` returns the events published by the *last* contract
//! invocation, so asserting the full filtered event list after each lifecycle
//! step verifies both payload correctness and cross-contract emission order.

use super::*;
use credential_verifier::{CredentialVerifier, CredentialVerifierClient, EventVkSet};
use issuer_registry::{
    EventIssuerRegistered, EventIssuerRevoked, IssuerRegistry, IssuerRegistryClient,
};
use proof_registry::{
    EventPaused, EventProofRevoked, EventProofSubmitted, EventUnpaused, ProofRegistry,
    ProofRegistryClient,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    vec, Bytes, BytesN, Env, IntoVal, InvokeError,
};

use credential_verifier::Error as VerifierError;
use proof_registry::Error as ProofRegistryError;

// Real UltraHonk artifacts for the `kyc` credential circuit, shared by every
// scenario in this module.
const VK: &[u8] = include_bytes!("../../../fixtures/kyc/vk");
const PROOF: &[u8] = include_bytes!("../../../fixtures/kyc/proof");
const PUBLIC_INPUTS: &[u8] = include_bytes!("../../../fixtures/kyc/public_inputs");

// Deterministic timeline for the whole module: the ledger clock starts at T0
// and every claim expires one week later. `validate_expiry` only requires
// expiry to be in the future and within one year, so this is well inside bounds.
const T0: u64 = 1_000_000;
const DAY: u64 = 86_400;
const EXPIRY: u64 = T0 + 7 * DAY;

// ── Helpers ──────────────────────────────────────────────────────────────────

/// The secp256k1 issuer pubkey (x || y) embedded in the kyc fixture's public
/// inputs: one byte per 32-byte field, taken from the low byte of fields 1..65
/// — the same layout ProofRegistry's `public_inputs_match_pubkey` checks.
fn demo_pubkey(env: &Env) -> BytesN<64> {
    let mut arr = [0u8; 64];
    for i in 0..64usize {
        arr[i] = PUBLIC_INPUTS[(1 + i) * 32 + 31];
    }
    BytesN::from_array(env, &arr)
}

/// All four contracts, deployed and cross-wired exactly as in production:
/// ProofRegistry is constructed with the verifier + issuer registry addresses,
/// and GatedPool is constructed with the ProofRegistry address.
struct World {
    admin: Address,
    issuer: Address,
    issuer_registry: IssuerRegistryClient<'static>,
    verifier: CredentialVerifierClient<'static>,
    registry: ProofRegistryClient<'static>,
    pool: GatedPoolClient<'static>,
}

fn deploy_world(env: &Env) -> World {
    env.ledger().with_mut(|li| li.timestamp = T0);

    let admin = Address::generate(env);

    // Root of trust: which issuers may attest which credential types.
    let ir_id = env.register(IssuerRegistry, (admin.clone(),));
    let issuer_registry = IssuerRegistryClient::new(env, &ir_id);

    // Stateless crypto gateway: UltraHonk verification keys per credential type.
    let cv_id = env.register(CredentialVerifier, (admin.clone(),));
    let verifier = CredentialVerifierClient::new(env, &cv_id);

    // Cache of verified claims, wired to the two contracts above.
    let pr_id = env.register(
        ProofRegistry,
        (admin.clone(), cv_id.clone(), ir_id.clone()),
    );
    let registry = ProofRegistryClient::new(env, &pr_id);

    // Gated DeFi pool wired to the claim cache.
    let gate_type = symbol_short!("kyc");
    let min_threshold: Option<u64> = None;
    let pool_id = env.register(GatedPool, (pr_id.clone(), gate_type, min_threshold));
    let pool = GatedPoolClient::new(env, &pool_id);

    World {
        admin,
        issuer: Address::generate(env),
        issuer_registry,
        verifier,
        registry,
        pool,
    }
}

/// Extracts the contract error code from a generated `try_*` client result and
/// fails the test with context if the call did not fail with a contract error.
///
/// Generated `try_` methods return
/// `Result<Result<T, T::Error>, Result<soroban_sdk::Error, InvokeError>>`; a
/// `panic_with_error!` inside any contract in the call chain surfaces here as a
/// Soroban contract error whose code equals the panicking contract's
/// `contracterror` discriminant — which is exactly the cross-contract error
/// propagation these tests assert on.
fn expect_err_code<T: core::fmt::Debug, E: core::fmt::Debug>(
    res: Result<Result<T, E>, Result<soroban_sdk::Error, InvokeError>>,
) -> u32 {
    match res {
        Err(Ok(e)) => match InvokeError::from(e) {
            InvokeError::Contract(code) => code,
            other => panic!("expected a contract error, got {other:?}"),
        },
        Err(Err(e)) => match e {
            InvokeError::Contract(code) => code,
            other => panic!("expected a contract error, got {other:?}"),
        },
        Ok(Ok(v)) => panic!("expected an error, got Ok({v:?})"),
        Ok(Err(e)) => panic!("expected an error, got conversion error {e:?}"),
    }
}

// ── Happy path: complete four-contract lifecycle ─────────────────────────────

/// The full lifecycle from the issue, in order:
/// deploy + wire → register issuer → set VK → submit proof → claim exists →
/// gated deposit accepted → revoke claim → deposits rejected → expire claim →
/// gate stays closed. Every state-changing step also asserts the event payload
/// it emitted, in the documented order.
#[test]
fn four_contract_lifecycle_end_to_end() {
    let env = Env::default();
    env.mock_all_auths();
    let w = deploy_world(&env);
    let holder = Address::generate(&env);
    let pubkey = demo_pubkey(&env);

    // 1–2. Deploy all four contracts and verify the address wiring/trust
    // configuration matches the constructor arguments.
    assert_eq!(w.pool.registry_address(), w.registry.address);
    assert_eq!(w.registry.verifier_address(), w.verifier.address);
    assert_eq!(
        w.registry.issuer_registry_address(),
        w.issuer_registry.address
    );
    assert_eq!(w.pool.gate(), (symbol_short!("kyc"), None));
    assert_eq!(w.registry.version(), 1_000_000);

    // 3. Register the issuer in IssuerRegistry → IssuerRegistered.
    w.issuer_registry
        .register_issuer(&w.issuer, &pubkey, &vec![&env, symbol_short!("kyc")]);
    assert!(w
        .issuer_registry
        .is_valid_issuer(&w.issuer, &symbol_short!("kyc")));
    assert_eq!(
        env.events().all().filter_by_contract(&w.issuer_registry.address),
        vec![
            &env,
            (
                w.issuer_registry.address.clone(),
                (symbol_short!("iss_reg"), symbol_short!("register")).into_val(&env),
                EventIssuerRegistered {
                    issuer: w.issuer.clone(),
                    pubkey: pubkey.clone(),
                }
                .into_val(&env),
            ),
        ],
    );

    // 4. Set the verification key in CredentialVerifier → VerificationKeySet.
    w.verifier
        .set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(&env, VK));
    assert_eq!(w.verifier.get_latest_version(&symbol_short!("kyc")), 1);
    assert_eq!(
        env.events().all().filter_by_contract(&w.verifier.address),
        vec![
            &env,
            (
                w.verifier.address.clone(),
                (
                    symbol_short!("cred_ver"),
                    symbol_short!("vk_set"),
                    symbol_short!("kyc"),
                )
                    .into_val(&env),
                EventVkSet {
                    admin: w.admin.clone(),
                    version: 1,
                    contract_version: w.verifier.version(),
                }
                .into_val(&env),
            ),
        ],
    );

    // 5. Submit the valid UltraHonk proof through ProofRegistry → ProofSubmitted.
    w.registry.submit_proof(
        &holder,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &EXPIRY,
    );

    // 6. The proof created the expected claim (no event; observed on-chain).
    assert_eq!(
        w.registry.is_verified(&holder, &symbol_short!("kyc"), &None),
        (true, T0, EXPIRY),
    );
    let record = w
        .registry
        .get_record(&holder, &symbol_short!("kyc"))
        .expect("claim should exist after submit_proof");
    assert!(!record.revoked);
    assert_eq!(record.issuer, Some(w.issuer.clone()));
    assert_eq!(record.expiry, EXPIRY);
    assert_eq!(w.registry.claim_expiry(&holder, &symbol_short!("kyc")), EXPIRY);
    assert_eq!(
        env.events().all().filter_by_contract(&w.registry.address),
        vec![
            &env,
            (
                w.registry.address.clone(),
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("submitted"),
                    symbol_short!("kyc"),
                )
                    .into_val(&env),
                EventProofSubmitted {
                    holder: holder.clone(),
                    issuer: w.issuer.clone(),
                    verified_at: T0,
                    expiry: EXPIRY,
                }
                .into_val(&env),
            ),
        ],
    );

    // 7. GatedPool accepts a deposit backed by the claim → DepositAccepted.
    w.pool.deposit(&holder, &500);
    assert_eq!(w.pool.get_balance(&holder), 500);
    assert_eq!(
        env.events().all().filter_by_contract(&w.pool.address),
        vec![
            &env,
            (
                w.pool.address.clone(),
                (symbol_short!("gate_pool"), symbol_short!("deposit")).into_val(&env),
                EventDeposit {
                    caller: holder.clone(),
                    amount: 500,
                    new_balance: 500,
                }
                .into_val(&env),
            ),
        ],
    );

    // 8. Revoke the claim (the issuing issuer, through ProofRegistry)
    //    → ClaimRevoked.
    w.registry.revoke(&w.issuer, &holder, &symbol_short!("kyc"));
    assert!(!w
        .registry
        .is_verified(&holder, &symbol_short!("kyc"), &None)
        .0);
    assert!(w
        .registry
        .get_record(&holder, &symbol_short!("kyc"))
        .expect("revocation marks the record, it does not delete it")
        .revoked);
    assert_eq!(
        env.events().all().filter_by_contract(&w.registry.address),
        vec![
            &env,
            (
                w.registry.address.clone(),
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("revoked"),
                    symbol_short!("kyc"),
                )
                    .into_val(&env),
                EventProofRevoked {
                    holder: holder.clone(),
                    issuer: w.issuer.clone(),
                    revoked_at: T0,
                }
                .into_val(&env),
            ),
        ],
    );

    // 9. Deposits are rejected after revocation. A rejected deposit has no
    // on-chain event (the gate panics with GatedPool::NotKycVerified before
    // any state change), so the assertion is the propagated error code plus an
    // empty event list for the failed invocation.
    let res = w.pool.try_deposit(&holder, &100);
    assert_eq!(expect_err_code(res), Error::NotKycVerified as u32);
    assert_eq!(w.pool.get_balance(&holder), 500);
    assert_eq!(
        env.events().all().filter_by_contract(&w.pool.address),
        vec![&env],
    );

    // Revocation gates future deposits but must not trap existing funds:
    // withdrawals stay open for the balance owner.
    w.pool.withdraw(&holder, &200);
    assert_eq!(w.pool.get_balance(&holder), 300);

    // 10–11. A second holder proves and deposits, then the claim expires —
    // the gate remains closed after expiration.
    let holder_b = Address::generate(&env);
    w.registry.submit_proof(
        &holder_b,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &EXPIRY,
    );
    w.pool.deposit(&holder_b, &50);
    assert_eq!(w.pool.get_balance(&holder_b), 50);

    env.ledger()
        .with_mut(|li| li.timestamp = EXPIRY + 1);
    assert!(!w
        .registry
        .is_verified(&holder_b, &symbol_short!("kyc"), &None)
        .0);
    let res = w.pool.try_deposit(&holder_b, &10);
    assert_eq!(expect_err_code(res), Error::NotKycVerified as u32);
    assert_eq!(w.pool.get_balance(&holder_b), 50);
    assert_eq!(
        env.events().all().filter_by_contract(&w.pool.address),
        vec![&env],
    );

    // Funds remain withdrawable after the credential expired.
    w.pool.withdraw(&holder_b, &50);
    assert_eq!(w.pool.get_balance(&holder_b), 0);
}

// ── Cross-contract failure scenarios ─────────────────────────────────────────

/// An issuer that is not registered in IssuerRegistry cannot get a proof
/// accepted by ProofRegistry: the trust check fails cross-contract and the
/// submission panics with ProofRegistry::IssuerNotTrusted before any storage
/// or event side effects. The gated pool never sees a claim.
#[test]
fn untrusted_issuer_cannot_submit_through_proof_registry() {
    let env = Env::default();
    env.mock_all_auths();
    let w = deploy_world(&env);
    // The VK is set so the ONLY missing piece is issuer trust: the rejection
    // below is provably the IssuerRegistry trust check, not missing crypto
    // material or a bad proof.
    w.verifier
        .set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(&env, VK));
    let holder = Address::generate(&env);

    // Sanity: an unregistered issuer is not trusted for kyc (root of trust).
    assert!(!w
        .issuer_registry
        .is_valid_issuer(&w.issuer, &symbol_short!("kyc")));

    let res = w.registry.try_submit_proof(
        &holder,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &EXPIRY,
    );
    assert_eq!(
        expect_err_code(res),
        ProofRegistryError::IssuerNotTrusted as u32
    );

    // No claim was cached, nothing was emitted, and the gate stays closed.
    assert!(w
        .registry
        .get_record(&holder, &symbol_short!("kyc"))
        .is_none());
    assert_eq!(
        env.events().all().filter_by_contract(&w.registry.address),
        vec![&env],
    );
    let res = w.pool.try_deposit(&holder, &100);
    assert_eq!(expect_err_code(res), Error::NotKycVerified as u32);
}

/// Submitting against a VK version that was never registered propagates
/// CredentialVerifier::VkNotSet out of the nested
/// ProofRegistry → CredentialVerifier call to the original caller.
///
/// Note both `CredentialVerifier::VkNotSet` and `ProofRegistry::VerificationFailed`
/// have discriminant 2, so the sanity check at the end (the byte-identical
/// proof with `vk_version = None` is accepted) proves the failure came from the
/// version lookup panicking inside the verifier — not from verification
/// returning `false` (which would have been ProofRegistry's own code 2).
#[test]
fn unregistered_vk_version_propagates_verifier_error() {
    let env = Env::default();
    env.mock_all_auths();
    let w = deploy_world(&env);
    w.issuer_registry
        .register_issuer(&w.issuer, &demo_pubkey(&env), &vec![&env, symbol_short!("kyc")]);
    w.verifier
        .set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(&env, VK));
    let holder = Address::generate(&env);

    // Version 7 was never registered for kyc.
    let res = w.registry.try_submit_proof(
        &holder,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &Some(7u32),
        &EXPIRY,
    );
    assert_eq!(
        expect_err_code(res),
        VerifierError::VkNotSet as u32,
        "expected CredentialVerifier::VkNotSet to propagate through ProofRegistry"
    );

    // No claim was cached for the failed submission.
    assert!(w
        .registry
        .get_record(&holder, &symbol_short!("kyc"))
        .is_none());

    // Differentiator: the identical proof at the latest version is accepted,
    // so the rejection above is attributable to the version alone.
    w.registry.submit_proof(
        &holder,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &EXPIRY,
    );
    assert!(w
        .registry
        .is_verified(&holder, &symbol_short!("kyc"), &None)
        .0);
}

/// Submitting against a *deprecated* VK version propagates
/// CredentialVerifier::VersionDeprecated through ProofRegistry, and the gate
/// stays closed for the rejected holder.
///
/// `CredentialVerifier::VersionDeprecated` and `ProofRegistry::IssuerNotTrusted`
/// share discriminant 4; the issuer is registered and the pubkey matches here,
/// and the `None`-version sanity submission is accepted, which together pin the
/// failure on the deprecation flag inside the verifier.
#[test]
fn deprecated_vk_version_propagates_verifier_error() {
    let env = Env::default();
    env.mock_all_auths();
    let w = deploy_world(&env);
    w.issuer_registry
        .register_issuer(&w.issuer, &demo_pubkey(&env), &vec![&env, symbol_short!("kyc")]);
    let verifier = &w.verifier;
    verifier.set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(&env, VK));
    // A second circuit version (same VK bytes for test purposes), then
    // deprecated by the admin: new submissions against it are rejected.
    verifier.set_vk(&symbol_short!("kyc"), &2u32, &Bytes::from_slice(&env, VK));
    verifier.deprecate_version(&symbol_short!("kyc"), &2u32);
    assert_eq!(verifier.get_latest_version(&symbol_short!("kyc")), 2);

    let holder = Address::generate(&env);
    let res = w.registry.try_submit_proof(
        &holder,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &Some(2u32),
        &EXPIRY,
    );
    assert_eq!(
        expect_err_code(res),
        VerifierError::VersionDeprecated as u32,
        "expected CredentialVerifier::VersionDeprecated to propagate through ProofRegistry"
    );
    assert!(w
        .registry
        .get_record(&holder, &symbol_short!("kyc"))
        .is_none());

    // Deprecating version 2 did not break submissions that explicitly target
    // the still-live version 1 (the deprecated flag is per-version, and latest
    // pointer 2 is only consulted for `None`).
    let holder_b = Address::generate(&env);
    w.registry.submit_proof(
        &holder_b,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &Some(1u32),
        &EXPIRY,
    );
    assert!(w
        .registry
        .is_verified(&holder_b, &symbol_short!("kyc"), &None)
        .0);

    // The rejected holder never gets past the pool's gate.
    let res = w.pool.try_deposit(&holder, &100);
    assert_eq!(expect_err_code(res), Error::NotKycVerified as u32);
}

/// Pausing ProofRegistry rejects new submissions with
/// ProofRegistry::SubmissionsPaused (the pause check runs before any
/// cross-contract verification), emits the Paused/Unpaused audit events, and
/// unpausing restores the full submit → deposit flow.
#[test]
fn paused_registry_rejects_submissions_until_unpause() {
    let env = Env::default();
    env.mock_all_auths();
    let w = deploy_world(&env);
    w.issuer_registry
        .register_issuer(&w.issuer, &demo_pubkey(&env), &vec![&env, symbol_short!("kyc")]);
    w.verifier
        .set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(&env, VK));
    let holder = Address::generate(&env);

    w.registry.pause();
    assert_eq!(
        env.events().all().filter_by_contract(&w.registry.address),
        vec![
            &env,
            (
                w.registry.address.clone(),
                (symbol_short!("proof_reg"), symbol_short!("paused")).into_val(&env),
                EventPaused {
                    admin: w.admin.clone(),
                    paused_at: T0,
                }
                .into_val(&env),
            ),
        ],
    );

    let res = w.registry.try_submit_proof(
        &holder,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &EXPIRY,
    );
    assert_eq!(
        expect_err_code(res),
        ProofRegistryError::SubmissionsPaused as u32
    );
    assert!(w
        .registry
        .get_record(&holder, &symbol_short!("kyc"))
        .is_none());

    w.registry.unpause();
    assert_eq!(
        env.events().all().filter_by_contract(&w.registry.address),
        vec![
            &env,
            (
                w.registry.address.clone(),
                (symbol_short!("proof_reg"), symbol_short!("unpaused")).into_val(&env),
                EventUnpaused {
                    admin: w.admin.clone(),
                    unpaused_at: T0,
                }
                .into_val(&env),
            ),
        ],
    );

    // The full cross-contract flow works again after unpausing.
    w.registry.submit_proof(
        &holder,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &EXPIRY,
    );
    assert!(w
        .registry
        .is_verified(&holder, &symbol_short!("kyc"), &None)
        .0);
    w.pool.deposit(&holder, &25);
    assert_eq!(w.pool.get_balance(&holder), 25);
}

/// Mid-flight issuer revocation: the issuer is registered, but revoked after
/// registration and *before* the proof submission completes. ProofRegistry's
/// trust check against IssuerRegistry fails and the submission is rejected
/// with ProofRegistry::IssuerNotTrusted — even though the issuer's key was
/// valid when the holder obtained the proof.
#[test]
fn issuer_revoked_midflight_rejects_submission() {
    let env = Env::default();
    env.mock_all_auths();
    let w = deploy_world(&env);
    w.issuer_registry
        .register_issuer(&w.issuer, &demo_pubkey(&env), &vec![&env, symbol_short!("kyc")]);
    w.verifier
        .set_vk(&symbol_short!("kyc"), &1u32, &Bytes::from_slice(&env, VK));

    // The issuer is trusted right up until the admin revokes it.
    assert!(w
        .issuer_registry
        .is_valid_issuer(&w.issuer, &symbol_short!("kyc")));
    w.issuer_registry.revoke_issuer(&w.issuer);
    assert!(!w
        .issuer_registry
        .is_valid_issuer(&w.issuer, &symbol_short!("kyc")));

    // Revocation is audited on the IssuerRegistry itself.
    assert_eq!(
        env.events().all().filter_by_contract(&w.issuer_registry.address),
        vec![
            &env,
            (
                w.issuer_registry.address.clone(),
                (symbol_short!("iss_reg"), symbol_short!("revoked")).into_val(&env),
                EventIssuerRevoked {
                    issuer: w.issuer.clone(),
                }
                .into_val(&env),
            ),
        ],
    );

    // The mid-flight submission now fails the cross-contract trust check.
    let holder = Address::generate(&env);
    let res = w.registry.try_submit_proof(
        &holder,
        &w.issuer,
        &symbol_short!("kyc"),
        &Bytes::from_slice(&env, PROOF),
        &Bytes::from_slice(&env, PUBLIC_INPUTS),
        &None,
        &EXPIRY,
    );
    assert_eq!(
        expect_err_code(res),
        ProofRegistryError::IssuerNotTrusted as u32
    );
    assert!(w
        .registry
        .get_record(&holder, &symbol_short!("kyc"))
        .is_none());
    assert_eq!(
        env.events().all().filter_by_contract(&w.registry.address),
        vec![&env],
    );

    // And the pool's gate stays closed for the holder.
    let res = w.pool.try_deposit(&holder, &100);
    assert_eq!(expect_err_code(res), Error::NotKycVerified as u32);
}

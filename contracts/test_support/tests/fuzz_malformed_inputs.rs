//! Property-based fuzzing of every contract entry point that accepts
//! attacker-controlled bytes or boundary numeric inputs (#1020).
//!
//! The invariant under test is the one a Soroban contract owes its callers:
//! **malformed input must be rejected with a declared contract error (or
//! handled), never by an unhandled panic.** In the host, a Rust panic (slice
//! out of range, `unwrap` on `None`, arithmetic overflow with
//! `overflow-checks = true`, ...) surfaces to the caller as
//! a non-contract host error (`Error(Context, InvalidAction)` or
//! `InvokeError::Abort`), while `panic_with_error!` surfaces as a contract
//! error. [`assert_no_abort`] enforces exactly that distinction on every call.
//!
//! Beyond "does not abort", the suites assert the security properties that
//! malformed input must not break:
//!
//! * a proof / public-input pair that differs from the real fixture never
//!   verifies (no malleability),
//! * a verification key made of arbitrary bytes never makes a real proof
//!   verify,
//! * pool balances track a checked-arithmetic model exactly, including at
//!   `i128` boundaries.
//!
//! Inputs come from three families: fully arbitrary bytes, bytes of boundary
//! lengths (0, 1, 31, 32, 33, len-1, len, len+1), and byte-level mutations
//! (flips, truncation, extension) of the checked-in valid fixtures. Failures
//! are shrunk by proptest to a minimal counterexample.
//!
//! Case counts can be raised for a deeper local run:
//! `FUZZ_CASES=2000 cargo test -p test_support --test fuzz_malformed_inputs`.

use proptest::collection::vec;
use proptest::prelude::*;
use proptest::test_runner::{Config, TestCaseError, TestRunner};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Bytes, BytesN, Env, InvokeError, String as SorobanString, Symbol, Vec as SorobanVec,
};
use std::fmt::Debug;
use test_support::{Circuit, Contracts, AGGREGATE, KYC};

use proof_registry::ProofSubmission;

/// Ledger time every test runs at, so expiry boundaries are deterministic.
const NOW: u64 = 1_700_000_000;
/// `MAX_CREDENTIAL_TTL_SECS` in proof_registry (one year).
const MAX_TTL: u64 = 365 * 86_400;
/// Longest batch the registry accepts (`MAX_BATCH_SIZE`).
const MAX_BATCH: usize = 5;

/// Cases for cheap targets (rejected before any pairing/verification work).
fn cheap_cases() -> u32 {
    scaled(128)
}

/// Cases for targets that can reach the real UltraHonk verifier.
fn costly_cases() -> u32 {
    scaled(12)
}

fn scaled(default: u32) -> u32 {
    match std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
    {
        Some(n) => n.max(1),
        None => default,
    }
}

fn runner(cases: u32) -> TestRunner {
    TestRunner::new(Config {
        cases,
        // Integration tests have no lib/main to anchor a regressions file to;
        // don't litter the tree with `.proptest-regressions` files.
        failure_persistence: None,
        ..Config::default()
    })
}

fn fresh_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    env
}

/// Fail the case if a `try_*` client call died from an unhandled panic.
///
/// How the host reports a call that did not succeed:
///
/// * `panic_with_error!(Error::X)` / a nested contract's declared error:
///   `Error(Contract, #n)`, or the contract's own error enum. **Handled.**
/// * a Rust panic (slice index, `unwrap` on `None`, arithmetic overflow under
///   `overflow-checks = true`, ...): a non-contract host error such as
///   `Error(Context, InvalidAction)` / `Error(WasmVm, ..)`, or
///   `InvokeError::Abort`. **Unhandled** — this is what the suite hunts for.
///
/// Which shape a panic takes depends on the function's declared return type,
/// so both are checked.
fn assert_no_abort<T, C, E: Debug>(
    what: &str,
    r: &Result<Result<T, C>, Result<E, InvokeError>>,
) -> Result<(), TestCaseError> {
    let unhandled = match r {
        Err(Err(InvokeError::Abort)) => Some("InvokeError::Abort".to_string()),
        Err(Ok(e)) => {
            let shown = format!("{e:?}");
            (shown.starts_with("Error(") && !shown.starts_with("Error(Contract,")).then_some(shown)
        }
        _ => None,
    };
    match unhandled {
        Some(err) => Err(TestCaseError::fail(format!(
            "{what}: unhandled panic on malformed input ({err}); \
             expected a declared contract error"
        ))),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/// Arbitrary bytes, or bytes whose *length* sits on a boundary of `base_len`.
fn raw_bytes(base_len: usize, max: usize) -> impl Strategy<Value = Vec<u8>> {
    let boundary = [
        0,
        1,
        31,
        32,
        33,
        base_len.saturating_sub(1),
        base_len,
        base_len + 1,
    ];
    prop_oneof![
        vec(any::<u8>(), 0..=max),
        (prop::sample::select(boundary.to_vec()), any::<u8>()).prop_map(|(n, b)| vec![b; n]),
    ]
}

/// A byte-level mutation of `base`: some flipped bytes, a truncation, or an
/// appended tail. Often equals `base` (no flips), which the properties allow.
fn mutated(base: &'static [u8]) -> impl Strategy<Value = Vec<u8>> {
    (
        vec((0..base.len(), any::<u8>()), 1..4),
        0..=base.len(),
        vec(any::<u8>(), 1..64),
        0u8..3,
    )
        .prop_map(move |(flips, cut, tail, mode)| {
            let mut out = base.to_vec();
            match mode {
                0 => {
                    for (i, b) in flips {
                        out[i] = b;
                    }
                }
                1 => out.truncate(cut),
                _ => out.extend_from_slice(&tail),
            }
            out
        })
}

/// Fixture-derived mutations mixed with fully arbitrary bytes.
fn bytes_near(base: &'static [u8], max: usize) -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        3 => mutated(base),
        1 => raw_bytes(base.len(), max),
    ]
}

/// Half the time the untouched genuine bytes, so the *other* argument is what
/// gets exercised rather than being rejected by an earlier length/shape check.
fn genuine_or_near(base: &'static [u8], max: usize) -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        2 => Just(base.to_vec()),
        3 => bytes_near(base, max),
    ]
}

fn expiry() -> impl Strategy<Value = u64> {
    prop_oneof![
        Just(0),
        Just(1),
        Just(NOW - 1),
        Just(NOW),
        Just(NOW + 1),
        Just(NOW + MAX_TTL),
        Just(NOW + MAX_TTL + 1),
        Just(u64::MAX - 1),
        Just(u64::MAX),
        any::<u64>(),
    ]
}

fn amount() -> impl Strategy<Value = i128> {
    prop_oneof![
        Just(i128::MIN),
        Just(i128::MIN + 1),
        Just(-1),
        Just(0),
        Just(1),
        Just(i128::MAX - 1),
        Just(i128::MAX),
        1i128..1_000_000,
        any::<i128>(),
    ]
}

fn cred_type() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("kyc".to_string()),
        Just("age".to_string()),
        Just("income".to_string()),
        Just("funds".to_string()),
        Just("employment".to_string()),
        Just("accreditation".to_string()),
        Just("aggregate".to_string()),
        "[a-zA-Z0-9_]{1,32}",
    ]
}

fn nonzero_u32() -> impl Strategy<Value = u32> {
    prop_oneof![Just(0), Just(1), Just(2), Just(u32::MAX), any::<u32>()]
}

fn key64() -> impl Strategy<Value = Vec<u8>> {
    vec(any::<u8>(), 64..=64)
}

fn key32() -> impl Strategy<Value = Vec<u8>> {
    vec(any::<u8>(), 32..=32)
}

fn b64(env: &Env, v: &[u8]) -> BytesN<64> {
    BytesN::from_array(
        env,
        &<[u8; 64]>::try_from(v).expect("strategy yields 64 bytes"),
    )
}

fn b32(env: &Env, v: &[u8]) -> BytesN<32> {
    BytesN::from_array(
        env,
        &<[u8; 32]>::try_from(v).expect("strategy yields 32 bytes"),
    )
}

fn kyc_stack(env: &Env) -> (Contracts, Address) {
    let c = Contracts::deploy(env);
    let issuer = c.enable(env, &KYC);
    (c, issuer)
}

fn real_len(c: &Circuit) -> usize {
    c.proof.len()
}

// ---------------------------------------------------------------------------
// credential_verifier
// ---------------------------------------------------------------------------

/// `verify_proof` with arbitrary / boundary / mutated proof and public-input
/// bytes: never aborts, and nothing but the genuine pair verifies.
#[test]
fn verifier_verify_proof_never_aborts_and_rejects_non_genuine_inputs() {
    let env = fresh_env();
    let (c, _issuer) = kyc_stack(&env);
    let ct = KYC.ct(&env);
    let strat = (
        genuine_or_near(KYC.proof, 2 * real_len(&KYC)),
        genuine_or_near(KYC.public_inputs, 4096),
        prop_oneof![2 => Just(None), 1 => Just(Some(1u32)), 1 => nonzero_u32().prop_map(Some)],
    );

    runner(costly_cases())
        .run(&strat, |(proof, pi, version)| {
            let r = c.verifier.try_verify_proof(
                &ct,
                &Bytes::from_slice(&env, &proof),
                &Bytes::from_slice(&env, &pi),
                &version,
            );
            assert_no_abort("verify_proof", &r)?;

            // Soundness: the public inputs are the statement being proven, so
            // no proof may verify against any statement but the genuine one.
            // (Proof bytes alone are *not* asserted: UltraHonk proofs carry
            // padding for unused sumcheck/fold rounds that the verifier never
            // reads, so some byte changes yield an equally valid proof.)
            if pi != KYC.public_inputs && matches!(r, Ok(Ok(true))) {
                return Err(TestCaseError::fail(
                    "verify_proof accepted a statement other than the genuine public inputs",
                ));
            }
            // The proof length is fixed; anything else must be a clean `false`.
            if proof.len() != real_len(&KYC) {
                prop_assert!(
                    matches!(r, Ok(Ok(false))),
                    "wrong-length proof must return false"
                );
            }
            Ok(())
        })
        .unwrap();
}

/// Bytes of a verification key that is *structurally* wrong: arbitrary bytes,
/// boundary lengths, or a corrupted 32-byte header (circuit size, log size,
/// public-input count, offset). `UltraHonkVerifier::new` validates all of
/// these, so `set_vk` must reject each cleanly — never an abort.
fn structural_vk() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        raw_bytes(KYC.vk.len(), 4096),
        vec((0usize..32, any::<u8>()), 1..6).prop_map(|flips| {
            let mut v = KYC.vk.to_vec();
            for (i, b) in flips {
                v[i] = b;
            }
            v
        }),
    ]
}

/// A verification key whose G1 commitment bytes (offset 32..) are corrupted:
/// non-canonical coordinates or points off the curve. `set_vk` must reject
/// these with `VkInvalid` rather than store a key that later traps the host.
fn corrupted_point_vk() -> impl Strategy<Value = Vec<u8>> {
    vec((32usize..KYC.vk.len(), any::<u8>()), 1..6).prop_map(|flips| {
        let mut v = KYC.vk.to_vec();
        for (i, b) in flips {
            v[i] = b;
        }
        v
    })
}

/// Registering a verification key of arbitrary bytes never aborts, and no key
/// that is not the genuine one can ever make the genuine proof verify.
#[test]
fn verifier_set_vk_arbitrary_bytes_never_aborts_or_verifies() {
    let env = fresh_env();
    let c = Contracts::deploy(&env);
    let ct = Symbol::new(&env, "fuzzvk");
    let next_version = std::cell::Cell::new(1u32);
    let genuine_proof = KYC.proof_bytes(&env);
    let genuine_pi = KYC.public_inputs_bytes(&env);

    let strat = prop_oneof![structural_vk(), corrupted_point_vk()];
    runner(costly_cases())
        .run(&strat, |vk| {
            let version = next_version.get();
            next_version.set(version + 1);

            let r = c
                .verifier
                .try_set_vk(&ct, &version, &Bytes::from_slice(&env, &vk));
            assert_no_abort("set_vk", &r)?;

            let r = c
                .verifier
                .try_verify_proof(&ct, &genuine_proof, &genuine_pi, &Some(version));
            assert_no_abort("verify_proof (arbitrary vk)", &r)?;
            if vk != KYC.vk && matches!(r, Ok(Ok(true))) {
                return Err(TestCaseError::fail(
                    "a verification key that is not the genuine one verified the genuine proof",
                ));
            }
            Ok(())
        })
        .unwrap();
}

/// Boundary `version` / `credential_type` arguments on the version-management
/// entry points.
#[test]
fn verifier_version_management_boundaries_never_abort() {
    let env = fresh_env();
    let (c, _issuer) = kyc_stack(&env);
    let strat = (cred_type(), nonzero_u32());

    runner(cheap_cases())
        .run(&strat, |(ct, version)| {
            let ct = Symbol::new(&env, &ct);
            assert_no_abort(
                "set_vk",
                &c.verifier.try_set_vk(&ct, &version, &Bytes::new(&env)),
            )?;
            assert_no_abort(
                "deprecate_version",
                &c.verifier.try_deprecate_version(&ct, &version),
            )?;
            assert_no_abort(
                "prune_version",
                &c.verifier.try_prune_version(&ct, &version),
            )?;
            assert_no_abort(
                "get_latest_version",
                &c.verifier.try_get_latest_version(&ct),
            )?;
            assert_no_abort(
                "refresh_latest_version_ttl",
                &c.verifier.try_refresh_latest_version_ttl(&ct),
            )?;
            Ok(())
        })
        .unwrap();
}

// ---------------------------------------------------------------------------
// proof_registry
// ---------------------------------------------------------------------------

/// `submit_proof` with arbitrary credential type, issuer, proof bytes, public
/// inputs, version and expiry.
#[test]
fn registry_submit_proof_never_aborts() {
    let env = fresh_env();
    let (c, issuer) = kyc_stack(&env);
    let strat = (
        cred_type(),
        any::<bool>(),
        genuine_or_near(KYC.proof, 2 * real_len(&KYC)),
        genuine_or_near(KYC.public_inputs, 4096),
        prop_oneof![2 => Just(None), 1 => nonzero_u32().prop_map(Some)],
        expiry(),
    );

    runner(costly_cases())
        .run(&strat, |(ct, known_issuer, proof, pi, version, expiry)| {
            let holder = Address::generate(&env);
            let who = if known_issuer {
                issuer.clone()
            } else {
                Address::generate(&env)
            };
            let ct = Symbol::new(&env, &ct);
            let r = c.registry.try_submit_proof(
                &holder,
                &who,
                &ct,
                &Bytes::from_slice(&env, &proof),
                &Bytes::from_slice(&env, &pi),
                &version,
                &expiry,
            );
            assert_no_abort("submit_proof", &r)?;

            // Only the genuine statement may ever be accepted.
            if pi != KYC.public_inputs && matches!(r, Ok(Ok(()))) {
                return Err(TestCaseError::fail(
                    "submit_proof accepted a non-genuine statement",
                ));
            }
            Ok(())
        })
        .unwrap();
}

/// A *genuine* proof submitted with boundary expiries: either rejected with a
/// contract error or stored with the expiry the caller asked for.
#[test]
fn registry_submit_proof_boundary_expiry_is_consistent() {
    let env = fresh_env();
    let (c, issuer) = kyc_stack(&env);

    runner(costly_cases())
        .run(&expiry(), |expiry| {
            let holder = Address::generate(&env);
            let r = c.registry.try_submit_proof(
                &holder,
                &issuer,
                &KYC.ct(&env),
                &KYC.proof_bytes(&env),
                &KYC.public_inputs_bytes(&env),
                &None,
                &expiry,
            );
            assert_no_abort("submit_proof (genuine)", &r)?;

            let in_window = expiry > NOW && expiry <= NOW + MAX_TTL;
            prop_assert_eq!(
                matches!(r, Ok(Ok(()))),
                in_window,
                "expiry {} accepted/rejected inconsistently with the (now, now+1y] window",
                expiry
            );
            if in_window {
                prop_assert_eq!(c.registry.claim_expiry(&holder, &KYC.ct(&env)), expiry);
            }
            Ok(())
        })
        .unwrap();
}

/// `submit_proofs` with arbitrary batches: length 0..=MAX+2, duplicate types,
/// arbitrary `Vec<u32>` public inputs, arbitrary proofs and expiries.
#[test]
fn registry_submit_proofs_batch_never_aborts() {
    let env = fresh_env();
    let (c, issuer) = kyc_stack(&env);
    let item = (
        cred_type(),
        bytes_near(KYC.proof, 2 * real_len(&KYC)),
        vec(any::<u32>(), 0..200),
        any::<bool>(),
        expiry(),
        prop_oneof![Just(None), nonzero_u32().prop_map(Some)],
    );
    let strat = vec(item, 0..=MAX_BATCH + 2);

    runner(costly_cases())
        .run(&strat, |items| {
            let holder = Address::generate(&env);
            let mut subs = SorobanVec::new(&env);
            for (ct, proof, pi, known, expiry, version) in items {
                subs.push_back(ProofSubmission {
                    credential_type: Symbol::new(&env, &ct),
                    proof: Bytes::from_slice(&env, &proof),
                    public_inputs: SorobanVec::from_slice(&env, &pi),
                    issuer_id: if known {
                        issuer.clone()
                    } else {
                        Address::generate(&env)
                    },
                    expiry,
                    vk_version: version,
                });
            }
            let r = c.registry.try_submit_proofs(&holder, &subs);
            assert_no_abort("submit_proofs", &r)?;
            Ok(())
        })
        .unwrap();
}

/// `submit_aggregate_proof` with arbitrary/mutated proof and public inputs
/// and arbitrary slot vectors (length mismatches included).
#[test]
fn registry_submit_aggregate_proof_never_aborts() {
    let env = fresh_env();
    let c = Contracts::deploy(&env);
    let issuer = c.enable(&env, &KYC);
    c.set_vk(&env, &AGGREGATE, 1);

    let strat = (
        genuine_or_near(AGGREGATE.proof, 2 * real_len(&AGGREGATE)),
        genuine_or_near(AGGREGATE.public_inputs, 8192),
        vec((cred_type(), any::<bool>(), expiry()), 0..=MAX_BATCH + 2),
    );

    runner(costly_cases())
        .run(&strat, |(proof, pi, slots)| {
            let holder = Address::generate(&env);
            let (mut issuers, mut types, mut expiries) = (
                SorobanVec::new(&env),
                SorobanVec::new(&env),
                SorobanVec::new(&env),
            );
            for (ct, known, expiry) in slots {
                issuers.push_back(if known {
                    issuer.clone()
                } else {
                    Address::generate(&env)
                });
                types.push_back(Symbol::new(&env, &ct));
                expiries.push_back(expiry);
            }
            let r = c.registry.try_submit_aggregate_proof(
                &holder,
                &issuers,
                &types,
                &Bytes::from_slice(&env, &proof),
                &Bytes::from_slice(&env, &pi),
                &expiries,
            );
            assert_no_abort("submit_aggregate_proof", &r)?;
            Ok(())
        })
        .unwrap();
}

/// Nullifier entry points take raw 32-byte values; any value must be handled,
/// and a nullifier is single-use per application context.
#[test]
fn registry_nullifiers_arbitrary_32_bytes() {
    let env = fresh_env();
    let (c, _issuer) = kyc_stack(&env);

    runner(cheap_cases())
        .run(&(key32(), key32()), |(ctx, nullifier)| {
            let (ctx, nullifier) = (b32(&env, &ctx), b32(&env, &nullifier));
            assert_no_abort(
                "is_nullifier_used",
                &c.registry.try_is_nullifier_used(&ctx, &nullifier),
            )?;

            let first = c.registry.try_record_nullifier(&ctx, &nullifier);
            assert_no_abort("record_nullifier", &first)?;
            let second = c.registry.try_record_nullifier(&ctx, &nullifier);
            assert_no_abort("record_nullifier (replay)", &second)?;

            // Replay of a recorded nullifier must be rejected, and it must be
            // reported as used afterwards.
            if matches!(first, Ok(Ok(()))) {
                prop_assert!(
                    !matches!(second, Ok(Ok(()))),
                    "nullifier replay was accepted"
                );
                prop_assert!(c.registry.is_nullifier_used(&ctx, &nullifier));
            }
            Ok(())
        })
        .unwrap();
}

/// Read / claim-check / revoke paths with boundary thresholds and arbitrary
/// credential types against a holder that does and does not hold a claim.
#[test]
fn registry_claim_queries_and_revocation_never_abort() {
    let env = fresh_env();
    let (c, issuer) = kyc_stack(&env);
    let verified = Address::generate(&env);
    c.submit(&env, &verified, &issuer, &KYC, NOW + 1_000);

    let strat = (
        cred_type(),
        any::<bool>(),
        prop_oneof![
            Just(None),
            Just(Some(0u64)),
            Just(Some(u64::MAX)),
            any::<Option<u64>>()
        ],
        prop_oneof![Just(None), any::<bool>().prop_map(Some)],
    );

    runner(cheap_cases())
        .run(&strat, |(ct, use_verified, threshold, trusted)| {
            let holder = if use_verified {
                verified.clone()
            } else {
                Address::generate(&env)
            };
            let ct = Symbol::new(&env, &ct);
            let trusted = trusted.map(|include| {
                let mut v = SorobanVec::new(&env);
                v.push_back(if include {
                    issuer.clone()
                } else {
                    Address::generate(&env)
                });
                v
            });

            assert_no_abort(
                "check_claim",
                &c.registry
                    .try_check_claim(&holder, &ct, &threshold, &trusted),
            )?;
            assert_no_abort(
                "is_verified",
                &c.registry.try_is_verified(&holder, &ct, &trusted),
            )?;
            assert_no_abort("get_record", &c.registry.try_get_record(&holder, &ct))?;
            assert_no_abort("claim_expiry", &c.registry.try_claim_expiry(&holder, &ct))?;
            assert_no_abort("bump_claim", &c.registry.try_bump_claim(&holder, &ct))?;
            assert_no_abort(
                "migrate_record",
                &c.registry.try_migrate_record(&holder, &ct),
            )?;
            // Revoke the throwaway holders only; the shared verified holder
            // must stay usable for the remaining cases.
            if !use_verified {
                assert_no_abort("revoke_proof", &c.registry.try_revoke_proof(&holder, &ct))?;
                assert_no_abort("revoke_all", &c.registry.try_revoke_all(&holder))?;
            }
            Ok(())
        })
        .unwrap();
}

// ---------------------------------------------------------------------------
// issuer_registry
// ---------------------------------------------------------------------------

/// Issuer registration and key management with arbitrary 64-byte keys and
/// credential-type lists, plus the paged reads with boundary offsets.
#[test]
fn issuer_registry_keys_and_paging_never_abort() {
    let env = fresh_env();
    let c = Contracts::deploy(&env);
    let strat = (
        key64(),
        key64(),
        vec(cred_type(), 0..8),
        any::<u64>(),
        prop_oneof![Just(0u32), Just(1), Just(u32::MAX), any::<u32>()],
        prop_oneof![Just(0u32), Just(1), Just(u32::MAX), any::<u32>()],
    );

    runner(cheap_cases())
        .run(
            &strat,
            |(key_a, key_b, types, valid_until, start, limit)| {
                let issuer = Address::generate(&env);
                let (key_a, key_b) = (b64(&env, &key_a), b64(&env, &key_b));
                let mut cts = SorobanVec::new(&env);
                for t in &types {
                    cts.push_back(Symbol::new(&env, t));
                }

                assert_no_abort(
                    "register_issuer",
                    &c.issuers.try_register_issuer(&issuer, &key_a, &cts),
                )?;
                assert_no_abort(
                    "is_valid_issuer_key",
                    &c.issuers.try_is_valid_issuer_key(&issuer, &key_a),
                )?;
                assert_no_abort(
                    "rotate_issuer_key",
                    &c.issuers
                        .try_rotate_issuer_key(&issuer, &key_b, &valid_until),
                )?;
                assert_no_abort(
                    "revoke_issuer_key",
                    &c.issuers.try_revoke_issuer_key(&issuer, &key_a),
                )?;
                assert_no_abort("get_issuer_keys", &c.issuers.try_get_issuer_keys(&issuer))?;
                assert_no_abort(
                    "get_issuer_pubkey",
                    &c.issuers.try_get_issuer_pubkey(&issuer),
                )?;
                assert_no_abort(
                    "get_issuers_page",
                    &c.issuers.try_get_issuers_page(&start, &limit),
                )?;
                assert_no_abort(
                    "refresh_issuer_keys_ttl",
                    &c.issuers.try_refresh_issuer_keys_ttl(&issuer),
                )?;
                for t in &types {
                    assert_no_abort(
                        "is_valid_issuer",
                        &c.issuers
                            .try_is_valid_issuer(&issuer, &Symbol::new(&env, t)),
                    )?;
                }
                assert_no_abort("revoke_issuer", &c.issuers.try_revoke_issuer(&issuer))?;
                Ok(())
            },
        )
        .unwrap();
}

/// Issuer metadata strings are arbitrary bytes (not necessarily UTF-8, up to
/// several KiB); they must be stored or rejected, never abort the contract.
#[test]
fn issuer_registry_metadata_arbitrary_strings_never_abort() {
    let env = fresh_env();
    let c = Contracts::deploy(&env);
    let issuer = Address::generate(&env);
    let mut cts = SorobanVec::new(&env);
    cts.push_back(Symbol::new(&env, "kyc"));
    c.issuers
        .register_issuer(&issuer, &BytesN::from_array(&env, &[7u8; 64]), &cts);

    let opt_str = || prop_oneof![Just(None), raw_bytes(256, 4096).prop_map(Some)];
    runner(cheap_cases())
        .run(&(opt_str(), opt_str(), opt_str()), |(name, url, logo)| {
            let to = |o: Option<Vec<u8>>| o.map(|b| SorobanString::from_bytes(&env, &b));
            let r = c
                .issuers
                .try_set_issuer_metadata(&issuer, &to(name), &to(url), &to(logo));
            assert_no_abort("set_issuer_metadata", &r)?;
            assert_no_abort(
                "get_issuer_metadata",
                &c.issuers.try_get_issuer_metadata(&issuer),
            )?;
            Ok(())
        })
        .unwrap();
}

// ---------------------------------------------------------------------------
// gated_pool
// ---------------------------------------------------------------------------

/// Arbitrary `i128` amounts (including `i128::MIN/MAX`) through deposit and
/// withdraw: no aborts, and the balance always matches a checked-arithmetic
/// model — i.e. an overflowing deposit is rejected, not wrapped or panicked.
#[test]
fn pool_amount_boundaries_never_abort_and_match_model() {
    let env = fresh_env();
    let (c, issuer) = kyc_stack(&env);
    let holder = Address::generate(&env);
    c.submit(&env, &holder, &issuer, &KYC, NOW + 1_000);

    let ops = vec((any::<bool>(), amount()), 1..10);
    runner(cheap_cases())
        .run(&ops, |ops| {
            let pool = c.deploy_pool(&env, "kyc", None);
            let mut model: i128 = 0;
            for (is_deposit, amt) in ops {
                if is_deposit {
                    let r = pool.try_deposit(&holder, &amt);
                    assert_no_abort("deposit", &r)?;
                    if matches!(r, Ok(Ok(()))) {
                        model = model.checked_add(amt).filter(|_| amt > 0).ok_or_else(|| {
                            TestCaseError::fail(
                                "deposit succeeded although it overflows or is non-positive",
                            )
                        })?;
                    }
                } else {
                    let r = pool.try_withdraw(&holder, &amt);
                    assert_no_abort("withdraw", &r)?;
                    if matches!(r, Ok(Ok(()))) {
                        prop_assert!(amt > 0 && amt <= model, "withdraw succeeded beyond balance");
                        model -= amt;
                    }
                }
                prop_assert_eq!(pool.get_balance(&holder), model);
            }
            Ok(())
        })
        .unwrap();
}

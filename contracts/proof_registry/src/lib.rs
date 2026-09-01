#![no_std]
// The `submit_proof` function requires `env` + 7 domain parameters; grouping
// them into a request struct would change the on-chain ABI that callers depend
// on. The lint fires through macro expansion (contractimpl / contractclient),
// where item-level #[allow] attributes are not propagated, so we suppress it
// at the crate level here.
#![allow(clippy::too_many_arguments)]
//! ProofRegistry
//!
//! Caches successful verifications so protocols don't re-run the (expensive)
//! UltraHonk verifier on every interaction. A holder proves once; the registry
//! records "this address satisfies credential X until ledger time T". Any gated
//! protocol then makes a single cheap `is_verified` call.
//!
//! On `submit_proof` the registry (1) checks the named issuer is registered and
//! trusted for the credential type via IssuerRegistry, (2) forwards the proof to
//! CredentialVerifier, and only caches the result if both pass.
//!
//! `submit_proofs_batch` accepts up to 5 `ProofSubmission` entries and verifies
//! and stores all of them atomically: if any single proof fails the entire call
//! reverts, saving the holder from multiple wallet confirmations and fee payments.
//!
//! `submit_aggregate_proof` verifies a single aggregate proof covering N
//! credential types (N=2 PoC: KYC + age) and stores all claims atomically.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Bytes, BytesN, Env, Map, Symbol, Val, Vec,
};

// ── Event topic constants ────────────────────────────────────────────────────

// NOTE: `#[contractevent]` (the newer Soroban SDK macro for typed events) is
// deliberately not used here. `#[contractevent]` derives fixed topic values
// from the type/field names and doesn't support runtime-composed topic tuples
// like `(symbol_short!("proof_reg"), symbol_short!("submitted"), credential_type)`.
// We publish through `env.events().publish` directly instead, which triggers
// the SDK's deprecation warning — hence `#[allow(deprecated)]` on every method
// that emits an event. Revisit if the SDK adds dynamic-topic support to
// `#[contractevent]`.

/// Payload emitted when a proof is successfully verified and stored.
#[contracttype]
#[derive(Clone)]
pub struct EventProofSubmitted {
    pub holder: Address,
    pub issuer: Address,
    pub verified_at: u64,
    pub expiry: u64,
}

/// Payload emitted when an issuer revokes a holder's proof.
#[contracttype]
#[derive(Clone)]
pub struct EventProofRevoked {
    pub holder: Address,
    pub issuer: Address,
    pub revoked_at: u64,
}

/// Payload emitted when submissions are paused by admin.
#[contracttype]
#[derive(Clone)]
pub struct EventPaused {
    pub admin: Address,
    pub paused_at: u64,
}

/// Payload emitted when submissions are unpaused by admin.
#[contracttype]
#[derive(Clone)]
pub struct EventUnpaused {
    pub admin: Address,
    pub unpaused_at: u64,
}

/// Payload emitted when a holder grants a verifier delegated read access
/// (#396). `credential_type` is already in the event topic tuple, matching
/// `EventProofSubmitted`'s convention, so it isn't repeated here.
#[contracttype]
#[derive(Clone)]
pub struct EventVerificationGranted {
    pub holder: Address,
    pub verifier: Address,
    pub expiry: u64,
}

/// Payload emitted when a holder revokes a previously-granted delegation.
#[contracttype]
#[derive(Clone)]
pub struct EventVerificationRevoked {
    pub holder: Address,
    pub verifier: Address,
}

// Persistent-entry lifetime management
const DAY_IN_LEDGERS: u32 = 17280;
const SECONDS_PER_LEDGER: u64 = 5;
const PROOF_BUMP_THRESHOLD: u32 = DAY_IN_LEDGERS;
const PROOF_TTL: u32 = 90 * DAY_IN_LEDGERS;
const MAX_CREDENTIAL_TTL_SECS: u64 = 365 * 86_400; // 1 year, in seconds

/// Maximum number of submissions accepted by `submit_proofs_batch`.
const MAX_BATCH_SIZE: u32 = 5;

// ── Aggregate proof public-input layout (N=2: KYC + age) ────────────────────
// The aggregate_proof circuit packs N credential public inputs sequentially,
// followed by num_credentials as the last field.
//
// KYC (65 fields): commitment(1) + issuer_x(32) + issuer_y(32)
// Age  (67 fields): commitment(1) + issuer_x(32) + issuer_y(32) +
//                    current_date(1) + threshold_years(1)
//
// Field indices (0-based) within public_inputs.
// These constants document the fixed layout for auditors; runtime logic uses
// `field_offset + aggregate_field_count` instead of referencing them directly.
#[allow(dead_code)]
const AGG_FIELD_KYC_START: u32 = 0;
#[allow(dead_code)]
const AGG_FIELD_KYC_PUBKEY: u32 = 1;
#[allow(dead_code)]
const AGG_FIELD_AGE_START: u32 = 65;
#[allow(dead_code)]
const AGG_FIELD_AGE_PUBKEY: u32 = 66;
#[allow(dead_code)] // AGG_FIELD_AGE_START(65) + 1 + 32 + 32 + 1 = 131
const AGG_FIELD_AGE_THRESHOLD: u32 = 131;
const AGG_FIELD_NUM_CREDENTIALS: u32 = 132;

/// Typed client for the deployed CredentialVerifier contract.
#[contractclient(name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify_proof(
        env: Env,
        credential_type: Symbol,
        proof: Bytes,
        public_inputs: Bytes,
        vk_version: Option<u32>,
    ) -> bool;
}

/// Typed client for the deployed IssuerRegistry contract.
#[contractclient(name = "IssuerClient")]
pub trait IssuerRegistryInterface {
    fn is_valid_issuer(env: Env, issuer_id: Address, credential_type: Symbol) -> bool;
    fn get_issuer_pubkey(env: Env, issuer_id: Address) -> BytesN<64>;
}

const PUBKEY_START_FIELD: u32 = 1;
const FIELD_BYTES: u32 = 32;

#[contracttype]
#[derive(Clone)]
pub struct ProofRecord {
    pub verified_at: u64,
    pub expiry: u64,
    pub threshold: Option<u64>,
    pub revoked: bool,
    pub issuer: Option<Address>,
    pub vk_version: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct LegacyProofRecord {
    pub verified_at: u64,
    pub expiry: u64,
    pub threshold: Option<u64>,
    pub revoked: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct ProofSubmission {
    pub credential_type: Symbol,
    pub proof: Bytes,
    pub public_inputs: Vec<u32>,
    pub issuer_id: Address,
    pub expiry: u64,
    pub vk_version: Option<u32>,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Verifier,
    IssuerRegistry,
    Paused,
    Proof(Address, Symbol),
    /// (holder, verifier, credential_type) -> expiry (unix seconds). A
    /// scoped, time-boxed grant letting `verifier` read `holder`'s
    /// `credential_type` result via `check_delegated_verification` (#396).
    Delegation(Address, Address, Symbol),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    VerificationFailed = 2,
    NotAuthorized = 3,
    IssuerNotTrusted = 4,
    IssuerKeyMismatch = 5,
    ProofNotFound = 6,
    BatchTooLarge = 7,
    BatchEmpty = 8,
    DuplicateCredentialType = 9,
    AggregateLayoutInvalid = 10,
    SubmissionsPaused = 11,
    /// `expiry` is not in the future, or is too far in the future.
    InvalidExpiry = 12,
}

#[contract]
pub struct ProofRegistry;

fn vec_u32_to_bytes(env: &Env, vec: &Vec<u32>) -> Bytes {
    let mut bytes = Bytes::new(env);
    for val in vec.iter() {
        bytes.append(&Bytes::from_array(env, &val.to_be_bytes()));
    }
    bytes
}

#[contractimpl]
impl ProofRegistry {
    pub fn __constructor(env: Env, admin: Address, verifier: Address, issuer_registry: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage()
            .instance()
            .set(&DataKey::IssuerRegistry, &issuer_registry);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    #[allow(deprecated)]
    pub fn pause(env: Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish(
            (symbol_short!("proof_reg"), symbol_short!("paused")),
            EventPaused {
                admin,
                paused_at: env.ledger().timestamp(),
            },
        );
    }

    #[allow(deprecated)]
    pub fn unpause(env: Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(
            (symbol_short!("proof_reg"), symbol_short!("unpaused")),
            EventUnpaused {
                admin,
                unpaused_at: env.ledger().timestamp(),
            },
        );
    }

    /// Verify a proof and, if valid, cache it for `holder` until `expiry`.
    #[allow(deprecated)]
    pub fn submit_proof(
        env: Env,
        holder: Address,
        issuer_id: Address,
        credential_type: Symbol,
        proof: Bytes,
        public_inputs: Bytes,
        vk_version: Option<u32>,
        expiry: u64,
    ) {
        holder.require_auth();
        Self::ensure_not_paused(&env);
        Self::validate_expiry(&env, expiry);

        let registry = IssuerClient::new(&env, &Self::issuer_registry(&env));
        if !registry.is_valid_issuer(&issuer_id, &credential_type) {
            panic_with_error!(&env, Error::IssuerNotTrusted);
        }

        let expected = registry.get_issuer_pubkey(&issuer_id);
        if !Self::public_inputs_match_pubkey(&public_inputs, &expected) {
            panic_with_error!(&env, Error::IssuerKeyMismatch);
        }

        let verifier = VerifierClient::new(&env, &Self::verifier(&env));
        if !verifier.verify_proof(&credential_type, &proof, &public_inputs, &vk_version) {
            panic_with_error!(&env, Error::VerificationFailed);
        }

        let key = DataKey::Proof(holder.clone(), credential_type.clone());
        let record = ProofRecord {
            verified_at: env.ledger().timestamp(),
            expiry,
            threshold: Self::extract_threshold(&env, &credential_type, &public_inputs),
            revoked: false,
            issuer: Some(issuer_id),
            vk_version: vk_version.unwrap_or(0),
        };
        env.storage().persistent().set(&key, &record);
        Self::bump_ttl(&env, &key, expiry);

        env.events().publish(
            (
                symbol_short!("proof_reg"),
                symbol_short!("submitted"),
                credential_type,
            ),
            EventProofSubmitted {
                holder,
                issuer: record.issuer.unwrap(),
                verified_at: record.verified_at,
                expiry: record.expiry,
            },
        );
    }

    /// Batch submission - one event per credential.
    #[allow(deprecated)]
    pub fn submit_proofs(
        env: Env,
        holder: Address,
        submissions: Vec<ProofSubmission>,
    ) -> Vec<bool> {
        holder.require_auth();
        Self::ensure_not_paused(&env);

        let len = submissions.len();
        if len == 0 {
            panic_with_error!(&env, Error::BatchEmpty);
        }
        if len > MAX_BATCH_SIZE {
            panic_with_error!(&env, Error::BatchTooLarge);
        }

        for i in 0..len {
            for j in (i + 1)..len {
                if submissions.get(i).unwrap().credential_type
                    == submissions.get(j).unwrap().credential_type
                {
                    panic_with_error!(&env, Error::DuplicateCredentialType);
                }
            }
        }

        let issuer_registry_addr = Self::issuer_registry(&env);
        let verifier_addr = Self::verifier(&env);
        let registry = IssuerClient::new(&env, &issuer_registry_addr);
        let verifier = VerifierClient::new(&env, &verifier_addr);

        let now = env.ledger().timestamp();

        for sub in submissions.iter() {
            Self::validate_expiry(&env, sub.expiry);
            let public_inputs_bytes = vec_u32_to_bytes(&env, &sub.public_inputs);

            if !registry.is_valid_issuer(&sub.issuer_id, &sub.credential_type) {
                panic_with_error!(&env, Error::IssuerNotTrusted);
            }

            let expected = registry.get_issuer_pubkey(&sub.issuer_id);
            if !Self::public_inputs_match_pubkey(&public_inputs_bytes, &expected) {
                panic_with_error!(&env, Error::IssuerKeyMismatch);
            }

            if !verifier.verify_proof(
                &sub.credential_type,
                &sub.proof,
                &public_inputs_bytes,
                &sub.vk_version,
            ) {
                panic_with_error!(&env, Error::VerificationFailed);
            }

            let key = DataKey::Proof(holder.clone(), sub.credential_type.clone());
            let effective_version = sub.vk_version.unwrap_or(0);
            let record = ProofRecord {
                verified_at: now,
                expiry: sub.expiry,
                threshold: Self::extract_threshold(
                    &env,
                    &sub.credential_type,
                    &public_inputs_bytes,
                ),
                revoked: false,
                issuer: Some(sub.issuer_id.clone()),
                vk_version: effective_version,
            };
            env.storage().persistent().set(&key, &record);
            Self::bump_ttl(&env, &key, sub.expiry);

            env.events().publish(
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("submitted"),
                    sub.credential_type.clone(),
                ),
                EventProofSubmitted {
                    holder: holder.clone(),
                    issuer: record.issuer.clone().unwrap(),
                    verified_at: record.verified_at,
                    expiry: record.expiry,
                },
            );
        }

        let mut results = Vec::new(&env);
        for _ in 0..len {
            results.push_back(true);
        }
        results
    }

    /// Aggregate proof submission with per-credential expiries.
    #[allow(deprecated)]
    pub fn submit_aggregate_proof(
        env: Env,
        holder: Address,
        issuer_ids: Vec<Address>,
        credential_types: Vec<Symbol>,
        proof: Bytes,
        public_inputs: Bytes,
        expiries: Vec<u64>,
    ) {
        holder.require_auth();
        Self::ensure_not_paused(&env);

        let verifier = VerifierClient::new(&env, &Self::verifier(&env));
        if !verifier.verify_proof(&symbol_short!("aggregate"), &proof, &public_inputs, &None) {
            panic_with_error!(&env, Error::VerificationFailed);
        }

        let num = Self::read_u64_field(&public_inputs, AGG_FIELD_NUM_CREDENTIALS);
        if num != credential_types.len() as u64
            || num < 2
            || num > MAX_BATCH_SIZE as u64
            || issuer_ids.len() != credential_types.len()
            || expiries.len() != credential_types.len()
        {
            panic_with_error!(&env, Error::AggregateLayoutInvalid);
        }

        for expiry in expiries.iter() {
            Self::validate_expiry(&env, expiry);
        }

        let registry = IssuerClient::new(&env, &Self::issuer_registry(&env));
        let now = env.ledger().timestamp();

        let mut field_offset: u32 = 0;
        for i in 0..credential_types.len() {
            let ct = credential_types.get(i).unwrap();
            let issuer = issuer_ids.get(i).unwrap();

            if !registry.is_valid_issuer(&issuer, &ct) {
                panic_with_error!(&env, Error::IssuerNotTrusted);
            }

            let expected = registry.get_issuer_pubkey(&issuer);
            if !Self::aggregate_pubkey_match(&public_inputs, field_offset + 1, &expected) {
                panic_with_error!(&env, Error::IssuerKeyMismatch);
            }

            let threshold =
                Self::extract_threshold_from_aggregate(&ct, &public_inputs, field_offset);
            Self::store_claim(&env, &holder, &ct, now, expiries.get(i).unwrap(), threshold, issuer.clone());

            env.events().publish(
                (
                    symbol_short!("proof_reg"),
                    symbol_short!("submitted"),
                    ct.clone(),
                ),
                EventProofSubmitted {
                    holder: holder.clone(),
                    issuer: issuer.clone(),
                    verified_at: now,
                    expiry: expiries.get(i).unwrap(),
                },
            );

            field_offset += Self::aggregate_field_count(&ct);
        }
    }

    /// Read-only verification check for `holder`'s cached `credential_type` claim.
    ///
    /// Returns `(valid, verified_at, expiry)`:
    /// - `valid` is `true` only if the record exists, is not revoked, has not
    ///   passed `expiry`, and (if `trusted_issuers` is provided) was issued by
    ///   one of the addresses in that list.
    /// - `verified_at` / `expiry` are returned even when `valid` is `false`
    ///   (e.g. an expired or untrusted-issuer record still reports its stored
    ///   timestamps), so callers can distinguish "never submitted" (both `0`)
    ///   from "submitted but no longer valid".
    ///
    /// `trusted_issuers`:
    /// - `None` accepts a claim from any issuer registered at submission time.
    /// - `Some(list)` restricts acceptance to issuers in `list`; a record with
    ///   no stored issuer (e.g. an un-migrated legacy record) is rejected.
    pub fn is_verified(
        env: Env,
        holder: Address,
        credential_type: Symbol,
        trusted_issuers: Option<Vec<Address>>,
    ) -> (bool, u64, u64) {
        match env
            .storage()
            .persistent()
            .get::<_, ProofRecord>(&DataKey::Proof(holder, credential_type))
        {
            Some(r) => {
                let valid = !r.revoked
                    && r.expiry > env.ledger().timestamp()
                    && Self::issuer_is_trusted(&trusted_issuers, &r.issuer);
                (valid, r.verified_at, r.expiry)
            }
            None => (false, 0, 0),
        }
    }

    /// Grant `verifier` a scoped, time-boxed right to read `holder`'s
    /// `credential_type` result via `check_delegated_verification`, until
    /// `expiry` (#396). Purely additive: `is_verified` remains a public read
    /// exactly as before for every caller — this is a discoverable,
    /// on-chain consent record apps can condition *their own* gated
    /// experiences on, not a change to the underlying read's semantics
    /// (Soroban storage has no confidentiality to gate in the first place).
    /// Granting the same (holder, verifier, credential_type) again simply
    /// overwrites the previous expiry.
    #[allow(deprecated)]
    pub fn grant_verification(
        env: Env,
        holder: Address,
        verifier: Address,
        credential_type: Symbol,
        expiry: u64,
    ) {
        holder.require_auth();
        Self::validate_expiry(&env, expiry);

        let key = DataKey::Delegation(holder.clone(), verifier.clone(), credential_type.clone());
        env.storage().persistent().set(&key, &expiry);
        Self::bump_ttl(&env, &key, expiry);

        env.events().publish(
            (
                symbol_short!("proof_reg"),
                symbol_short!("dlg_grant"),
                credential_type,
            ),
            EventVerificationGranted {
                holder,
                verifier,
                expiry,
            },
        );
    }

    /// Revoke a previously-granted delegation. The holder authorizes their
    /// own revocation, same as `revoke_proof`. A no-op (not an error) if no
    /// such delegation exists.
    #[allow(deprecated)]
    pub fn revoke_verification(env: Env, holder: Address, verifier: Address, credential_type: Symbol) {
        holder.require_auth();
        env.storage().persistent().remove(&DataKey::Delegation(
            holder.clone(),
            verifier.clone(),
            credential_type.clone(),
        ));
        env.events().publish(
            (
                symbol_short!("proof_reg"),
                symbol_short!("dlg_revok"),
                credential_type,
            ),
            EventVerificationRevoked { holder, verifier },
        );
    }

    /// `verifier`'s delegated view of `holder`'s `credential_type` result
    /// (#396): returns `is_verified`'s own `(valid, verified_at, expiry)` —
    /// but only if `verifier` currently holds a non-expired
    /// `grant_verification` delegation from `holder` for that credential
    /// type; otherwise `(false, 0, 0)`, mirroring `is_verified`'s own
    /// "never submitted" shape so callers can't distinguish "no delegation"
    /// from "no claim" by shape alone (deliberately — see the module-level
    /// note on this not being a confidentiality boundary).
    pub fn check_delegated_verification(
        env: Env,
        holder: Address,
        verifier: Address,
        credential_type: Symbol,
    ) -> (bool, u64, u64) {
        let now = env.ledger().timestamp();
        let delegation_key =
            DataKey::Delegation(holder.clone(), verifier, credential_type.clone());
        let delegated = match env.storage().persistent().get::<_, u64>(&delegation_key) {
            Some(expiry) => expiry > now,
            None => false,
        };
        if !delegated {
            return (false, 0, 0);
        }
        Self::is_verified(env, holder, credential_type, None)
    }

    pub fn check_claim(
        env: Env,
        holder: Address,
        credential_type: Symbol,
        min_threshold: Option<u64>,
        trusted_issuers: Option<Vec<Address>>,
    ) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, ProofRecord>(&DataKey::Proof(holder, credential_type))
        {
            Some(r) => {
                if r.revoked || r.expiry <= env.ledger().timestamp() {
                    return false;
                }
                if !Self::issuer_is_trusted(&trusted_issuers, &r.issuer) {
                    return false;
                }
                match min_threshold {
                    None => true,
                    Some(min) => r.threshold.unwrap_or(0) >= min,
                }
            }
            None => false,
        }
    }

    pub fn get_record(env: Env, holder: Address, credential_type: Symbol) -> Option<ProofRecord> {
        env.storage()
            .persistent()
            .get::<_, ProofRecord>(&DataKey::Proof(holder, credential_type))
    }

    pub fn claim_expiry(env: Env, holder: Address, credential_type: Symbol) -> u64 {
        let key = DataKey::Proof(holder, credential_type);
        let record = env.storage().persistent().get::<_, ProofRecord>(&key);
        if let Some(ref record) = record {
            Self::bump_ttl(&env, &key, record.expiry);
        }
        record.map(|r| r.expiry).unwrap_or(0)
    }

    pub fn bump_claim(env: Env, holder: Address, credential_type: Symbol) {
        let key = DataKey::Proof(holder, credential_type);
        let record: ProofRecord = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::ProofNotFound));
        if record.revoked || record.expiry <= env.ledger().timestamp() {
            panic_with_error!(&env, Error::ProofNotFound);
        }
        Self::bump_ttl(&env, &key, record.expiry);
    }

    fn issuer_is_trusted(trusted_issuers: &Option<Vec<Address>>, issuer: &Option<Address>) -> bool {
        match trusted_issuers {
            None => true,
            Some(list) => match issuer {
                None => false,
                Some(addr) => list.contains(addr),
            },
        }
    }

    /// Revoke a cached proof. The holder authorizes their own revocation.
    pub fn revoke_proof(env: Env, holder: Address, credential_type: Symbol) {
        holder.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Proof(holder, credential_type));
    }

    pub fn revoke_all(env: Env, holder: Address) {
        holder.require_auth();
        let types = [
            symbol_short!("kyc"),
            symbol_short!("age"),
            symbol_short!("income"),
            Symbol::new(&env, "jurisdiction"),
            symbol_short!("funds"),
            Symbol::new(&env, "accreditation"),
            Symbol::new(&env, "employment"),
        ];
        for t in types {
            env.storage()
                .persistent()
                .remove(&DataKey::Proof(holder.clone(), t));
        }
    }

    #[allow(deprecated)]
    pub fn revoke(env: Env, issuer: Address, holder: Address, credential_type: Symbol) {
        issuer.require_auth();

        let registry = IssuerClient::new(&env, &Self::issuer_registry(&env));
        if !registry.is_valid_issuer(&issuer, &credential_type) {
            panic_with_error!(&env, Error::IssuerNotTrusted);
        }

        let key = DataKey::Proof(holder.clone(), credential_type.clone());
        let mut record: ProofRecord = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::ProofNotFound));
        record.revoked = true;
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, PROOF_BUMP_THRESHOLD, PROOF_TTL);

        // Emit: topics = ("proof_reg", "revoked", credential_type)
        //       data   = EventProofRevoked { holder, issuer, revoked_at }
        env.events().publish(
            (
                symbol_short!("proof_reg"),
                symbol_short!("revoked"),
                credential_type,
            ),
            EventProofRevoked {
                holder,
                issuer,
                revoked_at: env.ledger().timestamp(),
            },
        );
    }

    pub fn migrate_record(env: Env, holder: Address, credential_type: Symbol) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();

        let key = DataKey::Proof(holder.clone(), credential_type.clone());

        let raw_map: Map<Symbol, Val> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::ProofNotFound));

        if raw_map.len() == 4 {
            let legacy: LegacyProofRecord = env.storage().persistent().get(&key).unwrap();

            let record = ProofRecord {
                verified_at: legacy.verified_at,
                expiry: legacy.expiry,
                threshold: legacy.threshold,
                revoked: legacy.revoked,
                issuer: None,
                vk_version: 0,
            };
            env.storage().persistent().set(&key, &record);
            Self::bump_ttl(&env, &key, record.expiry);
        }
    }

    pub fn verifier_address(env: Env) -> Address {
        Self::verifier(&env)
    }

    pub fn issuer_registry_address(env: Env) -> Address {
        Self::issuer_registry(&env)
    }

    fn validate_expiry(env: &Env, expiry: u64) {
        let now = env.ledger().timestamp();
        if expiry <= now {
            panic_with_error!(env, Error::InvalidExpiry);
        }
        if expiry > now.saturating_add(MAX_CREDENTIAL_TTL_SECS) {
            panic_with_error!(env, Error::InvalidExpiry);
        }
    }

    fn extract_threshold(
        env: &Env,
        credential_type: &Symbol,
        public_inputs: &Bytes,
    ) -> Option<u64> {
        if *credential_type == symbol_short!("age") {
            Some(Self::read_u64_field(public_inputs, 66))
        } else if *credential_type == symbol_short!("income")
            || *credential_type == symbol_short!("funds")
            || *credential_type == Symbol::new(env, "accreditation")
            || *credential_type == Symbol::new(env, "employment")
        {
            Some(Self::read_u64_field(public_inputs, 65))
        } else {
            None
        }
    }

    fn read_u64_field(public_inputs: &Bytes, field_index: u32) -> u64 {
        let base = field_index * FIELD_BYTES;
        let mut b = [0u8; 8];
        for i in 0..8u32 {
            b[i as usize] = public_inputs.get(base + 24 + i).unwrap_or(0);
        }
        u64::from_be_bytes(b)
    }

    /// True iff the secp256k1 public key embedded in `public_inputs` (fields
    /// 1..65, one byte per field in the low byte) equals `expected` (x || y).
    fn public_inputs_match_pubkey(public_inputs: &Bytes, expected: &BytesN<64>) -> bool {
        Self::aggregate_pubkey_match(public_inputs, PUBKEY_START_FIELD, expected)
    }

    fn aggregate_pubkey_match(
        public_inputs: &Bytes,
        start_field: u32,
        expected: &BytesN<64>,
    ) -> bool {
        let exp = expected.to_array();
        for i in 0..64u32 {
            let offset = (start_field + i) * FIELD_BYTES + (FIELD_BYTES - 1);
            match public_inputs.get(offset) {
                Some(b) if b == exp[i as usize] => {}
                _ => return false,
            }
        }
        true
    }

    fn store_claim(
        env: &Env,
        holder: &Address,
        credential_type: &Symbol,
        verified_at: u64,
        expiry: u64,
        threshold: Option<u64>,
        issuer: Address,
    ) {
        let key = DataKey::Proof(holder.clone(), credential_type.clone());
        let record = ProofRecord {
            verified_at,
            expiry,
            threshold,
            revoked: false,
            issuer: Some(issuer),
            vk_version: 0,
        };
        env.storage().persistent().set(&key, &record);
        Self::bump_ttl(env, &key, expiry);
    }

    fn bump_ttl(env: &Env, key: &DataKey, expiry: u64) {
        let now = env.ledger().timestamp();
        let seconds_until_expiry = expiry.saturating_sub(now);
        let expiry_ttl = seconds_until_expiry
            .saturating_add(SECONDS_PER_LEDGER - 1)
            .checked_div(SECONDS_PER_LEDGER)
            .unwrap_or(u64::MAX);
        let requested_ttl = u64::from(PROOF_TTL).max(expiry_ttl);
        let ttl = requested_ttl.min(u64::from(u32::MAX)) as u32;
        env.storage()
            .persistent()
            .extend_ttl(key, PROOF_BUMP_THRESHOLD, ttl);
    }

    fn aggregate_field_count(credential_type: &Symbol) -> u32 {
        let base: u32 = 65;
        if *credential_type == symbol_short!("kyc") {
            base
        } else if *credential_type == symbol_short!("age") {
            base + 2
        } else if *credential_type == symbol_short!("income")
            || *credential_type == symbol_short!("funds")
        {
            base + 1
        } else {
            base
        }
    }

    fn extract_threshold_from_aggregate(
        credential_type: &Symbol,
        public_inputs: &Bytes,
        field_offset: u32,
    ) -> Option<u64> {
        if *credential_type == symbol_short!("age") {
            Some(Self::read_u64_field(public_inputs, field_offset + 65 + 1))
        } else if *credential_type == symbol_short!("income")
            || *credential_type == symbol_short!("funds")
        {
            Some(Self::read_u64_field(public_inputs, field_offset + 65))
        } else {
            None
        }
    }

    fn issuer_registry(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::IssuerRegistry)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    fn verifier(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Verifier)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    fn ensure_not_paused(env: &Env) {
        if Self::is_paused(env) {
            panic_with_error!(env, Error::SubmissionsPaused);
        }
    }
}

mod test;

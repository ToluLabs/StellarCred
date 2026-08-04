#![no_std]
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
// Topics follow the convention: (contract, action, credential_type).
// `contract` is always `symbol_short!("proof_reg")` for ProofRegistry events.
// `action`   identifies the operation.
// `credential_type` is the per-event Symbol (e.g. "kyc", "age").

/// Payload emitted when a proof is successfully verified and stored.
/// Topics: ("proof_reg", "submitted", credential_type)
#[contracttype]
#[derive(Clone)]
pub struct EventProofSubmitted {
    /// The holder whose proof was verified.
    pub holder: Address,
    /// The issuer that signed the credential.
    pub issuer: Address,
    /// The ledger timestamp at which verification was recorded.
    pub verified_at: u64,
    /// The expiry timestamp supplied by the holder.
    pub expiry: u64,
}

/// Payload emitted when an issuer revokes a holder's proof.
/// Topics: ("proof_reg", "revoked", credential_type)
#[contracttype]
#[derive(Clone)]
pub struct EventProofRevoked {
    /// The holder whose proof was revoked.
    pub holder: Address,
    /// The issuer that performed the revocation.
    pub issuer: Address,
    /// The ledger timestamp at which the revocation was recorded.
    pub revoked_at: u64,
}

// Persistent-entry lifetime management (~5s ledgers).
const DAY_IN_LEDGERS: u32 = 17280;
const PROOF_BUMP_THRESHOLD: u32 = DAY_IN_LEDGERS;
const PROOF_TTL: u32 = 90 * DAY_IN_LEDGERS;

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
// Field indices (0-based) within public_inputs:
const AGG_FIELD_KYC_START: u32 = 0;
const AGG_FIELD_KYC_PUBKEY: u32 = 1;
const AGG_FIELD_AGE_START: u32 = 65;
const AGG_FIELD_AGE_PUBKEY: u32 = 66;
const AGG_FIELD_AGE_THRESHOLD: u32 = 131; // AGG_FIELD_AGE_START(65)+1+32+32+1=131
const AGG_FIELD_NUM_CREDENTIALS: u32 = 132;

/// Typed client for the deployed CredentialVerifier contract. Declared as an
/// interface (not a crate dependency) so this contract links only the client,
/// never the verifier's exported wasm symbols.
#[contractclient(name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify_proof(env: Env, credential_type: Symbol, proof: Bytes, public_inputs: Bytes, vk_version: Option<u32>) -> bool;
}

/// Typed client for the deployed IssuerRegistry contract.
#[contractclient(name = "IssuerClient")]
pub trait IssuerRegistryInterface {
    fn is_valid_issuer(env: Env, issuer_id: Address, credential_type: Symbol) -> bool;
    fn get_issuer_pubkey(env: Env, issuer_id: Address) -> BytesN<64>;
}

// Public-input layout (each field is 32 bytes, big-endian): field 0 is the
// commitment, fields 1..33 are issuer_x bytes (one byte per field, in the low
// byte), fields 33..65 are issuer_y bytes. The signed public key therefore
// occupies bytes 32..2080 of `public_inputs`.
const PUBKEY_START_FIELD: u32 = 1;
const FIELD_BYTES: u32 = 32;

#[contracttype]
#[derive(Clone)]
pub struct ProofRecord {
    pub verified_at: u64,
    pub expiry: u64,
    /// For parameterised credential types (age, income, funds), the threshold
    /// value that was committed to in the proof's public inputs. None for types
    /// with no numeric threshold (kyc, jurisdiction).
    pub threshold: Option<u64>,
    /// Set by the registered issuer via `revoke`. Expiry data is kept for audit.
    pub revoked: bool,
    /// The issuer that signed the credential this proof was verified against.
    /// Lets a protocol restrict which issuers it trusts per claim type via
    /// `trusted_issuers` on `is_verified` / `check_claim`.
    ///
    /// `Option` so `issuer` can be explicitly absent within an
    /// already-current-shape record (e.g. one written by a future migration
    /// that can't recover the original issuer) — `issuer_is_trusted` then
    /// fails closed and rejects it under an active `trusted_issuers` filter,
    /// since there's no issuer to check against (a filterless caller is
    /// unaffected either way). This does NOT, by itself, make a record
    /// written before this field existed readable: Soroban's struct decoding
    /// requires the stored map's entry count to exactly match the current
    /// struct's field count, so those records still fail to deserialize (see
    /// `legacy_record_missing_issuer_key_fails_to_read` in test.rs). A real
    /// migration is required before redeploying over existing stored proofs.
    pub issuer: Option<Address>,
    /// VK version the proof was verified against at submission time.
    /// `0` is the sentinel for "latest at submission time" (the caller passed
    /// `vk_version = None` and the verifier resolved the newest version).
    /// Stored so a proof submitted against an older circuit version remains
    /// auditable — and valid — after the circuit is upgraded.
    pub vk_version: u32,
}

/// A legacy 4-field record shape from before `ProofRecord` gained the `issuer`
/// field (and later the `vk_version` field). Used by `migrate_record` to read
/// records stored under the old schema and rewrite them into the current
/// 6-field `ProofRecord` layout.
#[contracttype]
#[derive(Clone)]
pub struct LegacyProofRecord {
    pub verified_at: u64,
    pub expiry: u64,
    pub threshold: Option<u64>,
    pub revoked: bool,
}

/// A single proof submission inside a batch. Mirrors the individual parameters
/// of `submit_proof` but grouped into a struct so they can be passed as a `Vec`.
#[contracttype]
#[derive(Clone)]
pub struct ProofSubmission {
    pub credential_type: Symbol,
    pub proof: Bytes,
    pub public_inputs: Vec<u32>,
    pub issuer_id: Address,
    pub expiry: u64,
    /// VK version to use for verification. `None` defaults to the latest
    /// registered version (recommended for new submissions).
    pub vk_version: Option<u32>,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Verifier,
    IssuerRegistry,
    /// Cached verification, keyed by (holder, credential_type).
    Proof(Address, Symbol),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    VerificationFailed = 2,
    NotAuthorized = 3,
    IssuerNotTrusted = 4,
    /// The public key the proof was made against does not match the registered
    /// issuer's key.
    IssuerKeyMismatch = 5,
    ProofNotFound = 6,
    /// The batch contains more than `MAX_BATCH_SIZE` submissions.
    BatchTooLarge = 7,
    /// The batch must contain at least one submission.
    BatchEmpty = 8,
    /// Two or more submissions in the batch share the same `credential_type`;
    /// only the last write would survive, so the batch is rejected outright.
    DuplicateCredentialType = 9,
    /// The aggregate proof's num_credentials field doesn't match the expected
    /// count or the inner public inputs are too short.
    AggregateLayoutInvalid = 10,
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
    /// `admin`, `verifier` and `issuer_registry` are the deployed contract addresses.
    pub fn __constructor(env: Env, admin: Address, verifier: Address, issuer_registry: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage()
            .instance()
            .set(&DataKey::IssuerRegistry, &issuer_registry);
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

    /// Verify a proof and, if valid, cache it for `holder` until `expiry`
    /// (ledger timestamp, seconds). The holder authorizes their own submission.
    /// `issuer_id` must be registered and trusted for `credential_type`.
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

        // 1. The named issuer must be trusted for this credential type.
        let registry = IssuerClient::new(&env, &Self::issuer_registry(&env));
        if !registry.is_valid_issuer(&issuer_id, &credential_type) {
            panic_with_error!(&env, Error::IssuerNotTrusted);
        }

        // 2. The public key the proof attests to (in its public inputs) must be
        //    the registered issuer's key.
        let expected = registry.get_issuer_pubkey(&issuer_id);
        if !Self::public_inputs_match_pubkey(&public_inputs, &expected) {
            panic_with_error!(&env, Error::IssuerKeyMismatch);
        }

        // 3. The proof must verify against the registered VK for this type.
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
            // 0 = "latest at submission time" (see ProofRecord::vk_version).
            vk_version: vk_version.unwrap_or(0),
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, PROOF_BUMP_THRESHOLD, PROOF_TTL);

        // Emit: topics = ("proof_reg", "submitted", credential_type)
        //       data   = EventProofSubmitted { holder, issuer, verified_at, expiry }
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

    /// One event is emitted per successfully verified credential.
    /// Topics: ("proof_reg", "submitted", credential_type)
    /// Data:   EventProofSubmitted { holder, issuer, verified_at, expiry }
    // NOTE: We suppress the deprecation warning for `env.events().publish` here. 
    // The idiomatic Soroban v26 replacement is to define a typed event struct using the 
    // `#[contractevent]` macro; however, since the existing codebase uniformly uses the 
    // value-based `publish` API, we maintain consistency with other modules to avoid 
    // introducing architectural mismatch.
    #[allow(deprecated)]
    pub fn submit_proofs(env: Env, holder: Address, submissions: Vec<ProofSubmission>) -> Vec<bool> {
        holder.require_auth();

        let len = submissions.len();
        if len == 0 {
            panic_with_error!(&env, Error::BatchEmpty);
        }
        if len > MAX_BATCH_SIZE {
            panic_with_error!(&env, Error::BatchTooLarge);
        }

        // Guard: reject batches with duplicate credential_type entries.
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
            // 0 is the sentinel for "latest at submission time" (see submit_proof).
            let effective_version = sub.vk_version.unwrap_or(0);
            let record = ProofRecord {
                verified_at: now,
                expiry: sub.expiry,
                threshold: Self::extract_threshold(&env, &sub.credential_type, &public_inputs_bytes),
                revoked: false,
                issuer: Some(sub.issuer_id.clone()),
                vk_version: effective_version,
            };
            env.storage().persistent().set(&key, &record);
            env.storage()
                .persistent()
                .extend_ttl(&key, PROOF_BUMP_THRESHOLD, PROOF_TTL);

            // Emit one event per credential.
            // Topics: ("proof_reg", "submitted", credential_type)
            // Data:   EventProofSubmitted { holder, issuer, verified_at, expiry }
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

    /// Verify an aggregate proof that bundles N credential proofs into a single
    /// UltraHonk proof, and atomically store all N claims. This reduces on-chain
    /// verification from N separate `submit_proof` calls to 1.
    ///
    /// The aggregate circuit (N=2 PoC: KYC + age) packs the public inputs as:
    ///   [kyc_fields(65) | age_fields(67) | num_credentials(1)] = 133 fields.
    /// Each inner credential's issuer must be independently registered and
    /// trusted for its credential type; the outer proof must verify against
    /// the "aggregate" VK registered on the CredentialVerifier.
    ///
    /// Emits one "submitted" event per stored credential, mirroring
    /// `submit_proofs_batch`.
    #[allow(deprecated)]
    pub fn submit_aggregate_proof(
        env: Env,
        holder: Address,
        issuer_ids: Vec<Address>,
        credential_types: Vec<Symbol>,
        proof: Bytes,
        public_inputs: Bytes,
        expiry: u64,
    ) {
        holder.require_auth();

        // 1. Verify the outer aggregate proof against the aggregate VK. The
        //    aggregate circuit has no version parameter; always resolve the
        //    latest registered VK (`None`).
        let verifier = VerifierClient::new(&env, &Self::verifier(&env));
        if !verifier.verify_proof(&symbol_short!("aggregate"), &proof, &public_inputs, &None) {
            panic_with_error!(&env, Error::VerificationFailed);
        }

        // 2. Validate the layout: the num_credentials field (last public-input
        //    field) must match the supplied type count, and the issuer/type
        //    vectors must be the same length.
        let num = Self::read_u64_field(&public_inputs, AGG_FIELD_NUM_CREDENTIALS);
        if num != credential_types.len() as u64
            || num < 2
            || num > MAX_BATCH_SIZE as u64
            || issuer_ids.len() != credential_types.len()
        {
            panic_with_error!(&env, Error::AggregateLayoutInvalid);
        }

        let registry = IssuerClient::new(&env, &Self::issuer_registry(&env));
        let now = env.ledger().timestamp();

        // 3. For each inner credential, validate issuer trust and pubkey, then
        //    atomically store the claim. Public-input field offsets advance by
        //    each credential's field width.
        let mut field_offset: u32 = 0;
        for i in 0..credential_types.len() {
            let ct = credential_types.get(i).unwrap();
            let issuer = issuer_ids.get(i).unwrap();

            if !registry.is_valid_issuer(&issuer, &ct) {
                panic_with_error!(&env, Error::IssuerNotTrusted);
            }

            // Pubkey sits at (commitment field + 1) relative to the block start.
            let expected = registry.get_issuer_pubkey(&issuer);
            if !Self::aggregate_pubkey_match(&public_inputs, field_offset + 1, &expected) {
                panic_with_error!(&env, Error::IssuerKeyMismatch);
            }

            let threshold =
                Self::extract_threshold_from_aggregate(&ct, &public_inputs, field_offset);
            Self::store_claim(&env, &holder, &ct, now, expiry, threshold, issuer.clone());

            // Emit one event per stored credential.
            // Topics: ("proof_reg", "submitted", credential_type)
            // Data:   EventProofSubmitted { holder, issuer, verified_at, expiry }
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
                    expiry,
                },
            );

            field_offset += Self::aggregate_field_count(&ct);
        }
    }

    /// Returns `(is_currently_valid, verified_at, expiry)`. `is_currently_valid`
    /// accounts for expiry against the current ledger time.
    ///
    /// `trusted_issuers`, if `Some`, restricts which issuer's proof is accepted:
    /// the stored proof's issuer must be in the list, or this returns
    /// `(false, verified_at, expiry)` even if the proof is otherwise valid —
    /// timestamps are still returned for audit, matching the existing
    /// revoked/expired behaviour. `None` accepts any registered issuer
    /// (unchanged behaviour).
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

    /// Like `is_verified` but also enforces a minimum threshold for parameterised
    /// credential types (age, income, funds). A proof submitted with a threshold
    /// of 200_000 satisfies `min_threshold = 50_000` because it proves strictly
    /// more. For `kyc` and `jurisdiction`, pass `min_threshold = None`.
    ///
    /// `trusted_issuers`, if `Some`, restricts which issuer's proof is accepted
    /// — see `is_verified`. `None` accepts any registered issuer (unchanged
    /// behaviour).
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

    /// Returns the expiry (ledger timestamp, seconds) for `holder`'s cached
    /// proof of `credential_type`, or 0 if no proof is on record. Like
    /// `is_verified`'s returned `expiry`, this reflects the stored value
    /// regardless of `revoked` status or whether it has already lapsed, so a
    /// caller can distinguish "never proved" (0) from "expired N days ago"
    /// (a past timestamp). Reading extends the entry's TTL the same way
    /// `submit_proof` does, so an otherwise-idle credential isn't evicted
    /// from storage before a holder gets a chance to see it needs renewal.
    pub fn claim_expiry(env: Env, holder: Address, credential_type: Symbol) -> u64 {
        let key = DataKey::Proof(holder, credential_type);
        let record = env.storage().persistent().get::<_, ProofRecord>(&key);
        if record.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, PROOF_BUMP_THRESHOLD, PROOF_TTL);
        }
        record.map(|r| r.expiry).unwrap_or(0)
    }

    /// `None` trusts any registered issuer (unchanged default behaviour). `Some`
    /// (including an empty list) requires `issuer` to be a member — an empty
    /// list therefore rejects every issuer. `issuer` is only `None` for a
    /// record explicitly written that way (no code path in this contract
    /// does so today — see `ProofRecord::issuer`); under an active
    /// `trusted_issuers` filter such a record fails closed (rejected), since
    /// there's no issuer to check against. A `None` filter is unaffected
    /// either way, matching unrestricted behaviour.
    fn issuer_is_trusted(trusted_issuers: &Option<Vec<Address>>, issuer: &Option<Address>) -> bool {
        match trusted_issuers {
            None => true,
            Some(list) => match issuer {
                None => false,
                Some(addr) => list.contains(addr),
            },
        }
    }    /// Revoke a cached proof. The holder authorizes their own revocation.
    pub fn revoke_proof(env: Env, holder: Address, credential_type: Symbol) {
        holder.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Proof(holder, credential_type));
    }

    /// Revoke ALL cached proofs for a holder — useful after an aggregate proof
    /// is submitted and the holder wants a clean slate. Best-effort removal
    /// across all known credential types; types without a stored proof are a
    /// no-op.
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

    /// Invalidate a holder's cached proof. Only the registered issuer for
    /// `credential_type` may call this (e.g. when KYC status changes).
    // NOTE: We suppress the deprecation warning for `env.events().publish` here.
    // The idiomatic Soroban v26 replacement is `#[contractevent]`; we use
    // value-based publish to stay consistent with the rest of the codebase.
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

        #[allow(deprecated)]
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

    /// Admin-only migration from the legacy 4-field `ProofRecord` layout (no
    /// `issuer`, no `vk_version`) to the current 6-field layout. Reads the
    /// stored map as a generic `Map<Symbol, Val>` to determine the field count
    /// without triggering the struct-deserialisation panic that would occur on
    /// a shape mismatch.
    ///
    /// - Idempotent: records already in the current 6-field shape are a no-op.
    /// - Migrated records are written with `issuer: None` so they fail closed
    ///   under an active `trusted_issuers` filter (there is no issuer to check
    ///   against) and `vk_version: 0` (the "latest at submission time"
    ///   sentinel, which is what legacy records were verified against).
    /// - Only the contract admin may call this function.
    pub fn migrate_record(env: Env, holder: Address, credential_type: Symbol) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();

        let key = DataKey::Proof(holder.clone(), credential_type.clone());

        // Read the stored value as a generic map so we can check the field
        // count without panicking on a shape mismatch.
        let raw_map: Map<Symbol, Val> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::ProofNotFound));

        if raw_map.len() == 4 {
            // Legacy 4-field record — safe to deserialise as LegacyProofRecord.
            let legacy: LegacyProofRecord = env
                .storage()
                .persistent()
                .get(&key)
                .unwrap();

            let record = ProofRecord {
                verified_at: legacy.verified_at,
                expiry: legacy.expiry,
                threshold: legacy.threshold,
                revoked: legacy.revoked,
                issuer: None,
                // Legacy records predate versioning; 0 means "latest at
                // submission time", which is what they were verified against.
                vk_version: 0,
            };
            env.storage().persistent().set(&key, &record);
            env.storage()
                .persistent()
                .extend_ttl(&key, PROOF_BUMP_THRESHOLD, PROOF_TTL);
        }
        // If raw_map.len() == 6, the record is already current — idempotent no-op.
    }

    pub fn verifier_address(env: Env) -> Address {
        Self::verifier(&env)
    }

    pub fn issuer_registry_address(env: Env) -> Address {
        Self::issuer_registry(&env)
    }

    /// Extract the numeric threshold from the proof's public inputs.
    fn extract_threshold(env: &Env, credential_type: &Symbol, public_inputs: &Bytes) -> Option<u64> {
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

    /// Read a big-endian u64 from the last 8 bytes of a 32-byte field element.
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

    /// Like `public_inputs_match_pubkey` but with a configurable starting field
    /// so it can validate the pubkey in any slice of an aggregate proof.
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

    /// Atomically write a ProofRecord and bump its TTL.
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
            // Aggregate proofs always verify against the latest VK (see
            // submit_aggregate_proof), so the stored version is the "latest at
            // submission time" sentinel 0 (see ProofRecord::vk_version).
            vk_version: 0,
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, PROOF_BUMP_THRESHOLD, PROOF_TTL);
    }

    /// Returns the number of 32-byte field elements a credential type occupies
    /// in the aggregate proof's public inputs.
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
            // TODO: add jurisdiction handling (73=base+8) when extending to N>2
            base
        }
    }

    /// Extract the threshold from within an aggregate proof's credential block.
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
}

mod test;



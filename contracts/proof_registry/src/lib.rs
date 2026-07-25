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

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Bytes, BytesN, Env, Symbol, Vec,
};

// Persistent-entry lifetime management (~5s ledgers).
const DAY_IN_LEDGERS: u32 = 17280;
const PROOF_BUMP_THRESHOLD: u32 = DAY_IN_LEDGERS;
const PROOF_TTL: u32 = 90 * DAY_IN_LEDGERS;

/// Maximum number of submissions accepted by `submit_proofs_batch`.
const MAX_BATCH_SIZE: u32 = 5;

/// Typed client for the deployed CredentialVerifier contract. Declared as an
/// interface (not a crate dependency) so this contract links only the client,
/// never the verifier's exported wasm symbols.
#[contractclient(name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify_proof(env: Env, credential_type: Symbol, proof: Bytes, public_inputs: Bytes) -> bool;
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
    // NOTE: We suppress the deprecation warning for `env.events().publish` here. 
    // The idiomatic Soroban v26 replacement is to define a typed event struct using the 
    // `#[contractevent]` macro; however, since the existing codebase uniformly uses the 
    // value-based `publish` API, we maintain consistency with other modules to avoid 
    // introducing architectural mismatch.
    #[allow(deprecated)]
    pub fn submit_proof(
        env: Env,
        holder: Address,
        issuer_id: Address,
        credential_type: Symbol,
        proof: Bytes,
        public_inputs: Bytes,
        expiry: u64,
    ) {
        holder.require_auth();

        // 1. The named issuer must be trusted for this credential type.
        let registry = IssuerClient::new(&env, &Self::issuer_registry(&env));
        if !registry.is_valid_issuer(&issuer_id, &credential_type) {
            panic_with_error!(&env, Error::IssuerNotTrusted);
        }

        // 2. The public key the proof attests to (in its public inputs) must be
        //    the registered issuer's key. Without this, a proof could be made
        //    against an attacker-controlled key.
        let expected = registry.get_issuer_pubkey(&issuer_id);
        if !Self::public_inputs_match_pubkey(&public_inputs, &expected) {
            panic_with_error!(&env, Error::IssuerKeyMismatch);
        }

        // 3. The proof must verify against the registered VK for this type.
        //    VerifierClient panics with VkNotSet if no VK is registered for the type.
        let verifier = VerifierClient::new(&env, &Self::verifier(&env));
        if !verifier.verify_proof(&credential_type, &proof, &public_inputs) {
            panic_with_error!(&env, Error::VerificationFailed);
        }

        let key = DataKey::Proof(holder, credential_type.clone());
        let record = ProofRecord {
            verified_at: env.ledger().timestamp(),
            expiry,
            threshold: Self::extract_threshold(&env, &credential_type, &public_inputs),
            revoked: false,
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, PROOF_BUMP_THRESHOLD, PROOF_TTL);

        // Emit an event matching the event emission shape in the batch-proof path.
        env.events().publish(
            (symbol_short!("proof"), symbol_short!("verified")),
            record.expiry,
        );
    }

    /// One event is emitted per successfully verified credential, matching
    /// the event emission shape in the single-proof path.
    // NOTE: We suppress the deprecation warning for `env.events().publish` here. 
    // The idiomatic Soroban v26 replacement is to define a typed event struct using the 
    // `#[contractevent]` macro; however, since the existing codebase uniformly uses the 
    // value-based `publish` API, we maintain consistency with other modules to avoid 
    // introducing architectural mismatch.
    #[allow(deprecated)]
    pub fn submit_proofs_batch(env: Env, holder: Address, submissions: Vec<ProofSubmission>) {
        holder.require_auth();

        let len = submissions.len();
        if len == 0 {
            panic_with_error!(&env, Error::BatchEmpty);
        }
        if len > MAX_BATCH_SIZE {
            panic_with_error!(&env, Error::BatchTooLarge);
        }

        // Guard: reject batches with duplicate credential_type entries.
        // The contract writes DataKey::Proof(holder, type) so duplicates would
        // silently overwrite each other (last-write-wins), misleading the caller.
        // MAX_BATCH_SIZE is 5, so O(n²) is fine here.
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

            // Step 1: issuer must be registered and trusted for this type.
            if !registry.is_valid_issuer(&sub.issuer_id, &sub.credential_type) {
                panic_with_error!(&env, Error::IssuerNotTrusted);
            }

            // Step 2: the public key embedded in the proof must match the
            // on-chain registered key for the claimed issuer.
            let expected = registry.get_issuer_pubkey(&sub.issuer_id);
            if !Self::public_inputs_match_pubkey(&public_inputs_bytes, &expected) {
                panic_with_error!(&env, Error::IssuerKeyMismatch);
            }

            // Step 3: the proof must verify against the registered VK.
            if !verifier.verify_proof(&sub.credential_type, &sub.proof, &public_inputs_bytes) {
                panic_with_error!(&env, Error::VerificationFailed);
            }

            let key = DataKey::Proof(holder.clone(), sub.credential_type.clone());
            let record = ProofRecord {
                verified_at: now,
                expiry: sub.expiry,
                threshold: Self::extract_threshold(&env, &sub.credential_type, &public_inputs_bytes),
                revoked: false,
            };
            env.storage().persistent().set(&key, &record);
            env.storage()
                .persistent()
                .extend_ttl(&key, PROOF_BUMP_THRESHOLD, PROOF_TTL);

            // Emit one event per credential, matching the shape callers already
            // expect from the single-proof path.
            env.events().publish(
                (symbol_short!("proof"), symbol_short!("verified")),
                record.expiry,
            );
        }
    }

    /// Returns `(is_currently_valid, verified_at, expiry)`. `is_currently_valid`
    /// accounts for expiry against the current ledger time.
    pub fn is_verified(env: Env, holder: Address, credential_type: Symbol) -> (bool, u64, u64) {
        match env
            .storage()
            .persistent()
            .get::<_, ProofRecord>(&DataKey::Proof(holder, credential_type))
        {
            Some(r) => {
                let valid = !r.revoked && r.expiry > env.ledger().timestamp();
                (valid, r.verified_at, r.expiry)
            }
            None => (false, 0, 0),
        }
    }

    /// Like `is_verified` but also enforces a minimum threshold for parameterised
    /// credential types (age, income, funds). A proof submitted with a threshold
    /// of 200_000 satisfies `min_threshold = 50_000` because it proves strictly
    /// more. For `kyc` and `jurisdiction`, pass `min_threshold = None`.
    pub fn check_claim(
        env: Env,
        holder: Address,
        credential_type: Symbol,
        min_threshold: Option<u64>,
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
                match min_threshold {
                    None => true,
                    Some(min) => r.threshold.unwrap_or(0) >= min,
                }
            }
            None => false,
        }
    }

    /// Revoke a cached proof. The holder authorizes their own revocation.
    pub fn revoke_proof(env: Env, holder: Address, credential_type: Symbol) {
        holder.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Proof(holder, credential_type));
    }

    /// Invalidate a holder's cached proof. Only the registered issuer for
    /// `credential_type` may call this (e.g. when KYC status changes).
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

        env.events().publish(
            (symbol_short!("revoked"),),
            (holder, credential_type, issuer, env.ledger().timestamp()),
        );
    }

    pub fn verifier_address(env: Env) -> Address {
        Self::verifier(&env)
    }

    pub fn issuer_registry_address(env: Env) -> Address {
        Self::issuer_registry(&env)
    }

    /// Extract the numeric threshold from the proof's public inputs for
    /// credential types that carry one. Public-input layout after the common
    /// header (commitment field 0, issuer_x fields 1-32, issuer_y fields 33-64):
    ///   age:        field 65 = current_date, field 66 = threshold_years
    ///   income:     field 65 = threshold
    ///   funds:      field 65 = threshold
    ///   kyc:        (no extra fields)
    fn extract_threshold(env: &Env, credential_type: &Symbol, public_inputs: &Bytes) -> Option<u64> {
        if *credential_type == symbol_short!("age") {
            // field 66, bytes 2112-2143, u64 in last 8 bytes
            Some(Self::read_u64_field(public_inputs, 66))
        } else if *credential_type == symbol_short!("income")
            || *credential_type == symbol_short!("funds")
            || *credential_type == Symbol::new(env, "accreditation")
        {
            // field 65, bytes 2080-2111, u64 in last 8 bytes
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
        let exp = expected.to_array();
        for i in 0..64u32 {
            let offset = (PUBKEY_START_FIELD + i) * FIELD_BYTES + (FIELD_BYTES - 1);
            match public_inputs.get(offset) {
                Some(b) if b == exp[i as usize] => {}
                _ => return false,
            }
        }
        true
    }

    fn verifier(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Verifier)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    fn issuer_registry(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::IssuerRegistry)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
}

mod test;

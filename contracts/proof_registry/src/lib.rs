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

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Bytes, BytesN, Env, Symbol,
};

// Persistent-entry lifetime management (~5s ledgers).
const DAY_IN_LEDGERS: u32 = 17280;
const PROOF_BUMP_THRESHOLD: u32 = DAY_IN_LEDGERS;
const PROOF_TTL: u32 = 90 * DAY_IN_LEDGERS;

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
}

#[contracttype]
pub enum DataKey {
    Verifier,
    IssuerRegistry,
    /// Cached verification, keyed by (holder, credential_type).
    Proof(Address, Symbol),
    /// Issuer revocation flag, keyed by (holder, credential_type).
    Revoked(Address, Symbol),
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
}

#[contract]
pub struct ProofRegistry;

#[contractimpl]
impl ProofRegistry {
    /// `verifier` and `issuer_registry` are the deployed contract addresses.
    pub fn __constructor(env: Env, verifier: Address, issuer_registry: Address) {
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage()
            .instance()
            .set(&DataKey::IssuerRegistry, &issuer_registry);
    }

    /// Verify a proof and, if valid, cache it for `holder` until `expiry`
    /// (ledger timestamp, seconds). The holder authorizes their own submission.
    /// `issuer_id` must be registered and trusted for `credential_type`.
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

        let key = DataKey::Proof(holder.clone(), credential_type.clone());
        let record = ProofRecord {
            verified_at: env.ledger().timestamp(),
            expiry,
            threshold: Self::extract_threshold(&credential_type, &public_inputs),
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, PROOF_BUMP_THRESHOLD, PROOF_TTL);
        env.storage()
            .persistent()
            .remove(&DataKey::Revoked(holder, credential_type));
    }

    /// Returns `(is_currently_valid, verified_at, expiry)`. `is_currently_valid`
    /// accounts for expiry against the current ledger time.
    pub fn is_verified(env: Env, holder: Address, credential_type: Symbol) -> (bool, u64, u64) {
        let key = DataKey::Proof(holder.clone(), credential_type.clone());
        match env.storage().persistent().get::<_, ProofRecord>(&key) {
            Some(r) => {
                if Self::is_revoked(&env, &holder, &credential_type) {
                    return (false, r.verified_at, r.expiry);
                }
                let valid = r.expiry > env.ledger().timestamp();
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
        let key = DataKey::Proof(holder.clone(), credential_type.clone());
        match env.storage().persistent().get::<_, ProofRecord>(&key) {
            Some(r) => {
                if Self::is_revoked(&env, &holder, &credential_type) {
                    return false;
                }
                if r.expiry <= env.ledger().timestamp() {
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

    /// Invalidate a cached proof before its expiry. Only the registered issuer
    /// for `credential_type` may call this; holders cannot self-revoke via
    /// this entrypoint.
    pub fn revoke(env: Env, holder: Address, credential_type: Symbol, issuer: Address) {
        issuer.require_auth();

        let registry = IssuerClient::new(&env, &Self::issuer_registry(&env));
        if !registry.is_valid_issuer(&issuer, &credential_type) {
            panic_with_error!(&env, Error::IssuerNotTrusted);
        }

        let proof_key = DataKey::Proof(holder.clone(), credential_type.clone());
        let ttl = env
            .storage()
            .persistent()
            .get::<_, ProofRecord>(&proof_key)
            .map(|r| Self::ttl_for_expiry(&env, r.expiry))
            .unwrap_or(PROOF_TTL);

        let rev_key = DataKey::Revoked(holder, credential_type);
        env.storage().persistent().set(&rev_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&rev_key, PROOF_BUMP_THRESHOLD, ttl);
    }

    /// Revoke a cached proof. The holder authorizes their own revocation.
    pub fn revoke_proof(env: Env, holder: Address, credential_type: Symbol) {
        holder.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Proof(holder.clone(), credential_type.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::Revoked(holder, credential_type));
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
    fn extract_threshold(credential_type: &Symbol, public_inputs: &Bytes) -> Option<u64> {
        if *credential_type == symbol_short!("age") {
            // field 66, bytes 2112-2143, u64 in last 8 bytes
            Some(Self::read_u64_field(public_inputs, 66))
        } else if *credential_type == symbol_short!("income")
            || *credential_type == symbol_short!("funds")
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

    fn is_revoked(env: &Env, holder: &Address, credential_type: &Symbol) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Revoked(holder.clone(), credential_type.clone()))
            .unwrap_or(false)
    }

    /// Persistent-entry TTL (in ledgers) that covers at least until `expiry`.
    fn ttl_for_expiry(env: &Env, expiry: u64) -> u32 {
        const LEDGER_TIME_SECS: u64 = 5;
        let now = env.ledger().timestamp();
        if expiry <= now {
            return PROOF_BUMP_THRESHOLD;
        }
        let ledgers = ((expiry - now) / LEDGER_TIME_SECS) as u32;
        ledgers.max(PROOF_BUMP_THRESHOLD).min(PROOF_TTL)
    }
}

mod test;

#![no_std]
//! IssuerRegistry
//!
//! Stores which issuers are trusted for which credential types. This is the
//! root of trust for the whole system: any verifier contract can query it to
//! learn an issuer's credential-signing public key, and any issuer can be
//! registered or revoked by the protocol admin (later: a DAO).
//!
//! Credential types are represented as short `Symbol`s, e.g. `kyc`, `age`,
//! `jurisdiction`, `income`, `human`, `employer`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, BytesN, Env,
    Symbol, Vec,
};

// Persistent-entry lifetime management (~5s ledgers).
const DAY_IN_LEDGERS: u32 = 17280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const ENTRY_TTL: u32 = 120 * DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
pub struct Issuer {
    /// secp256k1 public key (x || y, 32 bytes each) the issuer signs credentials
    /// with. A proof carries this key as a public input; ProofRegistry checks it
    /// matches this registered value, so a proof can only pass if a registered
    /// issuer actually signed the credential commitment.
    pub pubkey: BytesN<64>,
    /// Credential types this issuer is trusted to attest.
    pub credential_types: Vec<Symbol>,
    pub revoked: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Issuer(Address),
    /// Append-only list of registered issuer addresses for enumeration.
    IssuerList,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    IssuerNotFound = 2,
}

#[contract]
pub struct IssuerRegistry;

#[contractimpl]
impl IssuerRegistry {
    /// Set the protocol admin once, at deploy time.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Register (or overwrite) a trusted issuer. Admin-only.
    pub fn register_issuer(
        env: Env,
        issuer_id: Address,
        pubkey: BytesN<64>,
        credential_types: Vec<Symbol>,
    ) {
        Self::require_admin(&env);
        let issuer = Issuer {
            pubkey,
            credential_types,
            revoked: false,
        };
        let key = DataKey::Issuer(issuer_id.clone());
        env.storage().persistent().set(&key, &issuer);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, ENTRY_TTL);

        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::IssuerList)
            .unwrap_or_else(|| Vec::new(&env));
        if !list.contains(&issuer_id) {
            list.push_back(issuer_id);
            env.storage().instance().set(&DataKey::IssuerList, &list);
        }
    }

    /// Mark an issuer as revoked. Admin-only. Existing proofs are not affected
    /// here — revocation propagates through `is_valid_issuer` checks.
    pub fn revoke_issuer(env: Env, issuer_id: Address) {
        Self::require_admin(&env);
        let key = DataKey::Issuer(issuer_id);
        let mut issuer: Issuer = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::IssuerNotFound));
        issuer.revoked = true;
        env.storage().persistent().set(&key, &issuer);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, ENTRY_TTL);
    }

    /// All registered issuer addresses (including revoked).
    pub fn get_issuers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::IssuerList)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Full on-chain record for a registered issuer.
    pub fn get_issuer(env: Env, issuer_id: Address) -> Issuer {
        Self::load_issuer(&env, &issuer_id)
    }

    /// Look up an issuer's credential-signing public key (secp256k1 x || y).
    pub fn get_issuer_pubkey(env: Env, issuer_id: Address) -> BytesN<64> {
        Self::load_issuer(&env, &issuer_id).pubkey
    }

    /// True iff `issuer_id` is registered, not revoked, and trusted for
    /// `credential_type`.
    pub fn is_valid_issuer(env: Env, issuer_id: Address, credential_type: Symbol) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, Issuer>(&DataKey::Issuer(issuer_id))
        {
            Some(issuer) => !issuer.revoked && issuer.credential_types.contains(&credential_type),
            None => false,
        }
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    fn load_issuer(env: &Env, issuer_id: &Address) -> Issuer {
        env.storage()
            .persistent()
            .get(&DataKey::Issuer(issuer_id.clone()))
            .unwrap_or_else(|| panic_with_error!(env, Error::IssuerNotFound))
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        admin.require_auth();
    }
}

mod test;

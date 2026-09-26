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
//!
//! Privileged actions are governed by role-based access control (RBAC): the
//! constructor seeds the `admin` role with the deployer address, and issuer
//! registration / revocation / metadata are guarded by that role. Roles are
//! stored as a `Map<Symbol, Address>` (role name → current holder); the root
//! admin can delegate or rotate holders via `grant_role` / `revoke_role`, and
//! anyone can query membership with `has_role`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, Map, String, Symbol, Vec,
};

// ── Contract versioning ──────────────────────────────────────────────────────
// Semantic version: MAJOR.MINOR.PATCH
// Increment MAJOR on breaking changes (new entry points, changed ABI)
// Increment MINOR on additive changes (new events, new query endpoints)
// Increment PATCH on bug fixes with no ABI changes
const CONTRACT_VERSION: u32 = 1_000_000; // 1.0.0 encoded as (major * 1000000) + (minor * 1000) + patch

// ── Event types ──────────────────────────────────────────────────────────────
// Topics follow the convention: (contract, action, credential_type_or_unit).
// `contract` is always `symbol_short!("iss_reg")` for IssuerRegistry events.
// `action`   identifies the operation.
// For events that are not credential-type-specific, the third topic is omitted
// (tuple length 2).

/// Payload emitted when an issuer is registered or updated.
/// Topics: ("iss_reg", "register")
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventIssuerRegistered {
    /// The address of the newly registered issuer.
    pub issuer: Address,
    /// The issuer's secp256k1 public key (x || y, 32 bytes each).
    pub pubkey: BytesN<64>,
}

/// Payload emitted when an issuer is revoked.
/// Topics: ("iss_reg", "revoked")
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventIssuerRevoked {
    /// The address of the revoked issuer.
    pub issuer: Address,
}

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
#[derive(Clone)]
pub struct IssuerMetadata {
    pub name: Option<String>,
    pub url: Option<String>,
    pub logo: Option<String>,
}

#[contracttype]
pub enum DataKey {
    Admin,
    /// RBAC: role name (Symbol) → current holder (Address).
    Roles,
    Issuer(Address),
    /// Append-only list of registered issuer addresses for enumeration.
    /// Stored in persistent storage to avoid hitting the instance-storage
    /// size cap as the issuer set grows.
    IssuerList,
    IssuerMetadata(Address),
    /// Total number of registered issuers; kept in sync with IssuerList so
    /// callers can size pagination requests without loading the whole list.
    IssuerCount,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    IssuerNotFound = 2,
    MetadataTooLong = 3,
    /// The caller is not the holder of the role required by this function.
    RoleNotHeld = 4,
    /// `revoke_role` named an address that is not the current holder of the role.
    RoleHolderMismatch = 5,
}

/// Maximum byte length for on-chain metadata fields.
/// These caps prevent unbounded storage blobs that would inflate rent
/// and read costs.
const MAX_NAME_LEN: u32 = 64;
const MAX_URL_LEN: u32 = 256;
const MAX_LOGO_LEN: u32 = 256;

#[contract]
pub struct IssuerRegistry;

#[contractimpl]
impl IssuerRegistry {
    /// Set the protocol admin once, at deploy time.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        // Seed the admin role with the deployer so the contract works out of the
        // box; further roles can be delegated via `grant_role`.
        let mut roles: Map<Symbol, Address> = Map::new(&env);
        roles.set(symbol_short!("admin"), admin);
        env.storage().instance().set(&DataKey::Roles, &roles);
    }

    /// Returns the contract version as an encoded u32.
    /// Encoding: (major * 1000000) + (minor * 1000) + patch
    /// Example: 1.2.3 -> 1002003
    pub fn version(env: Env) -> u32 {
        let _ = env; // Silence unused warning
        CONTRACT_VERSION
    }

    /// Register (or overwrite) a trusted issuer. Admin-only.
    /// Register (or overwrite) a trusted issuer. Admin-role only.
    // NOTE: We suppress the deprecation warning for `env.events().publish` here.
    // The idiomatic Soroban v26 replacement is `#[contractevent]`; we use
    // value-based publish to stay consistent with the rest of the codebase.
    #[allow(deprecated)]
    pub fn register_issuer(
        env: Env,
        issuer_id: Address,
        pubkey: BytesN<64>,
        credential_types: Vec<Symbol>,
    ) {
        Self::require_role(&env, &symbol_short!("admin"));
        let issuer = Issuer {
            pubkey: pubkey.clone(),
            credential_types,
            revoked: false,
        };
        let key = DataKey::Issuer(issuer_id.clone());
        env.storage().persistent().set(&key, &issuer);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, ENTRY_TTL);

        // Maintain the enumeration list in persistent storage (not instance
        // storage) so large issuer sets don't hit Soroban's per-entry size cap.
        let list_key = DataKey::IssuerList;
        let mut list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env));
        if !list.contains(&issuer_id) {
            list.push_back(issuer_id.clone());
            env.storage().persistent().set(&list_key, &list);
            env.storage()
                .persistent()
                .extend_ttl(&list_key, BUMP_THRESHOLD, ENTRY_TTL);
            // Bump the count.
            let count_key = DataKey::IssuerCount;
            let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0u32);
            env.storage().persistent().set(&count_key, &(count + 1));
            env.storage()
                .persistent()
                .extend_ttl(&count_key, BUMP_THRESHOLD, ENTRY_TTL);
        }

        // Emit: topics = ("iss_reg", "register")
        //       data   = EventIssuerRegistered { issuer, pubkey }
        env.events().publish(
            (symbol_short!("iss_reg"), symbol_short!("register")),
            EventIssuerRegistered {
                issuer: issuer_id,
                pubkey,
            },
        );
    }

    /// Mark an issuer as revoked. Admin-role only. Existing proofs are not affected
    /// here — revocation propagates through `is_valid_issuer` checks.
    // NOTE: We suppress the deprecation warning for `env.events().publish` here.
    // The idiomatic Soroban v26 replacement is `#[contractevent]`; we use
    // value-based publish to stay consistent with the rest of the codebase.
    #[allow(deprecated)]
    pub fn revoke_issuer(env: Env, issuer_id: Address) {
        Self::require_role(&env, &symbol_short!("admin"));
        let key = DataKey::Issuer(issuer_id.clone());
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

        // Emit: topics = ("iss_reg", "revoked")
        //       data   = EventIssuerRevoked { issuer }
        env.events().publish(
            (symbol_short!("iss_reg"), symbol_short!("revoked")),
            EventIssuerRevoked { issuer: issuer_id },
        );
    }

    /// All registered issuer addresses (including revoked).
    ///
    /// # Warning
    /// This returns the full list in a single Vec. For production deployments
    /// with a large number of issuers, prefer [`get_issuers_page`] to bound
    /// the per-call read footprint and avoid hitting Soroban resource limits.
    pub fn get_issuers(env: Env) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::IssuerList)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Paginated read of registered issuer addresses (including revoked).
    ///
    /// Returns up to `limit` addresses starting at zero-based index `start`.
    /// `limit` is capped at 20 to bound the per-call read footprint; passing a
    /// larger value silently uses 20 instead.
    ///
    /// Use [`issuer_count`] to determine how many pages are needed:
    /// ```text
    /// pages = ceil(issuer_count() / limit)
    /// ```
    pub fn get_issuers_page(env: Env, start: u32, limit: u32) -> Vec<Address> {
        // Cap limit to 20 to guard against resource-limit exhaustion as the
        // issuer set grows. Soroban instruction budgets make materialising a
        // very large slice in one call prohibitively expensive.
        const MAX_PAGE_SIZE: u32 = 20;
        let effective_limit = limit.min(MAX_PAGE_SIZE);

        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::IssuerList)
            .unwrap_or_else(|| Vec::new(&env));

        let total = list.len();
        if start >= total || effective_limit == 0 {
            return Vec::new(&env);
        }

        let end = total.min(start + effective_limit);
        let mut page = Vec::new(&env);
        for i in start..end {
            page.push_back(list.get(i).unwrap());
        }
        page
    }

    /// Total number of registered issuers (including revoked).
    /// Use this together with [`get_issuers_page`] to iterate the full set
    /// without loading it all at once.
    pub fn issuer_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::IssuerCount)
            .unwrap_or(0u32)
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

    /// Set optional on-chain metadata (name, url, logo) for an issuer.
    /// Admin-role only. Pass `None` for fields you don't want to set.
    pub fn set_issuer_metadata(
        env: Env,
        issuer: Address,
        name: Option<String>,
        url: Option<String>,
        logo: Option<String>,
    ) {
        Self::require_role(&env, &symbol_short!("admin"));
        if !env.storage().persistent().has(&DataKey::Issuer(issuer.clone())) {
            panic_with_error!(&env, Error::IssuerNotFound);
        }
        // Enforce per-field length caps to bound storage rent.
        if let Some(ref n) = name {
            if n.len() > MAX_NAME_LEN {
                panic_with_error!(&env, Error::MetadataTooLong);
            }
        }
        if let Some(ref u) = url {
            if u.len() > MAX_URL_LEN {
                panic_with_error!(&env, Error::MetadataTooLong);
            }
        }
        if let Some(ref l) = logo {
            if l.len() > MAX_LOGO_LEN {
                panic_with_error!(&env, Error::MetadataTooLong);
            }
        }
        let metadata = IssuerMetadata { name, url, logo };
        let key = DataKey::IssuerMetadata(issuer.clone());
        env.storage().persistent().set(&key, &metadata);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, ENTRY_TTL);
    }

    /// Read the optional on-chain metadata for an issuer.
    /// Returns `None` if no metadata has been set.
    pub fn get_issuer_metadata(env: Env, issuer: Address) -> Option<IssuerMetadata> {
        let key = DataKey::IssuerMetadata(issuer);
        env.storage().persistent().get(&key)
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Assign `address` as the holder of `role`, replacing any previous holder.
    /// Root-admin only. Use this to delegate or rotate a role's key — e.g. hand
    /// the `admin` role to an operations key, or prepare an `issuer-manager`
    /// role for finer-grained issuer governance.
    pub fn grant_role(env: Env, role: Symbol, address: Address) {
        Self::require_admin(&env);
        let mut roles: Map<Symbol, Address> = Self::roles(&env);
        roles.set(role, address);
        env.storage().instance().set(&DataKey::Roles, &roles);
    }

    /// Remove `address` as the holder of `role`. Root-admin only.
    ///
    /// The named address must be the current holder (revoking a different
    /// address is a no-op risk, so it is rejected with `RoleHolderMismatch`
    /// instead). A role with no holder is simply unassigned — no one can act
    /// under it until it is granted again.
    pub fn revoke_role(env: Env, role: Symbol, address: Address) {
        Self::require_admin(&env);
        let mut roles: Map<Symbol, Address> = Self::roles(&env);
        match roles.get(role.clone()) {
            Some(current) if current == address => {
                roles.remove(role);
                env.storage().instance().set(&DataKey::Roles, &roles);
            }
            Some(_) => panic_with_error!(&env, Error::RoleHolderMismatch),
            // Unassigned role — nothing to revoke.
            None => {}
        }
    }

    /// True iff `address` currently holds `role`.
    pub fn has_role(env: Env, role: Symbol, address: Address) -> bool {
        match env
            .storage()
            .instance()
            .get::<_, Map<Symbol, Address>>(&DataKey::Roles)
        {
            Some(roles) => roles.get(role) == Some(address),
            None => false,
        }
    }

    fn load_issuer(env: &Env, issuer_id: &Address) -> Issuer {
        env.storage()
            .persistent()
            .get(&DataKey::Issuer(issuer_id.clone()))
            .unwrap_or_else(|| panic_with_error!(env, Error::IssuerNotFound))
    }

    fn roles(env: &Env) -> Map<Symbol, Address> {
        env.storage()
            .instance()
            .get(&DataKey::Roles)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    /// Require `address` to be authenticated as the current holder of `role`.
    fn require_role(env: &Env, role: &Symbol) {
        let holder: Address = Self::roles(env)
            .get(role.clone())
            .unwrap_or_else(|| panic_with_error!(env, Error::RoleNotHeld));
        holder.require_auth();
    }

    /// Require the root admin key to be authenticated. Used by the role
    /// management functions (`grant_role` / `revoke_role`), which stay on the
    /// bootstrap trust anchor rather than a delegatable role.
    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        admin.require_auth();
    }
}

#[cfg(test)]
mod test;

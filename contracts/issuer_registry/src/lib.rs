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
//!
//! Admin transfer is two-step (#342): the root admin calls `propose_admin`
//! with the incoming address, and that address must call `accept_admin` to
//! take over. On acceptance, the accepted address becomes the new root admin
//! AND inherits every role the outgoing admin held — a wholesale governance
//! transfer. A pending proposal can be overwritten by another `propose_admin`
//! or cleared with `cancel_admin_proposal`.
//!
//! ── Issuer key sets and rotation ───────────────────────────────────────────
//! An issuer signs credentials with a secp256k1 key, and that key is bound into
//! every proof's public inputs. Holding a single pubkey per issuer meant any
//! key change silently invalidated every credential the issuer had already
//! issued: proofs carried the old key while the registry only knew the new one,
//! so submissions failed with `IssuerKeyMismatch` and there was no migration
//! path.
//!
//! Each issuer therefore keeps a *key set*: one current signing key plus a
//! bounded history of retired keys, each with a validity window.
//!
//! * [`rotate_issuer_key`] retires the current key with a validity window long
//!   enough for outstanding credentials to reach their natural expiry, and
//!   installs the new key as current. Rotation never invalidates existing
//!   credentials on its own — a retired key keeps verifying submissions until
//!   its window closes.
//! * [`revoke_issuer_key`] is the emergency path for compromise: it kills a key
//!   immediately instead of waiting out a window.
//! * [`is_valid_issuer_key`] is the single verification query ProofRegistry uses
//!   instead of comparing against a single registered pubkey.
//!
//! Re-registering an existing issuer with a *different* pubkey is rejected
//! (`KeyChangeRequiresRotation`): that path is what used to invalidate
//! outstanding credentials, and it must go through an explicit rotation.
//! Key management is admin-role only, like registration itself.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, Map, String, Symbol, Vec,
};

// ── Contract versioning ──────────────────────────────────────────────────────
// Semantic version: MAJOR.MINOR.PATCH
// Increment MAJOR on breaking changes (new entry points, changed ABI)
// Increment MINOR on additive changes (new events, new query endpoints)
// Increment PATCH on bug fixes with no ABI changes
// 1.1.0: additive issuer key-set support — rotate_issuer_key,
// revoke_issuer_key, is_valid_issuer_key, get_issuer_keys.
const CONTRACT_VERSION: u32 = 1_001_000; // 1.1.0 encoded as (major * 1000000) + (minor * 1000) + patch

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

/// Payload emitted when an issuer's signing key is rotated.
/// Topics: ("iss_reg", "key_rot")
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventIssuerKeyRotated {
    /// The issuer whose key set changed.
    pub issuer: Address,
    /// The key that stopped being the current signing key.
    pub old_pubkey: BytesN<64>,
    /// The key that is current from now on.
    pub new_pubkey: BytesN<64>,
    /// Ledger timestamp after which `old_pubkey` stops validating submissions
    /// (inclusive: the key is still valid at exactly this timestamp).
    /// Already-revoked keys are recorded as history only, so this field is the
    /// requested window even when the old key is dead regardless.
    pub old_key_valid_until: u64,
}

/// Payload emitted when an issuer's signing key is emergency-revoked.
/// Topics: ("iss_reg", "key_revk")
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventIssuerKeyRevoked {
    /// The issuer whose key set changed.
    pub issuer: Address,
    /// The key that was killed.
    pub pubkey: BytesN<64>,
    /// True when the revoked key was the issuer's current signing key (no new
    /// credentials can be issued until the admin rotates to a new one); false
    /// when it was a retired key still inside its validity window.
    pub was_current: bool,
    /// Ledger timestamp at which the revocation took effect.
    pub revoked_at: u64,
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

/// One entry of an issuer's key set.
///
/// The current signing key is reported by [`IssuerRegistry::get_issuer_keys`]
/// as the first entry with `retired_at == 0` and `valid_until == 0`; retired
/// keys follow, oldest first. Retired entries are pruned once their validity
/// window closes, so a long-lived issuer's history stays bounded.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IssuerKey {
    /// secp256k1 public key (x || y, 32 bytes each).
    pub pubkey: BytesN<64>,
    /// Ledger timestamp at which the key stopped being the issuer's current
    /// signing key. 0 while the key is still current.
    pub retired_at: u64,
    /// Ledger timestamp from which the key stops validating submissions. 0
    /// while the key is current (the current key has no scheduled expiry).
    pub valid_until: u64,
    /// Set by `revoke_issuer_key`. A revoked key never validates again,
    /// regardless of `valid_until` — that is the difference between rotation
    /// (windowed) and revocation (immediate).
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
    /// Pending root-admin candidate set by `propose_admin` and consumed by
    /// `accept_admin` (#342).
    PendingAdmin,
    /// RBAC: role name (Symbol) → current holder (Address).
    Roles,
    Issuer(Address),
    /// Retired signing keys of an issuer, oldest first. Each entry carries its
    /// own validity window, so a rotation does not invalidate credentials that
    /// were signed before it. Bounded by `MAX_RETIRED_KEYS`.
    RetiredKeys(Address),
    /// Whether the issuer's current signing key was emergency-revoked. Stored
    /// separately from `Issuer` so the `Issuer` ABI stays stable; while set, the
    /// issuer cannot issue (`is_valid_issuer` is false) and must be rotated.
    CurrentKeyRevoked(Address),
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
    /// The key is not part of this issuer's live key set: it was never
    /// registered, or its validity window has already closed.
    KeyNotFound = 6,
    /// The key was already emergency-revoked, so revoking it again is a no-op.
    KeyAlreadyRevoked = 7,
    /// `rotate_issuer_key` was asked to install a key that is still in the
    /// issuer's key set. Re-using a retired key would revive the credentials
    /// signed with it.
    KeyAlreadyRetired = 8,
    /// The issuer already retains `MAX_RETIRED_KEYS` keys that are still inside
    /// their validity windows; wait for one to expire before rotating again.
    KeyHistoryFull = 9,
    /// The requested validity window is empty (already closed) or longer than
    /// `MAX_KEY_RETENTION_SECS`.
    InvalidKeyWindow = 10,
    /// `rotate_issuer_key` was asked to install the key that is already current.
    KeyAlreadyCurrent = 11,
    /// `register_issuer` tried to change the pubkey of an existing issuer.
    /// Use `rotate_issuer_key` so outstanding credentials keep verifying.
    KeyChangeRequiresRotation = 12,
    /// `accept_admin` was called with no pending proposal (#342).
    NoPendingAdmin = 13,
}

/// Upper bound on retired keys retained per issuer. Retired keys are pruned
/// automatically once their validity window closes, so this only has to cover
/// the number of rotations an issuer can perform within one credential's
/// maximum lifetime.
const MAX_RETIRED_KEYS: u32 = 8;

/// Longest validity window a rotation may grant a retired key (366 days).
/// Bounds how long a retired key keeps accepting proofs, and therefore how
/// long a leaked key stays useful after rotation.
const MAX_KEY_RETENTION_SECS: u64 = 366 * 24 * 60 * 60;

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
        let key = DataKey::Issuer(issuer_id.clone());
        // Re-registration may update credential types (or un-revoke), but a new
        // pubkey must go through `rotate_issuer_key`: silently swapping it here
        // is exactly what used to invalidate every outstanding credential.
        if let Some(existing) = env.storage().persistent().get::<_, Issuer>(&key) {
            if existing.pubkey != pubkey {
                panic_with_error!(&env, Error::KeyChangeRequiresRotation);
            }
        }
        let issuer = Issuer {
            pubkey: pubkey.clone(),
            credential_types,
            revoked: false,
        };
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
    ///
    /// This is the *current* signing key only. To check the key carried by a
    /// proof — which may have been signed by a retired key that is still inside
    /// its validity window — use [`is_valid_issuer_key`].
    pub fn get_issuer_pubkey(env: Env, issuer_id: Address) -> BytesN<64> {
        Self::load_issuer(&env, &issuer_id).pubkey
    }

    /// True iff `issuer_id` is registered, not revoked, and trusted for
    /// `credential_type`.
    ///
    /// A false result also covers an issuer whose current signing key was
    /// emergency-revoked: it cannot issue anything until an admin rotates it to
    /// a new key. Use [`is_valid_issuer_key`] to check a specific proof's key.
    pub fn is_valid_issuer(env: Env, issuer_id: Address, credential_type: Symbol) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, Issuer>(&DataKey::Issuer(issuer_id.clone()))
        {
            Some(issuer) => {
                !issuer.revoked
                    && !Self::current_key_revoked(&env, &issuer_id)
                    && issuer.credential_types.contains(&credential_type)
            }
            None => false,
        }
    }

    // ── Key set management ──────────────────────────────────────────────────
    // Rotation and revocation are admin-role only, like registration itself:
    // the issuer's own key cannot rewrite the registry's view of it. The
    // operational procedure (who prepares and signs a rotation) lives in
    // docs/ISSUER_KEY_ROTATION.md.

    /// Rotate an issuer's signing key. Admin-role only.
    ///
    /// The current key is retired with a validity window that stays open
    /// through `old_key_valid_until` (inclusive), and `new_pubkey` becomes the
    /// key used for new issuance. Credentials signed by the old key therefore
    /// keep verifying until they reach their natural expiry — rotation alone
    /// never invalidates outstanding credentials.
    ///
    /// `old_key_valid_until` must lie in `(now, now + MAX_KEY_RETENTION_SECS]`;
    /// set it to the latest expiry among the issuer's outstanding credentials.
    /// Retired keys are pruned once their window closes, so an issuer can rotate
    /// repeatedly over its lifetime.
    ///
    /// If the old key was emergency-revoked, rotating installs the replacement
    /// and the revoked key stays dead in the history. To kill a key
    /// immediately instead, use [`revoke_issuer_key`].
    // NOTE: `env.events().publish` is deprecated in Soroban v26 in favour of
    // `#[contractevent]`; the rest of the codebase uses value-based publish, so
    // we suppress the warning for consistency.
    #[allow(deprecated)]
    pub fn rotate_issuer_key(
        env: Env,
        issuer_id: Address,
        new_pubkey: BytesN<64>,
        old_key_valid_until: u64,
    ) {
        Self::require_role(&env, &symbol_short!("admin"));
        let issuer_key = DataKey::Issuer(issuer_id.clone());
        let mut issuer: Issuer = env
            .storage()
            .persistent()
            .get(&issuer_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::IssuerNotFound));

        if new_pubkey == issuer.pubkey {
            panic_with_error!(&env, Error::KeyAlreadyCurrent);
        }
        let now = env.ledger().timestamp();
        if old_key_valid_until <= now
            || old_key_valid_until > now.saturating_add(MAX_KEY_RETENTION_SECS)
        {
            panic_with_error!(&env, Error::InvalidKeyWindow);
        }

        // Drop retired keys whose window has closed, then refuse to re-install
        // a key that is still in the set: re-using one would silently revive
        // credentials signed during the window it was retired in.
        let mut keys = Self::pruned_retired_keys(&env, &issuer_id, now);
        for i in 0..keys.len() {
            if keys.get(i).unwrap().pubkey == new_pubkey {
                panic_with_error!(&env, Error::KeyAlreadyRetired);
            }
        }
        if keys.len() >= MAX_RETIRED_KEYS {
            panic_with_error!(&env, Error::KeyHistoryFull);
        }

        // A key that was already emergency-revoked stays revoked in history, so
        // the rotation purely installs the replacement key.
        let old_pubkey = issuer.pubkey.clone();
        keys.push_back(IssuerKey {
            pubkey: old_pubkey.clone(),
            retired_at: now,
            valid_until: old_key_valid_until,
            revoked: Self::current_key_revoked(&env, &issuer_id),
        });
        Self::store_retired_keys(&env, &issuer_id, &keys);

        issuer.pubkey = new_pubkey.clone();
        env.storage().persistent().set(&issuer_key, &issuer);
        env.storage()
            .persistent()
            .extend_ttl(&issuer_key, BUMP_THRESHOLD, ENTRY_TTL);

        // A rotation always leaves the issuer holding a usable signing key.
        let revoked_flag = DataKey::CurrentKeyRevoked(issuer_id.clone());
        if env.storage().persistent().has(&revoked_flag) {
            env.storage().persistent().remove(&revoked_flag);
        }

        // Emit: topics = ("iss_reg", "key_rot")
        //       data   = EventIssuerKeyRotated { issuer, old_pubkey, new_pubkey, old_key_valid_until }
        env.events().publish(
            (symbol_short!("iss_reg"), symbol_short!("key_rot")),
            EventIssuerKeyRotated {
                issuer: issuer_id,
                old_pubkey,
                new_pubkey,
                old_key_valid_until,
            },
        );
    }

    /// Emergency-revoke one of an issuer's signing keys. Admin-role only.
    ///
    /// Unlike rotation, revocation is immediate and ignores the key's validity
    /// window: proofs signed by the key stop verifying on the next ledger, and
    /// if the current key is revoked the issuer cannot issue at all
    /// (`is_valid_issuer` returns false) until an admin rotates it to a new key.
    /// Retiring a key normally and then discovering it was compromised is the
    /// exact case this exists for.
    #[allow(deprecated)]
    pub fn revoke_issuer_key(env: Env, issuer_id: Address, pubkey: BytesN<64>) {
        Self::require_role(&env, &symbol_short!("admin"));
        let issuer: Issuer = env
            .storage()
            .persistent()
            .get(&DataKey::Issuer(issuer_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::IssuerNotFound));
        let now = env.ledger().timestamp();

        if pubkey == issuer.pubkey {
            let revoked_flag = DataKey::CurrentKeyRevoked(issuer_id.clone());
            if env.storage().persistent().has(&revoked_flag) {
                panic_with_error!(&env, Error::KeyAlreadyRevoked);
            }
            env.storage().persistent().set(&revoked_flag, &true);
            env.storage()
                .persistent()
                .extend_ttl(&revoked_flag, BUMP_THRESHOLD, ENTRY_TTL);
            // Emit: topics = ("iss_reg", "key_revk")
            //       data   = EventIssuerKeyRevoked { issuer, pubkey, was_current: true, revoked_at }
            env.events().publish(
                (symbol_short!("iss_reg"), symbol_short!("key_revk")),
                EventIssuerKeyRevoked {
                    issuer: issuer_id,
                    pubkey,
                    was_current: true,
                    revoked_at: now,
                },
            );
            return;
        }

        let mut keys = Self::retired_keys(&env, &issuer_id);
        let mut found: Option<u32> = None;
        for i in 0..keys.len() {
            if keys.get(i).unwrap().pubkey == pubkey {
                found = Some(i);
                break;
            }
        }
        let index = found.unwrap_or_else(|| panic_with_error!(&env, Error::KeyNotFound));
        let mut record = keys.get(index).unwrap();
        if record.revoked {
            panic_with_error!(&env, Error::KeyAlreadyRevoked);
        }
        if record.valid_until <= now {
            // The window has already closed, so the key validates nothing and
            // there is nothing to revoke.
            panic_with_error!(&env, Error::KeyNotFound);
        }
        record.revoked = true;
        keys.set(index, record);
        Self::store_retired_keys(&env, &issuer_id, &keys);

        // Emit: topics = ("iss_reg", "key_revk")
        //       data   = EventIssuerKeyRevoked { issuer, pubkey, was_current: false, revoked_at }
        env.events().publish(
            (symbol_short!("iss_reg"), symbol_short!("key_revk")),
            EventIssuerKeyRevoked {
                issuer: issuer_id,
                pubkey,
                was_current: false,
                revoked_at: now,
            },
        );
    }

    /// True iff `pubkey` may sign submissions for `issuer_id` right now.
    ///
    /// True for the issuer's current key and for any retired key whose validity
    /// window has not closed and that has not been emergency-revoked. This is
    /// the check ProofRegistry runs against a proof's public inputs, so a
    /// credential issued before a rotation keeps verifying.
    pub fn is_valid_issuer_key(env: Env, issuer_id: Address, pubkey: BytesN<64>) -> bool {
        let issuer: Issuer = match env
            .storage()
            .persistent()
            .get(&DataKey::Issuer(issuer_id.clone()))
        {
            Some(i) => i,
            None => return false,
        };
        // A fully revoked issuer signs nothing, whatever its key history says.
        if issuer.revoked {
            return false;
        }
        if pubkey == issuer.pubkey {
            return !Self::current_key_revoked(&env, &issuer_id);
        }
        let now = env.ledger().timestamp();
        for record in Self::retired_keys(&env, &issuer_id).iter() {
            if record.pubkey == pubkey {
                return !record.revoked && now <= record.valid_until;
            }
        }
        false
    }

    /// Extend the persistent-entry lifetime of an issuer's record and key
    /// history. Admin-role only. Emits no event.
    ///
    /// Persistent entries expire after `ENTRY_TTL`, and expiry is what makes an
    /// entry unreadable — a retired key whose entry has lapsed stops verifying
    /// even though its validity window is still open. Call this periodically
    /// (a keeper job is the usual answer) for issuers with long validity
    /// windows, ideally before `BUMP_THRESHOLD` ledgers have elapsed.
    pub fn refresh_issuer_keys_ttl(env: Env, issuer_id: Address) {
        Self::require_role(&env, &symbol_short!("admin"));
        let issuer_key = DataKey::Issuer(issuer_id.clone());
        if !env.storage().persistent().has(&issuer_key) {
            panic_with_error!(&env, Error::IssuerNotFound);
        }
        env.storage()
            .persistent()
            .extend_ttl(&issuer_key, BUMP_THRESHOLD, ENTRY_TTL);

        let keys_key = DataKey::RetiredKeys(issuer_id.clone());
        if env.storage().persistent().has(&keys_key) {
            env.storage()
                .persistent()
                .extend_ttl(&keys_key, BUMP_THRESHOLD, ENTRY_TTL);
        }
        let revoked_key = DataKey::CurrentKeyRevoked(issuer_id.clone());
        if env.storage().persistent().has(&revoked_key) {
            env.storage()
                .persistent()
                .extend_ttl(&revoked_key, BUMP_THRESHOLD, ENTRY_TTL);
        }
    }

    /// The issuer's full key set: the current signing key first, then retired
    /// keys oldest-first. Empty vector for an unknown issuer.
    ///
    /// The current key is reported with `retired_at == 0`, `valid_until == 0`
    /// (it has no scheduled expiry) and `revoked` set when the current key was
    /// emergency-revoked. Retired keys past their window are pruned by the next
    /// rotation, so the list is live keys plus recent history.
    pub fn get_issuer_keys(env: Env, issuer_id: Address) -> Vec<IssuerKey> {
        let issuer: Issuer = match env
            .storage()
            .persistent()
            .get(&DataKey::Issuer(issuer_id.clone()))
        {
            Some(i) => i,
            None => return Vec::new(&env),
        };
        let mut out: Vec<IssuerKey> = Vec::new(&env);
        out.push_back(IssuerKey {
            pubkey: issuer.pubkey,
            retired_at: 0,
            valid_until: 0,
            revoked: Self::current_key_revoked(&env, &issuer_id),
        });
        for record in Self::retired_keys(&env, &issuer_id).iter() {
            out.push_back(record);
        }
        out
    }
    /// Admin-role only. Pass `None` for fields you don't want to set.
    pub fn set_issuer_metadata(
        env: Env,
        issuer: Address,
        name: Option<String>,
        url: Option<String>,
        logo: Option<String>,
    ) {
        Self::require_role(&env, &symbol_short!("admin"));
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Issuer(issuer.clone()))
        {
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

    /// Propose a new root admin. Root-admin only. Overwrites any existing
    /// pending proposal. Emits `("iss_reg", "adm_prop")` with the proposed
    /// address as the payload (#342).
    #[allow(deprecated)]
    pub fn propose_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);

        env.events().publish(
            (symbol_short!("iss_reg"), symbol_short!("adm_prop")),
            new_admin,
        );
    }

    /// Accept the pending root-admin role. Callable only by the address named
    /// in the most recent `propose_admin`. On success the accepted address
    /// becomes the new `DataKey::Admin` AND inherits every role the outgoing
    /// admin held — a wholesale governance transfer, so the outgoing root
    /// loses all privileged access exactly as it did before roles existed.
    /// Fine-grained delegation afterwards uses `grant_role` / `revoke_role`.
    /// Emits `("iss_reg", "adm_acc")` with the new admin as the payload (#342).
    #[allow(deprecated)]
    pub fn accept_admin(env: Env) {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingAdmin));
        pending.require_auth();

        let old_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));

        // Wholesale governance transfer: hand the new admin every role the old
        // admin held, so key management power moves with the admin key.
        let mut roles: Map<Symbol, Address> = Self::roles(&env);
        for (role, holder) in roles.iter() {
            if holder == old_admin {
                roles.set(role, pending.clone());
            }
        }
        env.storage().instance().set(&DataKey::Roles, &roles);
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);

        env.events().publish(
            (symbol_short!("iss_reg"), symbol_short!("adm_acc")),
            pending,
        );
    }

    /// Cancel a pending admin proposal. Root-admin only. Emits
    /// `("iss_reg", "adm_canc")` with an empty payload (#342).
    #[allow(deprecated)]
    pub fn cancel_admin_proposal(env: Env) {
        Self::require_admin(&env);
        env.storage().instance().remove(&DataKey::PendingAdmin);

        env.events()
            .publish((symbol_short!("iss_reg"), symbol_short!("adm_canc")), ());
    }

    /// Read the current pending admin proposal, if any (#342).
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
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

    /// Retired keys of an issuer, oldest first. Empty vector when it has none.
    fn retired_keys(env: &Env, issuer_id: &Address) -> Vec<IssuerKey> {
        env.storage()
            .persistent()
            .get(&DataKey::RetiredKeys(issuer_id.clone()))
            .unwrap_or_else(|| Vec::new(env))
    }

    fn store_retired_keys(env: &Env, issuer_id: &Address, keys: &Vec<IssuerKey>) {
        let key = DataKey::RetiredKeys(issuer_id.clone());
        env.storage().persistent().set(&key, keys);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, ENTRY_TTL);
    }

    /// Retired keys whose validity window has already closed. They validate
    /// nothing, so rotation drops them and the key history stays bounded.
    fn pruned_retired_keys(env: &Env, issuer_id: &Address, now: u64) -> Vec<IssuerKey> {
        let mut keys = Self::retired_keys(env, issuer_id);
        let mut i = 0u32;
        while i < keys.len() {
            if keys.get(i).unwrap().valid_until <= now {
                keys.remove(i);
            } else {
                i += 1;
            }
        }
        keys
    }

    /// True when the issuer's current signing key was emergency-revoked.
    fn current_key_revoked(env: &Env, issuer_id: &Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::CurrentKeyRevoked(issuer_id.clone()))
            .unwrap_or(false)
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

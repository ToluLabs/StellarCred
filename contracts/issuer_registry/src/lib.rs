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
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, String, Symbol, Vec,
};

// ── Event types ──────────────────────────────────────────────────────────────
// Topics follow the convention: (contract, action, credential_type_or_unit).
// `contract` is always `symbol_short!("iss_reg")` for IssuerRegistry events.
// `action`   identifies the operation.
// For events that are not credential-type-specific, the third topic is omitted
// (tuple length 2).

/// Payload emitted when an issuer is registered or updated.
/// Topics: ("iss_reg", "register")
#[contracttype]
#[derive(Clone)]
pub struct EventIssuerRegistered {
    /// The address of the newly registered issuer.
    pub issuer: Address,
    /// The issuer's secp256k1 public key (x || y, 32 bytes each).
    pub pubkey: BytesN<64>,
}

/// Payload emitted when an issuer is revoked.
/// Topics: ("iss_reg", "revoked")
#[contracttype]
#[derive(Clone)]
pub struct EventIssuerRevoked {
    /// The address of the revoked issuer.
    pub issuer: Address,
}

/// Payload emitted when an issuer rotates its signing key.
///
/// A rotation is *not* a revocation: `previous_pubkey` stays verifiable until
/// `previous_valid_until` so credentials already issued under it keep working,
/// while new issuance switches to `new_pubkey`.
///
/// Topics: ("iss_reg", "key_rot")
#[contracttype]
#[derive(Clone)]
pub struct EventIssuerKeyRotated {
    /// The issuer whose signing key changed.
    pub issuer: Address,
    /// The key that was in use before this rotation.
    pub previous_pubkey: BytesN<64>,
    /// The key that is in use after this rotation.
    pub new_pubkey: BytesN<64>,
    /// Ledger timestamp at which `previous_pubkey` stops being accepted.
    /// Credentials verified under it must be submitted before then.
    pub previous_valid_until: u64,
}

/// Payload emitted when an admin revokes a single issuer signing key.
///
/// Unlike a rotation this takes effect immediately and does not wait out any
/// overlap window — it is the emergency path for a compromised key.
///
/// Topics: ("iss_reg", "key_rev")
#[contracttype]
#[derive(Clone)]
pub struct EventIssuerKeyRevoked {
    /// The issuer that owned the key.
    pub issuer: Address,
    /// The revoked key.
    pub pubkey: BytesN<64>,
    /// Ledger timestamp at which the key was revoked.
    pub revoked_at: u64,
}

// Persistent-entry lifetime management (~5s ledgers).
const DAY_IN_LEDGERS: u32 = 17280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const ENTRY_TTL: u32 = 120 * DAY_IN_LEDGERS;

// Signing-key records get a longer life than ordinary issuer records. A
// retired key's record must outlive its overlap window, otherwise the entry
// would be evicted while outstanding credentials are still verifiable under
// it. 180 days comfortably covers the 90-day maximum window plus the bump
// threshold, and stays well under Stellar's ~1-year max persistent-entry TTL.
const KEY_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const KEY_ENTRY_TTL: u32 = 180 * DAY_IN_LEDGERS;

const SECONDS_PER_DAY: u64 = 86_400;

/// Maximum signing keys tracked per issuer (current + retired). Rotation is
/// expected to be rare (scheduled rotation, HSM migration), so a small bound
/// is enough and keeps `IssuerKeys` reads cheap.
const MAX_KEYS_PER_ISSUER: u32 = 4;

/// Maximum overlap window, in seconds, that a retired key may be given
/// (`MAX_OVERLAP_SECS = 90 days`).
///
/// Deliberately matched to ProofRegistry's `PROOF_TTL` (90 days): a cached
/// proof is evicted after 90 days, so a longer window would not keep any
/// additional credential verifiable — it would only widen the period during
/// which a superseded key can mint *new* credentials, which is the exact risk
/// rotation is meant to close.
const MAX_OVERLAP_SECS: u64 = 90 * SECONDS_PER_DAY;

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

/// A single issuer signing key and the window in which it is accepted.
///
/// An issuer holds exactly one *current* key (mirrored in [`Issuer::pubkey`])
/// and may hold retired keys, each with a bounded validity window. This is what
/// makes key rotation non-destructive: credentials signed by a retired key keep
/// verifying until that key's window closes, instead of failing with
/// `IssuerKeyMismatch` the moment the issuer publishes a new key.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningKey {
    /// secp256k1 public key (x || y, 32 bytes each).
    pub pubkey: BytesN<64>,
    /// Ledger timestamp from which this key is accepted (inclusive).
    pub valid_from: u64,
    /// Ledger timestamp after which this key is no longer accepted
    /// (exclusive). `None` means the key is open-ended — i.e. it is the
    /// issuer's current key.
    pub valid_until: Option<u64>,
    /// Set by `revoke_issuer_key`. A revoked key is rejected immediately,
    /// regardless of `valid_from` / `valid_until`.
    pub revoked: bool,
    /// Ledger timestamp of the revocation, for incident forensics.
    pub revoked_at: Option<u64>,
}

impl SigningKey {
    /// True iff this key may sign *and* back a proof at `now`.
    pub fn is_usable_at(&self, now: u64) -> bool {
        if self.revoked {
            return false;
        }
        if now < self.valid_from {
            return false;
        }
        match self.valid_until {
            Some(until) => now < until,
            None => true,
        }
    }
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
    Issuer(Address),
    /// Append-only list of registered issuer addresses for enumeration.
    /// Stored in persistent storage to avoid hitting the instance-storage
    /// size cap as the issuer set grows.
    IssuerList,
    IssuerMetadata(Address),
    /// Total number of registered issuers; kept in sync with IssuerList so
    /// callers can size pagination requests without loading the whole list.
    IssuerCount,
    /// (issuer, pubkey) -> validity record for one signing key.
    IssuerKey(Address, BytesN<64>),
    /// issuer -> ordered list of pubkeys tracked in `IssuerKey`, oldest first.
    /// Bounds the per-issuer key count and lets callers enumerate an issuer's
    /// rotation history without scanning storage.
    IssuerKeys(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    IssuerNotFound = 2,
    MetadataTooLong = 3,
    /// The referenced signing key is not tracked for this issuer.
    KeyNotFound = 4,
    /// The issuer already tracks `MAX_KEYS_PER_ISSUER` keys.
    TooManyKeys = 5,
    /// The requested overlap window is empty (would retire the old key
    /// immediately). Use `revoke_issuer_key` for that — it emits a distinct
    /// event and is safe to retry.
    InvalidOverlap = 6,
    /// The requested overlap window exceeds `MAX_OVERLAP_SECS`.
    OverlapTooLong = 7,
    /// The new key is already the issuer's current key.
    RotationNoop = 8,
    /// The key was explicitly revoked. Revoked keys are never reinstated by
    /// rotation or re-registration.
    KeyRevoked = 9,
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
    }

    /// Register (or overwrite) a trusted issuer. Admin-only.
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
        Self::require_admin(&env);

        // Key bookkeeping. `register_issuer` is the legacy entry point and has
        // no overlap parameter, so it must not be usable to silently change an
        // issuer's signing key — that is exactly what stranded every
        // outstanding credential before this feature existed. An issuer that
        // already has key history must rotate via `rotate_issuer_key`. As a
        // side effect, re-registering an issuer to update its credential types
        // no longer disturbs its key history.
        if !Self::load_key_index(&env, &issuer_id).is_empty() {
            if Self::load_issuer(&env, &issuer_id).pubkey != pubkey {
                panic_with_error!(&env, Error::RotationNoop);
            }
        } else {
            // First registration, or a pre-upgrade issuer with no key history:
            // seed the index with the registered key, open-ended and valid from
            // genesis so credentials signed before this upgrade still verify.
            Self::store_key(
                &env,
                &issuer_id,
                &SigningKey {
                    pubkey: pubkey.clone(),
                    valid_from: 0,
                    valid_until: None,
                    revoked: false,
                    revoked_at: None,
                },
            );
        }

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

    /// Mark an issuer as revoked. Admin-only. Existing proofs are not affected
    /// here — revocation propagates through `is_valid_issuer` checks.
    // NOTE: We suppress the deprecation warning for `env.events().publish` here.
    // The idiomatic Soroban v26 replacement is `#[contractevent]`; we use
    // value-based publish to stay consistent with the rest of the codebase.
    #[allow(deprecated)]
    pub fn revoke_issuer(env: Env, issuer_id: Address) {
        Self::require_admin(&env);
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

    /// Rotate an issuer's signing key without invalidating outstanding
    /// credentials. Admin-only.
    ///
    /// `new_pubkey` becomes the issuer's current signing key immediately.
    /// `previous_pubkey` is retired but stays accepted until
    /// `now + overlap_secs`, so proofs already built against it keep
    /// submitting until their natural expiry. `overlap_secs` must be in
    /// `(0, MAX_OVERLAP_SECS]`.
    ///
    /// This is the *planned* path (scheduled rotation, HSM migration). For a
    /// compromised key use [`revoke_issuer_key`], which takes effect at once.
    // NOTE: We suppress the deprecation warning for `env.events().publish` here.
    // See the comment on `register_issuer` for the rationale.
    #[allow(deprecated)]
    pub fn rotate_issuer_key(
        env: Env,
        issuer_id: Address,
        new_pubkey: BytesN<64>,
        overlap_secs: u64,
    ) {
        Self::require_admin(&env);
        let now = env.ledger().timestamp();

        // A zero-length (or overflowing) window would retire the old key
        // immediately, which is what `revoke_issuer_key` is for.
        if overlap_secs == 0 || now.saturating_add(overlap_secs) <= now {
            panic_with_error!(&env, Error::InvalidOverlap);
        }
        if overlap_secs > MAX_OVERLAP_SECS {
            panic_with_error!(&env, Error::OverlapTooLong);
        }

        let mut issuer = Self::load_issuer(&env, &issuer_id);
        let previous_pubkey = issuer.pubkey.clone();
        if previous_pubkey == new_pubkey {
            panic_with_error!(&env, Error::RotationNoop);
        }

        // Never reinstate a key an admin explicitly revoked. Rotation is not a
        // recovery path for a compromised key.
        match Self::load_key(&env, &issuer_id, &new_pubkey) {
            Some(ref existing) if existing.revoked => {
                panic_with_error!(&env, Error::KeyRevoked)
            }
            _ => {}
        }

        let valid_until = now + overlap_secs;

        // Retire the outgoing key. If it predates this feature it has no record
        // yet, so back-fill one already inside its window; it stops being
        // accepted at `valid_until` like any other retired key.
        let mut previous =
            Self::load_key(&env, &issuer_id, &previous_pubkey).unwrap_or(SigningKey {
                pubkey: previous_pubkey.clone(),
                valid_from: 0,
                valid_until: None,
                revoked: false,
                revoked_at: None,
            });
        // If this key was already retired, keep the *earlier* deadline: a
        // rotation must never extend a window that is already closing.
        previous.valid_until = Some(match previous.valid_until {
            Some(existing) => existing.min(valid_until),
            None => valid_until,
        });
        Self::store_key(&env, &issuer_id, &previous);

        // Promote the incoming key. Rotating back to a key whose window is
        // still open reuses its existing slot rather than consuming a new one.
        if Self::load_key(&env, &issuer_id, &new_pubkey).is_none()
            && Self::load_key_index(&env, &issuer_id).len() >= MAX_KEYS_PER_ISSUER
        {
            panic_with_error!(&env, Error::TooManyKeys);
        }
        Self::store_key(
            &env,
            &issuer_id,
            &SigningKey {
                pubkey: new_pubkey.clone(),
                valid_from: now,
                valid_until: None,
                revoked: false,
                revoked_at: None,
            },
        );

        // `Issuer::pubkey` remains the issuer's *current* key, so existing
        // readers (indexer, UI, SDK) keep working unchanged.
        issuer.pubkey = new_pubkey.clone();
        let issuer_key = DataKey::Issuer(issuer_id.clone());
        env.storage().persistent().set(&issuer_key, &issuer);
        env.storage()
            .persistent()
            .extend_ttl(&issuer_key, BUMP_THRESHOLD, ENTRY_TTL);

        // Emit: topics = ("iss_reg", "key_rot")
        //       data   = EventIssuerKeyRotated { issuer, previous_pubkey,
        //                                            new_pubkey,
        //                                            previous_valid_until }
        env.events().publish(
            (symbol_short!("iss_reg"), symbol_short!("key_rot")),
            EventIssuerKeyRotated {
                issuer: issuer_id,
                previous_pubkey,
                new_pubkey,
                previous_valid_until: valid_until,
            },
        );
    }

    /// Emergency-revoke a single issuer signing key, effective immediately.
    /// Admin-only.
    ///
    /// Unlike [`rotate_issuer_key`] this ignores any validity window, so
    /// credentials signed by the key stop being accepted on the next proof
    /// submission — the correct response to a compromised or leaked key.
    ///
    /// Idempotent: re-revoking an already-revoked key is a no-op, so an
    /// emergency runbook can be retried safely. A revoked key can never be
    /// reinstated by a later rotation.
    // NOTE: We suppress the deprecation warning for `env.events().publish` here.
    // See the comment on `register_issuer` for the rationale.
    #[allow(deprecated)]
    pub fn revoke_issuer_key(env: Env, issuer_id: Address, pubkey: BytesN<64>) {
        Self::require_admin(&env);
        let now = env.ledger().timestamp();
        let mut key = Self::load_key(&env, &issuer_id, &pubkey)
            .unwrap_or_else(|| panic_with_error!(&env, Error::KeyNotFound));
        if key.revoked {
            return;
        }
        key.revoked = true;
        key.revoked_at = Some(now);
        Self::store_key(&env, &issuer_id, &key);

        // Emit: topics = ("iss_reg", "key_rev")
        //       data   = EventIssuerKeyRevoked { issuer, pubkey, revoked_at }
        env.events().publish(
            (symbol_short!("iss_reg"), symbol_short!("key_rev")),
            EventIssuerKeyRevoked {
                issuer: issuer_id,
                pubkey,
                revoked_at: now,
            },
        );
    }

    /// True iff `pubkey` is one of `issuer_id`'s signing keys and is accepted
    /// *right now*: the issuer is registered and not revoked, the key is inside
    /// its validity window, and it has not been revoked.
    ///
    /// This is the check ProofRegistry performs against a proof's public
    /// inputs, replacing the previous single-key equality test that made key
    /// rotation destructive.
    pub fn is_issuer_key_valid(env: Env, issuer_id: Address, pubkey: BytesN<64>) -> bool {
        let issuer = match env
            .storage()
            .persistent()
            .get::<_, Issuer>(&DataKey::Issuer(issuer_id.clone()))
        {
            Some(issuer) => issuer,
            None => return false,
        };
        if issuer.revoked {
            return false;
        }

        let index = Self::load_key_index(&env, &issuer_id);
        if index.is_empty() {
            // Pre-upgrade issuer: no key history was ever recorded, so the
            // single key in `Issuer::pubkey` is the only acceptable one.
            return issuer.pubkey == pubkey;
        }

        let now = env.ledger().timestamp();
        for tracked in index.iter() {
            if let Some(candidate) = Self::load_key(&env, &issuer_id, &tracked) {
                if candidate.pubkey == pubkey {
                    return candidate.is_usable_at(now);
                }
            }
        }
        // The issuer has key history and this key is not in it. This also
        // covers a revoked key whose record has since expired from storage:
        // an unknown key is never accepted via the legacy fallback above.
        false
    }

    /// Every signing key tracked for an issuer, oldest first, with its current
    /// validity window and revocation state. Powers issuer key-management UIs.
    pub fn get_issuer_keys(env: Env, issuer_id: Address) -> Vec<SigningKey> {
        let index = Self::load_key_index(&env, &issuer_id);
        let mut keys = Vec::new(&env);
        if index.is_empty() {
            // Pre-upgrade issuer: synthesise the implicit single key so callers
            // see a uniform shape before any rotation has happened.
            if let Some(issuer) = env
                .storage()
                .persistent()
                .get::<_, Issuer>(&DataKey::Issuer(issuer_id))
            {
                keys.push_back(SigningKey {
                    pubkey: issuer.pubkey,
                    valid_from: 0,
                    valid_until: None,
                    revoked: false,
                    revoked_at: None,
                });
            }
            return keys;
        }
        for tracked in index.iter() {
            if let Some(key) = Self::load_key(&env, &issuer_id, &tracked) {
                keys.push_back(key);
            }
        }
        keys
    }

    /// The validity record for one of an issuer's signing keys, or `None` if
    /// this key was never registered for that issuer.
    pub fn get_issuer_key(env: Env, issuer_id: Address, pubkey: BytesN<64>) -> Option<SigningKey> {
        Self::load_key(&env, &issuer_id, &pubkey)
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
    /// Admin-only. Pass `None` for fields you don't want to set.
    pub fn set_issuer_metadata(
        env: Env,
        issuer: Address,
        name: Option<String>,
        url: Option<String>,
        logo: Option<String>,
    ) {
        Self::require_admin(&env);
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

    fn load_key(env: &Env, issuer_id: &Address, pubkey: &BytesN<64>) -> Option<SigningKey> {
        env.storage()
            .persistent()
            .get(&DataKey::IssuerKey(issuer_id.clone(), pubkey.clone()))
    }

    fn load_key_index(env: &Env, issuer_id: &Address) -> Vec<BytesN<64>> {
        env.storage()
            .persistent()
            .get(&DataKey::IssuerKeys(issuer_id.clone()))
            .unwrap_or_else(|| Vec::new(env))
    }

    /// Persist a key's validity record and add it to the issuer's key index
    /// if it is not tracked yet.
    fn store_key(env: &Env, issuer_id: &Address, key: &SigningKey) {
        let storage_key = DataKey::IssuerKey(issuer_id.clone(), key.pubkey.clone());
        env.storage().persistent().set(&storage_key, key);
        env.storage()
            .persistent()
            .extend_ttl(&storage_key, KEY_BUMP_THRESHOLD, KEY_ENTRY_TTL);

        let index_key = DataKey::IssuerKeys(issuer_id.clone());
        let mut index = Self::load_key_index(env, issuer_id);
        if !index.contains(&key.pubkey) {
            index.push_back(key.pubkey.clone());
            env.storage().persistent().set(&index_key, &index);
        }
        env.storage()
            .persistent()
            .extend_ttl(&index_key, KEY_BUMP_THRESHOLD, KEY_ENTRY_TTL);
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

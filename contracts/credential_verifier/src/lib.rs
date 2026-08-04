#![no_std]
//! CredentialVerifier
//!
//! Stateless cryptographic gateway. A single `verify_proof` entry point accepts
//! any credential type — it looks up the VK by Symbol from persistent storage
//! and runs the UltraHonk verifier. Adding a new credential type requires only
//! calling `set_vk` with the new circuit's VK; no contract changes or redeploy.
//!
//! Verification keys are set by an admin (one VK per credential circuit). Each VK
//! is tied to a specific Noir circuit and must be produced with the same `bb`
//! version used to generate proofs (Barretenberg v0.87.0 / Noir 1.0.0-beta.9).
//! `proof` and `public_inputs` are the opaque byte blobs emitted by `bb`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, Env, Symbol,
};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, PROOF_BYTES};

// ── Event types ──────────────────────────────────────────────────────────────
// Topics follow the convention: (contract, action, credential_type).
// `contract` is always `symbol_short!("cred_ver")` for CredentialVerifier events.

/// Payload emitted when a verification key is registered or replaced.
/// Topics: ("cred_ver", "vk_set", credential_type)
#[contracttype]
#[derive(Clone)]
pub struct EventVkSet {
    /// The admin address that performed the update.
    pub admin: Address,
}

// Persistent-entry lifetime management (~5s ledgers). VKs are long-lived.
const DAY_IN_LEDGERS: u32 = 17280;
const VK_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const VK_TTL: u32 = 180 * DAY_IN_LEDGERS;

#[contracttype]
pub enum DataKey {
    Admin,
    /// Verification key bytes, keyed by (credential-type symbol, version).
    Vk(Symbol, u32),
    /// Tracks the latest VK version registered for a credential type.
    LatestVersion(Symbol),
    /// Marks a specific (credential_type, version) as deprecated — no longer
    /// accepted for new submissions. Old proofs using this version remain
    /// readable (the VK is not deleted).
    DeprecatedVersion(Symbol, u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    VkNotSet = 2,
    VkInvalid = 3,
    /// The requested VK version has been deprecated by the admin; new
    /// submissions against it are rejected.
    VersionDeprecated = 4,
    /// A VK is already registered at the requested (credential_type,
    /// version); VKs are immutable once set — register a new version instead.
    VkAlreadySet = 5,
}

#[contract]
pub struct CredentialVerifier;

#[contractimpl]
impl CredentialVerifier {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Register the verification key for a credential circuit. Admin-only.
    /// A version's VK is immutable once set — re-registering an existing
    /// (credential_type, version) panics with `VkAlreadySet`; register a new
    /// (higher) version to upgrade. The VK is validated by parsing it before
    /// storage, rejecting malformed keys at set time.
    // NOTE: We suppress the deprecation warning for `env.events().publish` here.
    // The idiomatic Soroban v26 replacement is `#[contractevent]`; we use
    // value-based publish to stay consistent with the rest of the codebase.
    #[allow(deprecated)]
    pub fn set_vk(env: Env, credential_type: Symbol, version: u32, vk: Bytes) {
        let admin = Self::require_admin(&env);
        // Version 0 is reserved — it is the ProofRecord sentinel meaning
        // "no version" (see ProofRegistry), and no VK may be registered at 0.
        if version == 0 {
            panic_with_error!(&env, Error::VkInvalid);
        }
        let key = DataKey::Vk(credential_type.clone(), version);
        // A version's VK is immutable once registered: proofs are verified
        // and cached against it, so silently replacing the bytes would
        // invalidate every existing proof. Register a new (higher) version
        // to upgrade the circuit.
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::VkAlreadySet);
        }
        if UltraHonkVerifier::new(&env, &vk).is_err() {
            panic_with_error!(&env, Error::VkInvalid);
        }
        env.storage().persistent().set(&key, &vk);
        env.storage()
            .persistent()
            .extend_ttl(&key, VK_BUMP_THRESHOLD, VK_TTL);

        // Auto-advance the latest-version pointer for this credential type so
        // `verify_proof(None)` resolves to the newest registered VK. Re-setting
        // an older version (out-of-order admin call) never moves it backwards.
        let latest_key = DataKey::LatestVersion(credential_type.clone());
        let current = env
            .storage()
            .persistent()
            .get::<_, u32>(&latest_key)
            .unwrap_or(0);
        if version > current {
            env.storage().persistent().set(&latest_key, &version);
        }
        // Always refresh the latest pointer's TTL on any successful
        // registration — not only when the version advances — so that
        // `verify_proof(..., None)`, the default path for new submissions,
        // can never lapse into `VkNotSet` after 180 days without a new
        // circuit version.
        env.storage()
            .persistent()
            .extend_ttl(&latest_key, VK_BUMP_THRESHOLD, VK_TTL);

        // Emit: topics = ("cred_ver", "vk_set", credential_type)
        //       data   = EventVkSet { admin }
        env.events().publish(
            (
                symbol_short!("cred_ver"),
                symbol_short!("vk_set"),
                credential_type,
            ),
            EventVkSet { admin },
        );
    }

    /// Admin-only. Marks a specific `(credential_type, version)` VK as
    /// deprecated. New submissions against a deprecated version are rejected
    /// by `verify_proof` (panics with `VersionDeprecated`), but the VK is not
    /// deleted, so existing cached proofs that were verified against that
    /// version remain readable in ProofRegistry.
    pub fn deprecate_version(env: Env, credential_type: Symbol, version: u32) {
        Self::require_admin(&env);

        // Only versions that actually have a registered VK can be deprecated.
        env.storage()
            .persistent()
            .get::<_, Bytes>(&DataKey::Vk(credential_type.clone(), version))
            .unwrap_or_else(|| panic_with_error!(&env, Error::VkNotSet));

        let dep_key = DataKey::DeprecatedVersion(credential_type, version);
        env.storage().persistent().set(&dep_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&dep_key, VK_BUMP_THRESHOLD, VK_TTL);
    }

    /// Admin-only. Refreshes the TTL of the `LatestVersion` pointer AND the VK
    /// blob it resolves to, so that `verify_proof(..., None)` — the default
    /// submission path — keeps working in long-lived deployments that register
    /// no new circuit versions. Panics with `VkNotSet` if no VK has been
    /// registered for the credential type yet.
    ///
    /// The pointer alone is not enough: if the VK blob at
    /// `Vk(credential_type, version)` expires, `verify_proof` panics with
    /// `VkNotSet` at the blob lookup even though the pointer is still alive.
    /// And because `set_vk` rejects re-registration of an existing version
    /// (`VkAlreadySet`), this refresh is the only way to extend VK blob TTLs
    /// after deployment.
    pub fn refresh_latest_version_ttl(env: Env, credential_type: Symbol) {
        Self::require_admin(&env);
        let latest_key = DataKey::LatestVersion(credential_type.clone());
        let version = env
            .storage()
            .persistent()
            .get::<_, u32>(&latest_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::VkNotSet));
        env.storage()
            .persistent()
            .extend_ttl(&latest_key, VK_BUMP_THRESHOLD, VK_TTL);

        // Refresh the VK blob the pointer resolves to as well, so it never
        // expires underneath a live pointer (see doc comment above).
        let vk_key = DataKey::Vk(credential_type, version);
        env.storage()
            .persistent()
            .extend_ttl(&vk_key, VK_BUMP_THRESHOLD, VK_TTL);
    }

    /// Returns the highest VK version registered for `credential_type`, or
    /// panics with `VkNotSet` if no VK has been registered for the type yet.
    pub fn get_latest_version(env: Env, credential_type: Symbol) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LatestVersion(credential_type))
            .unwrap_or_else(|| panic_with_error!(&env, Error::VkNotSet))
    }

    /// Verify an UltraHonk proof for any registered credential type. Looks up
    /// the VK by `(credential_type, vk_version)`. Pass `vk_version = None` to
    /// use the latest registered version automatically.
    ///
    /// Returns `true` iff the proof is valid. Returns `false` for malformed
    /// inputs or invalid proofs; panics with `VkNotSet` if no VK has been
    /// registered for this type/version, or with `VersionDeprecated` if the
    /// requested version has been deprecated.
    pub fn verify_proof(
        env: Env,
        credential_type: Symbol,
        proof: Bytes,
        public_inputs: Bytes,
        vk_version: Option<u32>,
    ) -> bool {
        // Proofs are fixed-length; reject early before touching the verifier.
        if proof.len() as usize != PROOF_BYTES {
            return false;
        }

        // Version 0 is reserved — it is the ProofRecord sentinel meaning
        // "no version", and no VK may be registered at version 0.
        // Reject an explicit `Some(0)` so callers don't silently hit latest.
        let version = match vk_version {
            Some(0) => panic_with_error!(&env, Error::VkNotSet),
            Some(v) => v,
            None => env
                .storage()
                .persistent()
                .get(&DataKey::LatestVersion(credential_type.clone()))
                .unwrap_or_else(|| panic_with_error!(&env, Error::VkNotSet)),
        };

        // Reject submissions against a deprecated VK version.
        let dep_key = DataKey::DeprecatedVersion(credential_type.clone(), version);
        if env.storage().persistent().get::<_, bool>(&dep_key).unwrap_or(false) {
            panic_with_error!(&env, Error::VersionDeprecated);
        }

        let vk: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::Vk(credential_type, version))
            .unwrap_or_else(|| panic_with_error!(&env, Error::VkNotSet));

        match UltraHonkVerifier::new(&env, &vk) {
            Ok(verifier) => verifier.verify(&env, &proof, &public_inputs).is_ok(),
            Err(_) => false,
        }
    }

    fn require_admin(env: &Env) -> Address {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        admin.require_auth();
        admin
    }
}

mod test;

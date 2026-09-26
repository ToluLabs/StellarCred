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
//!
//! Privileged actions are governed by role-based access control (RBAC): the
//! constructor seeds the `admin` role with the deployer address, and each
//! privileged function is guarded by the role it maps to (`set_vk`,
//! `deprecate_version`, `refresh_latest_version_ttl` → `admin`). Roles are
//! stored as a `Map<Symbol, Address>` (role name → current holder); the root
//! admin can delegate or rotate holders via `grant_role` / `revoke_role`, and
//! anyone can query membership with `has_role`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, BytesN, Env, Map, Symbol,
};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, PROOF_BYTES};

// ── Event types ──────────────────────────────────────────────────────────────
// Topics follow the convention: (contract, action, credential_type).
// `contract` is always `symbol_short!("cred_ver")` for CredentialVerifier events.

/// Payload emitted when a verification key is registered or replaced.
/// Topics: ("cred_ver", "vk_set", credential_type)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventVkSet {
    /// The admin address that performed the update.
    pub admin: Address,
    /// The VK version being registered.
    pub version: u32,
    /// Contract version at time of VK registration (for audit trail).
    pub contract_version: u32,
}

/// Payload emitted when an obsolete verification key is removed.
/// Topics: ("cred_ver", "vk_pruned", credential_type)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventVkPruned {
    pub admin: Address,
    pub version: u32,
    /// Contract version at time of VK pruning (for audit trail).
    pub contract_version: u32,
}

/// Payload emitted when the contract is upgraded (new WASM deployed).
/// Topics: ("cred_ver", "upgraded")
#[contracttype]
#[derive(Clone)]
pub struct EventContractUpgraded {
    pub admin: Address,
    pub upgraded_at: u64,
}

// ── Contract versioning ──────────────────────────────────────────────────────
// Semantic version: MAJOR.MINOR.PATCH
// Increment MAJOR on breaking changes (new entry points, changed ABI)
// Increment MINOR on additive changes (new events, new query endpoints)
// Increment PATCH on bug fixes with no ABI changes
const CONTRACT_VERSION: u32 = 1_000_000; // 1.0.0 encoded as (major * 1000000) + (minor * 1000) + patch

// Persistent-entry lifetime management (~5s ledgers). VKs are long-lived.
const DAY_IN_LEDGERS: u32 = 17280;
const VK_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const VK_TTL: u32 = 180 * DAY_IN_LEDGERS;
// ProofRegistry's bounded claim validity window, expressed in ledger seconds.
const MAX_PROOF_VALIDITY_SECONDS: u64 = 90 * 86_400;

#[contracttype]
pub enum DataKey {
    Admin,
    /// RBAC: role name (Symbol) → current holder (Address).
    Roles,
    /// Verification key bytes, keyed by (credential-type symbol, version).
    Vk(Symbol, u32),
    /// Tracks the latest VK version registered for a credential type.
    LatestVersion(Symbol),
    /// Marks a specific (credential_type, version) as deprecated — no longer
    /// accepted for new submissions. Old proofs using this version remain
    /// readable (the VK is not deleted).
    DeprecatedVersion(Symbol, u32),
    /// Contract-controlled timestamp at which a version was deprecated.
    DeprecatedAt(Symbol, u32),
    /// Timestamp of the last upgrade (for audit trail).
    LastUpgradeTimestamp,
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
    /// The version may still be referenced by a valid cached proof.
    VkStillReferenceable = 6,
    /// The caller is not the holder of the role required by this function.
    RoleNotHeld = 7,
    /// `revoke_role` named an address that is not the current holder of the role.
    RoleHolderMismatch = 8,
}

#[contract]
pub struct CredentialVerifier;

#[contractimpl]
impl CredentialVerifier {
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

    /// Register the verification key for a credential circuit. Admin-only.
    /// Register the verification key for a credential circuit. Admin-role only.
    /// A version's VK is immutable once set — re-registering an existing
    /// (credential_type, version) panics with `VkAlreadySet`; register a new
    /// (higher) version to upgrade. The VK is validated by parsing it before
    /// storage, rejecting malformed keys at set time.
    // NOTE: We suppress the deprecation warning for `env.events().publish` here.
    // The idiomatic Soroban v26 replacement is `#[contractevent]`; we use
    // value-based publish to stay consistent with the rest of the codebase.
    #[allow(deprecated)]
    pub fn set_vk(env: Env, credential_type: Symbol, version: u32, vk: Bytes) {
        let admin = Self::require_role(&env, &symbol_short!("admin"));
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
        // A deprecated (including previously pruned) version can never be
        // resurrected. Register a new version instead.
        if env
            .storage()
            .persistent()
            .get::<_, bool>(&DataKey::DeprecatedVersion(credential_type.clone(), version))
            .unwrap_or(false)
        {
            panic_with_error!(&env, Error::VersionDeprecated);
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
        //       data   = EventVkSet { admin, version, contract_version }
        env.events().publish(
            (
                symbol_short!("cred_ver"),
                symbol_short!("vk_set"),
                credential_type,
            ),
            EventVkSet {
                admin,
                version,
                contract_version: CONTRACT_VERSION,
            },
        );
    }

    /// Admin-role only. Marks a specific `(credential_type, version)` VK as
    /// deprecated. New submissions against a deprecated version are rejected
    /// by `verify_proof` (panics with `VersionDeprecated`), but the VK is not
    /// deleted, so existing cached proofs that were verified against that
    /// version remain readable in ProofRegistry.
    pub fn deprecate_version(env: Env, credential_type: Symbol, version: u32) {
        Self::require_role(&env, &symbol_short!("admin"));

        // Only versions that actually have a registered VK can be deprecated.
        env.storage()
            .persistent()
            .get::<_, Bytes>(&DataKey::Vk(credential_type.clone(), version))
            .unwrap_or_else(|| panic_with_error!(&env, Error::VkNotSet));

        let dep_key = DataKey::DeprecatedVersion(credential_type.clone(), version);
        let already_deprecated = env
            .storage()
            .persistent()
            .get::<_, bool>(&dep_key)
            .unwrap_or(false);
        env.storage().persistent().set(&dep_key, &true);
        let at_key = DataKey::DeprecatedAt(credential_type, version);
        if !already_deprecated {
            env.storage()
                .persistent()
                .set(&at_key, &env.ledger().timestamp());
        }
        env.storage()
            .persistent()
            .extend_ttl(&dep_key, VK_BUMP_THRESHOLD, VK_TTL);
        env.storage()
            .persistent()
            .extend_ttl(&at_key, VK_BUMP_THRESHOLD, VK_TTL);
    }

    /// Admin-only. Permanently removes the VK bytes for a deprecated version.
    /// The safety delay starts when deprecation occurred, not when pruning is
    /// requested. The deprecation marker is retained, preventing reuse.
    #[allow(deprecated)]
    pub fn prune_version(env: Env, credential_type: Symbol, version: u32) {
        let admin = Self::require_admin(&env);
        let vk_key = DataKey::Vk(credential_type.clone(), version);
        if !env.storage().persistent().has(&vk_key) {
            panic_with_error!(&env, Error::VkNotSet);
        }
        if !env
            .storage()
            .persistent()
            .get::<_, bool>(&DataKey::DeprecatedVersion(credential_type.clone(), version))
            .unwrap_or(false)
        {
            panic_with_error!(&env, Error::VersionDeprecated);
        }
        let deprecated_at = env
            .storage()
            .persistent()
            .get::<_, u64>(&DataKey::DeprecatedAt(credential_type.clone(), version))
            .unwrap_or_else(|| panic_with_error!(&env, Error::VkStillReferenceable));
        if env.ledger().timestamp() < deprecated_at.saturating_add(MAX_PROOF_VALIDITY_SECONDS) {
            panic_with_error!(&env, Error::VkStillReferenceable);
        }

        env.storage().persistent().remove(&vk_key);
        env.events().publish(
            (
                symbol_short!("cred_ver"),
                symbol_short!("vk_pruned"),
                credential_type,
            ),
            EventVkPruned {
                admin,
                version,
                contract_version: CONTRACT_VERSION,
            },
        );
    }

    /// Admin-role only. Refreshes the TTL of the `LatestVersion` pointer AND the VK
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
        Self::require_role(&env, &symbol_short!("admin"));
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
        if env
            .storage()
            .persistent()
            .get::<_, bool>(&dep_key)
            .unwrap_or(false)
        {
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

    /// Assign `address` as the holder of `role`, replacing any previous holder.
    /// Root-admin only. Use this to delegate or rotate a role's key — e.g. hand
    /// the `admin` role to an operations key, or prepare an `upgrader` /
    /// `pauser` key before such functionality is enabled.
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

    fn roles(env: &Env) -> Map<Symbol, Address> {
        env.storage()
            .instance()
            .get(&DataKey::Roles)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    /// Require `address` to be authenticated as the current holder of `role`,
    /// returning the holder so callers can attribute an action to it.
    fn require_role(env: &Env, role: &Symbol) -> Address {
        let holder: Address = Self::roles(env)
            .get(role.clone())
            .unwrap_or_else(|| panic_with_error!(env, Error::RoleNotHeld));
        holder.require_auth();
        holder
    }

    /// Require the root admin key to be authenticated. Used by the role
    /// management functions (`grant_role` / `revoke_role`), which stay on the
    /// bootstrap trust anchor rather than a delegatable role.
    fn require_admin(env: &Env) -> Address {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        admin.require_auth();
        admin
    }

    /// Admin-only: upgrade contract to new WASM, emitting an upgrade event.
    #[allow(deprecated)]
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin = Self::require_admin(&env);

        // Emit upgrade event before executing the upgrade
        env.events().publish(
            (symbol_short!("cred_ver"), symbol_short!("upgraded")),
            EventContractUpgraded {
                admin,
                upgraded_at: env.ledger().timestamp(),
            },
        );

        // Record upgrade timestamp for audit trail
        env.storage()
            .instance()
            .set(&DataKey::LastUpgradeTimestamp, &env.ledger().timestamp());

        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Returns the timestamp of the last upgrade, or 0 if none has occurred.
    pub fn last_upgrade_timestamp(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::LastUpgradeTimestamp)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;

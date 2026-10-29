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
//!
//! Admin transfer is two-step (#342): the root admin calls `propose_admin`
//! with the incoming address, and that address must call `accept_admin` to
//! take over. On acceptance, the accepted address becomes the new root admin
//! AND inherits every role the outgoing admin held — a wholesale governance
//! transfer. A pending proposal can be overwritten by another `propose_admin`
//! or cleared with `cancel_admin_proposal`.

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

/// Payload emitted when a proof verification succeeds.
/// Topics: ("cred_ver", "ver_ok", credential_type)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventVerificationSucceeded {
    /// The VK version used for verification.
    pub version: u32,
    /// Ledger timestamp of the verification.
    pub verified_at: u64,
}

/// Payload emitted when a proof verification fails (invalid proof, malformed
/// input, or verifier error). Panics (e.g. `VkNotSet`, `VersionDeprecated`)
/// are not captured by this event.
/// Topics: ("cred_ver", "ver_fail", credential_type)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventVerificationFailed {
    /// The VK version used for verification.
    pub version: u32,
    /// Ledger timestamp of the failed verification.
    pub failed_at: u64,
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
// This constant is the on-chain enforcement of the VK support-window policy:
// a VK version may not be pruned until at least this many seconds have elapsed
// since it was deprecated. Changing this value changes the policy — update
// SUPPORT_POLICY.md (section "VK Versions and the Pruning Rule") in the same
// commit. See: SUPPORT_POLICY.md
const MAX_PROOF_VALIDITY_SECONDS: u64 = 90 * 86_400;

#[contracttype]
pub enum DataKey {
    Admin,
    /// Pending root-admin candidate set by `propose_admin` and consumed by
    /// `accept_admin` (#342).
    PendingAdmin,
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
    /// `accept_admin` was called with no pending proposal (#342).
    NoPendingAdmin = 9,
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
            .get::<_, bool>(&DataKey::DeprecatedVersion(
                credential_type.clone(),
                version,
            ))
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

    }
}

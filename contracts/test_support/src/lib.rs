//! Shared test harness for the StellarCred contract suites.
//!
//! Every contract test suite used to open with the same block of setup:
//! generate an admin, register `IssuerRegistry`, register `CredentialVerifier`,
//! register `ProofRegistry` wired to the two, register an issuer whose on-chain
//! pubkey matches the one baked into the checked-in UltraHonk fixtures, and
//! register the verification key. Each suite then re-derived those fixtures on
//! its own, which is why the test files grew past their implementations and why
//! adding a test meant retyping setup instead of writing a scenario.
//!
//! This crate owns that setup once:
//!
//! - [`deploy_all_contracts`] / [`Contracts::deploy`] — deploy and wire
//!   IssuerRegistry + CredentialVerifier + ProofRegistry (and, on request,
//!   GatedPool).
//! - [`Contracts::register_issuer`] / [`register_issuer_for`] — register an
//!   issuer trusted for a credential type, keyed by the pubkey the real
//!   fixtures were signed with.
//! - [`Contracts::set_vk`] / [`enable_vks`] — register real circuit VKs.
//! - [`Contracts::valid_submission`] / [`Contracts::submit`] — build a valid
//!   proof submission (batch entry or single `submit_proof` call).
//!
//! The artifacts are the *real* ones from `fixtures/<circuit>/`, produced by
//! `circuits/scripts/build.sh` and re-derived in CI, so the BN254 verification
//! path on-chain is genuinely exercised. This crate removes duplicated setup
//! only — it never stubs verification.
//!
//! # Example
//!
//! ```ignore
//! use test_support::{Contracts, KYC};
//!
//! let env = Env::default();
//! env.mock_all_auths();
//! let c = Contracts::deploy(&env);
//! let issuer = c.enable(&env, &KYC);
//!
//! let holder = Address::generate(&env);
//! c.submit(&env, &holder, &issuer, &KYC, 9_999);
//!
//! assert!(c.verify(&env, &holder, &KYC));
//! ```

use credential_verifier::CredentialVerifier;
use gated_pool::GatedPool;
use issuer_registry::IssuerRegistry;
use proof_registry::{ProofRegistry, ProofSubmission};
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Symbol, Vec};

// A contract crate's own test target compiles that crate twice: once as the
// lib under test and once as `test_support`'s dependency. The two copies are
// distinct types, so a harness-returned client would not unify with the same
// client named from the crate under test. Re-exporting the exact types the
// harness hands back lets every suite speak one client vocabulary.
pub use credential_verifier::CredentialVerifierClient;
pub use gated_pool::GatedPoolClient;
pub use issuer_registry::IssuerRegistryClient;
pub use proof_registry::ProofRegistryClient;

/// Include a raw artifact from `fixtures/<circuit>/<part>`.
///
/// `include_bytes!` needs a path literal, so the fixture name is a macro
/// argument rather than a runtime value. Every circuit in the repository has a
/// complete `{vk, proof, public_inputs}` bundle (see [`Circuit`]); reach for
/// this only for a one-off artifact, such as a VK with no matching proof.
#[macro_export]
macro_rules! fixture {
    ($circuit:literal, $part:literal) => {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/",
            $circuit,
            "/",
            $part
        ))
    };
}

/// Public-input field index (0-based) where a circuit's secp256k1 issuer key
/// starts. Mirrors `PUBKEY_START_FIELD` in `proof_registry`.
const PUBKEY_START_FIELD: u32 = 1;

/// Byte size of one BN254 public-input field.
const FIELD_BYTES: usize = 32;

/// Offset the tests flip to produce a "same shape, different proof" artifact.
const TAMPER_OFFSET: usize = 5000;

/// Credential types covered by the real N=2 aggregate fixture, in the order the
/// circuit packs them: KYC (65 fields) then age (67 fields).
const AGGREGATE_SLOTS: [&str; 2] = ["kyc", "age"];

// ── Circuit fixtures ─────────────────────────────────────────────────────────

/// A checked-in UltraHonk circuit: its credential-type name and its real
/// verification key, proof, and public inputs.
///
/// Building one of these is what lets a test say `&KYC` instead of restating
/// three `include_bytes!` constants and the pubkey-extraction loop that reads
/// the issuer key back out of the public inputs.
#[derive(Clone, Copy)]
pub struct Circuit {
    /// Credential type this circuit's VK is registered under.
    pub name: &'static str,
    /// Real verification key from `fixtures/<name>/vk`.
    pub vk: &'static [u8],
    /// Real proof from `fixtures/<name>/proof`.
    pub proof: &'static [u8],
    /// Real public inputs from `fixtures/<name>/public_inputs`.
    pub public_inputs: &'static [u8],
}

impl Circuit {
    /// This circuit's credential type as a contract `Symbol`.
    pub fn ct(&self, env: &Env) -> Symbol {
        Symbol::new(env, self.name)
    }

    /// The verification key as contract `Bytes`.
    pub fn vk_bytes(&self, env: &Env) -> Bytes {
        Bytes::from_slice(env, self.vk)
    }

    /// The proof as contract `Bytes`.
    pub fn proof_bytes(&self, env: &Env) -> Bytes {
        Bytes::from_slice(env, self.proof)
    }

    /// The public inputs as contract `Bytes`.
    pub fn public_inputs_bytes(&self, env: &Env) -> Bytes {
        Bytes::from_slice(env, self.public_inputs)
    }

    /// The secp256k1 issuer key (x ‖ y) this circuit's proof attests to, read
    /// out of the public inputs so a registered issuer matches the proof
    /// instead of a hand-written constant.
    pub fn issuer_pubkey(&self, env: &Env) -> BytesN<64> {
        issuer_pubkey_at(env, self.public_inputs, PUBKEY_START_FIELD)
    }

    /// The proof with one byte flipped — for "this must not verify" tests.
    /// Same length and framing as the real proof, so it reaches the verifier
    /// and fails on the cryptography rather than on a shape check.
    pub fn tampered_proof(&self, env: &Env) -> Bytes {
        let mut raw = self.proof.to_vec();
        let idx = TAMPER_OFFSET.min(raw.len().saturating_sub(1));
        if let Some(byte) = raw.get_mut(idx) {
            *byte ^= 0xff;
        }
        Bytes::from_slice(env, &raw)
    }
}

macro_rules! circuit {
    ($name:literal) => {
        Circuit {
            name: $name,
            vk: include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../fixtures/",
                $name,
                "/vk"
            )),
            proof: include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../fixtures/",
                $name,
                "/proof"
            )),
            public_inputs: include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../fixtures/",
                $name,
                "/public_inputs"
            )),
        }
    };
}

pub static KYC: Circuit = circuit!("kyc");
pub static AGE: Circuit = circuit!("age");
pub static INCOME: Circuit = circuit!("income");
pub static FUNDS: Circuit = circuit!("funds");
pub static RANGE: Circuit = circuit!("range");
pub static JURISDICTION: Circuit = circuit!("jurisdiction");
pub static EMPLOYMENT: Circuit = circuit!("employment");
pub static SET_MEMBERSHIP: Circuit = circuit!("set_membership");
/// The real N=2 aggregate proof covering KYC + age.
pub static AGGREGATE: Circuit = circuit!("aggregate");

/// Read the 64-byte issuer public key starting at 32-byte field
/// `start_field` of a circuit's public inputs.
pub fn issuer_pubkey_at(env: &Env, public_inputs: &[u8], start_field: u32) -> BytesN<64> {
    let mut key = [0u8; 64];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = public_inputs[(start_field as usize + i) * FIELD_BYTES + FIELD_BYTES - 1];
    }
    BytesN::from_array(env, &key)
}

/// Re-encode raw big-endian public-input bytes as the `Vec<u32>` that batch
/// submissions carry.
pub fn public_inputs_to_u32(env: &Env, public_inputs: &[u8]) -> Vec<u32> {
    let mut out = Vec::new(env);
    for chunk in public_inputs.chunks(4) {
        if chunk.len() < 4 {
            break;
        }
        let mut word = [0u8; 4];
        word.copy_from_slice(chunk);
        out.push_back(u32::from_be_bytes(word));
    }
    out
}

// ── Standalone deploys ───────────────────────────────────────────────────────

/// Deploy `IssuerRegistry` on its own, returning `(admin, client)`.
pub fn deploy_issuer_registry(env: &Env) -> (Address, IssuerRegistryClient<'static>) {
    let admin = Address::generate(env);
    let id = env.register(IssuerRegistry, (admin.clone(),));
    (admin, IssuerRegistryClient::new(env, &id))
}

/// Deploy `CredentialVerifier` on its own, returning `(admin, client)`.
pub fn deploy_credential_verifier(env: &Env) -> (Address, CredentialVerifierClient<'static>) {
    let admin = Address::generate(env);
    let id = env.register(CredentialVerifier, (admin.clone(),));
    (admin, CredentialVerifierClient::new(env, &id))
}

/// Deploy `CredentialVerifier` and register `circuit`'s real VK at `version`.
pub fn setup_verifier(
    env: &Env,
    circuit: &Circuit,
    version: u32,
) -> CredentialVerifierClient<'static> {
    setup_verifier_under(env, &circuit.ct(env), version, circuit.vk)
}

/// Deploy `CredentialVerifier` and register raw `vk` bytes under
/// `credential_type`. Use this when the registered VK and the credential type
/// do not come from the same circuit — the jurisdiction allowlist fixture is
/// registered under `jurisdiction`.
pub fn setup_verifier_under(
    env: &Env,
    credential_type: &Symbol,
    version: u32,
    vk: &[u8],
) -> CredentialVerifierClient<'static> {
    let (_admin, verifier) = deploy_credential_verifier(env);
    verifier.set_vk(credential_type, &version, &Bytes::from_slice(env, vk));
    verifier
}

/// Whether `circuit`'s real proof verifies on `verifier` at `vk_version`.
pub fn verify_with(
    verifier: &CredentialVerifierClient,
    env: &Env,
    circuit: &Circuit,
    vk_version: Option<u32>,
) -> bool {
    verifier.verify_proof(
        &circuit.ct(env),
        &circuit.proof_bytes(env),
        &circuit.public_inputs_bytes(env),
        &vk_version,
    )
}

/// Deploy IssuerRegistry, CredentialVerifier, and a ProofRegistry wired to both.
///
/// This is the whole stack a credential test needs; nothing is registered yet,
/// so auth mocking is the caller's choice.
pub fn deploy_all_contracts(env: &Env) -> Contracts {
    Contracts::deploy(env)
}

// ── The wired stack ──────────────────────────────────────────────────────────

/// A deployed, wired IssuerRegistry / CredentialVerifier / ProofRegistry triple.
pub struct Contracts {
    /// The address every contract in this stack was registered with as admin.
    pub admin: Address,
    /// Deployed `IssuerRegistry` contract id.
    pub issuer_registry_id: Address,
    /// Deployed `CredentialVerifier` contract id.
    pub verifier_id: Address,
    /// Deployed `ProofRegistry` contract id.
    pub registry_id: Address,
    /// Client for the deployed `IssuerRegistry`.
    pub issuers: IssuerRegistryClient<'static>,
    /// Client for the deployed `CredentialVerifier`.
    pub verifier: CredentialVerifierClient<'static>,
    /// Client for the deployed `ProofRegistry`.
    pub registry: ProofRegistryClient<'static>,
}

impl Contracts {
    /// Deploy IssuerRegistry, CredentialVerifier, and a ProofRegistry wired to
    /// both, all sharing one generated admin address.
    pub fn deploy(env: &Env) -> Self {
        let admin = Address::generate(env);

        let issuer_registry_id = env.register(IssuerRegistry, (admin.clone(),));
        let verifier_id = env.register(CredentialVerifier, (admin.clone(),));
        let registry_id = env.register(
            ProofRegistry,
            (
                admin.clone(),
                verifier_id.clone(),
                issuer_registry_id.clone(),
            ),
        );

        // Build the clients first: the struct literal below moves each address
        // into its field, so borrowing it for a client would come too late.
        let issuers = IssuerRegistryClient::new(env, &issuer_registry_id);
        let verifier = CredentialVerifierClient::new(env, &verifier_id);
        let registry = ProofRegistryClient::new(env, &registry_id);

        Self {
            admin,
            issuer_registry_id,
            verifier_id,
            registry_id,
            issuers,
            verifier,
            registry,
        }
    }

    /// Register a fresh issuer trusted for `circuit`'s credential type, keyed by
    /// the pubkey that circuit's real fixture attests to. Returns the issuer
    /// address to submit proofs as.
    pub fn register_issuer(&self, env: &Env, circuit: &Circuit) -> Address {
        self.register_issuer_for(env, circuit, &[circuit.name])
    }

    /// Register a fresh issuer trusted for several credential types, keyed by
    /// `circuit`'s pubkey. Use this when one issuer signed the fixtures for
    /// more than one circuit, as the KYC and funds demo fixtures share a key.
    pub fn register_issuer_for(
        &self,
        env: &Env,
        circuit: &Circuit,
        credential_types: &[&str],
    ) -> Address {
        self.register_issuer_with_key(env, credential_types, circuit.issuer_pubkey(env))
    }

    /// Register a fresh issuer with an explicit pubkey. Use this to build the
    /// negative case where the registered key does not match the proof.
    pub fn register_issuer_with_key(
        &self,
        env: &Env,
        credential_types: &[&str],
        pubkey: BytesN<64>,
    ) -> Address {
        let issuer = Address::generate(env);
        let mut types = Vec::new(env);
        for name in credential_types.iter() {
            types.push_back(Symbol::new(env, name));
        }
        self.issuers.register_issuer(&issuer, &pubkey, &types);
        issuer
    }

    /// Register `circuit`'s real VK at `version`.
    pub fn set_vk(&self, env: &Env, circuit: &Circuit, version: u32) {
        self.verifier
            .set_vk(&circuit.ct(env), &version, &circuit.vk_bytes(env));
    }

    /// Register the real VK of each circuit at version 1.
    pub fn enable_vks(&self, env: &Env, circuits: &[&Circuit]) {
        for &circuit in circuits {
            self.set_vk(env, circuit, 1);
        }
    }

    /// Make `circuit` fully usable: register its issuer and its VK. Returns the
    /// issuer address, so the usual test body is one line of setup.
    pub fn enable(&self, env: &Env, circuit: &Circuit) -> Address {
        let issuer = self.register_issuer(env, circuit);
        self.set_vk(env, circuit, 1);
        issuer
    }

    /// A `ProofSubmission` that verifies against this stack: real proof, real
    /// public inputs, and the issuer that signed them.
    pub fn valid_submission(
        &self,
        env: &Env,
        issuer: &Address,
        circuit: &Circuit,
        expiry: u64,
    ) -> ProofSubmission {
        ProofSubmission {
            credential_type: circuit.ct(env),
            proof: circuit.proof_bytes(env),
            public_inputs: public_inputs_to_u32(env, circuit.public_inputs),
            issuer_id: issuer.clone(),
            expiry,
            vk_version: None,
        }
    }

    /// Submit `circuit`'s real proof for `holder` via `submit_proof`.
    pub fn submit(
        &self,
        env: &Env,
        holder: &Address,
        issuer: &Address,
        circuit: &Circuit,
        expiry: u64,
    ) {
        self.registry.submit_proof(
            holder,
            issuer,
            &circuit.ct(env),
            &circuit.proof_bytes(env),
            &circuit.public_inputs_bytes(env),
            &None,
            &expiry,
        );
    }

    /// Submit `circuit`'s real proof for `holder`; returns true if the call
    /// reverted. Lets a negative test read as one line without naming the
    /// nested result type the SDK's `try_` methods return.
    pub fn try_submit(
        &self,
        env: &Env,
        holder: &Address,
        issuer: &Address,
        circuit: &Circuit,
        expiry: u64,
    ) -> bool {
        self.try_submit_with(env, holder, issuer, circuit, &circuit.proof_bytes(env), expiry)
    }

    /// Same as [`Contracts::try_submit`], with `proof` substituted for the real
    /// proof — the "one flipped byte" case.
    pub fn try_submit_with(
        &self,
        env: &Env,
        holder: &Address,
        issuer: &Address,
        circuit: &Circuit,
        proof: &Bytes,
        expiry: u64,
    ) -> bool {
        self.registry
            .try_submit_proof(
                holder,
                issuer,
                &circuit.ct(env),
                proof,
                &circuit.public_inputs_bytes(env),
                &None,
                &expiry,
            )
            .is_err()
    }

    /// Submit the real N=2 aggregate proof for `holder` with the given
    /// per-slot expiries; returns true if the call reverted.
    pub fn try_submit_aggregate(
        &self,
        env: &Env,
        holder: &Address,
        issuer: &Address,
        expiries: &[u64],
    ) -> bool {
        let call = self.aggregate_call(env, issuer, expiries);
        self.registry
            .try_submit_aggregate_proof(
                holder,
                &call.issuer_ids,
                &call.credential_types,
                &call.proof,
                &call.public_inputs,
                &call.expiries,
            )
            .is_err()
    }

    /// Whether `holder` currently has a valid claim for `circuit`.
    pub fn verify(&self, env: &Env, holder: &Address, circuit: &Circuit) -> bool {
        self.registry
            .is_verified(holder, &circuit.ct(env), &None)
            .0
    }

    /// Whether `circuit`'s real proof verifies directly on the verifier.
    pub fn verify_proof(&self, env: &Env, circuit: &Circuit, vk_version: Option<u32>) -> bool {
        verify_with(&self.verifier, env, circuit, vk_version)
    }

    /// Build the argument set for the real N=2 aggregate proof, with one slot
    /// per credential it covers and the given per-slot expiries.
    pub fn aggregate_call(&self, env: &Env, issuer: &Address, expiries: &[u64]) -> AggregateCall {
        let mut issuer_ids = Vec::new(env);
        let mut credential_types = Vec::new(env);
        let mut slots = Vec::new(env);

        for (slot, expiry) in AGGREGATE_SLOTS.iter().zip(expiries.iter()) {
            issuer_ids.push_back(issuer.clone());
            credential_types.push_back(Symbol::new(env, slot));
            slots.push_back(*expiry);
        }

        AggregateCall {
            issuer_ids,
            credential_types,
            proof: AGGREGATE.proof_bytes(env),
            public_inputs: AGGREGATE.public_inputs_bytes(env),
            expiries: slots,
        }
    }

    /// Deploy a `GatedPool` gated on `required_type` (optionally below
    /// `min_threshold`), wired to this stack's ProofRegistry.
    pub fn deploy_pool(
        &self,
        env: &Env,
        required_type: &str,
        min_threshold: Option<u64>,
    ) -> GatedPoolClient<'static> {
        let id = env.register(
            GatedPool,
            (
                self.registry_id.clone(),
                Symbol::new(env, required_type),
                min_threshold,
                None::<Address>,
            ),
        );
        GatedPoolClient::new(env, &id)
    }
}

/// The N=2 aggregate proof, one slot per credential it covers.
///
/// The credential types are fixed by the circuit's public-input layout, so the
/// only variable is the per-slot expiry. Build one with
/// [`Contracts::aggregate_call`]; submit it with [`AggregateCall::submit`].
pub struct AggregateCall {
    /// One issuer per slot, in slot order.
    issuer_ids: Vec<Address>,
    /// One credential type per slot, in slot order.
    credential_types: Vec<Symbol>,
    /// The real aggregate proof.
    proof: Bytes,
    /// The real aggregate public inputs.
    public_inputs: Bytes,
    /// One expiry per slot.
    expiries: Vec<u64>,
}

impl AggregateCall {
    /// Submit this aggregate proof for `holder`. Panics if any slot is invalid.
    pub fn submit(&self, contracts: &Contracts, holder: &Address) {
        contracts.registry.submit_aggregate_proof(
            holder,
            &self.issuer_ids,
            &self.credential_types,
            &self.proof,
            &self.public_inputs,
            &self.expiries,
        );
    }
}

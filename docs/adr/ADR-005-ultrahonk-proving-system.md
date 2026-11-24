# ADR-005: UltraHonk with keccak oracle hashing for on-chain verification

**Status:** Accepted  
**Relevant code:** `contracts/credential_verifier/src/lib.rs`, `circuits/Nargo.toml`, `CONTRIBUTING.md` (toolchain table)  
**Pinned versions:** Noir 1.0.0-beta.9 / Barretenberg (bb) 0.87.0

---

## Context

StellarCred generates ZK proofs in the browser and verifies them on the Stellar Soroban blockchain. The choice of proving system is not a simple preference — it determines proof size, verification cost, prover time, whether a trusted setup is required, and whether an efficient on-chain verifier exists for the target chain.

Soroban is a Wasm-based smart contract environment without a native elliptic-curve precompile. Any on-chain verifier must be compiled to Wasm and fit within Soroban's computational budget.

---

## Decision

StellarCred uses **UltraHonk** (the Honk proof system with UltraPlonk arithmetization), produced by Barretenberg (`bb`), with **keccak256 as the Fiat-Shamir oracle hash**. Proofs are verified on-chain by the `ultrahonk_soroban_verifier` crate, which is a Wasm-compatible Soroban contract library.

```rust
// contracts/credential_verifier/src/lib.rs
use ultrahonk_soroban_verifier::{UltraHonkVerifier, PROOF_BYTES};
```

Verification keys are deterministic given the circuit and the exact (`nargo`, `bb`) version pair. The toolchain versions are pinned precisely in `CONTRIBUTING.md` and the Docker image. A mismatch produces a VK that the on-chain verifier silently rejects.

---

## Alternatives considered

### 1. Groth16 (BN254)

Groth16 is the most widely deployed ZK proving system. It produces small proofs (≈192 bytes), has fast verification, and has well-audited toolchain support in `snarkjs`.

**Why rejected — trusted setup.** Groth16 requires a circuit-specific trusted setup (a Powers of Tau ceremony plus a per-circuit phase 2). Every time a circuit is modified — adding a new credential type, fixing a constraint — a new trusted setup ceremony must be run. StellarCred expects to iterate on circuits (adding employment, accreditation, and other credential types). Running a trusted setup ceremony for each change is operationally expensive and creates a window during which the system must trust the setup participants. UltraHonk is a transparent proving system with no trusted setup.

**Why rejected — no Wasm verifier for Soroban.** At the time of this decision, there was no production-ready Groth16 verifier for Soroban/Wasm. Soroban lacks the elliptic-curve precompiles that Ethereum provides, so a BN254 pairing-based verifier must be implemented entirely in Wasm, which is computationally expensive. The `ultrahonk_soroban_verifier` crate provides a working, tested Wasm verifier specifically for UltraHonk on Soroban.

### 2. PLONK (original KZG)

PLONK with KZG polynomial commitments also requires a trusted setup (a universal SRS, shared across circuits), which is less burdensome than Groth16 but still present. It provides smaller proofs than UltraHonk but still requires pairing operations that are expensive without a Soroban precompile.

**Why rejected — same pairing cost and ecosystem alignment.** The `bb` toolchain targets UltraHonk (and earlier UltraPlonk) natively; PLONK would require a different prover toolchain or a custom implementation. The ecosystem around Noir is converging on Honk-family proofs, and the Soroban verifier crate is written for UltraHonk specifically.

### 3. STARKs (e.g. via Stone or Plonky2)

STARKs are transparent (no trusted setup), post-quantum secure, and produce fast proofs. Recursive aggregation is a first-class feature.

**Why rejected — no Noir/Soroban integration.** Noir's primary backend is Barretenberg, which targets Honk-family proofs. There is no production-ready Noir → STARK compilation path. Using STARKs would require replacing the entire Noir toolchain with a different ZK DSL (e.g. Cairo for STARKs with a different VM). The development, auditing, and ecosystem cost of this switch is significantly higher than the current path.

**Why rejected — larger proof size.** STARK proofs are larger than SNARK proofs (tens of kilobytes versus a few kilobytes). Proof submission is an on-chain operation; larger proofs mean higher transaction fees for holders.

### 4. UltraHonk with SHA-256 oracle (instead of keccak)

UltraHonk supports both SHA-256 and keccak256 as the Fiat-Shamir hash. SHA-256 would be native to more blockchain environments.

**Why rejected — keccak256 is more efficient in Wasm.** The Soroban verifier is compiled to Wasm and runs inside the Soroban VM. keccak256 is implemented efficiently in the `tiny-keccak` crate, which compiles to compact Wasm. More practically, the `ultrahonk_soroban_verifier` crate is built for keccak-flavored UltraHonk proofs; switching oracle hashes would require either a different verifier crate or modifications to the existing one, and would invalidate all existing verification keys.

---

## Consequences

**What this makes true:**
- No trusted setup is required. Adding a new circuit type (e.g. a new credential type) requires only compiling the circuit and registering its VK via `CredentialVerifier.set_vk`. No ceremony, no coordination with external parties.
- The on-chain verifier is a pure Wasm crate that works within Soroban's computational model.
- Verification keys are deterministic and reproducible: given the same circuit source and the same (`nargo`, `bb`) version, `nargo compile` always produces the same VK. This is the basis for the reproducible build CI check (`.github/workflows/reproducible-build.yml`).

**What this makes harder:**
- The toolchain version pair (`nargo`, `bb`) must be pinned **exactly**. A minor version bump in either tool can change the VK, causing the on-chain verifier to reject all proofs generated with the new tool — or accept none of the proofs generated with the old tool. This is why `CONTRIBUTING.md` treats the version table as a hard constraint, not a guideline.
- Proof size is larger than Groth16 (a fixed `PROOF_BYTES` constant defined in the verifier crate). This determines the byte cost of each `submit_proof` call on-chain.
- Upgrading the proving system (e.g. moving to a future Honk variant or a different system entirely) requires: updating the verifier crate, registering new VKs for every credential type via `CredentialVerifier.set_vk`, deprecating old VKs via `CredentialVerifier.deprecate_version`, and having all holders re-submit proofs against the new VK. Existing cached proofs (stored `ProofRecord`s) remain valid until they expire; new submissions go against the upgraded VK.

**Version stability invariant:**
The `nargo` and `bb` version pair is the single most fragile dependency in the system. A circuit change, a toolchain upgrade, or even a change to a shared library dependency can silently alter the VK. The CI reproducible-build workflow (`reproducible-build.yml`) catches this by rebuilding circuits from source and comparing the output against committed artifacts. Any PR that touches `circuits/` or the toolchain versions must pass this check.

**If this decision were revisited:**
- Adopting a future Honk variant (e.g. Mega-Honk or a post-quantum variant) would require updating the `ultrahonk_soroban_verifier` dependency, re-generating VKs for all credential types, and coordinating a migration period during which both old and new VKs are registered in `CredentialVerifier` (using the versioning support already built into that contract).
- Adopting Groth16 for a specific credential type (e.g. a high-frequency type where smaller proof size justifies a trusted setup) could be done incrementally: `CredentialVerifier` is agnostic to proof system at the contract level; a Groth16 verifier crate could be added alongside the UltraHonk one and a new VK registered for that credential type. This would require a separate trusted setup ceremony for that circuit.

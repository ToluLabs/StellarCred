# ZK Toolchain Upgrade Policy

This document defines the formal policy and procedure for upgrading zero-knowledge (ZK) toolchain components in StellarCred (#971).

## Scope and Objectives

StellarCred relies on zero-knowledge proving circuits compiled with Noir and executed via Barretenberg and Soroban smart contracts. Upgrades to Noir (`nargo`), Barretenberg (`bb.js`), or contract verifiers can alter:
- Gate counts and constraint systems
- Public input ordering and serialization
- Prover outputs and Verification Keys (VKs)

To maintain cryptographic integrity and prevent unintended breaking changes for holders and integrators, all toolchain upgrades must follow this centralized policy.

---

## Toolchain Components and Pinned Versions

The canonical versions must remain synchronized across the repository:

| Component | Pinned Version | Canonical Reference |
|-----------|----------------|---------------------|
| Noir Language / Compiler | `1.0.0-beta.9` | `circuits/Nargo.toml`, `frontend/package.json` |
| Barretenberg Prover | `0.87.0` | `frontend/package.json` (`@aztec/bb.js`) |
| Noir JS Runtime | `1.0.0-beta.9` | `frontend/package.json` (`@noir-lang/noir_js`) |
| Circuit Manifest | `1.0.0` | `circuits/supported-circuits.v1.json` |

---

## Step-by-Step Upgrade Procedure

### 1. Pre-Upgrade Compatibility Assessment
Before initiating a toolchain upgrade:
- Review upstream changelogs for Noir and Barretenberg.
- Check for breaking changes in ACIR representation, UltraHonk/UltraPlonk proving format, and curve parameters.
- Verify whether the upgrade introduces breaking changes to existing on-chain verification contracts.

### 2. Synchronize Version Declarations
Update version pins across all repository locations simultaneously:
1. `frontend/package.json` (`dependencies` and `devDependencies`)
2. `circuits/Nargo.toml`
3. `.github/workflows/` CI workflow configurations
4. `docs/REPRODUCIBLE_BUILDS.md` and this policy document

Run the consistency checker to confirm synchronization:
```bash
node frontend/scripts/check-zk-toolchain-consistency.mjs
```

### 3. Recompile Circuits and Regenerate Artifacts
Rebuild all circuit artifacts with the updated compiler:
```bash
cd circuits
nargo compile
npm run testvectors:generate
```

### 4. Verification Key (VK) Review and Version Bumping
Every circuit modification or toolchain upgrade that changes circuit artifacts must be inspected:
1. Export the new verification keys.
2. Compare new VKs against current on-chain keys in `CredentialVerifier`.
3. If VK bytes have changed:
   - Increment `vkVersion` in `circuits/circuit-versions.json` and `circuits/supported-circuits.v1.json`.
   - Update `frontend/lib/circuit-versions.ts`.
   - Schedule the on-chain update via `set_vk(credential_type, new_vk_version, new_vk)`.
   - Preserve previous VK versions on-chain during the deprecation window to avoid stranding unexpired holder proofs.

### 5. Automated CI Validation
All toolchain upgrades must pass:
- Consistency checks (`check-zk-toolchain-consistency.mjs`)
- Unit and contract simulation tests (`pnpm test`)
- End-to-end browser prover tests (`pnpm test:e2e`)
- Artifact schema validation (`validateReleaseArtifacts`)

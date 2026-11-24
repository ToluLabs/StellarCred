# Security Review Handoff Package

This document is the self-contained handoff package for independent security reviewers auditing StellarCred's Soroban smart contracts, Noir zero-knowledge circuits, and credential issuance boundary.

---

## 1. Frozen Source Snapshot & Pinned Toolchains

| Artifact / Pin | Exact Value | Source of Truth |
|---|---|---|
| **Frozen Base Commit** | `481451442da89db91cf2b6427f0bfda61dc39ada` | `git rev-parse upstream/main` |
| **Rust Toolchain** | `1.93.1` (`wasm32v1-none` target) | `rust-toolchain.toml` |
| **Soroban SDK** | `26.0.1` | `Cargo.toml` / `Cargo.lock` |
| **UltraHonk Verifier** | `ultrahonk_soroban_verifier` rev `661db07200f890b1bd9a7349ed787c70a706dd12` | `Cargo.toml` |
| **Reproducible Docker Base** | `rust:1.93.1-slim-bookworm` | `docker/Dockerfile.reproducible` |
| **Noir Compiler (`nargo`)** | `1.0.0-beta.9` | `circuits/scripts/build.sh` |
| **Barretenberg (`bb`)** | `0.87.0` | `circuits/scripts/build.sh` |

Checkout the exact review snapshot:

```bash
git clone https://github.com/ToluLabs/StellarCred
cd StellarCred
git checkout 481451442da89db91cf2b6427f0bfda61dc39ada
```

---

## 2. Threat Model & Core Security Invariants

Reviewers should evaluate all in-scope components against [docs/THREAT_MODEL.md](THREAT_MODEL.md), [SECURITY.md](../SECURITY.md), and [docs/LIMITATIONS.md](LIMITATIONS.md).

### Key Trust Boundaries & Invariants

1. **On-Chain Trust Root (`IssuerRegistry`)**:
   - Only the admin can register, rotate (`rotate_issuer_key`), or revoke (`revoke_issuer_key`) issuer secp256k1 public keys.
   - `ProofRegistry` must reject any proof whose public-input issuer public key is not live in `IssuerRegistry` (`is_valid_issuer_key`).
2. **In-Circuit Signature Binding (`std::ecdsa_secp256k1`)**:
   - The issuer's secp256k1 signature over the raw 32-byte commitment (`prehash: false`) is verified inside the Noir circuit, binding the proof to a registered issuer without revealing the underlying attributes.
3. **Replay, Expiry & Revocation (`ProofRegistry`)**:
   - Verified proofs are cached with bounded TTL/expiry (`MAX_CREDENTIAL_TTL_SECS = 365 days`).
   - Revoking a proof (`revoke_proof`) or an issuer key invalidates subsequent checks as documented in `THREAT_MODEL.md` and `ISSUER_KEY_COMPROMISE_RUNBOOK.md`.
4. **Delegated Verification Privacy & Auth (`grant_verification` / `revoke_verification`)**:
   - Only the holder (`require_auth`) can create or revoke a grant; `check_delegated_verification` is a public read and must never be treated by relying parties as caller authentication.
5. **Server/Client Secret Boundary**:
   - `ISSUER_PRIVATE_KEY` must remain server-only (never `NEXT_PUBLIC_`), and KYC identity attributes must not be persisted or logged after commitment derivation.

---

## 3. Audit Scope

### 3.1 In-Scope Smart Contracts (`contracts/`)

| Contract Crate | Purpose | Security Criticality |
|---|---|---|
| `contracts/credential_verifier` | UltraHonk BN254 proof verification & VK registry (`set_vk`) | Critical — forged proof prevention |
| `contracts/issuer_registry` | Admin-controlled issuer secp256k1 key registration, rotation, revocation | Critical — trust root integrity |
| `contracts/proof_registry` | Proof submission, expiry, revocation, and delegated verification (`is_verified`, `check_delegated_verification`) | Critical — replay, TTL, and authorization |
| `contracts/gated_pool` | Protocol integration gating deposits/access via `ProofRegistry` | High — integration boundary & access control |

*(Note: `contracts/test_support` is a host-only test harness using `soroban-sdk` `testutils` and is excluded from WASM builds and deployment.)*

### 3.2 In-Scope Noir Circuits (`circuits/`)

All workspace members in `circuits/Nargo.toml` and the frozen v1.0.0 manifest (`circuits/supported-circuits.v1.json`):

- **Supported v1.0.0 Circuits**: `kyc_proof`, `age_proof`, `income_proof`, `jurisdiction_proof`, `funds_proof`, `accreditation_proof`
- **Additional Workspace Circuits & Libraries**: `range_proof`, `date_range`, `employment_proof`, `aggregate_proof`, `set_membership`, `commit`, `commit3`, `lib`

### 3.3 Security-Adjacent Off-Chain Surfaces

- `frontend/app/api/issue/route.ts` and `frontend/lib/issuer-signer.ts`: Server-side secp256k1 credential signing (`prehash: false`) and KYC attribute handling.
- `frontend/middleware.ts`: Auth/CSP boundary.

### 3.4 Out of Scope

- Frontend UI components, styling, localization, analytics, and marketing pages (`frontend/app/(marketing)`, `frontend/components/**` unrelated to signing/proof submission).
- Repository housekeeping workflows (`stale.yml`, `auto-label-deps.yml`).

---

## 4. Reproducible Build & Verification Instructions

### 4.1 Reproducible Contract WASM Build (Docker)

```bash
# 1. Build the pinned container image
docker build -f docker/Dockerfile.reproducible -t stellarcred-build .

# 2. Compile all four deployable contracts deterministically
mkdir -p out
docker run --rm \
  -v "$(pwd)/out:/out" \
  --env SOURCE_DATE_EPOCH=0 \
  stellarcred-build \
  sh -c "cargo build --release --target wasm32v1-none --locked --offline \
         && cp target/wasm32v1-none/release/credential_verifier.wasm \
               target/wasm32v1-none/release/issuer_registry.wasm \
               target/wasm32v1-none/release/proof_registry.wasm \
               target/wasm32v1-none/release/gated_pool.wasm \
               /out/"

# 3. Inspect SHA-256 hashes
sha256sum out/*.wasm
```

### 4.2 Contract Unit & Integration Tests

```bash
cargo test --workspace --locked
cargo clippy --workspace --all-targets -- -D warnings
```

### 4.3 Circuit Build & Verification Key (VK) Determinism Check

```bash
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"
./circuits/scripts/build.sh
./scripts/verify-vks.sh check
```

### 4.4 Live Deployment Verification

```bash
# Verifies contract IDs, on-chain versions, WASM hashes, and registered VKs
./scripts/verify-deployment.sh --network testnet
```

---

## 5. Deployed & Test Artifact Hashes

### 5.1 Testnet Deployment Artifacts (`v1.0.0`, Source Commit `f9250a5c`, from `DEPLOYMENTS.md`)

| Contract | WASM Binary | Testnet Contract ID | Expected WASM SHA-256 |
|---|---|---|---|
| **Issuer Registry** | `issuer_registry.wasm` | `CDYPCHIFRXAAJFUA7MBH4FAWYLNG7XMAH7QRGVF437V2PGDBXZ2VK2DZ` | `458d4ff6de2ca8e065388cab0b05b566a7a279ec4d46542ee5b41a30aacb46da` |
| **Credential Verifier** | `credential_verifier.wasm` | `CCUUSDWSCSML3DFXVNEXQN7OFYXY2PGBOLKJR5R4Q5JPK47V4TYPQUKJ` | `f3f26e37a960362784fbcd419de71986f06fc0655adfae08ba392f57ab7a199f` |
| **Proof Registry** | `proof_registry.wasm` | `CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV` | `ddf30335aa7dcf9146c9929003f3a4c1d1070f2c5d9482ca2e36886bfb34e0c4` |
| **Gated Pool** | `gated_pool.wasm` | `CCKQQGWNKMFWAYPT37KEI5WQSCDEPH6H7XZEFJ3UB5BH5SVZBUPVUGI3` | `32986998d4bf7277cbb3161d1236c349dcc39faa530a8ba2e74e00d1c27092d0` |

*(For the current frozen `HEAD` commit, compare locally built WASM hashes against the `wasm-hashes-<commit>` artifact generated by `.github/workflows/reproducible-build.yml`.)*

### 5.2 Committed Verification Key (`vk`) SHA-256 Hashes (`fixtures/*/vk` & `circuits/testvectors/`)

| Circuit / Fixture | Fixture Path | Verification Key SHA-256 |
|---|---|---|
| `kyc_proof` | `fixtures/kyc/vk` | `26ce557090824d4df738e6da312ca27cf550be0ea61d34351349b43b45e511ec` |
| `age_proof` | `fixtures/age/vk` | `59c05b19612ba45c6d22e3156241a061f70d2b8b71f18bdb225eb3ba9e7a5642` |
| `income_proof` | `fixtures/income/vk` | `54af1face92713de1c90cff727179324d3286a37bf07d399095162dd68338031` |
| `funds_proof` | `fixtures/funds/vk` | `54af1face92713de1c90cff727179324d3286a37bf07d399095162dd68338031` |
| `jurisdiction_proof` | `fixtures/jurisdiction/vk` | `f145ecc6fd0fee3fdb964aa1d29f53cce5c453672b2416383943c300b6d5c822` |
| `jurisdiction_allow` | `fixtures/jurisdiction_allow/vk` | `f145ecc6fd0fee3fdb964aa1d29f53cce5c453672b2416383943c300b6d5c822` |
| `accreditation_proof` | `fixtures/accreditation/vk` | `23938667956450a9d040a6c44d3e576e3d3ba5e3dbe13d9749a2625ce1536ca7` |
| `employment_proof` | `fixtures/employment/vk` | `0cd319427722b2d3f15ff0d04a020687a97e069163541f16290759ca890d526d` |
| `range_proof` | `fixtures/range/vk` | `b5e8e08f621124ba5ad8db3b2cb1ade0424b300071464c9a7e7991d8020d6070` |
| `set_membership` | `fixtures/set_membership/vk` | `6ea48a009c4d5cc23211c814f1de3962d8817650250ccaec505898753c5c8df8` |
| `aggregate_proof` | `fixtures/aggregate/vk` | `3d85a97e599b5cd383103694f3d6c153768dc99046cf17814effc07952c202bc` |

---

## 6. Finding-Response Tracker

All audit findings must be logged below and tracked to final disposition before mainnet deployment.

### Field Definitions
- **Severity**: `Critical` | `High` | `Medium` | `Low` | `Informational`
- **Disposition**: `Open` | `Confirmed - Fix Planned` | `Fixed` | `Acknowledged - Accepted Risk` | `Disputed` | `Duplicate`
- **Verification Status**: `Pending` | `Verified Fixed` | `N/A`

| Finding ID | Severity | Component | Summary | Disposition | Owner | Remediation Commit / PR | Verification Status |
|---|---|---|---|---|---|---|---|
| `SC-001` | *TBD* | *e.g. `contracts/proof_registry`* | *Reviewer finding description* | `Open` | *Maintainer* | *TBD* | `Pending` |

# StellarCred Contract Deployments

This document maintains the record of deployed StellarCred smart contract IDs
on each Stellar network, the exact source commit each deployment was built from,
and the SHA-256 hashes of the WASM artifacts. The hashes are the anchor for
independent verification: anyone can rebuild from the recorded commit and check
that their output matches.

---

## How to verify a deployment

For every deployment listed below, the recorded commit SHA and WASM hashes let
you confirm independently that the on-chain bytecode matches the open-source
source code.

**Quick path (Docker — recommended):**

```bash
# 1. Check out the exact commit the deployment was built from.
git clone https://github.com/ToluLabs/StellarCred
cd StellarCred
git checkout <COMMIT_SHA>          # see "Source commit" in the table below

# 2. Build inside the pinned container.
docker build -f docker/Dockerfile.reproducible -t stellarcred-build .
mkdir -p out
docker run --rm -v "$(pwd)/out:/out" --env SOURCE_DATE_EPOCH=0 \
  stellarcred-build \
  sh -c "cargo build --release --target wasm32v1-none --locked --offline \
         && cp target/wasm32v1-none/release/*.wasm /out/"

# 3. Compare your hashes against the "Expected WASM SHA-256" column below.
sha256sum out/*.wasm

# 4. Optionally, confirm the on-chain hash matches too (requires stellar CLI ≥ v26).
./scripts/verify-wasm.sh --network testnet   # or --network mainnet
```

**CI-verified hashes:**  
The hashes in this file come from the `wasm-hashes-<commit>` artifact produced
by the [Reproducible Build workflow](.github/workflows/reproducible-build.yml).
That workflow verifies byte-identity across two independent environments
(host runner and pinned Docker container) before publishing hashes, so the
recorded values have been proven reproducible across environment boundaries —
not just twice on the same machine.

---

## Testnet deployments

### v1.0.0 — 2024-08-30

| Field | Value |
|---|---|
| **Network** | Stellar Testnet |
| **Deployed at** | 2024-08-30T12:00:00Z |
| **Source commit** | `f9250a5c` — see [full SHA on GitHub](https://github.com/ToluLabs/StellarCred/commit/f9250a5c) |
| **Rust toolchain** | `1.93.1` (see `rust-toolchain.toml`) |
| **Verification** | `git checkout f9250a5c && docker build -f docker/Dockerfile.reproducible -t sc . && docker run --rm -v $(pwd)/out:/out --env SOURCE_DATE_EPOCH=0 sc sh -c "cargo build --release --target wasm32v1-none --locked --offline && cp target/wasm32v1-none/release/*.wasm /out/" && sha256sum out/*.wasm` |

| Contract | WASM | Contract ID | Expected WASM SHA-256 |
|---|---|---|---|
| **Issuer Registry** | `issuer_registry.wasm` | `CDYPCHIFRXAAJFUA7MBH4FAWYLNG7XMAH7QRGVF437V2PGDBXZ2VK2DZ` | `458d4ff6de2ca8e065388cab0b05b566a7a279ec4d46542ee5b41a30aacb46da` |
| **Credential Verifier** | `credential_verifier.wasm` | `CCUUSDWSCSML3DFXVNEXQN7OFYXY2PGBOLKJR5R4Q5JPK47V4TYPQUKJ` | `f3f26e37a960362784fbcd419de71986f06fc0655adfae08ba392f57ab7a199f` |
| **Proof Registry** | `proof_registry.wasm` | `CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV` | `ddf30335aa7dcf9146c9929003f3a4c1d1070f2c5d9482ca2e36886bfb34e0c4` |
| **Gated Pool** | `gated_pool.wasm` | `CCKQQGWNKMFWAYPT37KEI5WQSCDEPH6H7XZEFJ3UB5BH5SVZBUPVUGI3` | `32986998d4bf7277cbb3161d1236c349dcc39faa530a8ba2e74e00d1c27092d0` |

---

## Mainnet deployments

No mainnet deployments yet. Contract IDs and hashes will be recorded here after
the first mainnet deployment following the same template above.

---

## Recording a new deployment

When deploying a new version, `deploy.sh` produces a JSON manifest in
`deployment-manifests/`. After the deployment succeeds:

1. Run `./scripts/verify-wasm.sh --network <testnet|mainnet>` to confirm the
   on-chain hashes match the built artifacts.
2. Add a new versioned section to this file (copy the template above).
   - **Source commit**: the exact `git rev-parse HEAD` at build time.
     `deploy.sh` records this in the manifest under `source_commit`.
   - **Expected WASM SHA-256**: copy from the `wasm-hashes-<commit>` artifact
     produced by the Reproducible Build CI workflow for that commit, or from
     the `sha256sums` field in the deployment manifest.
3. Commit the updated `DEPLOYMENTS.md` to `main` alongside the manifest file.

The `source_commit` field is the critical link — it lets a verifier `git
checkout` to the exact tree the deployed WASM was compiled from.

---

## What the hashes cover

The SHA-256 hashes recorded here are the hash of the raw compiled WASM bytes —
the same value that:

- `sha256sum <file>.wasm` prints locally.
- `stellar contract info hash --id <ID>` returns from the chain (Soroban stores
  the raw SHA-256 of uploaded WASM).
- The `wasm-hashes-<commit>` CI artifact contains.

Alternatively, search the Contract ID on a Stellar block explorer (like [Stellar.expert](https://stellar.expert)) and verify that the deployed WASM hash matches your locally computed hash.
# Contract Deployments

This file is the authoritative registry of deployed StellarCred contracts.

Integrators should use the contract IDs recorded here rather than relying on
environment variable examples, local configuration, or undocumented values.

## Testnet

| Contract | Contract ID | Version | WASM Hash | Deploy Date |
|---|---|---|---|---|
| ProofRegistry | TBD | TBD | TBD | TBD |
| IssuerRegistry | TBD | TBD | TBD | TBD |
| CredentialVerifier | TBD | TBD | TBD | TBD |
| GatedPool | TBD | TBD | TBD | TBD |

## Mainnet

| Contract | Contract ID | Version | WASM Hash | Deploy Date |
|---|---|---|---|---|
| ProofRegistry | TBD | TBD | TBD | TBD |
| IssuerRegistry | TBD | TBD | TBD | TBD |
| CredentialVerifier | TBD | TBD | TBD | TBD |
| GatedPool | TBD | TBD | TBD | TBD |

## Updating this registry

`DEPLOYMENTS.md` must be updated whenever a contract is deployed or upgraded.

For every deployment, record:

- Network
- Contract ID
- Contract version
- WASM hash
- Deployment date

The deployment runbook is responsible for ensuring this file is updated before
a deployment is considered complete.

Do not use `.env.example` as the authoritative source for deployed contract IDs.

# Reproducible Builds & Deployment Verification

This document explains how to verify that the StellarCred contracts deployed
on-chain were compiled from this repository at a specific commit — and nothing
else.

---

## Why reproducibility matters

A deployed contract's on-chain WASM hash is the ground truth of what code is
running. Reproducible builds mean any third party can compile the same source
and arrive at byte-identical WASM, confirming the deployed bytecode matches the
audited source.

---

## Toolchain pins

All build inputs are pinned so the output is deterministic:

| Input | Pin | Where |
|---|---|---|
| Rust compiler | `1.93.1` | `rust-toolchain.toml` |
| Cargo dependencies | exact lockfile | `Cargo.lock` (`--locked` flag) |
| Build profile | `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `strip = "symbols"` | `Cargo.toml` `[profile.release]` |
| Docker base image | `rust:1.93.1-slim-bookworm@sha256:81ca81aa…` | `docker/Dockerfile.reproducible` |
| Noir compiler | `1.0.0-beta.9` | `circuits/scripts/build.sh`, `circuits/scripts/testvectors.js` |
| Barretenberg | `0.87.0` | `circuits/scripts/build.sh`, `circuits/scripts/testvectors.js` |

Do **not** run `cargo update` or `nargo update` before verifying — the lockfiles and pinned toolchain must be identical to the ones at the deployed commit.

---

## Circuit VK reproducibility

The circuit verification keys are also deterministic and are published as SHA-256 hashes in `circuits/testvectors/*.json` under the `vk_hash` field. Those files are generated with the exact pinned Noir + Barretenberg toolchain and are checked by the repository's deterministic-proof harness.

### Verify the committed hashes

```bash
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"
./scripts/verify-vks.sh check
```

This recompiles each committed circuit and compares the freshly derived `vk_hash`, public inputs, and witness data against the checked-in vectors. A mismatch fails the job, which catches circuit drift or a toolchain bump before any deployment.

---

## Option A — Verify using Docker (recommended)

Docker removes the last sources of non-determinism (host OS, linker version,
installed libraries).

### 1. Check out the deployed commit

```bash
git clone https://github.com/ToluLabs/StellarCred
cd StellarCred
# Replace <COMMIT> with the SHA recorded in DEPLOYMENTS.md for the deployment
# you want to verify.
git checkout <COMMIT>
```

### 2. Build the reproducible image

```bash
docker build \
  -f docker/Dockerfile.reproducible \
  -t stellarcred-build \
  .
```

### 3. Run the build and extract artifacts

```bash
mkdir -p out
docker run --rm \
  -v "$(pwd)/out:/out" \
  --env SOURCE_DATE_EPOCH=0 \
  stellarcred-build \
  sh -c "cargo build \
           --release \
           --target wasm32v1-none \
           --locked \
           --offline \
         && cp target/wasm32v1-none/release/credential_verifier.wasm \
                target/wasm32v1-none/release/issuer_registry.wasm \
                target/wasm32v1-none/release/proof_registry.wasm \
                target/wasm32v1-none/release/gated_pool.wasm \
              /out/"
```

### 4. Hash the local artifacts

```bash
sha256sum out/*.wasm
```

Expected output (hashes match those in `DEPLOYMENTS.md`):

```
458d4ff6de2ca8e065388cab0b05b566a7a279ec4d46542ee5b41a30aacb46da  out/issuer_registry.wasm
f3f26e37a960362784fbcd419de71986f06fc0655adfae08ba392f57ab7a199f  out/credential_verifier.wasm
ddf30335aa7dcf9146c9929003f3a4c1d1070f2c5d9482ca2e36886bfb34e0c4  out/proof_registry.wasm
32986998d4bf7277cbb3161d1236c349dcc39faa530a8ba2e74e00d1c27092d0  out/gated_pool.wasm
```

### 5. Compare against on-chain hashes (automated)

```bash
# Requires stellar CLI ≥ v26 on PATH.
./scripts/verify-wasm.sh --network testnet
```

The script fetches the WASM hash stored on-chain for each contract ID in
`DEPLOYMENTS.md` and diffs it against the locally computed hash. Exit code 0
means all verified contracts match.

For mainnet:

```bash
./scripts/verify-wasm.sh --network mainnet
```

---

## Option B — Verify without Docker

If you prefer to build on your host machine, you must match the exact toolchain.

### 1. Install the pinned Rust version

```bash
rustup toolchain install 1.93.1
rustup target add wasm32v1-none --toolchain 1.93.1
```

`rustup` reads `rust-toolchain.toml` automatically when you are inside the
repo, so the correct version is selected without extra flags.

### 2. Build with the locked lockfile

```bash
cargo build --release --target wasm32v1-none --locked
```

### 3. Hash and compare

```bash
sha256sum target/wasm32v1-none/release/*.wasm
```

Then compare the hashes against `DEPLOYMENTS.md` or run:

```bash
./scripts/verify-wasm.sh --network testnet
```

> **Note:** Host builds may produce different byte sequences on different
> operating systems due to linker and C-runtime variation. Use the Docker path
> (Option A) if you need guaranteed byte-identity.

---

## How the verification script works

`scripts/verify-wasm.sh`:

1. Reads contract IDs from `DEPLOYMENTS.md` (or from environment variables
   `ISSUER_REGISTRY_ID`, `CREDENTIAL_VERIFIER_ID`, `PROOF_REGISTRY_ID`,
   `GATED_POOL_ID`).
2. Calls `stellar contract info --id <ID> --wasm-hash` to retrieve the
   SHA-256 of the WASM stored on-chain.
3. Computes `sha256sum` of each local `.wasm` file.
4. Compares the two hashes and reports pass / fail per contract.
5. Exits non-zero if any contract mismatches.

---

## CI verification

Every pull request that touches contract source, `Cargo.lock`, `rust-toolchain.toml`,
or the reproducible Dockerfile triggers the **Reproducible Build** CI job
(`.github/workflows/reproducible-build.yml`). That job:

1. Builds the Docker image from `docker/Dockerfile.reproducible`. The image
   installs the compiler and pre-fetches all Cargo dependencies but does **not**
   run `cargo build` — compilation is deferred to run time.
2. Runs the build container **twice** in independent `docker run` invocations.
   Each run executes `cargo build --release --target wasm32v1-none --locked --offline`
   from scratch inside its own container, with `SOURCE_DATE_EPOCH=0`.
3. Computes SHA-256 of all four WASM artifacts from each run.
4. Diffs the two hash lists — the job fails if any file differs, catching any
   non-determinism in code-generation, symbol ordering, or LTO.
5. Uploads the WASM artifacts and a `sha256sums.txt` manifest as GitHub Actions
   artifacts (retained 30 / 90 days respectively) for independent inspection.

---

## Updating the toolchain

When the Rust toolchain is bumped:

1. Update `rust-toolchain.toml` → `channel`.
2. Update the `FROM` line in `docker/Dockerfile.reproducible` — change the
   image tag and digest:
   ```bash
   docker pull rust:<NEW_VERSION>-slim-bookworm
   docker inspect --format='{{index .RepoDigests 0}}' rust:<NEW_VERSION>-slim-bookworm
   # Paste the printed digest into the FROM line.
   ```
3. Update the `toolchain:` field in `.github/workflows/ci.yml`.
4. Rebuild, re-run `verify-wasm.sh`, and update the hashes in `DEPLOYMENTS.md`.
5. Open a PR — the reproducible-build CI job will confirm byte-identity before
   merge.

---

## Updating recorded hashes after a code change

After any contract change that is deployed:

1. Build from the deployment commit using Option A above.
2. Copy the new `sha256sum` output into the relevant row of `DEPLOYMENTS.md`.
3. Commit the updated `DEPLOYMENTS.md` alongside the deployment record.

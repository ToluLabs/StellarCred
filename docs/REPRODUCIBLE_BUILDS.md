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

Do **not** run `cargo update` or `nargo update` before verifying — the lockfiles
and pinned toolchain must be identical to the ones at the deployed commit.

---

## Circuit VK reproducibility

The circuit verification keys are also deterministic and are published as
SHA-256 hashes in `circuits/testvectors/*.json` under the `vk_hash` field.
Those files are generated with the exact pinned Noir + Barretenberg toolchain
and are checked by the repository's deterministic-proof harness.

### Verify the committed hashes

```bash
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"
./scripts/verify-vks.sh check
```

This recompiles each committed circuit and compares the freshly derived
`vk_hash`, public inputs, and witness data against the checked-in vectors. A
mismatch fails the job, which catches circuit drift or a toolchain bump before
any deployment.

---

## CI verification: two-layer determinism check

The [Reproducible Build workflow](.github/workflows/reproducible-build.yml)
runs on every PR and push that touches contract source, `Cargo.lock`,
`rust-toolchain.toml`, or the Dockerfile. It performs two distinct comparisons:

### Layer 1 — within-environment (container vs container)

Two independent `docker run` invocations each build the WASM from scratch
inside the pinned container. Both runs use the same host OS and Docker daemon,
but each container is fresh with no shared writable state.

**What this catches:** nondeterminism inside the compiler itself — timestamp
embedding in DWARF sections, ASLR affecting codegen addresses, non-deterministic
ordering of symbols from LTO, or unstable iteration over hash maps in compiler
passes. Any of these would cause run 1 and run 2 to differ.

### Layer 2 — cross-environment (host vs container)

The runner's own Rust toolchain (materialised from `rust-toolchain.toml` via
`rustup`) builds the WASM directly on the host OS, and those hashes are
compared against the container output. Host and container differ in:

- How the Rust toolchain was installed (`rustup` on the host vs baked into the
  official Docker image)
- Filesystem layout (`$HOME`, `$CARGO_HOME`, `/workspace` paths)
- Environment variables and shell configuration
- Minor OS/libc version variation between the runner image and the Debian base

**What this catches:** environment-dependent nondeterminism. If the build
embeds a host-specific path, uses an environment variable at compile time, or
depends on a system library that differs between environments, layer 1 would
pass (both containers share the same environment) but layer 2 would fail
(host and container would diverge).

**Why layer 2 matters for the trust claim:** a pass on layer 2 is the CI
equivalent of the third-party reproducibility guarantee in issue #427. It
demonstrates that a verifier on a different machine with a fresh `rustup`
install — not just a re-run of the same Docker image — will arrive at the same
bytes. That is the claim that lets an auditor or operator trust the published
hashes.

### Canonical hash manifest

When both layers pass, the workflow produces a `canonical-hashes.txt` file and
uploads it as the `wasm-hashes-<commit>` artifact (retained 90 days). This is
the authoritative source for the hashes to record in `DEPLOYMENTS.md`. It
includes the commit SHA, toolchain version, and a note that the hashes were
verified cross-environment.

---

## Option A — Verify using Docker (recommended)

Docker removes host-specific sources of variation. This path matches layer 2 of
the CI check.

### 1. Check out the deployed commit

```bash
git clone https://github.com/ToluLabs/StellarCred
cd StellarCred
# Replace <COMMIT> with the "Source commit" recorded in DEPLOYMENTS.md for
# the deployment you want to verify.
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

Compare the output against the "Expected WASM SHA-256" column in `DEPLOYMENTS.md`
for the deployed commit.

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
SOURCE_DATE_EPOCH=0 cargo build --release --target wasm32v1-none --locked
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
> operating systems due to linker and C-runtime variation. Use Option A
> (Docker) if you need guaranteed byte-identity and want your result to match
> the cross-environment CI check.

---

## How the verification script works

`scripts/verify-wasm.sh`:

1. Reads contract IDs from `DEPLOYMENTS.md` (or from environment variables
   `ISSUER_REGISTRY_ID`, `CREDENTIAL_VERIFIER_ID`, `PROOF_REGISTRY_ID`,
   `GATED_POOL_ID`).
2. Calls `stellar contract info hash --id <ID>` to retrieve the SHA-256 of the
   WASM stored on-chain.
3. Computes `sha256sum` of each local `.wasm` file.
4. Compares the two hashes and reports pass / fail per contract.
5. Exits non-zero if any contract mismatches.

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
3. Update the toolchain pin in the `docs/REPRODUCIBLE_BUILDS.md` toolchain
   table and in `.github/workflows/ci.yml`.
4. Rebuild, re-run `verify-wasm.sh`, confirm the CI reproducible-build job
   passes **both layers**, and update the hashes in `DEPLOYMENTS.md`.
5. Open a PR — the reproducible-build CI job will confirm byte-identity across
   environments before merge.

---

## Updating recorded hashes after a code change

After any contract change that is deployed:

1. Build from the deployment commit using Option A above.
2. Confirm both CI layers passed for that commit — download the
   `wasm-hashes-<commit>` artifact from the Reproducible Build workflow run.
3. Copy the hashes from that artifact into a new versioned section of
   `DEPLOYMENTS.md`. Include the exact `git rev-parse HEAD` commit SHA under
   "Source commit" — this is what lets a verifier `git checkout` to the exact
   tree the WASM was compiled from.
4. Commit the updated `DEPLOYMENTS.md` alongside the deployment manifest from
   `deployment-manifests/`.

# Verifiable Build Provenance

StellarCred smart contract binaries, zero-knowledge verification keys, and SDK packages are built with verifiable build provenance complying with the [SLSA v1.0 (Supply-chain Levels for Software Artifacts)](https://slsa.dev/provenance/v1) and [in-toto](https://in-toto.io) specification.

Build provenance provides cryptographic proof linking release binaries directly to the exact source commit, pinned compiler toolchains, build environment flags, and CI workflow run that generated them.

---

## Provenance Artifacts

Every GitHub release publishes three verification files alongside the compiled binaries:

1. `build-provenance.json`: The canonical in-toto SLSA Provenance v1.0 attestation statement.
2. `build-provenance.json.sha256`: The SHA-256 digest of the provenance statement itself.
3. `artifacts-checksums.txt`: Standard GNU `sha256sum` formatted checksums for rapid terminal verification.

---

## Pinned Build Environment

To ensure bit-for-bit reproducible compilation across developer machines and automated runners, StellarCred strictly pins all toolchains:

| Component | Pinned Version | Configuration / Location |
| :--- | :--- | :--- |
| Rust Compiler | `1.93.1` | `rust-toolchain.toml`, `docker/Dockerfile.reproducible` |
| Compilation Target | `wasm32v1-none` | Pinned target in `rust-toolchain.toml` |
| Soroban SDK | `26.0.1` | `Cargo.toml` |
| Noir Toolchain | `1.0.0-beta.9` | `circuits/scripts/build.sh`, `.github/workflows/ci.yml` |
| Barretenberg | `0.87.0` | `circuits/scripts/build.sh`, `.github/workflows/ci.yml` |
| Node.js | `20.x` | `package.json`, `.github/workflows/release.yml` |
| Pnpm | `9.x` | `frontend/pnpm-lock.yaml`, `.github/workflows/release.yml` |

### Deterministic Compiler Flags

All contract compilations apply deterministic path remapping and reproducible timestamp zeroing:

```bash
SOURCE_DATE_EPOCH=0
RUSTFLAGS="--remap-path-prefix=/workspace=/workspace --remap-path-prefix=/usr/local/cargo=/usr/local/cargo --remap-path-prefix=/usr/local/rustup=/usr/local/rustup"
cargo build --release --target wasm32v1-none --locked
```

---

## Verifying Release Artifacts

Auditors and integrators can verify artifact integrity using any of the following independent methods.

### 1. Fast Checksum Verification

Download the release assets and `artifacts-checksums.txt` into a folder, then execute:

```bash
sha256sum -c artifacts-checksums.txt
```

Expected output:
```text
credential_verifier.wasm: OK
issuer_registry.wasm: OK
proof_registry.wasm: OK
gated_pool.wasm: OK
circuit-versions.json: OK
```

### 2. Full SLSA Provenance Verification

StellarCred includes a dedicated, self-contained verification tool that checks artifact hashes against `build-provenance.json` and asserts that compiler versions match official pins:

```bash
node scripts/verify-provenance.mjs \
  --provenance build-provenance.json \
  --artifacts-dir ./release-artifacts
```

The script performs the following validation passes:
- Validates the in-toto SLSA v1.0 JSON schema.
- Re-hashes each release artifact on disk (both SHA-256 and SHA-512).
- Verifies exact match against the provenance subject digests.
- Confirms the source repository, commit SHA, and release workflow identity.
- Asserts that recorded toolchain dependencies match required pinned versions.

### 3. Bit-for-Bit Reproducible Build Replay

Integrators can independently rebuild the smart contract WASM artifacts from source and verify that their output hashes match the published release bit-for-bit:

1. Clone the repository at the release tag:
   ```bash
   git clone https://github.com/ToluLabs/StellarCred.git
   cd StellarCred
   git checkout <vX.Y.Z>
   ```

2. Build the hermetic build container:
   ```bash
   docker build -f docker/Dockerfile.reproducible -t stellarcred-repro:local .
   ```

3. Run deterministic compilation:
   ```bash
   mkdir -p local-build
   docker run --rm \
     -v "$PWD:/workspace" \
     -v "$PWD/local-build:/out" \
     -e SOURCE_DATE_EPOCH=0 \
     -e "RUSTFLAGS=--remap-path-prefix=/workspace=/workspace --remap-path-prefix=/usr/local/cargo=/usr/local/cargo --remap-path-prefix=/usr/local/rustup=/usr/local/rustup" \
     stellarcred-repro:local \
     cargo build --release --target wasm32v1-none --locked
   ```

4. Compare SHA-256 hashes against `artifacts-checksums.txt`:
   ```bash
   sha256sum local-build/*.wasm
   ```

---

## Provenance Attestation Schema

The `build-provenance.json` file uses the standard in-toto envelope:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    {
      "name": "credential_verifier.wasm",
      "digest": {
        "sha256": "...",
        "sha512": "..."
      },
      "size": 12345
    }
  ],
  "predicateType": "https://slsa.dev/provenance/v1",
  "predicate": {
    "buildDefinition": {
      "buildType": "https://stellarcred.network/attestations/release-build/v1",
      "externalParameters": {
        "repository": "https://github.com/ToluLabs/StellarCred",
        "ref": "refs/tags/vX.Y.Z",
        "commit": "...",
        "workflow": ".github/workflows/release.yml"
      },
      "internalParameters": {
        "reproducibleContainer": "stellarcred-build:ci",
        "sourceDateEpoch": "0"
      },
      "resolvedDependencies": [
        { "uri": "pkg:cargo/rustc", "version": "1.93.1" },
        { "uri": "pkg:cargo/soroban-sdk", "version": "26.0.1" }
      ]
    },
    "runDetails": {
      "builder": {
        "id": "https://github.com/ToluLabs/StellarCred/.github/workflows/release.yml@refs/tags/vX.Y.Z"
      }
    }
  }
}
```

---

## Supply Chain Security Principles

- **Immutability**: Checksums and provenance attestations are permanently anchored to git tags and GitHub Releases.
- **Hermeticity**: Offline builds isolate compilation from network drift, ensuring zero unpinned dependencies.
- **Transparency**: Anyone can inspect, verify, and reproduce artifacts without trusting third-party intermediaries.

# StellarCred Contract Deployments

This document maintains the record of deployed StellarCred smart contract IDs on each Stellar network environment, along with instructions to verify the integrity of the deployed bytecode.

---

## Deployed Contract IDs

### Stellar Testnet

These contracts are deployed on the Stellar Testnet (passphrase: `Test SDF Network ; September 2015`) using RPC URL `https://soroban-testnet.stellar.org`.

| Contract | Target WASM | Contract ID (Testnet) | Reproducible WASM SHA-256 Hash |
| :--- | :--- | :--- | :--- |
| **Issuer Registry** | `issuer_registry.wasm` | `CDYPCHIFRXAAJFUA7MBH4FAWYLNG7XMAH7QRGVF437V2PGDBXZ2VK2DZ` | `458d4ff6de2ca8e065388cab0b05b566a7a279ec4d46542ee5b41a30aacb46da` |
| **Credential Verifier** | `credential_verifier.wasm` | `CCUUSDWSCSML3DFXVNEXQN7OFYXY2PGBOLKJR5R4Q5JPK47V4TYPQUKJ` | `f3f26e37a960362784fbcd419de71986f06fc0655adfae08ba392f57ab7a199f` |
| **Proof Registry** | `proof_registry.wasm` | `CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV` | `ddf30335aa7dcf9146c9929003f3a4c1d1070f2c5d9482ca2e36886bfb34e0c4` |
| **Gated Pool** | `gated_pool.wasm` | `CCKQQGWNKMFWAYPT37KEI5WQSCDEPH6H7XZEFJ3UB5BH5SVZBUPVUGI3` | `32986998d4bf7277cbb3161d1236c349dcc39faa530a8ba2e74e00d1c27092d0` |

### Stellar Mainnet

These contracts will be deployed on the Stellar Mainnet (passphrase: `Public Global Stellar Network ; September 2015`) using RPC URL `https://mainnet.sorobanrpc.com`.

| Contract | Target WASM | Contract ID (Mainnet) | Expected WASM SHA-256 Hash |
| :--- | :--- | :--- | :--- |
| **Issuer Registry** | `issuer_registry.wasm` | *Placeholder — To be filled post-deployment* | `458d4ff6de2ca8e065388cab0b05b566a7a279ec4d46542ee5b41a30aacb46da` |
| **Credential Verifier** | `credential_verifier.wasm` | *Placeholder — To be filled post-deployment* | `f3f26e37a960362784fbcd419de71986f06fc0655adfae08ba392f57ab7a199f` |
| **Proof Registry** | `proof_registry.wasm` | *Placeholder — To be filled post-deployment* | `ddf30335aa7dcf9146c9929003f3a4c1d1070f2c5d9482ca2e36886bfb34e0c4` |
| **Gated Pool** | `gated_pool.wasm` | *Placeholder — To be filled post-deployment* | `32986998d4bf7277cbb3161d1236c349dcc39faa530a8ba2e74e00d1c27092d0` |

---

## Contract Source Verification

To trust the deployed contracts, any third party can verify that the deployed bytecode matches this open-source repository by reproducing the compilation and comparing the WASM hash.

### Prerequisites

Ensure you have Rust and the `wasm32v1-none` compilation target installed:

```bash
# Verify Rust compiler version (pinned toolchain / stable recommended)
rustc --version # e.g. rustc 1.96.0 or stable

# Add the target required for Soroban contracts
rustup target add wasm32v1-none
```

### 1. Compile the Contracts

From the repository root, build the contracts in release mode:

```bash
cargo build --release --target wasm32v1-none
```

Alternatively, if you have the `stellar` CLI installed:

```bash
stellar contract build
```

The optimized WASM binaries will be generated under:
`target/wasm32v1-none/release/`

### 2. Compute the Local WASM Hashes

Run the following command to compute the SHA-256 hash of the compiled bytecode:

```bash
sha256sum target/wasm32v1-none/release/*.wasm
```

Expected output:
```text
458d4ff6de2ca8e065388cab0b05b566a7a279ec4d46542ee5b41a30aacb46da  target/wasm32v1-none/release/issuer_registry.wasm
f3f26e37a960362784fbcd419de71986f06fc0655adfae08ba392f57ab7a199f  target/wasm32v1-none/release/credential_verifier.wasm
ddf30335aa7dcf9146c9929003f3a4c1d1070f2c5d9482ca2e36886bfb34e0c4  target/wasm32v1-none/release/proof_registry.wasm
32986998d4bf7277cbb3161d1236c349dcc39faa530a8ba2e74e00d1c27092d0  target/wasm32v1-none/release/gated_pool.wasm
```

### 3. Verify Against Deployed Contracts

You can check the WASM hash of the deployed contracts on-chain. Compare the hashes computed in Step 2 with the deployed contract hashes using the `stellar` CLI:

```bash
# Retrieve info about the deployed contract (including its WASM hash)
stellar contract inspect --id <CONTRACT_ID> --network mainnet
```

Alternatively, search the Contract ID on a Stellar block explorer (like [Stellar.expert](https://stellar.expert)) and verify that the deployed WASM hash matches your locally computed hash.

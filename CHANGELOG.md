# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-26

### Added
- **SDK Release & Packaging**: Configured dual CommonJS (`dist/index.js`) and ECMAScript Modules (`dist/index.mjs`) builds with full TypeScript declarations (`dist/index.d.ts`).
- **Claim Verification**: `hasClaim`, `getClaims`, and `verifyProof` client methods supporting zero-knowledge credential verification directly against deployed ProofRegistry contracts.
- **Typed Errors**: Introduced structured error taxonomy (`StellarCredError`, `RpcError`, `ContractError`, `NetworkError`) for predictable failure handling.
- **Bounded Request Timeouts**: Configurable timeout (`requestTimeoutMs`) preventing stalled Soroban RPC nodes from hanging integrations.
- **Environment & Presets**: Out-of-the-box configuration presets for Soroban testnet and mainnet, with automatic environment variable resolution.
- **Contract GatedPool Integration**: Real token client integration supporting live token transfers on deposit and open withdrawal semantics.

### Changed
- Refactored SDK export bundle to only ship compiled artifacts (`dist/`), excluding tests, fixtures, and internal source code.
- Hardened release automation workflow in `.github/workflows/release.yml` with version parity validation.

## [0.1.0] - 2026-08-15

### Added
- Initial release of the StellarCred TypeScript SDK client.
- Soroban RPC simulation client for reading on-chain credential registry states.

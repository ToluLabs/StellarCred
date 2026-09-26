# @stellarcred/sdk Changelog

All notable changes to `@stellarcred/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-26

### Added
- Complete typed error hierarchy (`StellarCredError`, `RpcError`, `ContractError`, `NetworkError`).
- Bounded RPC call execution via `requestTimeoutMs` config option.
- Stellar address formatting and validation prior to Soroban contract invocation.
- Built dual CJS (`dist/index.js`) and ESM (`dist/index.mjs`) builds with TypeScript `.d.ts` declaration maps.
- Strict package exports defining clean entry points while excluding private source code and unit tests.
- Claim gate helper functions and React integration utilities.

### Documentation
- Added release lifecycle documentation covering git tag mapping, version bumps, and release verification.
- Documented consumption guidance for both published npm package and local monorepo / git workspace development.

## [0.1.0] - 2026-08-15

### Added
- Initial implementation of the `@stellarcred/sdk` client library.
- Core functions: `hasClaim`, `getClaims`, and `buildVerifyUrl`.
- Support for default testnet and mainnet presets.

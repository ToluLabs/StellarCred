# @stellarcred/sdk Changelog

All notable changes to `@stellarcred/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Optional indexer-backed read path (#613). `hasClaim`, `getClaim`, `hasClaims`,
  `getClaims`, `verifyPreset`, and `watchClaim` accept a `source` option of
  `"chain"` (default, unchanged behaviour), `"indexer"`, or `"indexer-verified"`.
- `indexerUrl`, `indexerApiKey`, and `indexerCacheMs` configuration options, plus
  the `STELLARCRED_INDEXER_URL` / `NEXT_PUBLIC_INDEXER_URL` and
  `STELLARCRED_INDEXER_API_KEY` environment variables.
- `IndexerError`, thrown for failed indexer reads under `throwOnError: true`.
- `source: "indexer-verified"` reads the indexer, confirms against ProofRegistry,
  returns the chain result, and warns once per process when the two disagree —
  including in production, so indexer drift is visible to operators.
- Per-wallet memoisation of indexer rows (`indexerCacheMs`, default 2000ms) so a
  `getClaims` fan-out issues one HTTP request instead of six. Chain reads are
  never cached.
- Development-mode warning when `indexerApiKey` is configured from a browser
  context, since it is a secret with no `NEXT_PUBLIC_` alias.
- `subscribeClaims()` real-time subscription helper (#392): push-style `gained`/`lost` claim change notifications for a set of wallets and claim types, backed by the indexer (`GET /recent` cursor feed + `GET /claims` snapshot reconciliation), delivered via callbacks or a registered webhook with retry.

### Documentation
- New "Indexer fast path (optional)" section covering the trust tradeoff, the
  three sources, contract-parity of the evaluation predicates, and the known
  divergences (wall clock vs. ledger timestamp, indexer lag, operator trust).

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

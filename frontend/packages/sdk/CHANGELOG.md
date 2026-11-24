# @stellarcred/sdk Changelog

All notable changes to `@stellarcred/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `@stellarcred/sdk/testing` entry point (#1065): `MockWalletProvider` (SEP-43 wallet backed by a real Ed25519 keypair), `CredentialFactory` (secp256k1-signed credential JSON that passes `validateCredential`), `MockProofRegistry` with `installMockRegistry` / `uninstallMockRegistry` (simulated proofs with the contract's expiry, revocation, trusted-issuer and threshold rules), and `verifyCredentialSignature`. Lets integrators unit-test without an RPC, a deployed registry or a Noir toolchain.
- `BatchVerifierPool` and `verifyWalletSignaturesBatch` (#1063): verify batches of wallet-signed presentations in parallel on `worker_threads` without blocking the event loop. Node-only, exported from `@stellarcred/sdk/server`.
- Configurable backoff for every RPC, indexer and polling call (#1056):
  `jitter` now accepts a strategy (`"full"`, `"decorrelated"`, `"equal"` or
  `"none"`) as well as `true` / `false`; `maxElapsedMs` sets a total retry
  budget; per-call `retryOptions` accept an `AbortSignal` (`signal`) that
  cancels pending delays, and an `onRetry` hook that receives the exact delay.
  `withRetry` passes `{ attempt, signal }` to the operation, and
  `computeBackoffDelay` is exported.
- `watchClaim` accepts `retryOptions`; stopping a watch or unsubscribing from
  `subscribeClaims` now cancels retries that are still waiting.
- `configure()` and `withRetry` reject invalid retry settings with `ConfigError`.
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

### Changed

- `jitter: true` (the default) now uses full jitter, a random delay from zero up
  to the exponential delay, instead of half the delay plus a random half. The
  worst-case retry time is unchanged; the average delay is lower and clients
  that failed together no longer retry in step (#1056).
- `submitTransaction`'s `onRetry` now receives the exact delay instead of `0`,
  and is called only when a retry will happen, as its documentation states. It
  is no longer called after the final failed attempt (#1056).

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

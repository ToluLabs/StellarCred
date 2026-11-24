# SDK Runtime Support Policy

This is the support contract for the published `@stellarcred/sdk` package
(`frontend/packages/sdk`). It declares which Node.js versions, browsers, and
edge runtimes each SDK release line supports, how that support is verified in
CI, and how support is deprecated.

Integrators can rely on the matrix below: a runtime listed as **Supported** is
expected to keep working for the whole release line, except for a breaking
change announced under §5.

The machine-readable form of this matrix is
[`frontend/packages/sdk/runtime-support.json`](../frontend/packages/sdk/runtime-support.json).
The two must agree with `package.json`'s `engines` field and with the
`SDK runtime matrix` CI job; `node .github/scripts/check-sdk-runtime-support.mjs`
fails the build when they drift.

## 1. Supported runtime matrix — `0.1.x`

<!-- sdk-runtime-matrix:start -->

| Runtime family                 | Entry point                                    | Supported versions                                                                                                                 | CI verification                                                                          |
| :----------------------------- | :--------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| **Node.js** (ESM and CommonJS) | `@stellarcred/sdk`, `@stellarcred/sdk/testing` | `20.0.0` minimum; tests run on Node `20`, `22`, `24`                                                                               | Typecheck, unit tests, and package build on every listed version                         |
| **Browsers**                   | `@stellarcred/sdk`, `@stellarcred/sdk/testing` | Chrome `103`+, Edge `103`+, Firefox `100`+, Safari `16.0`+                                                                         | jsdom smoke test plus a static check that the browser entry imports no `node:` built-ins |
| **Edge runtimes**              | `@stellarcred/sdk`                             | Runtimes providing `fetch`, `AbortSignal.timeout`, Web Crypto and no Node built-ins (e.g. Vercel Edge Runtime, Cloudflare Workers) | Same static no-`node:`-built-ins check; not exercised on a real edge runtime             |
| **Node.js server**             | `@stellarcred/sdk/server`                      | Node `20.0.0`+                                                                                                                     | Included in the Node matrix above                                                        |

<!-- sdk-runtime-matrix:end -->

`@stellarcred/sdk/server` is the only entry point that may load Node-only
modules. Today it adds `BatchVerifierPool` / `verifyWalletSignaturesBatch`
(`node:worker_threads`, `node:crypto`, `node:os`). Importing the default
entry point in a browser or edge runtime must not pull those modules in; the
CI check above enforces that boundary at the source level.

### Why these minimums

- **Node.js 20** — the oldest line the repository's CI and toolchain still
  target, and the first line with stable `fetch`, `AbortSignal.timeout`, and the
  `node:worker_threads` APIs used by the server entry.
- **Chrome / Edge 103, Firefox 100, Safari 16.0** — the first releases that
  ship `AbortSignal.timeout`, the highest-floor Web API the SDK uses.
  `crypto.randomUUID` (used for request nonces) is available in all of them.
  The package targets ES2020.
- **Edge runtimes** — the SDK only needs standard Web APIs. `./server` is
  intentionally unavailable because `worker_threads` has no edge equivalent.

## 2. What "supported" means

- A supported runtime receives fixes for security and correctness bugs.
- CI runs the SDK test suite on every supported Node version, and the browser
  entry is smoke-tested in jsdom. A run that fails on any listed runtime blocks
  merging.
- Behaviour differences between supported runtimes are bugs. Report them with
  the runtime and version.
- **Not covered:** real-browser end-to-end runs (jsdom approximates the DOM
  APIs the SDK touches, not a complete browser), Deno, Bun, React Native, and
  Node versions older than the declared minimum. They may work, but no support
  is promised and CI does not test them.
- The frontend application has its own, broader browser matrix for
  zero-knowledge proving (WASM); see
  [`wallet-network-compatibility.md`](./wallet-network-compatibility.md). This
  document covers only the read-only SDK package.

## 3. Per-release declaration

Every release line gets its own entry in
`frontend/packages/sdk/runtime-support.json` (for example `0.1.x`) and its own
matrix table in this document. When a new minor line starts, copy the table,
change only what the release actually changes, and record the rationale in the
release notes. Do not rewrite the matrix for an older line: integrators pin
versions, and the matrix they relied on must stay accurate.

## 4. How CI verifies the matrix

The `SDK runtime matrix (Node x)` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs for every pull
request and push to `main`:

1. installs the SDK's workspace dependencies;
2. runs `pnpm typecheck` and `pnpm test` on Node `20`, `22`, and `24` — the
   minimum plus the current LTS lines;
3. builds the package (`cjs` + `esm` + type declarations) and checks that the
   browser build contains no `node:` built-in imports;
4. runs `test/browser-runtime.test.ts` under jsdom, exercising `configure`,
   `hasClaim`, and the browser entry surface;
5. runs `node .github/scripts/check-sdk-runtime-support.mjs`, which keeps
   `runtime-support.json`, `package.json#engines`, this document, and the CI
   matrix in agreement.

The check also fails if a new browser-reachable source file imports a `node:`
built-in without being listed as Node-only, so declaring a browser target
cannot silently become untrue.

To verify locally:

```bash
node .github/scripts/check-sdk-runtime-support.mjs
# The SDK is outside the frontend pnpm workspace; the frontend install supplies
# the peer toolchain (`@stellar/stellar-sdk`) and jsdom for the browser leg.
(cd frontend && pnpm install --frozen-lockfile)
(cd frontend/packages/sdk && pnpm typecheck && pnpm test)
```

## 5. Deprecation and removal timeline

A runtime is never dropped silently. Removing or raising support for a runtime
follows this timeline:

1. **Announce** — add a `Runtime support` entry to the SDK
   [`CHANGELOG.md`](../frontend/packages/sdk/CHANGELOG.md), update this matrix
   with the runtime marked **Deprecated**, and state the release and date it
   will be removed.
2. **Wait at least 90 days** (and at least one published release) from the
   announcement before the removal ships. The deprecated runtime remains in the
   CI matrix for that whole period, so it is known to still work.
3. **Remove** — delete it from `runtime-support.json`, this matrix, and the CI
   matrix in the same change. Removal is a breaking change: under Semantic
   Versioning it requires a major version; while the package is `0.x`, the
   project treats it as a minor version bump and calls it out as breaking in
   the release notes.
4. **Migrate** — the release notes name the replacement runtime and any code
   change consumers need.

Raising a minimum (for example Node 20 → 22) is a removal of the older line and
follows the same three steps. Support is not dropped while the runtime is still
listed as supported here.

## 6. Release notes

Every release that changes the matrix must:

- update `runtime-support.json` and the table above;
- add a `Runtime support` bullet under `Added`, `Changed`, or `Removed` in the
  SDK changelog, naming versions added, deprecated, or removed;
- for a removal, include the migration note required by §5.

The release workflow runs
`.github/scripts/check-sdk-runtime-support.mjs` before publishing, so a tag
whose package.json, matrix, and CI job disagree cannot be released.

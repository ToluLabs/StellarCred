# SDK read-only variant investigation (issue #631)

## Question

Can `@stellarcred/sdk` ship a read-only claim-check entry point that avoids
pulling `@stellar/stellar-sdk` into the browser bundle for integrators whose
only use is `hasClaim`?

## Method

The RPC-level operation the SDK needs is a single `simulateTransaction` call
against the ProofRegistry contract, invoking `is_verified(holder,
credential_type, trusted_issuers)` and decoding a `(bool, u64, u64)` return.

Two candidate approaches were considered.

### Approach A — import only the SDK's subpaths

`@stellar/stellar-sdk` exposes `@stellar/stellar-sdk/rpc` and
`@stellar/stellar-sdk/contract` as separate subpath entry points. Importing
only those, in principle, drops the top-level barrel — the wallet-kit, the
SEP-41 client, the fee-bump wrapper, and whatever else the barrel re-exports.

### Approach B — hand-rolled fetch + XDR

Build the `simulateTransaction` JSON-RPC request by hand: `fetch` to the RPC
endpoint, base64-encoded `TransactionEnvelope` XDR in the body, decode the
ScVal tuple from the response. No dependency on `@stellar/stellar-sdk` at all.

## Finding

**Approach A does not work.** The Soroban RPC's `simulateTransaction` method
requires a full `TransactionEnvelope`, and constructing that envelope requires
`TransactionBuilder`, `Account`, and `Operation`. Those three are exported
**only from the top-level `@stellar/stellar-sdk`** — not from `/rpc`, not from
`/contract`. Importing them pulls the top-level barrel back into the bundle,
which defeats the subpath saving.

**Approach B is possible but expensive.** Building a valid envelope by hand
means owning XDR encoding for the envelope v1 wrapper, `Transaction` (source
account, fee, seq, memo, timebounds, `SorobanTransactionData` ext), and the
`InvokeHostFunctionOp` (host function, auth entries, ScVal args). That is
roughly 200–400 LOC of cryptography-adjacent code plus tests, maintained
indefinitely, for a saving that has not been shown to be material.

## Recommendation

Do not ship a read-only variant at this time. The measurable saving depends on
how much of `@stellar/stellar-sdk` the consumer's bundler can tree-shake — if
it already drops the wallet-kit and SEP-41 paths for a bundle that only calls
`hasClaim`, the delta against a hand-rolled version may be small. A future
investigation could:

1. Add a `size-limit` entry to the SDK's `package.json` so this is tracked.
2. Measure the actual gzipped size of a bundle that imports only `hasClaim`
   from `@stellarcred/sdk` — no other symbol.
3. Only pursue approach B if that measurement shows the SDK is a dominant
   contributor to the bundle, and only if the resulting maintenance burden is
   accepted explicitly.

## Why this closes the issue

Issue #631 explicitly allows the investigation itself as the deliverable:
"Either a measurably smaller read-only entry point ships with the tradeoff
documented, or the investigation is recorded as not worthwhile." This document
records the finding that approach A is not viable and that approach B is a
larger commitment than the issue's current framing suggests.

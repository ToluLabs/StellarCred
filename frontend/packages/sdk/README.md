# @stellarcred/sdk

Read-only client for [StellarCred](https://github.com/Psalmuel01/StellarCred) — check zero-knowledge credential proofs on Stellar from any protocol, frontend, or backend.

Protocols call one function. No API key, no backend, no personal data handling — the only thing you trust is the on-chain ProofRegistry.

## Install

```bash
npm install @stellarcred/sdk
```

> **Note on NPM Publication**:
> Official `@stellarcred/sdk` releases are cut via git tags (e.g. `v0.1.1`).
> In local development environments or before an upstream npm publish token is configured, you can consume the SDK directly from this repository:
>
> ```bash
> # Build the SDK inside the monorepo:
> cd frontend/packages/sdk
> pnpm install
> pnpm build
>
> # Link or import directly into your project:
> pnpm link ./frontend/packages/sdk
> ```
## API Reference

Generate the SDK API documentation locally:

```bash
pnpm docs:api
```

The generated documentation is written to:

```
docs/api/
```
## Quick start

```ts
import StellarCred from "@stellarcred/sdk";

// Configure once at startup
StellarCred.configure({
  registryId: process.env.PROOF_REGISTRY_ID,
});

// Check a claim — returns true/false
const eligible = await StellarCred.hasClaim(walletAddress, "kyc");
```

## Configuration

Call `configure()` once before any other call, or set environment variables — both approaches work in Node.js, Next.js, and edge runtimes.

```ts
StellarCred.configure({
  registryId: "C...",                              // ProofRegistry contract ID
  rpcUrl: "https://soroban-testnet.stellar.org",   // defaults to testnet
  networkPassphrase: "Test SDF Network ; September 2015",
  baseUrl: "https://stellarcred.xyz",              // used by buildVerifyUrl
  requestTimeoutMs: 10000,                         // max time for each RPC read
});
```

Each `is_verified` / `check_claim` simulation is bounded by `requestTimeoutMs`,
which defaults to 10 seconds. The timeout covers retries as well as the
underlying RPC call, so a stalled Soroban node cannot leave `hasClaim` or
`getClaims` pending indefinitely. A timed out read follows the normal failure
behavior: it returns `false` or an empty result by default, and throws
`RpcError` when `throwOnError: true` is used.

**Environment variables** (auto-read at import time, no `configure()` needed):

| Variable | Next.js alias |
|---|---|
| `STELLARCRED_REGISTRY_ID` | `NEXT_PUBLIC_PROOF_REGISTRY_ID` |
| `STELLARCRED_RPC_URL` | `NEXT_PUBLIC_RPC_URL` |
| `STELLARCRED_NETWORK_PASSPHRASE` | `NEXT_PUBLIC_NETWORK_PASSPHRASE` |
| `STELLARCRED_BASE_URL` | `NEXT_PUBLIC_STELLARCRED_BASE_URL` |
| `STELLARCRED_INDEXER_URL` | `NEXT_PUBLIC_INDEXER_URL` |
| `STELLARCRED_INDEXER_API_KEY` | *(no browser alias — it is a secret)* |

Setting `STELLARCRED_INDEXER_URL` alone changes nothing: reads still go to the
chain until you pass `source` explicitly. See
[Indexer fast path](#indexer-fast-path-optional).

## Contract Deployments

For the authoritative list of deployed StellarCred contract IDs, contract
versions, WASM hashes, and deployment dates by network, see
[`DEPLOYMENTS.md`](../../../DEPLOYMENTS.md).

Use the deployment registry when configuring the SDK for a specific network
rather than relying on `.env.example` placeholders or undocumented contract
IDs.


## API

### `hasClaim(wallet, claimType, opts?)`

Returns `true` if `wallet` has a currently valid, unexpired proof of `claimType`.

For parameterised claims (age, income, funds), pass `minThreshold` to enforce the threshold on-chain. A proof generated with threshold=200,000 satisfies `minThreshold: 50000` — the check is `stored >= required`.

```ts
// Binary claims — no threshold needed
const kycOk   = await StellarCred.hasClaim(wallet, "kyc");
const jurisOk = await StellarCred.hasClaim(wallet, "jurisdiction");

// Threshold claims — enforced on-chain, fully trustless
const ageOk   = await StellarCred.hasClaim(wallet, "age",    { minThreshold: 21 });
const incOk   = await StellarCred.hasClaim(wallet, "income", { minThreshold: 200000 });
const fundsOk = await StellarCred.hasClaim(wallet, "funds",  { minThreshold: 50000 });
```

Pass `trustedIssuers` to restrict which issuer(s) a proof must come from — e.g. accept `kyc` only from Persona or Jumio, not a self-attested issuer. This is enforced on-chain by `ProofRegistry`; omit it (or leave it `undefined`) to accept a proof from any registered issuer, matching current behaviour. An empty array rejects every issuer.

```ts
const kycOk = await StellarCred.hasClaim(wallet, "kyc", {
  trustedIssuers: ["G...PERSONA_ISSUER", "G...JUMIO_ISSUER"],
  requestTimeoutMs: 5000,
});

// Combine with a threshold — both must hold
const incomeOk = await StellarCred.hasClaim(wallet, "income", {
  minThreshold: 100000,
  trustedIssuers: ["G...PLAID_ISSUER"],
});
```

### `getClaim(wallet, claimType, opts?)`

Returns the full claim record with `verifiedAt` and `expiry` timestamps, or `null` if the wallet has no current proof of that type. Respects `trustedIssuers`.

```ts
const claim = await StellarCred.getClaim(wallet, "kyc");
if (claim) {
  console.log(claim); // { valid: true, verifiedAt: 1719000000, expiry: 1726776000 }
}

// Restrict to a trusted issuer
const trustedClaim = await StellarCred.getClaim(wallet, "kyc", {
  trustedIssuers: ["G...PERSONA_ISSUER"],
});
```

### `getClaimRecord(wallet, claimType, opts?)`

Fetches the low-level on-chain `ProofRecord` containing `verifiedAt`, `expiry`, `threshold`, `revoked`, `issuer`, and `vkVersion`, or `null` if no record exists.

```ts
const record = await StellarCred.getClaimRecord(wallet, "age");
if (record) {
  console.log(record.revoked);   // false
  console.log(record.expiry);    // 1780000000n
  console.log(record.threshold); // 21n
  console.log(record.issuer);    // "G..."
}
```

### `checkClaimStatus(wallet, claimType, opts?)`

Performs diagnostic analysis of a credential claim, returning the granular failure or success state. Useful for presenting actionable feedback to users.

Possible statuses:
- `"valid"`: Active, unrevoked, unexpired credential satisfying threshold and issuer requirements
- `"not_verified"`: No on-chain proof record found for this wallet and claim type
- `"expired"`: Record found, but its expiry timestamp is in the past
- `"revoked"`: Record found, but the issuer or admin marked it revoked
- `"unmet_threshold"`: Record found, but the proved threshold is below `minThreshold`
- `"wrong_issuer"`: Record found, but issued by an entity outside `trustedIssuers`

```ts
const result = await StellarCred.checkClaimStatus(wallet, "age", { minThreshold: 21 });
switch (result.status) {
  case "valid":
    console.log("Verified! Expires:", result.record?.expiry);
    break;
  case "expired":
    console.warn("Credential has expired. Please re-prove at StellarCred.");
    break;
  case "revoked":
    console.error("Credential was revoked.");
    break;
  case "unmet_threshold":
    console.warn("Proved threshold below requirement:", result.record?.threshold);
    break;
  case "wrong_issuer":
    console.warn("Issuer not in trusted list:", result.record?.issuer);
    break;
  case "not_verified":
    console.info("No record found. Please verify at StellarCred.");
    break;
}
```

#### Typed errors (`throwOnError`)

By default `hasClaim` / `getClaims` are **fail-soft**: a missing `registryId` or an RPC/simulation failure returns `false` / `[]`, which is indistinguishable from "not verified." Pass `{ throwOnError: true }` to surface a typed error instead:

| Failure | Error class |
|---|---|
| Missing `registryId` | `ConfigError` |
| Network / simulation failure | `RpcError` |
| Holder not verified | still returns `false` (not an error) |

```ts
import StellarCred, { ConfigError, RpcError } from "@stellarcred/sdk";

try {
  const ok = await StellarCred.hasClaim(wallet, "kyc", { throwOnError: true });
  // ok === false means "not verified"; ok === true means verified
} catch (err) {
  if (err instanceof ConfigError) {
    // SDK misconfigured — fix registryId
  } else if (err instanceof RpcError) {
    // Couldn't reach the chain — retry / degrade UI
  } else {
    throw err;
  }
}
```

`TimeoutError` remains the rejection used by `watchClaim` when its poll window expires.

### `getClaims(wallet)`

Returns all active claims a wallet has proved, across all known credential types.

```ts
const claims = await StellarCred.getClaims(wallet);
// {
//   kyc:          { verified: true,  expiry: 1780000000 },
//   age:          { verified: true,  threshold: 21, expiry: 1780000000 },
//   income:       { verified: false },
//   jurisdiction: { verified: true,  expiry: 1780000000 },
//   funds:        { verified: false },
// }
```

### `watchClaim(wallet, claimType, opts?)`

A polling helper that checks `hasClaim` on an interval. It either resolves a Promise or fires a callback when the claim is verified. Works with `minThreshold` for parameterised claims.

**Promise form** — resolves `true` when verified, or rejects with `TimeoutError` after a timeout:

```ts
try {
  await StellarCred.watchClaim(wallet, 'kyc', { 
    pollMs: 3000, 
    timeoutMs: 120_000 
  });
  console.log("Verified!");
} catch (err) {
  console.error("Timeout waiting for verification");
}
```

**Callback form** — fires `onChange` whenever the status changes. Returns a `stop()` function to cancel polling:

```ts
const stop = StellarCred.watchClaim(wallet, 'funds', {
  minThreshold: 50000,
  pollMs: 3000,
  timeoutMs: 120_000,
  onChange: (verified) => console.log('verified:', verified),
});

// Cancel polling manually (e.g. on component unmount)
// stop();
```

### `buildVerifyUrl(options)`

Builds a StellarCred verification URL to redirect users to. After verifying, StellarCred returns the user to `returnUrl` with `?sc_verified=true&sc_wallet=<address>&sc_claims=<claim-types>` appended. `sc_claims` is a comma-separated list of the claim types issued in the current session (not all-time claims), allowing protocols to optimistically update their UI before an on-chain read completes.

```ts
// Basic — redirect to verify KYC
const url = StellarCred.buildVerifyUrl({
  returnUrl: "https://yourapp.xyz/deposit",
  claim: "kyc",
});

// With threshold — user proves balance >= $50,000
const url = StellarCred.buildVerifyUrl({
  returnUrl: "https://yourapp.xyz/vault",
  claim: "funds",
  claimParams: { threshold: "50000" },
});

// Age gate — require 21+
const url = StellarCred.buildVerifyUrl({
  returnUrl: "https://yourapp.xyz/markets",
  claim: "age",
  claimParams: { threshold_years: "21" },
});

// Jurisdiction — block specific countries (ISO 3166-1 numeric codes)
const url = StellarCred.buildVerifyUrl({
  returnUrl: "https://yourapp.xyz/app",
  claim: "jurisdiction",
  claimParams: { restricted: ["840", "364"] },
});
```

## Claim types

| Type | Proves | Threshold parameter |
|---|---|---|
| `kyc` | Identity verified by a KYC provider | — |
| `age` | Holder is at least N years old | `threshold_years` (years) |
| `income` | Annual income exceeds threshold | `threshold` (USD) |
| `jurisdiction` | Country is not in a restricted list | `restricted` (country codes) |
| `funds` | Liquid balance exceeds threshold | `threshold` (USD) |
| `accreditation` | Holder meets an accredited-investor threshold | `threshold` (USD) |

## Types

The package exports its public types so you can type your own wrappers without
duplicating the union. They appear in `dist/index.d.ts` after `pnpm build` and
are available from `@stellarcred/sdk` directly.

```ts
import type { ClaimType, ClaimOptions } from "@stellarcred/sdk";

// `ClaimType` is exactly the credential union published with the SDK.
// `ClaimOptions.minThreshold` / `.trustedIssuers` are forwarded to `hasClaim`'s
// on-chain `check_claim` / `is_verified` checks.
function gate(wallet: string, claim: ClaimType, opts?: ClaimOptions) {
  return StellarCred.hasClaim(wallet, claim, opts);
}
```

| Export | Kind | Description |
|---|---|---|
| `ClaimType` | `"kyc" \| "age" \| "income" \| "jurisdiction" \| "funds" \| "accreditation"` | The credential types StellarCred supports. Mirrors the on-chain `CLAIM_TYPES` constant. |
| `ClaimOptions` | `{ minThreshold?: number; trustedIssuers?: string[]; requestTimeoutMs?: number }` | Optional settings for `hasClaim`. `minThreshold` is forwarded to the on-chain `check_claim` for parameterised claim types and ignored for binary claims (`kyc`, `jurisdiction`). `trustedIssuers` restricts which issuer(s) the proof must come from, for any claim type — omit to accept any registered issuer. `requestTimeoutMs` bounds the individual read and defaults to 10 seconds. |
| `Claim` | `{ type: string; verifiedAt: number; expiry: number }` | Shape returned by `getClaims`. |
| `CLAIM_TYPES` | `readonly ClaimType[]` | The runtime constant. Use `as const` strings for compile-time narrowing. |

## Full integration example

```ts
import StellarCred from "@stellarcred/sdk";

StellarCred.configure({ registryId: process.env.PROOF_REGISTRY_ID });

async function handleDeposit(wallet: string) {
  // Check all required claims
  const [kycOk, fundsOk] = await Promise.all([
    StellarCred.hasClaim(wallet, "kyc"),
    StellarCred.hasClaim(wallet, "funds", { minThreshold: 50000 }),
  ]);

  if (!kycOk || !fundsOk) {
    // Redirect to verify the missing claim
    const missing = !kycOk ? "kyc" : "funds";
    const opts = missing === "funds" ? { claimParams: { threshold: "50000" } } : {};
    return redirect(StellarCred.buildVerifyUrl({
      returnUrl: "https://yourapp.xyz/deposit",
      claim: missing,
      ...opts,
    }));
  }

  // All claims verified — proceed
  processDeposit(wallet);
}
```

## Peer dependency

Requires `@stellar/stellar-sdk >= 13.0.0` as a peer dependency.

```bash
npm install @stellar/stellar-sdk
```

## Trust boundary

The SDK is designed to work in both browsers and Node.js, but there is an
important boundary between public client-side config and private server-side
config. Understanding this boundary prevents accidental secret leakage.

### What is safe to expose to the client

| Config | Safe for browser? | Why |
|---|---|---|
| `registryId` (ProofRegistry contract ID) | ✅ Yes | A public Stellar contract address — no secret |
| `rpcUrl` | ✅ Yes | A public RPC endpoint — no secret |
| `networkPassphrase` | ✅ Yes | A well-known network identifier — no secret |
| `baseUrl` | ✅ Yes | The StellarCred public URL — no secret |

Pass these via `NEXT_PUBLIC_*` (Next.js) or `VITE_*` (Vite) env vars so they
are available in browser bundles:

```bash
# .env.local (Next.js)
NEXT_PUBLIC_PROOF_REGISTRY_ID=C...
NEXT_PUBLIC_RPC_URL=https://soroban-testnet.stellar.org
```

### What must stay server-side only

| Config / Package | Server-only? | Why |
|---|---|---|
| `ISSUER_PRIVATE_KEY` | ✅ Server-only | Signs credentials — exposure lets anyone forge credentials |
| `@stellarcred/issuer` | ✅ Server-only | Contains the signing key; throws if imported in a browser |
| Server-side `hasClaim` checks | ✅ Server-only for access control | Client-side checks are optimistic UI only (see below) |

Never use `NEXT_PUBLIC_` on `ISSUER_PRIVATE_KEY` or any other secret.

### Server-side re-verification is required

Client-side claim checks (via `hasClaim` in the browser, `useStellarCred`,
etc.) are optimistic UI only — they improve UX by providing immediate feedback
but they **cannot be trusted for access control**:

- The browser environment is not trusted; results can be spoofed by the user.
- `sc_verified=true` return-URL params are untrusted URL hints, not proofs.

**Always re-verify claims server-side before granting access**, using the
wallet address the user has actually authenticated with (not one from a URL
param):

```ts
// ✅ Server-side gate (API route, middleware, server component)
import StellarCred from "@stellarcred/sdk/server";

const ok = await StellarCred.hasClaim(authenticatedWallet, "kyc");
if (!ok) return res.status(403).json({ error: "KYC required" });
```

```ts
// ⚠️  Client-side check — optimistic UI only, not a security gate
import StellarCred from "@stellarcred/sdk";

const ok = await StellarCred.hasClaim(wallet, "kyc");
if (!ok) router.push("/verify"); // redirect to verify, but server will also check
```

### Server entry point: `@stellarcred/sdk/server`

When importing the SDK in server-side code (API routes, middleware, server
components, Lambda handlers, etc.), use the dedicated server entry point:

```ts
// ✅ Explicit server-side import
import StellarCred from "@stellarcred/sdk/server";
import { hasClaim, configure } from "@stellarcred/sdk/server";
```

This is a thin re-export of the same SDK — the API is identical. The separate
path makes the intent explicit at the import site and suppresses the
development-mode warning described below.

### Development-mode boundary warning

In development (`NODE_ENV !== "production"`), the SDK emits a **one-time
`console.warn`** when `configure()` is called from a browser context with
values that appear to come from server-only environment variables (e.g.
`STELLARCRED_REGISTRY_ID` or bare `PROOF_REGISTRY_ID` without a `NEXT_PUBLIC_`
prefix). This catches the common mistake:

```ts
// ⚠️  Wrong — uses a server-only env var name
StellarCred.configure({ registryId: process.env.PROOF_REGISTRY_ID });

// ✅ Right — uses the public Next.js alias
StellarCred.configure({ registryId: process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID });
```

The warning only fires once per page load, only in development (when `NODE_ENV`
is not `"production"`), and only in a browser context. It is silent in
production, in Node.js, and when no suspicious indicators are present.

To silence the warning permanently for server-side code, import from
`@stellarcred/sdk/server` — the warning is only relevant for browser bundles.

## Indexer fast path (optional)

By default every read simulates against `ProofRegistry`. That is the correct
trust model — the only thing your protocol needs to trust is the contract — but
it costs a round trip to a Soroban RPC node per credential type, and the chain
cannot answer questions like "what has this issuer ever issued?" or "what
happened recently?".

A StellarCred [indexer](../../../services/indexer) answers those faster. The SDK
can read from one, **off by default and only when you ask for it per call**.

> ### ⚠️ Read this before you gate anything on it
>
> An indexer is an **off-chain cache of public chain data, operated by someone**.
> It can be stale, lagging, misconfigured, or dishonest. A claim read with
> `source: "indexer"` is *not* a proof.
>
> **Never use `source: "indexer"` as the sole basis for a security decision.**
> Gate access with `source: "chain"` (the default) or `source: "indexer-verified"`.
> Use plain `"indexer"` for UI, analytics, previews, and anywhere a wrong answer
> costs you a flicker rather than an authorisation bypass.

### The three sources

```ts
import StellarCred from "@stellarcred/sdk";

StellarCred.configure({
  registryId: process.env.PROOF_REGISTRY_ID,
  indexerUrl: process.env.STELLARCRED_INDEXER_URL,
  // indexerApiKey: process.env.STELLARCRED_INDEXER_API_KEY,  // only if the indexer gates /claims
});

// 1. Default — trust-minimised. Use this for gating.
const ok = await StellarCred.hasClaim(wallet, "kyc");

// 2. Fast path — trusts the indexer operator. Not for security decisions.
const preview = await StellarCred.hasClaim(wallet, "kyc", { source: "indexer" });

// 3. Trust anchor — reads the indexer, then confirms on-chain and returns the
//    CHAIN's answer. Use when you want drift detection alongside the read.
const gated = await StellarCred.hasClaim(wallet, "kyc", {
  source: "indexer-verified",
});
```

`source` is accepted by `hasClaim`, `getClaim`, `hasClaims`, `getClaims`,
`verifyPreset`, and `watchClaim`, and is inherited by `createClaimGate` and
`useStellarCred` through the options they forward.

**`"indexer-verified"` is not faster than `"chain"`.** It still performs a chain
read, because the chain is what makes the answer trustworthy. Its value is that
a disagreement between the two is logged, which tells you your indexer has
drifted before your users are affected by it:

```
[StellarCred] Indexer disagreed with the chain for claim "kyc": indexer said
true, ProofRegistry said false. The chain result was used. …
```

That warning is rate-limited to once per process and — unlike the SDK's other
warnings — fires in production too, because an integrity signal you only see in
development is not much use.

### What the fast path does and does not change

`minThreshold` and `trustedIssuers` are both honoured on the indexer path. The
SDK re-evaluates them from the raw claim row using the same predicates the
contract uses, so a call is drop-in compatible across sources:

| Contract rule | Indexer equivalent |
|---|---|
| `!revoked` | `row.revoked === 0` |
| `expiry > ledger.timestamp()` | `expiry > Date.now()/1000` |
| `issuer_is_trusted(list, issuer)` | same, with an empty issuer treated as the contract's `None` and therefore rejected when a filter is set |
| `threshold.unwrap_or(0) >= min` | `(row.threshold ?? 0) >= min` |

### Known divergences

These are inherent to reading a cache rather than the chain, and are the reason
`"indexer"` must not gate access:

- **Clock source.** The contract compares `expiry` against the ledger timestamp;
  the SDK compares against your local wall clock. Near an expiry boundary the two
  can disagree, in either direction.
- **Lag.** The indexer trails the chain by its finality lag plus poll interval
  (seconds by default, longer if it is unhealthy). A just-submitted claim can
  read as absent, and a just-revoked claim can still read as valid. Check the
  indexer's `GET /health` for `lag` and `status` if you depend on freshness.
- **Trust.** You are trusting the indexer operator to serve you honest data.
  `"chain"` and `"indexer-verified"` do not ask you to.

### Fan-out and caching

`GET /claims?wallet=…` returns *all* of a wallet's claims in one response, so a
`getClaims` fan-out over the six credential types issues **one** HTTP request,
not six. To do that the SDK memoises indexer rows per wallet for
`indexerCacheMs` (default `2000`, set `0` to disable).

This cache applies only to `"indexer"` and `"indexer-verified"` reads. **Chain
reads are never cached** — every `source: "chain"` call is a fresh simulation.

### Failure behaviour

The indexer path follows the SDK's existing fail-soft convention: an unreachable
indexer, an HTTP error, or a malformed body yields `false` / `null` / `[]` rather
than throwing, and throws `IndexerError` (or `ConfigError` when `indexerUrl` is
missing) under `throwOnError: true`. Failed responses are not cached.

For `source: "indexer-verified"` a failed indexer read is not fatal — the chain
read still happens and still decides the result.

### The API key is a secret

`indexerApiKey` is sent as `Authorization: Bearer`. There is deliberately no
`NEXT_PUBLIC_` alias for it, and configuring one from a browser context warns in
development: shipping it to the browser hands it to every visitor. Either read
from the browser without a key, or proxy indexer reads through your own backend.

Note also that the indexer's CORS policy does not allow an `X-API-Key` header
through a browser preflight, which is why the SDK uses `Authorization`.

## How it works

StellarCred stores ZK proofs on Stellar. A holder proves a claim once (in their browser, using UltraHonk / Barretenberg); the result is cached in the `ProofRegistry` contract. Your protocol reads it with a single free simulation — no wallet connection, no fee, no personal data.

The `minThreshold` check calls `ProofRegistry.check_claim` on-chain, which compares the threshold stored in the proof's public inputs against your required minimum. It is not a frontend check — the contract enforces it.

### Contract Events & Indexing

For backend indexers, analytics services, or event-driven integrations monitoring proof submissions, revocations, and lifecycle events, see the authoritative [EVENTS.md](../../../EVENTS.md) (or [docs/EVENTS.md](../../../docs/EVENTS.md)) for complete topic schemas, payload structures, and drift guarantees.

## License

MIT

## Using StellarCred outside React

The SDK exports a framework-agnostic `createClaimGate` core that exposes a subscribe/unsubscribe API. Use it anywhere — Vue, Svelte, vanilla JS, or any other framework.

```ts
import { createClaimGate } from "@stellarcred/sdk";

const gate = createClaimGate({ wallet: "G…" });
gate.subscribe((state) => {
  console.log(state.claims);  // { kyc: true, age: true, ... }
  console.log(state.loading); // false
});

// Re-check claims later
gate.refetch();

// Clean up when done
gate.destroy();
```

### API

```ts
createClaimGate(config: ClaimGateConfig): ClaimGate
```

| Field | Type | Description |
|---|---|---|
| `subscribe(fn)` | `(ClaimGateState) => void` | Subscribe to state changes; returns unsubscribe |
| `unsubscribe(fn)` | `void` | Remove a listener |
| `getSnapshot()` | `ClaimGateState` | Get current state synchronously |
| `refetch()` | `void` | Re-run all claim checks |
| `destroy()` | `void` | Stop polling, clear listeners |

### TypeScript

```ts
import type { ClaimGate, ClaimGateState, ClaimGateConfig } from "@stellarcred/sdk";
```

### React

The existing `useStellarCred` React hook is a React wrapper around the batched `hasClaims` read. It is a separate implementation from `createClaimGate` (the framework-agnostic per-claim gate) — both expose the same claim status, so pick whichever fits your framework.

```ts
import { useStellarCred } from "@stellarcred/sdk";
// Works exactly as before
const { claims, loading, error, refetch } = useStellarCred(walletAddress);
```

### Vue example

See [`examples/vue-gate/ClaimGate.vue`](./examples/vue-gate/ClaimGate.vue) for a complete Vue 3 component using `createClaimGate`.

```vue
<script setup lang="ts">
import { createClaimGate } from "@stellarcred/sdk";
import { ref, onMounted, onUnmounted } from "vue";

const props = defineProps<{ wallet: string }>();
const state = ref({ claims: null, loading: true, error: null });
let gate;

onMounted(() => {
  gate = createClaimGate({ wallet: props.wallet });
  gate.subscribe((s) => { state.value = s; });
});
onUnmounted(() => gate?.destroy());
</script>
```

### Svelte example

See [`examples/svelte-gate/ClaimGate.svelte`](./examples/svelte-gate/ClaimGate.svelte) for a complete Svelte component.

```svelte
<script lang="ts">
  import { createClaimGate } from "@stellarcred/sdk";
  import { onMount, onDestroy } from "svelte";

  export let wallet: string;
  let state = { claims: null, loading: true, error: null };
  let gate;

  onMount(() => {
    gate = createClaimGate({ wallet });
    gate.subscribe((s) => { state = s; });
  });
  onDestroy(() => gate?.destroy());
</script>

{#if state.loading}<p>Checking claims…</p>
{:else}{#each Object.entries(state.claims || {}) as [type, ok]}
  <p>{type}: {ok ? '✅' : '❌'}</p>
{/each}{/if}
```

---

## Server-Side Wallet Challenge & Verification (`verifyWalletClaim`)

> ⚠️ **CRITICAL SECURITY WARNING: The Wallet Spoofing Pitfall**
>
> **Do NOT use `hasClaim(wallet, ...)` alone to gate server-side resources or create authenticated sessions.**
>
> Anyone can look up a verified public key on-chain and pass it in a request body, query parameter, or header. Checking `hasClaim(untrustedAddress, "kyc")` only proves that *someone* owns credentials for that address, **not** that the current HTTP caller controls that address!
>
> To securely gate access, your server must issue a cryptographic challenge, have the client sign it with their Stellar wallet (Freighter, Albedo, etc.), and verify both the signature and on-chain credential claim.

### 1. Issue a Challenge (Server)

```ts
import { createWalletChallenge } from "@stellarcred/sdk";

// In your GET /api/auth/challenge endpoint:
const challenge = createWalletChallenge({
  domain: "yourapp.com",
  statement: "Sign in to access accredited investor pool",
  ttlMs: 5 * 60 * 1000, // 5 minutes validity
});

// Send `challenge` JSON to frontend
res.json(challenge);
```

### 2. Sign Challenge (Client / Wallet)

```ts
// In your frontend with Freighter or wallet of choice:
import { signMessage } from "@stellar/freighter-api";

const signature = await signMessage(challenge.message);
// Send { wallet, challenge, signature } to POST /api/auth/verify
```

### 3. Verify Wallet Control & On-Chain Claim in One Call (Server)

```ts
import { verifyWalletClaim } from "@stellarcred/sdk";

// In your POST /api/auth/verify endpoint:
const result = await verifyWalletClaim({
  wallet: req.body.wallet,
  challenge: req.body.challenge,
  signature: req.body.signature,
  claim: "kyc",
  // Optional threshold or issuer requirements:
  // claimOptions: { minThreshold: 50000, trustedIssuers: ["G..."] },
});

if (!result.ok) {
  // Returns detailed diagnostics:
  // result.signatureValid === false (spoofing attempt or altered challenge)
  // result.claimValid === false (wallet doesn't hold the on-chain claim)
  return res.status(403).json({ error: result.error });
}

// ✅ Proven wallet control AND valid on-chain KYC credential!
// Proceed with issuing session cookie or JWT:
createSession(req, result.wallet);
```

### Complete Runnable Reference Application

A complete, runnable application implementing this entire pattern end-to-end (redirect, return handling, challenge generation, signature verification, on-chain re-verification, session route gating, and failure-state diagnosis) is available at [`examples/canonical-integration`](../../../examples/canonical-integration).

---

## Release Process

The SDK follows [Semantic Versioning](https://semver.org/). Releases are fully automated through `.github/workflows/release.yml`.

### How Releases Work:
1. **Version Declaration**: The canonical version is maintained in `frontend/packages/sdk/package.json` (e.g. `"version": "0.1.1"`).
2. **Cutting a Release**:
   - Update `package.json` version and document changes in `frontend/packages/sdk/CHANGELOG.md` and root `CHANGELOG.md`.
   - Create and push a signed git tag matching the version with a `v` prefix:
     ```bash
     git tag -a v0.1.1 -m "Release v0.1.1"
     git push origin v0.1.1
     ```
3. **Workflow Execution**:
   - `.github/workflows/release.yml` triggers on `v*` tag pushes.
   - It validates that the git tag version strictly matches `package.json`.
   - Runs `pnpm build` to compile the dual CJS/ESM distribution bundles with TypeScript definitions.
   - Generates release notes from conventional commit messages.
   - Creates an official GitHub Release with release artifacts.
   - Publishes `@stellarcred/sdk` with public access to the npm registry using `NPM_TOKEN`.


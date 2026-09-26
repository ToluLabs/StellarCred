# @stellarcred/sdk

Read-only client for [StellarCred](https://github.com/Psalmuel01/StellarCred) — check zero-knowledge credential proofs on Stellar from any protocol, frontend, or backend.

Protocols call one function. No API key, no backend, no personal data handling — the only thing you trust is the on-chain ProofRegistry.

## Install

```bash
npm install @stellarcred/sdk
```
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

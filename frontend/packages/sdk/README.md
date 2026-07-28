# @stellarcred/sdk

Read-only client for [StellarCred](https://github.com/Psalmuel01/StellarCred) — check zero-knowledge credential proofs on Stellar from any protocol, frontend, or backend.

Protocols call one function. No API key, no backend, no personal data handling — the only thing you trust is the on-chain ProofRegistry.

## Install

```bash
npm install @stellarcred/sdk
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
});
```

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
});

// Combine with a threshold — both must hold
const incomeOk = await StellarCred.hasClaim(wallet, "income", {
  minThreshold: 100000,
  trustedIssuers: ["G...PLAID_ISSUER"],
});
```

### `getClaims(wallet)`

Returns all active claims a wallet has proved, across all known credential types.

```ts
const claims = await StellarCred.getClaims(wallet);
// [{ type: "kyc", verifiedAt: 1719000000, expiry: 1726776000 }, ...]
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
| `ClaimOptions` | `{ minThreshold?: number; trustedIssuers?: string[] }` | Optional settings for `hasClaim`. `minThreshold` is forwarded to the on-chain `check_claim` for parameterised claim types and ignored for binary claims (`kyc`, `jurisdiction`). `trustedIssuers` restricts which issuer(s) the proof must come from, for any claim type — omit to accept any registered issuer. |
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

## License

MIT

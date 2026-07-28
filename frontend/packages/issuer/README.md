# @stellarcred/issuer

Server-only issuance client for [StellarCred](https://github.com/Psalmuel01/StellarCred) — turns a verified attribute (date of birth, income, balance, …) into a signed ZK credential a holder can prove claims against.

## ⚠️ Server-side only

This package signs credentials with a private key. It must **never** run in a browser.

- Set `ISSUER_PRIVATE_KEY` as a plain server-side environment variable — **never** prefix it `NEXT_PUBLIC_` (or any other client-exposed prefix). A `NEXT_PUBLIC_`-prefixed env var is inlined into the browser bundle at build time; doing that with an issuer private key hands out the ability to mint arbitrary credentials.
- `package.json`'s `exports` field only defines a `node` condition — bundlers that respect package exports (webpack 5+, Vite, esbuild) will fail to resolve `@stellarcred/issuer` for a browser target. The module also throws immediately if it ever detects a `window` global, as defense-in-depth for older tooling.
- Only call this package from a server context: a Next.js Route Handler / API route, a standalone Node.js server, a serverless function, etc.

## Install

```bash
npm install @stellarcred/issuer
```

## Quick start

```ts
import { IssuerClient } from "@stellarcred/issuer";

const issuer = new IssuerClient({
  privateKey: process.env.ISSUER_PRIVATE_KEY!, // 64-char hex secp256k1 private key, server-side only
});

const credential = await issuer.issue({
  type: "kyc",
  holder: "GABC...",
  issuerId: "did:example:my-issuer",
  issuerName: "My KYC Provider",
  expiry: Math.floor(Date.now() / 1000) + 31536000, // or a duration string like "90 days"
  attribute: {}, // kyc has no attribute — just an identity check
});

// credential.commitment / credential.sig / credential.issuerPubX / credential.issuerPubY
// are what you persist alongside the holder's wallet and submit for on-chain proving.
```

Each call to `issue()` produces one independent credential — its own preimage, salt, commitment, and signature. Issuing multiple credential types for the same holder means calling `issue()` once per type.

## Credential types and attributes

| `type` | required `attribute` field | claim proved |
|---|---|---|
| `kyc` | — (none) | identity verified |
| `age` | `date_of_birth` (ISO date string) | age ≥ threshold |
| `income` | `income` (numeric string) | income > threshold |
| `jurisdiction` | `country_code` (numeric string) | country not restricted |
| `funds` | `balance` (numeric string) | balance > threshold |
| `accreditation` | `net_worth` (numeric string) | net worth ≥ threshold |

`claimParams` (optional) controls the human-readable `claim` label and the threshold a downstream verifier checks against — e.g. `{ threshold_years: "21" }` for `age`, `{ threshold: "250000" }` for `income`/`funds`.

## API

### `new IssuerClient({ privateKey })`

`privateKey` — 64-character hex secp256k1 private key. Required; throws if missing or malformed. The corresponding public key must be registered with the on-chain `IssuerRegistry` contract for credentials from this key to be provable — see `issuer.publicKey()` below.

### `issuer.issue(params): Promise<Credential>`

| param | type | notes |
|---|---|---|
| `type` | `CredentialType` | one of the six types above |
| `holder` | `string` | the holder's Stellar wallet address |
| `issuerId` | `string` | your issuer identifier |
| `issuerName` | `string` | human-readable issuer name, stored in the credential |
| `expiry` | `string \| number` | a duration string (`"90 days"`) or an absolute unix timestamp |
| `attribute` | `Record<string, string>` | type-specific fields, see table above |
| `claimParams` | `object` (optional) | thresholds / restricted list for the claim label |

Returns a `Credential`:

```ts
interface Credential {
  type: CredentialType;
  title: string;
  claim: string;
  issuer: string;
  issuerId: string;
  holder: string;
  value: string;        // circuit preimage
  salt: string;         // 31-byte random field element
  commitment: string;   // Poseidon2([value, salt], 2)
  sig: number[];        // secp256k1 signature over the raw commitment (prehash: false)
  issuerPubX: number[]; // 32 bytes
  issuerPubY: number[]; // 32 bytes
  issuedAt: number;
  expiry: string;
  claimParams?: { threshold_years?: string; threshold?: string; restricted?: string[] };
}
```

### `issuer.publicKey(): { x: number[]; y: number[] }`

Returns the uncompressed public key (32-byte `x`/`y`) for the configured private key — register this with `IssuerRegistry` so proofs signed by this issuer can be verified on-chain.

## Security notes

- **`prehash: false` is not configurable.** Noir circuits consume the raw 32-byte commitment as the signing digest directly — no SHA-256 pre-hash. This package always signs with `prehash: false` to match; changing this would make every issued credential unprovable against the on-chain verifier.
- **No logging, no persistence.** This package never calls `console.*` and never writes to disk or a database — attribute values (date of birth, income, balance, …) exist only for the duration of the `issue()` call. Any audit logging you need is your responsibility, and should log metadata (issuer ID, credential type, outcome) rather than raw attribute values.
- The Poseidon2 commitment scheme and the compiled circuit shipped inside this package are the same ones used by every StellarCred proof circuit and the on-chain verifier — see the [main repo](https://github.com/Psalmuel01/StellarCred) for the full architecture.

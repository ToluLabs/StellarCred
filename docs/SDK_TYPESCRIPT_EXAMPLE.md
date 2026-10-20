# TypeScript example for `@stellarcred/sdk`

**Audience:** a developer adding StellarCred to a TypeScript service or dapp.

`@stellarcred/sdk` ships its own typings, so a TypeScript integration needs no
`@types` package and no generated client. This page is a complete, minimal
example — the same code lives in
[`examples/typescript-quickstart`](../examples/typescript-quickstart) and is
typechecked in CI, so it always compiles against the published API.

> **The SDK is read-only.** It verifies signatures and reads `ProofRegistry`; it
> never builds, signs, or submits a transaction. Transactions in this example are
> built and signed with `@stellar/stellar-sdk`, which is already a required peer
> dependency of the SDK.

---

## Contents

1. [Install](#1-install)
2. [tsconfig](#2-tsconfig)
3. [Configure with types](#3-configure-with-types)
4. [Typed claim reads](#4-typed-claim-reads)
5. [Create and sign a transaction](#5-create-and-sign-a-transaction)
6. [Verify the transaction signature](#6-verify-the-transaction-signature)
7. [Recommended: challenge + claim](#7-recommended-challenge--claim)
8. [Run and typecheck it](#8-run-and-typecheck-it)
9. [CI](#9-ci)

---

## 1. Install

```bash
npm install @stellarcred/sdk @stellar/stellar-sdk
npm install --save-dev typescript tsx @types/node
```

| Package | Role |
| --- | --- |
| `@stellarcred/sdk` | claim reads, `createWalletChallenge`, `verifyWalletClaim`, branded errors |
| `@stellar/stellar-sdk` | required peer dependency; `TransactionBuilder`, `Keypair`, `Networks` |
| `typescript` | typechecking (`tsc --noEmit`) |
| `tsx` | run the `.ts` example without a build step |
| `@types/node` | `process.env`, `Buffer` |

`@stellarcred/sdk` resolves through its `exports` map with `types` pointing at
`dist/index.d.ts`, so `moduleResolution: "node16"`, `"bundler"` (used below), or
`"nodenext"` all pick up the declarations automatically.

## 2. tsconfig

The minimal strict configuration — copy
[`examples/typescript-quickstart/tsconfig.json`](../examples/typescript-quickstart/tsconfig.json):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

`skipLibCheck` is not required by the SDK; keep it unless you also want to
typecheck your dependencies' `.d.ts` files.

## 3. Configure with types

`configure()` accepts `SDKConfig`; every field is optional and an explicit value
wins over the matching `STELLARCRED_*` environment variable.

```ts
import { Networks } from "@stellar/stellar-sdk";
import StellarCred from "@stellarcred/sdk";

StellarCred.configure({
  // Canonical testnet ProofRegistry (see DEPLOYMENTS.md).
  registryId:
    process.env.STELLARCRED_REGISTRY_ID ??
    "CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV",
  rpcUrl: process.env.STELLARCRED_RPC_URL ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
});
```

Call it once at startup, before any read. Reads on a wallet cannot be spoofed by
passing someone else's address — see [§7](#7-recommended-challenge--claim).

## 4. Typed claim reads

`CLAIM_TYPES` is exported as a readonly tuple, so `ClaimType` is a literal union
(`"kyc" | "age" | "income" | "jurisdiction" | "funds" | ...`) rather than
`string`. Pass typed values and let the compiler keep you honest.

```ts
import StellarCred, {
  type Claim,
  type ClaimOptions,
  type ClaimType,
  type CredentialStatusResult,
} from "@stellarcred/sdk";

/** true only when the wallet holds a valid, unexpired proof of `claim`. */
export async function hasVerifiedClaim(
  wallet: string,
  claim: ClaimType,
  options: ClaimOptions = {},
): Promise<boolean> {
  // throwOnError turns a transport/RPC failure into a typed error instead of
  // a silently-false result — use it when "unknown" must not look like "no".
  return StellarCred.hasClaim(wallet, claim, { ...options, throwOnError: true });
}

/** Validity window and failure reason, without exposing personal data. */
export async function readClaim(
  wallet: string,
  claim: ClaimType,
): Promise<CredentialStatusResult> {
  return StellarCred.checkClaimStatus(wallet, claim, { throwOnError: true });
}

/** Every claim the wallet currently holds. */
export async function readAllClaims(wallet: string): Promise<Claim[]> {
  return StellarCred.getClaims(wallet, { throwOnError: true });
}
```

Threshold claims are enforced on-chain — pass `minThreshold` and the registry
checks `stored >= required`:

```ts
const canTrade = await StellarCred.hasClaim(wallet, "age", { minThreshold: 21 });
```

## 5. Create and sign a transaction

`@stellar/stellar-sdk` builds the transaction; the SDK's peer dependency means
you already have it installed.

```ts
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

export function createSignedPayment(params: {
  payer: Keypair;
  destination: string;
  amount?: string;
  /** Current account sequence number; "0" is enough for a local demo. */
  sequence?: string;
}): Transaction {
  const { payer, destination, amount = "1", sequence = "0" } = params;

  const transaction = new TransactionBuilder(new Account(payer.publicKey(), sequence), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount }))
    .setTimeout(30)
    .build();

  // Signs the transaction hash with the payer's Ed25519 key.
  transaction.sign(payer);
  return transaction;
}
```

In a browser wallet, call `signTransaction(xdr, { networkPassphrase })` on
Freighter/Stellar Wallets Kit instead of `transaction.sign(keypair)`; everything
after that — verification and claim checks — is identical.

## 6. Verify the transaction signature

`verifyWalletSignature(wallet, message, signature)` verifies any Ed25519 signature
over a string or raw bytes, so a transaction hash works exactly like a challenge
string. It returns `false` instead of throwing on malformed input.

```ts
import { verifyWalletSignature } from "@stellarcred/sdk";

export function verifyTransactionSignature(wallet: string, transaction: Transaction): boolean {
  const signature = transaction.signatures[0]?.signature();
  if (!signature) return false;
  return verifyWalletSignature(wallet, transaction.hash(), signature);
}
```

Use this to confirm that the wallet submitting a signed transaction is the wallet
whose credential you are gating on. It proves *control of the key*; combine it
with `hasClaim` for credential status.

## 7. Recommended: challenge + claim

For authenticated sessions, do not gate on `hasClaim(address)` alone: public keys
and proofs are public, so anyone can copy a verified address into a request body.
Issue a replay-protected challenge, have the wallet sign the challenge message,
then verify signature **and** claim in one call.

```ts
import type { VerifyWalletClaimResult, WalletChallenge } from "@stellarcred/sdk";

export function issueChallenge(domain: string): WalletChallenge {
  return StellarCred.createWalletChallenge({
    domain,
    statement: "Sign in to verify your credential",
    ttlMs: 5 * 60 * 1000, // single-use nonce expires with the challenge
  });
}

export async function authenticate(params: {
  wallet: string;
  challenge: WalletChallenge;
  signature: string | Uint8Array;
  claim?: ClaimType;
  claimOptions?: ClaimOptions;
}): Promise<VerifyWalletClaimResult> {
  return StellarCred.verifyWalletClaim({
    wallet: params.wallet,
    challenge: params.challenge,
    signature: params.signature,
    claim: params.claim ?? "kyc",
    claimOptions: params.claimOptions,
  });
}
```

The result is fully discriminated: `ok` is true only when both checks pass, and
`failureReason` distinguishes `invalid_signature`, `challenge_replayed`,
`challenge_expired`, `not_verified`, `expired`, `revoked`, `wrong_issuer`, and
`unmet_threshold`.

## 8. Run and typecheck it

```bash
cd examples/typescript-quickstart
npm install
npm run typecheck   # tsc --noEmit — the check CI runs
npm start           # offline demo: create, sign, verify
```

`npm start` makes no network calls. Set `SC_CHECK_WALLET=G...` to add a live
`ProofRegistry` read.

Expected output:

```
signed transaction verifies : true
signed challenge verifies   : true
transaction hash            : <64 hex characters>
```

## 9. CI

The frontend job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
builds the SDK distribution and then runs, for this example:

```yaml
- name: Typecheck TypeScript SDK example (#751)
  working-directory: examples/typescript-quickstart
  run: |
    npm ci
    npm run typecheck
    npm start
```

That means a breaking change to a signature, an export, or a type in
`@stellarcred/sdk` fails CI here instead of in a user's project.

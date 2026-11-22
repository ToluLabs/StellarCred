# StellarCred TypeScript SDK Example

A clean, type-safe reference example demonstrating how to integrate `@stellarcred/sdk` and `@stellar/stellar-sdk` in a modern TypeScript environment.

This example illustrates end-to-end credential gating and Stellar transaction construction:
1. **SDK Initialization & Health Check**: Configure explicit RPC and registry parameters with typed health diagnostics.
2. **On-Chain Credential Verification**: Query zero-knowledge credential proofs (`hasClaim`, `getClaimRecord`) directly against Soroban `ProofRegistry`.
3. **Anti-Spoofing Wallet Challenge**: Generate replay-protected cryptographic challenges and verify wallet signatures atomically (`verifyWalletClaim`), mitigating wallet-spoofing risks ([Issue #543](https://github.com/ToluLabs/StellarCred/issues/543)).
4. **Credential-Gated Stellar Transactions**: Build, gate, and sign Stellar payments (`createAndSignGatedPayment`) that enforce verified on-chain claims before signing.
5. **Type-Safe Error Handling**: Catch and handle typed SDK error hierarchies (`RpcError`, `ContractError`, `TimeoutError`, `InvalidAddressError`).

---

## Prerequisites

- **Node.js**: v20 or newer
- **npm** (or pnpm)

---

## Quick Start

### 1. Install Dependencies

From this directory (`examples/typescript`):

```bash
npm install
```

### 2. Typecheck

Verify full TypeScript compilation without emitting JavaScript:

```bash
npm run typecheck
```

### 3. Run Automated Tests

Execute the test suite against testnet fixtures:

```bash
npm test
```

### 4. Run Example Flow

Execute the complete end-to-end flow:

```bash
npm start
```

---

## Code Walkthrough

The primary implementation is located in [`src/index.ts`](src/index.ts).

### 1. Configuration & Health Check

```typescript
import { configure, healthCheck } from "@stellarcred/sdk";
import { Networks } from "@stellar/stellar-sdk";

configure({
  registryId: process.env.STELLARCRED_REGISTRY_ID ?? "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  rpcUrl: process.env.STELLARCRED_RPC_URL ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.STELLARCRED_NETWORK_PASSPHRASE ?? Networks.TESTNET,
  requestTimeoutMs: 10_000,
});

const health = healthCheck();
if (!health.configured) {
  console.warn(`Missing required configuration: ${health.missing.join(", ")}`);
}
```

### 2. Checking On-Chain Claims

```typescript
import { hasClaim, getClaimRecord } from "@stellarcred/sdk";

// Boolean check for verified claim
const isVerified = await hasClaim(walletAddress, "kyc");

// Detailed metadata inspection
const record = await getClaimRecord(walletAddress, "kyc");
```

### 3. Anti-Spoofing Wallet Authentication

Public keys and on-chain proofs are publicly observable on the ledger. Never grant authorization based solely on a claimed wallet address.

```typescript
import { createWalletChallenge, verifyWalletClaim } from "@stellarcred/sdk";
import { Keypair } from "@stellar/stellar-sdk";

// 1. Generate challenge with nonce and TTL
const challenge = createWalletChallenge({
  domain: "myapp.stellarcred.xyz",
  statement: "Sign to prove wallet control and access credential-gated transaction",
  ttlMs: 5 * 60 * 1000,
});

// 2. Client signs challenge (e.g., via Freighter signMessage or Keypair)
const signatureHex = Buffer.from(walletKeypair.sign(Buffer.from(challenge.message))).toString("hex");

// 3. Verify signature and on-chain claim status in one call
const result = await verifyWalletClaim({
  wallet: walletKeypair.publicKey(),
  challenge,
  signature: signatureHex,
  claim: "kyc",
});

if (result.signatureValid && result.claimValid) {
  // Wallet control and credential requirement satisfied
}
```

### 4. Creating and Signing Gated Transactions

```typescript
import {
  Account,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  Asset,
} from "@stellar/stellar-sdk";

// Gate before building or signing
const hasKyc = await hasClaim(senderKeypair.publicKey(), "kyc");
if (!hasKyc) {
  throw new Error("Credential requirement not met.");
}

const sourceAccount = new Account(senderKeypair.publicKey(), "1000");
const transaction = new TransactionBuilder(sourceAccount, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(
    Operation.payment({
      destination: recipientAddress,
      asset: Asset.native(),
      amount: "10.0000000",
    })
  )
  .setTimeout(60)
  .build();

transaction.sign(senderKeypair);
const signedXdr = transaction.toXDR();
```

---

## License

Apache-2.0

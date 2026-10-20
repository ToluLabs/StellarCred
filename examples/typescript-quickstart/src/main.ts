/**
 * Minimal TypeScript integration for `@stellarcred/sdk` (issue #751).
 *
 * This file is typechecked (`npm run typecheck`) and executed (`npm start`) in
 * CI, so every snippet in `docs/SDK_TYPESCRIPT_EXAMPLE.md` is known to compile.
 *
 * What it shows:
 *   1. Typed SDK configuration and claim reads.
 *   2. Creating and signing a Stellar transaction with the SDK's
 *      `@stellar/stellar-sdk` peer dependency.
 *   3. Verifying that signature with `verifyWalletSignature` from the SDK.
 *   4. The recommended server-side flow: issue a challenge, then verify the
 *      wallet's signature together with the on-chain claim.
 *
 * The SDK itself is read-only: it never builds, signs, or submits
 * transactions. It verifies signatures and reads `ProofRegistry`.
 */

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
import StellarCred, {
  verifyWalletSignature,
  type Claim,
  type ClaimOptions,
  type ClaimType,
  type CredentialStatusResult,
  type VerifyWalletClaimResult,
  type WalletChallenge,
} from "@stellarcred/sdk";

// Canonical testnet deployment of ProofRegistry (see DEPLOYMENTS.md).
const DEFAULT_REGISTRY_ID = "CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV";
const RPC_URL = process.env.STELLARCRED_RPC_URL ?? "https://soroban-testnet.stellar.org";

// ---------------------------------------------------------------------------
// 1. Configure once at startup. An explicit `registryId` wins over the
//    STELLARCRED_REGISTRY_ID environment variable the SDK reads on import.
// ---------------------------------------------------------------------------
StellarCred.configure({
  registryId: process.env.STELLARCRED_REGISTRY_ID ?? DEFAULT_REGISTRY_ID,
  rpcUrl: RPC_URL,
  networkPassphrase: Networks.TESTNET,
});

/**
 * Returns `true` only when `wallet` holds a valid, unexpired proof of `claim`.
 * Threshold claims (`age`, `income`, `funds`) are enforced on-chain via
 * `minThreshold`, so the returned boolean is trustless.
 */
export async function hasVerifiedClaim(
  wallet: string,
  claim: ClaimType,
  options: ClaimOptions = {},
): Promise<boolean> {
  return StellarCred.hasClaim(wallet, claim, { ...options, throwOnError: true });
}

/**
 * Full record for a claim: `valid`, `status`, and the issuer-signed details.
 * Unlike `hasClaim`, this is safe to show in a UI because it exposes no
 * personal data — only the commitment and validity window.
 */
export async function readClaim(
  wallet: string,
  claim: ClaimType,
): Promise<CredentialStatusResult> {
  return StellarCred.checkClaimStatus(wallet, claim, { throwOnError: true });
}

/** All claims a wallet currently holds, typed as `Claim[]`. */
export async function readAllClaims(wallet: string): Promise<Claim[]> {
  return StellarCred.getClaims(wallet, { throwOnError: true });
}

// ---------------------------------------------------------------------------
// 2. Create and sign a transaction.
//
// StellarCred does not submit transactions, but most integrations already sign
// one (a payment, a contract call, a session-authorising transfer). Building it
// needs only the peer dependency the SDK already requires, and the signature it
// produces is a normal Ed25519 signature that the SDK can verify.
// ---------------------------------------------------------------------------
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

/**
 * Verifies a signed transaction against the wallet that claims to have signed
 * it. `verifyWalletSignature` accepts any message or raw bytes, so a
 * transaction hash works exactly like a challenge string.
 */
export function verifyTransactionSignature(wallet: string, transaction: Transaction): boolean {
  const signature = transaction.signatures[0]?.signature();
  if (!signature) return false;
  return verifyWalletSignature(wallet, transaction.hash(), signature);
}

// ---------------------------------------------------------------------------
// 3. Recommended server-side flow: prove wallet control, then check the claim.
//    Checking `hasClaim(untrustedAddress)` alone is spoofable — anyone can read
//    a verified public key off-chain. The challenge signature binds the address
//    to the caller.
// ---------------------------------------------------------------------------
export function issueChallenge(domain: string): WalletChallenge {
  return StellarCred.createWalletChallenge({
    domain,
    statement: "Sign in to verify your credential",
    ttlMs: 5 * 60 * 1000,
  });
}

/**
 * Verifies the wallet's signature over `challenge.message` and then reads the
 * on-chain claim in one call. `ok` is true only when both checks pass.
 */
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

// ---------------------------------------------------------------------------
// Offline demo — no network calls, so it is safe to run in CI.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const payer = Keypair.random();
  const destination = Keypair.random().publicKey();

  const transaction = createSignedPayment({ payer, destination });
  const transactionValid = verifyTransactionSignature(payer.publicKey(), transaction);

  const challenge = issueChallenge("localhost:3000");
  const challengeSignature = payer.sign(Buffer.from(challenge.message, "utf8"));
  const challengeValid = StellarCred.verifyWalletSignature(
    payer.publicKey(),
    challenge.message,
    challengeSignature,
  );

  console.log(`signed transaction verifies : ${transactionValid}`);
  console.log(`signed challenge verifies   : ${challengeValid}`);
  console.log(`transaction hash            : ${transaction.hash().toString("hex")}`);

  if (!transactionValid || !challengeValid) {
    throw new Error("signature verification failed");
  }

  // Set SC_CHECK_WALLET to run a live on-chain read against ProofRegistry.
  const walletToCheck = process.env.SC_CHECK_WALLET;
  if (walletToCheck) {
    const status = await readClaim(walletToCheck, "kyc");
    console.log(`kyc status for ${walletToCheck}: ${status.status}`);
  } else {
    console.log("set SC_CHECK_WALLET=G... to run a live ProofRegistry read");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

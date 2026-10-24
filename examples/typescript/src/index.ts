/**
 * examples/typescript/src/index.ts
 *
 * Minimal, clean TypeScript example demonstrating how to integrate @stellarcred/sdk:
 * 1. Typed imports and SDK configuration
 * 2. On-chain credential verification (hasClaim, getClaimRecord)
 * 3. Wallet challenge and anti-spoofing signature verification (verifyWalletClaim)
 * 4. Creating and signing a Stellar transaction gated by verified credentials
 * 5. Type-safe error handling
 */

import StellarCred, {
  configure,
  healthCheck,
  hasClaim,
  getClaimRecord,
  createWalletChallenge,
  verifyWalletClaim,
  type ClaimType,
  type ClaimOptions,
  type SDKConfig,
  type ProofRecordDetails,
  type WalletChallenge,
  type VerifyWalletClaimResult,
  RpcError,
  ContractError,
  TimeoutError,
  InvalidAddressError,
} from "@stellarcred/sdk";

import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  Asset,
  Transaction,
  Memo,
} from "@stellar/stellar-sdk";

// ─── 1. SDK Configuration ────────────────────────────────────────────────────

/**
 * Configure the StellarCred SDK with explicit environment parameters.
 * Configuration can also be provided automatically via environment variables
 * (STELLARCRED_REGISTRY_ID, STELLARCRED_RPC_URL, STELLARCRED_NETWORK_PASSPHRASE).
 */
export function initializeSdk(config?: Partial<SDKConfig>): void {
  configure({
    registryId:
      config?.registryId ??
      process.env.STELLARCRED_REGISTRY_ID ??
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    rpcUrl:
      config?.rpcUrl ??
      process.env.STELLARCRED_RPC_URL ??
      "https://soroban-testnet.stellar.org",
    networkPassphrase:
      config?.networkPassphrase ??
      process.env.STELLARCRED_NETWORK_PASSPHRASE ??
      Networks.TESTNET,
    requestTimeoutMs: config?.requestTimeoutMs ?? 10_000,
  });

  const health = healthCheck();
  if (!health.configured) {
    console.warn(
      `[StellarCred] Warning: Missing configuration parameters: ${health.missing.join(", ")}`
    );
  }
}

// ─── 2. Credential Verification ──────────────────────────────────────────────

/**
 * Check whether a wallet address holds a valid on-chain credential claim.
 *
 * @param walletAddress - The Stellar public key (G...) to check
 * @param claimType - Credential type (e.g. "kyc", "funds", "age", "accredited")
 * @param options - Optional threshold requirements and trusted issuer filters
 */
export async function verifyCredential(
  walletAddress: string,
  claimType: ClaimType = "kyc",
  options?: ClaimOptions
): Promise<boolean> {
  return await hasClaim(walletAddress, claimType, options);
}

/**
 * Retrieve full on-chain proof metadata for a credential.
 *
 * @param walletAddress - The Stellar public key (G...)
 * @param claimType - Credential type
 */
export async function fetchProofRecord(
  walletAddress: string,
  claimType: ClaimType = "kyc"
): Promise<ProofRecordDetails | null> {
  return await getClaimRecord(walletAddress, claimType);
}

// ─── 3. Anti-Spoofing Wallet Challenge & Signature Verification ──────────────

/**
 * Demonstrate wallet-control verification (defends against Issue #543 wallet spoofing).
 *
 * Generates a replay-protected cryptographic challenge, signs it using the holder's
 * keypair (e.g. via Freighter signMessage in web apps), and verifies both signature
 * and on-chain credential claim atomically.
 */
export async function proveAndVerifyWalletControl(
  walletKeypair: Keypair,
  claim: ClaimType = "kyc",
  domain = "myapp.stellarcred.xyz"
): Promise<VerifyWalletClaimResult> {
  // 1. Server generates replay-protected challenge
  const challenge: WalletChallenge = createWalletChallenge({
    domain,
    statement: "Sign to prove wallet control and access credential-gated transaction",
    ttlMs: 5 * 60 * 1000, // 5 minutes validity
  });

  // 2. Client signs challenge message with Ed25519 key (e.g. Freighter signMessage)
  const signatureBytes = walletKeypair.sign(Buffer.from(challenge.message));
  const signatureHex = Buffer.from(signatureBytes).toString("hex");

  // 3. Server atomically validates signature AND checks on-chain claim
  const result: VerifyWalletClaimResult = await verifyWalletClaim({
    wallet: walletKeypair.publicKey(),
    challenge,
    signature: signatureHex,
    claim,
  });

  return result;
}

// ─── 4. Credential-Gated Transaction Creation & Signing ──────────────────────

export interface GatedTransactionOptions {
  claimType?: ClaimType;
  claimOptions?: ClaimOptions;
  sequenceNumber?: string;
  networkPassphrase?: string;
  memoText?: string;
}

export interface GatedTransactionResult {
  signedXdr: string;
  transaction: Transaction;
  senderAddress: string;
  verifiedClaim: ClaimType;
}

/**
 * Create, gate, and sign a Stellar transaction.
 *
 * The transaction is ONLY created and signed if the sender wallet proves
 * the required credential on-chain via @stellarcred/sdk.
 *
 * @param senderKeypair - Sender Stellar Keypair (for signing)
 * @param destinationAddress - Target Stellar public key
 * @param amount - Amount of XLM to transfer (e.g. "25.0000000")
 * @param options - Additional gating and transaction parameters
 */
export async function createAndSignGatedPayment(
  senderKeypair: Keypair,
  destinationAddress: string,
  amount: string,
  options: GatedTransactionOptions = {}
): Promise<GatedTransactionResult> {
  const senderAddress = senderKeypair.publicKey();
  const requiredClaim = options.claimType ?? "kyc";
  const passphrase = options.networkPassphrase ?? Networks.TESTNET;

  // Step 1: Gate on verified credential via @stellarcred/sdk
  const isVerified = await hasClaim(senderAddress, requiredClaim, options.claimOptions);
  if (!isVerified) {
    throw new Error(
      `Credential gate failed: Wallet ${senderAddress} does not satisfy requirement "${requiredClaim}".`
    );
  }

  // Step 2: Construct the Stellar transaction using @stellar/stellar-sdk
  // In production, fetch current sequence number via horizon.loadAccount(senderAddress)
  const sequence = options.sequenceNumber ?? "1000";
  const sourceAccount = new Account(senderAddress, sequence);

  const builder = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.payment({
        destination: destinationAddress,
        asset: Asset.native(),
        amount,
      })
    )
    .setTimeout(60);

  if (options.memoText) {
    builder.addMemo(Memo.text(options.memoText));
  }

  const transaction = builder.build();

  // Step 3: Sign the transaction using the sender Keypair
  transaction.sign(senderKeypair);

  // Step 4: Return signed envelope XDR ready for submission or broadcasting
  const signedXdr = transaction.toXDR();

  return {
    signedXdr,
    transaction,
    senderAddress,
    verifiedClaim: requiredClaim,
  };
}

// ─── 5. Example Flow Demonstration ───────────────────────────────────────────

/**
 * Demonstrates the complete flow from configuration to signing with typed error handling.
 */
export async function runExample(): Promise<void> {
  console.log("=== StellarCred SDK TypeScript Example ===");

  // 1. Setup SDK
  initializeSdk();
  console.log("✓ SDK initialized with Soroban RPC endpoint");

  // 2. Generate sample sender & recipient keypairs for demonstration
  const sender = Keypair.random();
  const recipient = Keypair.random();
  console.log(`Sender Public Key:    ${sender.publicKey()}`);
  console.log(`Recipient Public Key: ${recipient.publicKey()}`);

  // 3. Issue and sign wallet challenge (demonstrates anti-spoofing flow)
  console.log("\n--- Step 1: Wallet Control Verification ---");
  const authResult = await proveAndVerifyWalletControl(sender, "kyc");
  console.log("Signature valid:", authResult.signatureValid);
  console.log("On-chain claim valid:", authResult.claimValid);

  // 4. Create and sign transaction with error handling
  console.log("\n--- Step 2: Credential-Gated Transaction Signing ---");
  try {
    const gatedResult = await createAndSignGatedPayment(
      sender,
      recipient.publicKey(),
      "10.0000000",
      {
        claimType: "kyc",
        claimOptions: { minThreshold: 50_000 },
      }
    );

    console.log("✓ Transaction successfully created and signed!");
    console.log(`Signed XDR: ${gatedResult.signedXdr.slice(0, 48)}...`);
  } catch (error) {
    if (error instanceof ContractError) {
      console.error(`Contract panic: [${error.code}] ${error.message}`);
    } else if (error instanceof RpcError) {
      console.error(`Soroban RPC error: ${error.message}`);
    } else if (error instanceof TimeoutError) {
      console.error(`Operation timed out: ${error.message}`);
    } else if (error instanceof InvalidAddressError) {
      console.error(`Invalid Stellar address provided: ${error.message}`);
    } else if (error instanceof Error) {
      console.log(`Expected gate result in demo environment: ${error.message}`);
    } else {
      console.error("Unknown error:", error);
    }
  }

  console.log("\n✓ TypeScript example completed successfully.");
}

// Execute if run directly
if (typeof process !== "undefined" && process.argv[1] && /index\.(ts|js)$/.test(process.argv[1])) {
  runExample().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

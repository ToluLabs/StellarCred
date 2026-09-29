/**
 * Wallet challenge generation, replay protection, and cryptographic claim verification.
 *
 * Implements Issue #543: Proves caller controls the wallet address before
 * checking on-chain claims, eliminating the wallet spoofing vulnerability where
 * an attacker passes someone else's verified address in return params or headers.
 */

import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import {
  hasClaim,
  getClaims,
  checkClaimStatus,
  type ClaimType,
  type ClaimOptions,
  type Claim,
  type CredentialFailureReason,
  type CredentialStatusResult,
} from "./claims";

/**
 * A challenge payload presented to a user's wallet for cryptographic signing.
 */
export interface WalletChallenge {
  /** Random cryptographic nonce preventing replay attacks. */
  nonce: string;
  /** Unix timestamp in milliseconds when the challenge was issued. */
  issuedAt: number;
  /** Unix timestamp in milliseconds after which this challenge is invalid. */
  expiresAt: number;
  /** The full textual statement that the user signs in their wallet prompt. */
  message: string;
  /** The domain or application requesting verification. */
  domain?: string;
  /** Optional statement describing the action being authorized. */
  statement?: string;
}

export interface CreateChallengeOptions {
  /**
   * The domain or identifier of the requesting application (e.g. "app.example.com").
   * Defaults to "stellarcred".
   */
  domain?: string;
  /**
   * Human-readable description of what the user is proving or accessing.
   * Defaults to "Prove ownership of your Stellar wallet to access gated services."
   */
  statement?: string;
  /**
   * Validity duration in milliseconds before the challenge expires.
   * Defaults to 5 minutes (300,000 ms).
   */
  ttlMs?: number;
}

/**
 * Storage interface for tracking challenge nonces to ensure single-use replay protection.
 */
export interface ChallengeStore {
  /** Save a newly issued challenge nonce and expiration. */
  save(nonce: string, expiresAt: number): void | Promise<void>;
  /**
   * Atomically consume a nonce. Returns true if the nonce was valid, fresh,
   * and unconsumed; false if it was already used, missing, or expired.
   */
  consume(nonce: string): boolean | Promise<boolean>;
}

/**
 * In-memory TTL challenge store with automatic expired nonce cleanup.
 */
export class MemoryChallengeStore implements ChallengeStore {
  private store = new Map<string, number>();

  save(nonce: string, expiresAt: number): void {
    this.cleanup();
    this.store.set(nonce, expiresAt);
  }

  consume(nonce: string): boolean {
    this.cleanup();
    const expiresAt = this.store.get(nonce);
    if (expiresAt === undefined) {
      return false; // Nonce not found or already consumed
    }
    this.store.delete(nonce); // Single-use consumption
    return Date.now() <= expiresAt;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.store.entries()) {
      if (now > expiresAt) {
        this.store.delete(nonce);
      }
    }
  }

  /** Visible for testing. */
  clear(): void {
    this.store.clear();
  }
}

/** Global default in-memory challenge store. */
export const defaultChallengeStore = new MemoryChallengeStore();

/**
 * Generates a cryptographically random, replay-protected wallet challenge.
 *
 * @example
 * ```ts
 * const challenge = createWalletChallenge({
 *   domain: "app.lendfi.com",
 *   statement: "Sign in to verify KYC credential on LendFi",
 * });
 * // Send challenge to client to sign with Freighter or wallet of choice.
 * ```
 */
export function createWalletChallenge(
  options: CreateChallengeOptions = {},
  store: ChallengeStore = defaultChallengeStore,
): WalletChallenge {
  const domain = options.domain ?? "stellarcred";
  const statement =
    options.statement ?? "Prove ownership of your Stellar wallet to access gated services.";
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;

  // Generate 16 bytes of entropy for nonce
  let nonce: string;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    nonce = crypto.randomUUID().replace(/-/g, "");
  } else {
    nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  const message = [
    `${domain} requests you sign this message to prove control of your Stellar account:`,
    "",
    `Statement: ${statement}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    `Expires At: ${new Date(expiresAt).toISOString()}`,
  ].join("\n");

  const challenge: WalletChallenge = {
    nonce,
    issuedAt,
    expiresAt,
    message,
    domain,
    statement,
  };

  void store.save(nonce, expiresAt);
  return challenge;
}

/**
 * Verifies a Stellar wallet Ed25519 signature over an arbitrary message or challenge string.
 */
export function verifyWalletSignature(
  wallet: string,
  message: string | Uint8Array,
  signature: string | Uint8Array,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(wallet);
    const msgBytes =
      typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);

    let sigBytes: Buffer;
    if (typeof signature === "string") {
      const clean = signature.trim();
      // 128 hex characters = 64 bytes Ed25519 signature
      if (/^[0-9a-fA-F]{128}$/.test(clean)) {
        sigBytes = Buffer.from(clean, "hex");
      } else {
        sigBytes = Buffer.from(clean, "base64");
      }
    } else {
      sigBytes = Buffer.from(signature);
    }

    return keypair.verify(msgBytes, sigBytes);
  } catch {
    return false;
  }
}

/** Parameters required for verifying a signed wallet challenge and on-chain claim. */
export interface VerifyWalletClaimParams {
  /** The Stellar wallet public key (G...) claiming access. */
  wallet: string;
  /** The challenge previously generated by `createWalletChallenge`. */
  challenge: WalletChallenge | { nonce: string; message: string; expiresAt?: number };
  /** The wallet's Ed25519 signature over `challenge.message` (hex, base64, or Uint8Array/Buffer). */
  signature: string | Uint8Array;
  /** The on-chain credential claim type to check (e.g. "kyc", "age", "funds"). */
  claim: ClaimType;
  /** Optional claim options (minThreshold, trustedIssuers, requestTimeoutMs). */
  claimOptions?: ClaimOptions;
  /** Optional custom challenge store for replay protection. Defaults to built-in store. */
  store?: ChallengeStore;
}

export type WalletClaimFailureReason =
  | "invalid_wallet"
  | "malformed_challenge"
  | "challenge_expired"
  | "challenge_replayed"
  | "invalid_signature"
  | "on_chain_error"
  | CredentialFailureReason;

/** Typed verification result combining signature verification and on-chain claim check. */
export interface VerifyWalletClaimResult {
  /** True if and only if BOTH signature verification AND on-chain claim check succeeded. */
  ok: boolean;
  /** The wallet address evaluated. */
  wallet: string;
  /** True if wallet signature over challenge was valid and challenge was fresh (not replayed/expired). */
  signatureValid: boolean;
  /** True if on-chain credential claim is valid, unrevoked, and meets threshold/trusted issuer constraints. */
  claimValid: boolean;
  /** The on-chain claim details if the claim was found on-chain. */
  claimDetails?: Claim | null;
  /** Detailed on-chain credential status if evaluated. */
  claimStatus?: CredentialStatusResult;
  /** Specific machine-readable failure reason if verification failed. */
  failureReason?: WalletClaimFailureReason;
  /** Human-readable explanation if verification failed. */
  error?: string;
}


/**
 * Verifies a wallet-signed challenge proving control of the address, then verifies
 * the specified credential claim on-chain, returning a single typed result.
 *
 * Prevents wallet spoofing attacks where an unauthorized party submits an address
 * that belongs to someone else who happens to have a valid on-chain claim.
 *
 * @example
 * ```ts
 * const result = await verifyWalletClaim({
 *   wallet: userWallet,
 *   challenge,
 *   signature: clientSignature,
 *   claim: "kyc",
 * });
 *
 * if (!result.ok) {
 *   return Response.json({ error: result.error }, { status: 403 });
 * }
 * // Access granted — caller proved control of wallet AND holds valid KYC proof.
 * ```
 */
export async function verifyWalletClaim(
  params: VerifyWalletClaimParams,
): Promise<VerifyWalletClaimResult> {
  const {
    wallet,
    challenge,
    signature,
    claim,
    claimOptions,
    store = defaultChallengeStore,
  } = params;

  if (!wallet || typeof wallet !== "string" || !wallet.startsWith("G") || wallet.length !== 56) {
    return {
      ok: false,
      wallet: wallet ?? "",
      signatureValid: false,
      claimValid: false,
      failureReason: "invalid_wallet",
      error: "Invalid Stellar wallet public address.",
    };
  }

  if (!challenge || !challenge.nonce || !challenge.message) {
    return {
      ok: false,
      wallet,
      signatureValid: false,
      claimValid: false,
      failureReason: "malformed_challenge",
      error: "Invalid or malformed challenge object.",
    };
  }

  // 1. Replay protection: consume the challenge nonce
  const fresh = await store.consume(challenge.nonce);
  if (!fresh) {
    return {
      ok: false,
      wallet,
      signatureValid: false,
      claimValid: false,
      failureReason: "challenge_replayed",
      error: "Challenge has expired or has already been used (replay attack prevented).",
    };
  }

  if (challenge.expiresAt && Date.now() > challenge.expiresAt) {
    return {
      ok: false,
      wallet,
      signatureValid: false,
      claimValid: false,
      failureReason: "challenge_expired",
      error: "Challenge has expired.",
    };
  }

  // 2. Cryptographic signature check (proof of wallet control)
  const signatureValid = verifyWalletSignature(wallet, challenge.message, signature);
  if (!signatureValid) {
    return {
      ok: false,
      wallet,
      signatureValid: false,
      claimValid: false,
      failureReason: "invalid_signature",
      error: "Invalid signature: caller does not control the claimed wallet address.",
    };
  }

  // 3. On-chain claim verification
  let claimValid = false;
  let claimDetails: Claim | null = null;
  let claimStatus: CredentialStatusResult | undefined = undefined;
  try {
    claimValid = await hasClaim(wallet, claim, claimOptions);
    if (claimValid) {
      const all = await getClaims(wallet);
      claimDetails = all.find((c) => c.type === claim) ?? {
        type: claim,
        verifiedAt: Math.floor(Date.now() / 1000),
        expiry: 0,
      };
      claimStatus = {
        valid: true,
        status: "verified",
        record: {
          verifiedAt: claimDetails.verifiedAt,
          expiry: claimDetails.expiry,
          revoked: false,
          threshold: claimOptions?.minThreshold,
          vkVersion: 1,
        },
      };
    } else {
      try {
        claimStatus = await checkClaimStatus(wallet, claim, claimOptions);
      } catch {
        // fail-soft
      }
    }
  } catch (e) {
    return {
      ok: false,
      wallet,
      signatureValid: true,
      claimValid: false,
      failureReason: "on_chain_error",
      error: `On-chain claim verification error: ${(e as Error).message}`,
    };
  }

  if (!claimValid) {
    const failureReason =
      claimStatus && claimStatus.status !== "verified"
        ? claimStatus.status
        : "not_verified";
    const detailMsg = claimStatus?.error ? ` (${claimStatus.error})` : "";
    return {
      ok: false,
      wallet,
      signatureValid: true,
      claimValid: false,
      claimStatus,
      failureReason,
      error: `Wallet does not possess an active on-chain '${claim}' credential.${detailMsg}`,
    };
  }

  return {
    ok: true,
    wallet,
    signatureValid: true,
    claimValid: true,
    claimDetails,
    claimStatus,
  };
}



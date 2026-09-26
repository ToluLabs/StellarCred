// @stellarcred/sdk
//
// A tiny, zero-dependency* read-only client for protocols integrating
// StellarCred. The only thing a protocol trusts is the on-chain
// ProofRegistry — there is no API key, no backend, and no personal data
// handling. `hasClaim` is the primary integration call.
//
// *Requires @stellar/stellar-sdk as a peer dependency.
//
// Quick start (Next.js / Vite / Node.js):
//
//   import StellarCred from "@stellarcred/sdk";
//
//   // Option A: configure explicitly at startup (recommended for servers)
//   StellarCred.configure({
//     registryId: process.env.PROOF_REGISTRY_ID,
//     rpcUrl: "https://soroban-testnet.stellar.org",
//   });
//
//   // Option B: set env vars instead (STELLARCRED_REGISTRY_ID, etc.)
//   //           — works in both Node.js and Next.js (NEXT_PUBLIC_* prefix)
//
//   const ok = await StellarCred.hasClaim(walletAddress, "kyc");

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

function env(key: string, nextPublicKey?: string): string {
  if (typeof process === "undefined") return "";
  return (
    (process.env as Record<string, string | undefined>)[key] ??
    (nextPublicKey
      ? ((process.env as Record<string, string | undefined>)[nextPublicKey] ?? "")
      : "")
  );
}

// ── Single network selector (Issue #408) ─────────────────────────────────────
// STELLARCRED_NETWORK / NEXT_PUBLIC_STELLAR_NETWORK (testnet | mainnet |
// futurenet) picks a coherent preset for RPC URL and network passphrase.
// Explicit URL/passphrase env vars override the preset.

type StellarNetwork = "testnet" | "mainnet" | "futurenet";

const NETWORK_PRESETS: Record<StellarNetwork, { rpcUrl: string; networkPassphrase: string }> = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    rpcUrl: "https://soroban.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
  futurenet: {
    rpcUrl: "https://soroban-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
  },
};

function parseNetwork(raw: string | undefined): StellarNetwork {
  const key = (raw ?? "").trim().toLowerCase();
  if (key === "public" || key === "main") return "mainnet";
  if (key === "testnet" || key === "mainnet" || key === "futurenet") return key;
  return "testnet";
}

const _preset = NETWORK_PRESETS[parseNetwork(env("STELLARCRED_NETWORK", "NEXT_PUBLIC_STELLAR_NETWORK"))];

let _config = {
  registryId: env("STELLARCRED_REGISTRY_ID", "NEXT_PUBLIC_PROOF_REGISTRY_ID"),
  rpcUrl: env("STELLARCRED_RPC_URL", "NEXT_PUBLIC_RPC_URL") || _preset.rpcUrl,
  networkPassphrase:
    env("STELLARCRED_NETWORK_PASSPHRASE", "NEXT_PUBLIC_NETWORK_PASSPHRASE") ||
    _preset.networkPassphrase,
  baseUrl: env("STELLARCRED_BASE_URL", "NEXT_PUBLIC_STELLARCRED_BASE_URL") || "https://stellarcred.xyz",
  requestTimeoutMs: 10_000,
  retries: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  jitter: true,
};

/**
 * Override SDK defaults at runtime. Call this once at app startup before any
 * `hasClaim` / `getClaims` calls. Each key is optional — omitted keys keep
 * their env-var-derived or default values.
 */
export function configure(opts: {
  registryId?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}): void {
  _config = { ..._config, ...opts };
  const sharedOpts: Parameters<typeof configureSharedClaims>[0] = {};
  if (opts.registryId !== undefined) sharedOpts.registryId = opts.registryId;
  if (opts.rpcUrl !== undefined) sharedOpts.rpcUrl = opts.rpcUrl;
  if (opts.networkPassphrase !== undefined) {
    sharedOpts.networkPassphrase = opts.networkPassphrase;
  }
  if (opts.baseUrl !== undefined) sharedOpts.baseUrl = opts.baseUrl;
  if (opts.requestTimeoutMs !== undefined) {
    sharedOpts.requestTimeoutMs = opts.requestTimeoutMs;
  }
  if (Object.keys(sharedOpts).length > 0) configureSharedClaims(sharedOpts);
  // The cached client is bound to the old config — drop it so the next read
  // rebuilds against the new one.
  _client = null;
  _clientKey = "";
}

/**
 * Reports which required configuration is present, without throwing.
 *
 * `registryId` is read from `STELLARCRED_REGISTRY_ID` / `NEXT_PUBLIC_PROOF_REGISTRY_ID`
 * (or {@link configure}) — if it is missing, every {@link hasClaim} /
 * {@link getClaims} call silently returns `false` / `[]` (via `getClient`
 * returning `null`) instead of throwing, so a misconfigured integration can
 * ship a gate that always denies access with no visible error. Call
 * `healthCheck()` (e.g. at app startup, or from a debug route) to diagnose
 * this before it surfaces as "nothing works."
 *
 * @example
 * const health = StellarCred.healthCheck();
 * if (!health.configured) console.error("StellarCred misconfigured:", health.missing);
 */
export function healthCheck(): {
  configured: boolean;
  registryId: boolean;
  rpcUrl: boolean;
  networkPassphrase: boolean;
  missing: Array<"registryId" | "rpcUrl" | "networkPassphrase">;
} {
  const registryId = !!_config.registryId;
  const rpcUrl = !!_config.rpcUrl;
  const networkPassphrase = !!_config.networkPassphrase;
  const missing: Array<"registryId" | "rpcUrl" | "networkPassphrase"> = [];
  if (!registryId) missing.push("registryId");
  if (!rpcUrl) missing.push("rpcUrl");
  if (!networkPassphrase) missing.push("networkPassphrase");
  return {
    configured: missing.length === 0,
    registryId,
    rpcUrl,
    networkPassphrase,
    missing,
  };
}

/**
 * Alias for `healthCheck().configured` — a quick boolean check for call
 * sites that don't need the detailed breakdown.
 */
export function isConfigured(): boolean {
  return healthCheck().configured;
}

// One-time (per missing-config state) dev warning — never logs in production
// builds, and never logs more than once for the same misconfiguration so it
// doesn't spam a polling caller like `watchClaim`.
let _warnedMissingRegistryId = false;
function warnIfMissingRegistryIdOnce(): void {
  if (_config.registryId) {
    _warnedMissingRegistryId = false; // config fixed at runtime — allow re-warning if it regresses
    return;
  }
  if (_warnedMissingRegistryId) return;
  const isDev =
    typeof process !== "undefined" &&
    (process.env as Record<string, string | undefined>)?.NODE_ENV !== "production";
  if (!isDev) return;
  _warnedMissingRegistryId = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[StellarCred] hasClaim()/getClaim()/getClaims() called with no `registryId` configured. " +
      "Every check will silently return false/[] until you set STELLARCRED_REGISTRY_ID " +
      "(or NEXT_PUBLIC_PROOF_REGISTRY_ID) or call StellarCred.configure({ registryId }). " +
      "Call StellarCred.healthCheck() to diagnose. This warning only logs in development.",
  );
}

// ---------------------------------------------------------------------------
// Types and Errors
// ---------------------------------------------------------------------------

/** Error thrown when watchClaim times out. */
export class TimeoutError extends Error {
  constructor(message = "Timeout waiting for claim") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Error thrown when the SDK is missing required configuration (e.g. no
 * `registryId`). Only surfaces when `{ throwOnError: true }` is passed;
 * the default fail-soft path returns `false` / `[]` instead.
 */
export class ConfigError extends Error {
  constructor(message = "StellarCred is not configured: missing registryId") {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Error thrown when a wallet address is empty or is not a valid Stellar
 * Ed25519 public key.
 *
 * In the default fail-soft path, public claim-read APIs return `false`, `null`,
 * or `[]` for an invalid address. Pass `{ throwOnError: true }` to `hasClaim`
 * / `getClaims` to surface this error to the caller.
 */
export class InvalidAddressError extends Error {
  constructor(message = "Invalid Stellar address") {
    super(message);
    this.name = "InvalidAddressError";
  }
}

/**
 * Error thrown when an RPC / contract-simulation call fails (network,
 * timeout at the transport layer, simulation error, etc.). Only surfaces
 * when `{ throwOnError: true }` is passed — distinguishing "couldn't check"
 * from "not verified" (`false`).
 */
export class RpcError extends Error {
  /** Underlying transport / simulation failure, when available. */
  cause?: unknown;
  constructor(message = "StellarCred RPC call failed", options?: { cause?: unknown }) {
    super(message);
    this.name = "RpcError";
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

/** The credential types StellarCred supports. Matches the contract Symbols. */
export const CLAIM_TYPES = ["kyc", "age", "income", "jurisdiction", "funds", "accreditation"] as const;
/**
 * Union type representing every supported StellarCred credential.
 *
 * @example
 * ```ts
 * const claim: ClaimType = "kyc";
 * ```
 */
export type ClaimType = (typeof CLAIM_TYPES)[number];

/**
 * Options accepted by {@link hasClaim} and {@link getClaims}.
 *
 * Currently only threshold-based claims use this; binary claims (e.g. `kyc`)
 * ignore the option. The on-chain `check_claim` enforces that the stored
 * threshold is at least `minThreshold`, so a proof generated with a higher
 * threshold always satisfies a lower `minThreshold`.
 */
export interface ClaimOptions {
  /**
   * Minimum acceptable threshold for parameterised claims:
   *   - `age`         → minimum age in years
   *   - `income`      → minimum annual income (whole units)
   *   - `funds`       → minimum liquid balance (whole units)
   *   - `accreditation` → minimum net-worth / income requirement (whole units)
   * Ignored for binary claims (`kyc`, `jurisdiction`).
   */
  minThreshold?: number;
  /**
   * Restrict which issuer(s) a proof must come from — e.g. accept `kyc` only
   * from Persona or Jumio, not a self-attested issuer. Pass the issuers'
   * Stellar addresses. Omit (or leave `undefined`) to accept a proof from any
   * registered issuer, matching the on-chain `check_claim`/`is_verified`
   * `trusted_issuers: None` default. An empty array rejects every issuer.
   */
  trustedIssuers?: string[];
  /**
   * Maximum time in milliseconds allowed for this read, including retries.
   * Defaults to the value passed to {@link configure}, or 10 seconds.
   */
  requestTimeoutMs?: number;
  /**
   * When `true`, configuration and RPC failures throw {@link ConfigError} /
   * {@link RpcError} instead of being masked as `false` / empty results.
   * Default `false` preserves the historical fail-soft behaviour so a
   * network blip is indistinguishable from "not verified" unless callers
   * opt in.
   */
  throwOnError?: boolean;
}

export interface Claim {
  /** Credential type — one of CLAIM_TYPES. */
  type: string;
  /** Unix timestamp (seconds) when the proof was submitted on-chain. */
  verifiedAt: number;
  /** Unix timestamp (seconds) when the on-chain record expires. */
  expiry: number;
}

// ---------------------------------------------------------------------------
// Low-level read: ProofRegistry.is_verified via simulation
// ---------------------------------------------------------------------------

import { Client as ProofRegistryClient } from "../../proof-registry/src/index";
import { configure as configureSharedClaims } from "./claims";

type StellarSDK = typeof import("@stellar/stellar-sdk");
let _sdk: Promise<StellarSDK> | null = null;
function getSdk(): Promise<StellarSDK> {
  if (!_sdk) _sdk = import("@stellar/stellar-sdk");
  return _sdk;
}

/**
 * Normalize and validate a wallet before any on-chain read.
 *
 * This is intentionally performed before `getClient()` so malformed input
 * cannot result in an RPC/client construction attempt.
 */
async function normalizeAndValidateWallet(wallet: string): Promise<string> {
  const normalized = wallet.trim();

  if (!normalized) {
    throw new InvalidAddressError("Invalid Stellar address: address is empty");
  }

  const { StrKey } = await getSdk();

  if (!StrKey.isValidEd25519PublicKey(normalized)) {
    throw new InvalidAddressError("Invalid Stellar address");
  }

  return normalized;
}

// The client is stateless per config, so one instance is shared across every
// read. Cached as a promise so a fan-out of concurrent reads (see `fanOut`)
// awaits a single construction instead of racing to build N clients.
let _client: Promise<ProofRegistryClient> | null = null;
let _clientKey = "";

async function getClient(throwOnError = false): Promise<ProofRegistryClient | null> {
  const { registryId, rpcUrl, networkPassphrase } = _config;
  if (!registryId) {
    if (throwOnError) {
      throw new ConfigError("StellarCred is not configured: missing registryId");
    }
    return null;
  }

  const key = `${registryId}|${rpcUrl}|${networkPassphrase}`;
  if (_client && _clientKey === key) return _client;

  _clientKey = key;
  _client = getSdk().then(
    () =>
      new ProofRegistryClient({
        networkPassphrase,
        contractId: registryId,
        rpcUrl,
        allowHttp: rpcUrl.startsWith("http://"),
      }),
  );
  // Don't cache a failed SDK import — the next read should retry. `_sdk` holds
  // the import promise itself, so it has to be cleared too: leaving a rejected
  // promise there would make every later `getClient()` fail on the same
  // rejection instead of re-attempting the import.
  _client.catch(() => {
    _sdk = null;
    _client = null;
    _clientKey = "";
  });
  return _client;
}

/**
 * Runs `fn` over `items` concurrently after priming the shared client, so a
 * multi-claim read builds one `ProofRegistryClient` rather than one per item.
 */
async function fanOut<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  // Priming is an optimisation only — if it fails, each read falls back to its
  // own `getClient()` call and its own error handling.
  await getClient().catch(() => null);
  return Promise.all(items.map(fn));
}

function isRetryable(error: any): boolean {
  if (error && typeof error.message === "string") {
    const msg = error.message.toLowerCase();
    // Non-retryable errors (e.g., bad args, 400 Bad Request, parsing errors)
    if (
      msg.includes("invalid argument") ||
      msg.includes("bad request") ||
      msg.includes("not found") ||
      msg.includes("parse error")
    ) {
      return false;
    }
  }
  return true;
}

class ReadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`RPC read timed out after ${timeoutMs}ms`);
    this.name = "ReadTimeoutError";
  }
}

function withRequestTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new ReadTimeoutError(timeoutMs)), timeoutMs);
  });

  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() =>
    clearTimeout(timeoutId),
  );
}

export async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  const { retries, baseDelayMs, maxDelayMs, jitter } = _config;
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error: any) {
      if (attempt >= retries || !isRetryable(error)) {
        throw error;
      }
      attempt++;
      let delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      if (jitter) {
        delay = delay / 2 + Math.random() * (delay / 2);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function readIsVerified(
  wallet: string,
  claimType: string,
  trustedIssuers?: string[],
  throwOnError = false,
  requestTimeoutMs = _config.requestTimeoutMs,
): Promise<{ valid: boolean; verifiedAt: number; expiry: number } | null> {
  const client = await getClient(throwOnError);
  if (!client) return null;

  try {
    const { result } = await withRequestTimeout(
      () =>
        withRetry(() =>
          client.is_verified({
            holder: wallet,
            credential_type: claimType,
            trusted_issuers: trustedIssuers,
          }),
        ),
      requestTimeoutMs,
    );
    if (!result) return null;
    const [valid, verifiedAt, expiry] = result;
    return { valid, verifiedAt: Number(verifiedAt), expiry: Number(expiry) };
  } catch (err) {
    if (throwOnError) {
      throw new RpcError(`is_verified RPC failed for claim "${claimType}"`, { cause: err });
    }
    return null;
  }
}

async function readCheckClaim(
  wallet: string,
  claimType: string,
  minThreshold: number,
  trustedIssuers?: string[],
  throwOnError = false,
  requestTimeoutMs = _config.requestTimeoutMs,
): Promise<boolean> {
  const client = await getClient(throwOnError);
  if (!client) return false;

  try {
    const { result } = await withRequestTimeout(
      () =>
        withRetry(() =>
          client.check_claim({
            holder: wallet,
            credential_type: claimType,
            min_threshold: BigInt(minThreshold),
            trusted_issuers: trustedIssuers,
          }),
        ),
      requestTimeoutMs,
    );
    return result ?? false;
  } catch (err) {
    if (throwOnError) {
      throw new RpcError(`check_claim RPC failed for claim "${claimType}"`, { cause: err });
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `wallet` has a currently-valid, unexpired proof of
 * `claimType` in the StellarCred ProofRegistry.
 *
 * For parameterised claim types (age, income, funds), pass `minThreshold` to
 * enforce that the proof was generated with at least that threshold — e.g. a
 * proof for "balance ≥ 200,000" satisfies `minThreshold: 50000`, but a proof
 * for "balance ≥ 10,000" does not. The check is performed on-chain and is
 * fully trustless.
 *
 * @example
 * // Binary claim — no threshold needed
 * const ok = await hasClaim("G1ABC…", "kyc");
 *
 * @example
 * // Funds gate — require balance ≥ $50,000
 * const ok = await hasClaim("G1ABC…", "funds", { minThreshold: 50000 });
 *
 * @example
 * // Age gate — require age ≥ 21
 * const ok = await hasClaim("G1ABC…", "age", { minThreshold: 21 });
 *
 * @example
 * // Only accept KYC from specific issuers, e.g. Persona or Jumio
 * const ok = await hasClaim("G1ABC…", "kyc", {
 *   trustedIssuers: ["G...PERSONA_ISSUER", "G...JUMIO_ISSUER"],
 * });
 *
 * @example
 * // Opt into typed errors — invalid wallets throw InvalidAddressError,
 * // network failure throws RpcError, missing registryId throws ConfigError;
 * // "not verified" still returns false.
 * try {
 *   const ok = await hasClaim("G1ABC…", "kyc", { throwOnError: true });
 * } catch (err) {
 *   if (err instanceof ConfigError) {
 *     // misconfigured SDK — set registryId
 *   }
 *   if (err instanceof RpcError) {
 *     // could not reach the chain — retry or degrade
 *   }
 * }
 */
export async function hasClaim(
  wallet: string,
  claimType: string,
  opts?: ClaimOptions,
): Promise<boolean> {
  warnIfMissingRegistryIdOnce();
  const throwOnError = opts?.throwOnError === true;

  let normalizedWallet: string;
  try {
    normalizedWallet = await normalizeAndValidateWallet(wallet);
  } catch (err) {
    if (err instanceof InvalidAddressError) {
      if (throwOnError) throw err;
      return false;
    }
    // Loading the Stellar SDK itself failed. Treat this like the existing
    // fail-soft/RPC path rather than misclassifying it as invalid input.
    if (throwOnError) {
      throw new RpcError("Failed to validate Stellar address", { cause: err });
    }
    return false;
  }

  if (opts?.minThreshold !== undefined) {
    return readCheckClaim(
      normalizedWallet,
      claimType,
      opts.minThreshold,
      opts.trustedIssuers,
      throwOnError,
      opts.requestTimeoutMs,
    );
  }

  const r = await readIsVerified(
    normalizedWallet,
    claimType,
    opts?.trustedIssuers,
    throwOnError,
    opts?.requestTimeoutMs,
  );
  return !!r && r.valid;
}

/**
 * Returns the full claim record (valid, verifiedAt, expiry) for a wallet and
 * credential type, or `null` if the wallet has no current proof of that type.
 *
 * Unlike {@link hasClaim} which only returns a boolean, this gives UIs the
 * verified-at timestamp and expiry so they can show claim freshness without
 * pulling every claim type via {@link getClaims}.
 *
 * Respects `trustedIssuers` — only proofs from the given issuers are accepted.
 *
 * @example
 * const claim = await getClaim("G1ABC…", "kyc");
 * if (claim) {
 *   console.log(`Verified at: ${new Date(claim.verifiedAt * 1000)}`);
 *   console.log(`Expires: ${new Date(claim.expiry * 1000)}`);
 * }
 *
 * @example
 * // Only accept KYC from a trusted issuer
 * const claim = await getClaim("G1ABC…", "kyc", {
 *   trustedIssuers: ["G...PERSONA_ISSUER"],
 * });
 */
export async function getClaim(
  wallet: string,
  claimType: string,
  opts?: Pick<ClaimOptions, "trustedIssuers" | "requestTimeoutMs">,
): Promise<{ valid: boolean; verifiedAt: number; expiry: number } | null> {
  warnIfMissingRegistryIdOnce();

  let normalizedWallet: string;
  try {
    normalizedWallet = await normalizeAndValidateWallet(wallet);
  } catch {
    return null;
  }

  const r = await readIsVerified(
    normalizedWallet,
    claimType,
    opts?.trustedIssuers,
    false,
    opts?.requestTimeoutMs,
  );
  return r && r.valid ? r : null;
}

/**
 * Options accepted by {@link hasClaims}.
 *
 * Mirrors {@link ClaimOptions}, except the threshold is per claim type so one
 * batched call can gate on several parameterised claims at once.
 */
export interface BatchClaimOptions {
  /**
   * Per-type minimum thresholds, e.g. `{ age: 21, funds: 50000 }`. A type with
   * no entry here is checked as a binary claim (`is_verified`), exactly as
   * {@link hasClaim} does when `minThreshold` is omitted.
   */
  minThresholds?: Partial<Record<ClaimType, number>>;
  /**
   * Restrict which issuer(s) every proof in this batch must come from. Same
   * semantics as {@link ClaimOptions.trustedIssuers} — omit to accept any
   * registered issuer, pass an empty array to reject every issuer.
   */
  trustedIssuers?: string[];
  /** Maximum time in milliseconds allowed for each read. */
  requestTimeoutMs?: number;
}

/**
 * Batched form of {@link hasClaim}: checks several claim types for one wallet
 * in a single fan-out that shares one `ProofRegistryClient`, instead of the
 * caller issuing N independent `hasClaim` calls.
 *
 * Each type resolves independently — a read that fails (RPC error, missing
 * config) resolves to `false` for that type rather than rejecting the whole
 * batch. Duplicate types in `types` are read once and appear once in the
 * result. The returned record contains a key for every requested type.
 *
 * @param wallet Stellar address to check.
 * @param types Claim types to read.
 * @param opts Per-type thresholds and issuer restrictions.
 *
 * @example
 * // Gate on three claims at once
 * const claims = await hasClaims("G1ABC…", ["kyc", "age", "funds"], {
 *   minThresholds: { age: 21, funds: 50000 },
 * });
 * if (claims.kyc && claims.age) grantAccess();
 */
export async function hasClaims(
  wallet: string,
  types: readonly ClaimType[],
  opts?: BatchClaimOptions,
): Promise<Partial<Record<ClaimType, boolean>>> {
  warnIfMissingRegistryIdOnce();

  const unique = Array.from(new Set(types));
  const results: Partial<Record<ClaimType, boolean>> = {};

  let normalizedWallet: string;
  try {
    normalizedWallet = await normalizeAndValidateWallet(wallet);
  } catch {
    // Preserve the fail-soft batch contract: each requested type is false,
    // and importantly no client/RPC read is attempted.
    for (const type of unique) {
      results[type] = false;
    }
    return results;
  }

  await fanOut(unique, async (t) => {
    try {
      const minThreshold = opts?.minThresholds?.[t];
      if (minThreshold !== undefined) {
        results[t] = await readCheckClaim(
          normalizedWallet,
          t,
          minThreshold,
          opts?.trustedIssuers,
          false,
          opts?.requestTimeoutMs,
        );
        return;
      }
      const r = await readIsVerified(
        normalizedWallet,
        t,
        opts?.trustedIssuers,
        false,
        opts?.requestTimeoutMs,
      );
      results[t] = !!r && r.valid;
    } catch {
      results[t] = false;
    }
  });

  return results;
}

/** One claim type + optional minimum threshold within a selective-disclosure preset (#386). */
export interface PresetClaim {
  type: ClaimType;
  /** Same semantics as {@link ClaimOptions.minThreshold} — omit for a binary claim. */
  minThreshold?: number;
}

/** Result of {@link verifyPreset}. */
export interface PresetVerificationResult {
  /** Per-type pass/fail, same shape {@link hasClaims} returns. */
  results: Partial<Record<ClaimType, boolean>>;
  /** True only if every claim in the preset passed. */
  allValid: boolean;
}

/**
 * Verifies every claim in a selective-disclosure preset — a holder-defined,
 * shareable bundle like "Investor onboarding" (kyc + accreditation +
 * jurisdiction) — against one wallet in a single batched call.
 *
 * This is a thin wrapper over {@link hasClaims}: presets themselves are not
 * an on-chain concept (there is no preset registry), they're just a named,
 * shareable list of `(type, minThreshold)` pairs a holder defines and a
 * protocol requests out-of-band (e.g. via the deep link/QR the holder page
 * generates) — verification is still exactly the same trustless on-chain
 * `ProofRegistry` read every other claim check in this SDK uses.
 *
 * @example
 * const { allValid, results } = await verifyPreset("G1ABC…", [
 *   { type: "kyc" },
 *   { type: "accreditation", minThreshold: 1_000_000 },
 * ]);
 * if (allValid) grantAccess();
 */
export async function verifyPreset(
  wallet: string,
  claims: readonly PresetClaim[],
  opts?: Pick<BatchClaimOptions, "trustedIssuers" | "requestTimeoutMs">,
): Promise<PresetVerificationResult> {
  const types = claims.map((c) => c.type);
  const minThresholds: Partial<Record<ClaimType, number>> = {};
  for (const c of claims) {
    if (c.minThreshold !== undefined) minThresholds[c.type] = c.minThreshold;
  }

  const results = await hasClaims(wallet, types, {
    minThresholds,
    trustedIssuers: opts?.trustedIssuers,
    requestTimeoutMs: opts?.requestTimeoutMs,
  });
  const allValid = types.length > 0 && types.every((t) => results[t] === true);
  return { results, allValid };
}

/**
 * Returns every active claim a wallet has proven, across all known credential
 * types. Useful for profile pages and protocol dashboards.
 *
 * Uses the same batched fan-out as {@link hasClaims}, so all types are read
 * through one shared client.
 *
 * Pass `{ throwOnError: true }` to surface {@link InvalidAddressError},
 * {@link ConfigError} / {@link RpcError} instead of silently dropping failed
 * reads. When `throwOnError` is set, a single failing claim type rejects the
 * whole batch (fail-fast) and discards successful reads for other types.
 */
export async function getClaims(
  wallet: string,
  opts?: Pick<ClaimOptions, "throwOnError" | "requestTimeoutMs">,
): Promise<Claim[]> {
  warnIfMissingRegistryIdOnce();
  const throwOnError = opts?.throwOnError === true;

  let normalizedWallet: string;
  try {
    normalizedWallet = await normalizeAndValidateWallet(wallet);
  } catch (err) {
    if (err instanceof InvalidAddressError) {
      if (throwOnError) throw err;
      return [];
    }
    if (throwOnError) {
      throw new RpcError("Failed to validate Stellar address", { cause: err });
    }
    return [];
  }

  const results = await fanOut(CLAIM_TYPES, async (t) => {
    // Same isolation as `hasClaims` when fail-soft: `readIsVerified` swallows
    // read errors, but its own `getClient()` await can still reject (a failed
    // SDK import), which would otherwise reject the whole fan-out.
    try {
      const r = await readIsVerified(
        normalizedWallet,
        t,
        undefined,
        throwOnError,
        opts?.requestTimeoutMs,
      );
      return r && r.valid ? { type: t, verifiedAt: r.verifiedAt, expiry: r.expiry } : null;
    } catch (err) {
      if (throwOnError) throw err;
      return null;
    }
  });
  return results.filter((x): x is NonNullable<typeof x> => x !== null);
}

/**
 * Build a StellarCred verification URL to redirect users to. After the user
 * verifies, StellarCred sends them back to `returnUrl` with `sc_verified=true`,
 * `sc_wallet=<address>`, and `sc_claims=<comma-separated-types>` appended as
 * query params. `sc_claims` contains only the claim types issued in the current
 * session (not all-time claims).
 *
 * Pass `claimParams` to customize thresholds for parameterised claims:
 *
 * @example
 * // Require age ≥ 21
 * buildVerifyUrl({ returnUrl: "/deposit", claim: "age", claimParams: { threshold_years: "21" } })
 *
 * @example
 * // Require balance > $50,000
 * buildVerifyUrl({ returnUrl: "/vault", claim: "funds", claimParams: { threshold: "50000" } })
 *
 * @example
 * // Restrict specific countries
 * buildVerifyUrl({ returnUrl: "/app", claim: "jurisdiction", claimParams: { restricted: ["840","364"] } })
 */
export function buildVerifyUrl(options: {
  returnUrl: string;
  claim: string;
  /** Override the StellarCred base URL (defaults to config or https://stellarcred.xyz). */
  baseUrl?: string;
  claimParams?: {
    /** For "age" claims: minimum age in years (default "18"). */
    threshold_years?: string;
    /** For "income" / "funds" claims: minimum value in whole units (default varies). */
    threshold?: string;
    /** For "jurisdiction" claims: ISO 3166-1 numeric codes (default []). */
    restricted?: string | string[];
    /** For "jurisdiction" claims: "block" = denylist (default), "allow" = allowlist. */
    mode?: "allow" | "block";
  };
  /**
   * Opaque CSRF-style correlation token (e.g. a per-session nonce). Embedded
   * into `returnUrl` as `sc_state` and round-tripped back on the redirect —
   * use it to confirm the return matches a session *you* started. This is a
   * correlation aid only, not a substitute for the on-chain `hasClaim` check:
   * see {@link parseReturnParams} for the full trust model.
   */
  state?: string;
}): string {
  const base = options.baseUrl ?? _config.baseUrl;
  const url = new URL("/verify", base);

  let returnUrl = options.returnUrl;
  if (options.state !== undefined) {
    // Merge into returnUrl's own query string so it round-trips through the
    // verify flow untouched, with no server-side change required — the verify
    // page forwards return_url's existing query params as-is.
    const returnUrlBase =
      typeof window !== "undefined" ? window.location.origin : (base ?? "https://stellarcred.xyz");
    const returnUrlObj = returnUrl.startsWith("/")
      ? new URL(returnUrl, returnUrlBase)
      : new URL(returnUrl);
    returnUrlObj.searchParams.set("sc_state", options.state);
    returnUrl = returnUrl.startsWith("/") ? returnUrlObj.pathname + returnUrlObj.search : returnUrlObj.toString();
  }

  url.searchParams.set("return_url", returnUrl);
  url.searchParams.set("claim", options.claim);
  if (options.claimParams) {
    const { threshold_years, threshold, restricted, mode } = options.claimParams;
    if (threshold_years) url.searchParams.set("threshold_years", threshold_years);
    if (threshold) url.searchParams.set("threshold", threshold);
    if (restricted) {
      url.searchParams.set("restricted", Array.isArray(restricted) ? restricted.join(",") : restricted);
    }
    if (mode) {
      url.searchParams.set("mode", mode === "allow" ? "1" : "0");
    }
  }
  return url.toString();
}

/**
 * Build a shareable embed URL for the StellarCred public verification badge.
 *
 * @example
 * const url = buildBadgeUrl({
 *   wallet: "G1ABC…",
 *   claim: "kyc",
 *   theme: "dark",
 * });
 */
export function buildBadgeUrl(options: {
  wallet: string;
  claim: string;
  theme?: "dark" | "light" | "auto";
  compact?: boolean;
  baseUrl?: string;
}): string {
  const base = options.baseUrl ?? _config.baseUrl;
  const url = new URL("/badge", base);
  url.searchParams.set("wallet", options.wallet);
  url.searchParams.set("claim", options.claim);
  if (options.theme && options.theme !== "auto") {
    url.searchParams.set("theme", options.theme);
  }
  if (options.compact) {
    url.searchParams.set("compact", "1");
  }
  return url.toString();
}

/**
 * Generate an HTML <iframe> embed code snippet for the verification badge.
 */
export function buildBadgeEmbedCode(options: {
  wallet: string;
  claim: string;
  theme?: "dark" | "light" | "auto";
  compact?: boolean;
  baseUrl?: string;
}): string {
  const src = buildBadgeUrl(options);
  const width = options.compact ? "180" : "260";
  const height = options.compact ? "36" : "54";
  return `<iframe src="${src}" width="${width}" height="${height}" frameborder="0" scrolling="no" style="border:none;overflow:hidden;border-radius:8px;" title="StellarCred Verification Badge"></iframe>`;
}

// ---------------------------------------------------------------------------
// Return-URL params — untrusted hints only (Issue #213)
// ---------------------------------------------------------------------------

/**
 * The query params StellarCred appends to `returnUrl` after the verify flow
 * completes: `sc_verified=true`, `sc_wallet=<address>`, and an optional
 * `sc_claims=<comma-separated-types>` (only the claim types issued in the
 * current session — see {@link buildVerifyUrl}). `sc_state` round-trips
 * whatever correlation token was passed to `buildVerifyUrl`'s `state` option.
 *
 * **These are untrusted hints, not a proof.** Nothing binds this redirect to
 * a specific session — a URL shaped exactly like this one can be
 * hand-crafted by anyone and pasted into a browser; StellarCred does not
 * sign or otherwise authenticate this redirect. `sc_state`, if you set one,
 * only tells you the redirect correlates with a session *you* started — it
 * does not tell you the claims are real. The one thing that IS trustless is
 * the on-chain ProofRegistry itself: **always call {@link hasClaim} (server
 * side, for the real wallet address you intend to gate) before granting
 * access**, using these params only to decide which wallet/claim to check
 * and to render optimistic UI while that check is in flight.
 *
 * @example
 * const hint = parseReturnParams(window.location.href);
 * if (hint.verified && hint.wallet) {
 *   // Optimistic UI only — the real gate is the server-side check below.
 *   const reallyVerified = await hasClaim(hint.wallet, "kyc");
 * }
 */
export interface UntrustedReturnParams {
  /** `true` if `sc_verified=true` was present. Untrusted — see interface doc. */
  verified: boolean;
  /** The wallet address the redirect claims verified. Untrusted — re-check with `hasClaim`. */
  wallet: string | null;
  /** Claim types the redirect claims were just issued. Untrusted — re-check with `hasClaim`. */
  claims: string[];
  /** The `state` token passed to `buildVerifyUrl`, if any — for session correlation only. */
  state: string | null;
}

/**
 * Extracts `sc_verified` / `sc_wallet` / `sc_claims` / `sc_state` from a
 * return-URL, typed as {@link UntrustedReturnParams} to make the trust model
 * explicit at the call site. See that type's TSDoc for why these values MUST
 * be re-verified with {@link hasClaim} before granting access.
 *
 * Accepts a full URL string, a relative URL (`pathname?search`), or a
 * `URLSearchParams`/`URL` instance directly.
 */
export function parseReturnParams(url: string | URL | URLSearchParams): UntrustedReturnParams {
  const params =
    url instanceof URLSearchParams
      ? url
      : new URL(url instanceof URL ? url.toString() : url, "http://localhost").searchParams;

  const claimsParam = params.get("sc_claims");
  return {
    verified: params.get("sc_verified") === "true",
    wallet: params.get("sc_wallet"),
    claims: claimsParam ? claimsParam.split(",").filter(Boolean) : [],
    state: params.get("sc_state"),
  };
}

/**
 * Options for `watchClaim`.
 */
export interface WatchClaimOptions {
  /** How often to poll in milliseconds (default: 3000) */
  pollMs?: number;
  /** How long to wait before timing out in milliseconds (default: 120000) */
  timeoutMs?: number;
  /** For parameterised claims (e.g. age, funds), minimum threshold to require */
  minThreshold?: number;
  /** Maximum time in milliseconds allowed for each poll read. */
  requestTimeoutMs?: number;
}

export interface WatchClaimCallbackOptions extends WatchClaimOptions {
  /** Callback fired whenever the verification status changes from false to true or vice-versa */
  onChange: (verified: boolean) => void;
}

/**
 * Polls for a claim to become verified.
 * 
 * In Promise form (without `onChange`), it resolves `true` when the claim is verified,
 * or rejects with `TimeoutError` after `timeoutMs`.
 */
export function watchClaim(
  wallet: string,
  claimType: string,
  opts?: WatchClaimOptions,
): Promise<boolean>;

/**
 * Polls for a claim to become verified.
 * 
 * In Callback form (with `onChange`), it fires the callback whenever the status changes
 * (e.g. from false to true). Returns a `stop` function to cancel polling.
 */
export function watchClaim(
  wallet: string,
  claimType: string,
  opts: WatchClaimCallbackOptions,
): () => void;

export function watchClaim(
  wallet: string,
  claimType: string,
  opts?: WatchClaimOptions | WatchClaimCallbackOptions,
): Promise<boolean> | (() => void) {
  const pollMs = opts?.pollMs ?? 3000;
  const timeoutMs = opts?.timeoutMs ?? 120000;
  const minThreshold = opts?.minThreshold;
  const onChange = (opts as WatchClaimCallbackOptions)?.onChange;

  let intervalId: ReturnType<typeof setInterval>;
  let timeoutId: ReturnType<typeof setTimeout>;
  let isStopped = false;
  let lastState = false;
  // Ensure we don't have overlapping polls if `hasClaim` is slow
  let isPolling = false;

  const stop = () => {
    isStopped = true;
    clearInterval(intervalId);
    clearTimeout(timeoutId);
  };

  if (onChange) {
    const poll = async () => {
      if (isStopped || isPolling) return;
      isPolling = true;
      try {
        const verified = await hasClaim(wallet, claimType, {
          minThreshold,
          requestTimeoutMs: opts?.requestTimeoutMs,
        });
        if (isStopped) return;
        if (verified !== lastState) {
          lastState = verified;
          onChange(verified);
        }
      } finally {
        isPolling = false;
      }
    };

    intervalId = setInterval(poll, pollMs);
    timeoutId = setTimeout(stop, timeoutMs);
    poll(); // Initial check
    return stop;
  } else {
    return new Promise((resolve, reject) => {
      const poll = async () => {
        if (isStopped || isPolling) return;
        isPolling = true;
        try {
          const verified = await hasClaim(wallet, claimType, {
            minThreshold,
            requestTimeoutMs: opts?.requestTimeoutMs,
          });
          if (isStopped) return;
          if (verified) {
            stop();
            resolve(true);
          }
        } finally {
          isPolling = false;
        }
      };

      intervalId = setInterval(poll, pollMs);
      timeoutId = setTimeout(() => {
        stop();
        reject(new TimeoutError());
      }, timeoutMs);
      poll(); // Initial check
    });
  }
}

// ---------------------------------------------------------------------------
// Namespace export (StellarCred.hasClaim / StellarCred.getClaims / etc.)
// ---------------------------------------------------------------------------

export const StellarCred = {
  configure,
  healthCheck,
  isConfigured,
  hasClaim,
  getClaim,
  hasClaims,
  getClaims,
  verifyPreset,
  buildVerifyUrl,
  buildBadgeUrl,
  buildBadgeEmbedCode,
  parseReturnParams,
  watchClaim,
  CLAIM_TYPES,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
  RpcError,
};
export default StellarCred;

// Framework-agnostic core — for use outside React (Vue, Svelte, vanilla).
export { createClaimGate } from "./core";
export type { ClaimGateConfig, ClaimGateState, ClaimGateListener, ClaimGate } from "./core";

// React hook — React wrapper around the batched `hasClaims` read. It is an
// independent implementation from `createClaimGate` (which performs per-claim
// `hasClaim` reads), so keep the two behaviourally in sync.
export { useStellarCred } from "./react";
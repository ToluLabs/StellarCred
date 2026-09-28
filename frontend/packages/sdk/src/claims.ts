// @stellarcred/sdk — shared claim-checking core
//
// Authoritative module holding the complete claim-checking machinery:
// config, low-level ProofRegistry reads, and the public functions
// (`hasClaim`, `hasClaims`, `getClaim`, `getClaims`, `verifyPreset`, `watchClaim`)
// plus all associated types and error classes.
//
// `index.ts`, `core.ts`, `react.ts`, `server.ts`, and `challenge.ts` all import
// from here, so nothing in this module imports back from those files — keeping
// the module graph acyclic.

import { Client as ProofRegistryClient } from "../../proof-registry/src/index";

// ---------------------------------------------------------------------------
// Runtime environment detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the SDK is running in a browser (or browser-like) context.
 * Used only for development-mode boundary warnings — never throws.
 */
function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/**
 * Returns true when the current process is running in development mode.
 * Recognises the conventional NODE_ENV values used by Next.js, Vite, CRA,
 * and bare Node.js scripts. Always returns false when `process` is undefined
 * (e.g. a plain browser bundle without an env shim).
 */
function isDev(): boolean {
  if (typeof process === "undefined") return false;
  const nodeEnv = (process.env as Record<string, string | undefined>).NODE_ENV;
  return nodeEnv !== "production";
}

/**
 * Fires a one-time `console.warn` when `configure()` is called from a browser
 * context with values that look like they came from server-only environment
 * variables (i.e. variables that are never injected into browser bundles by
 * Next.js / Vite / CRA because they lack the `NEXT_PUBLIC_` / `VITE_` prefix).
 */
let _warnedBoundaryViolation = false;

/**
 * @internal — test-only hook to reset the one-shot boundary violation flag
 * between test cases. Not part of the public API.
 */
export function __resetBoundaryWarningForTesting(): void {
  _warnedBoundaryViolation = false;
}

function warnOnClientServerBoundaryViolation(opts: {
  registryId?: string;
  rpcUrl?: string;
}): void {
  if (!isBrowser()) return;
  if (!isDev()) return;
  if (_warnedBoundaryViolation) return;

  const proc =
    typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined>)
      : {};

  const leakedServerVar =
    !!proc["STELLARCRED_REGISTRY_ID"] ||
    !!proc["STELLARCRED_RPC_URL"] ||
    !!proc["STELLARCRED_NETWORK_PASSPHRASE"] ||
    !!proc["STELLARCRED_BASE_URL"] ||
    !!proc["STELLARCRED_NETWORK"];

  const serverEnvRegistryId =
    proc["STELLARCRED_REGISTRY_ID"] ?? proc["PROOF_REGISTRY_ID"];
  const serverEnvRpcUrl = proc["STELLARCRED_RPC_URL"];
  const configMatchesServerVar =
    (opts.registryId !== undefined &&
      opts.registryId !== "" &&
      opts.registryId === serverEnvRegistryId) ||
    (opts.rpcUrl !== undefined &&
      opts.rpcUrl !== "" &&
      opts.rpcUrl === serverEnvRpcUrl);

  if (!leakedServerVar && !configMatchesServerVar) return;

  _warnedBoundaryViolation = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[StellarCred] configure() was called in a browser context with values that " +
      "appear to come from server-only environment variables (e.g. STELLARCRED_REGISTRY_ID " +
      "or PROOF_REGISTRY_ID without the NEXT_PUBLIC_ prefix).\n\n" +
      "The ProofRegistry contract ID and RPC URL are read-only infrastructure config " +
      "that is safe to expose to the client — but they must reach the browser through " +
      "public env vars (NEXT_PUBLIC_PROOF_REGISTRY_ID / NEXT_PUBLIC_RPC_URL in Next.js, " +
      "VITE_* in Vite) rather than server-only names.\n\n" +
      "If you are verifying claims server-side (recommended for access control), " +
      "import from '@stellarcred/sdk/server' instead — the intent is explicit at " +
      "the import site and this warning will not fire.\n\n" +
      "See the SDK README §Trust boundary for details. " +
      "This warning only appears in development mode.",
  );
}

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

// Single network selector (Issue #408)
export type StellarNetwork = "testnet" | "mainnet" | "futurenet";

export const NETWORK_PRESETS: Record<
  StellarNetwork,
  { rpcUrl: string; networkPassphrase: string }
> = {
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

const _preset =
  NETWORK_PRESETS[
    parseNetwork(env("STELLARCRED_NETWORK", "NEXT_PUBLIC_STELLAR_NETWORK"))
  ];

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

export interface SDKConfig {
  registryId?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

const DEFAULT_CONFIG: Required<SDKConfig> = {
  registryId: env("STELLARCRED_REGISTRY_ID", "NEXT_PUBLIC_PROOF_REGISTRY_ID"),
  rpcUrl: env("STELLARCRED_RPC_URL", "NEXT_PUBLIC_RPC_URL") || _preset.rpcUrl,
  networkPassphrase:
    env("STELLARCRED_NETWORK_PASSPHRASE", "NEXT_PUBLIC_NETWORK_PASSPHRASE") ||
    _preset.networkPassphrase,
  baseUrl:
    env("STELLARCRED_BASE_URL", "NEXT_PUBLIC_STELLARCRED_BASE_URL") ||
    "https://stellarcred.xyz",
  requestTimeoutMs: 10_000,
  retries: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  jitter: true,
};

let _config: Required<SDKConfig> = { ...DEFAULT_CONFIG };

/**
 * Override SDK defaults at runtime. Call this once at app startup before any
 * `hasClaim` / `getClaims` calls. Each key is optional — omitted keys keep
 * their env-var-derived or default values.
 */
export function configure(opts: SDKConfig): void {
  warnOnClientServerBoundaryViolation({
    registryId: opts.registryId,
    rpcUrl: opts.rpcUrl,
  });
  _config = { ..._config, ...opts };
  // The cached client is bound to the old config — drop it so the next read
  // rebuilds against the new one.
  _client = null;
  _clientKey = "";
}

/**
 * Read the current runtime configuration (read-only snapshot).
 */
export function getConfig(): Readonly<Required<SDKConfig>> {
  return { ..._config };
}

/**
 * Reset config back to initial env defaults.
 */
export function resetConfig(): void {
  _config = { ...DEFAULT_CONFIG };
  _client = null;
  _clientKey = "";
  _warnedMissingRegistryId = false;
  _warnedBoundaryViolation = false;
}

/**
 * Reports which required configuration is present, without throwing.
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
 * Alias for `healthCheck().configured` — a quick boolean check.
 */
export function isConfigured(): boolean {
  return healthCheck().configured;
}

let _warnedMissingRegistryId = false;
function warnIfMissingRegistryIdOnce(): void {
  if (_config.registryId) {
    _warnedMissingRegistryId = false;
    return;
  }
  if (_warnedMissingRegistryId) return;
  const isDevMode =
    typeof process !== "undefined" &&
    (process.env as Record<string, string | undefined>)?.NODE_ENV !== "production";
  if (!isDevMode) return;
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
 * `registryId`). Only surfaces when `{ throwOnError: true }` is passed.
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
 */
export class InvalidAddressError extends Error {
  constructor(message = "Invalid Stellar address") {
    super(message);
    this.name = "InvalidAddressError";
  }
}

/**
 * Error thrown when an unrecognized claim type is requested.
 */
export class InvalidClaimTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClaimTypeError";
  }
}

/**
 * Error thrown when an issuer address is invalid.
 */
export class InvalidIssuerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIssuerError";
  }
}

/**
 * Error thrown when a threshold value is negative or invalid.
 */
export class InvalidThresholdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidThresholdError";
  }
}

/**
 * Error thrown when an RPC / contract-simulation call fails.
 */
export class RpcError extends Error {
  cause?: unknown;
  constructor(
    message = "StellarCred RPC call failed",
    options?: { cause?: unknown } | unknown,
  ) {
    super(message);
    this.name = "RpcError";
    if (options && typeof options === "object" && "cause" in (options as any)) {
      this.cause = (options as any).cause;
    } else if (options !== undefined) {
      this.cause = options;
    }
  }
}

/** The credential types StellarCred supports. Matches the contract Symbols. */
export const CLAIM_TYPES = [
  "kyc",
  "age",
  "income",
  "jurisdiction",
  "funds",
  "accreditation",
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

export function isValidClaimType(value: string): value is ClaimType {
  return (CLAIM_TYPES as readonly string[]).includes(value);
}

export function assertValidClaimType(value: string): asserts value is ClaimType {
  if (!isValidClaimType(value)) {
    throw new InvalidClaimTypeError(
      `Invalid claim type: "${value}". Expected one of: ${CLAIM_TYPES.join(", ")}`,
    );
  }
}

/** Options accepted by hasClaim. */
export interface ClaimOptions {
  minThreshold?: number;
  trustedIssuers?: string[];
  requestTimeoutMs?: number;
  throwOnError?: boolean;
  retryOptions?: RetryOptions;
}

export interface Claim {
  type: string;
  verifiedAt: number;
  expiry: number;
}

export interface BatchClaimOptions {
  minThresholds?: Partial<Record<ClaimType, number>>;
  trustedIssuers?: string[];
  requestTimeoutMs?: number;
  throwOnError?: boolean;
  retryOptions?: RetryOptions;
}

export interface PresetClaim {
  type: ClaimType;
  minThreshold?: number;
}

export interface PresetVerificationResult {
  results: Partial<Record<ClaimType, boolean>>;
  allValid: boolean;
}

// ---------------------------------------------------------------------------
// Low-level read: ProofRegistry.is_verified via simulation
// ---------------------------------------------------------------------------

type StellarSDK = typeof import("@stellar/stellar-sdk");
let _sdk: Promise<StellarSDK> | null = null;
function getSdk(): Promise<StellarSDK> {
  if (!_sdk) _sdk = import("@stellar/stellar-sdk");
  return _sdk;
}

export async function normalizeAndValidateWallet(wallet: string): Promise<string> {
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

export async function validateIssuer(issuer: string): Promise<string> {
  const normalized = issuer.trim();
  if (!normalized) {
    throw new InvalidIssuerError("Invalid issuer address: address is empty");
  }
  const { StrKey } = await getSdk();
  if (!StrKey.isValidEd25519PublicKey(normalized)) {
    throw new InvalidIssuerError(`Invalid issuer address: "${normalized}"`);
  }
  return normalized;
}

export function validateThreshold(minThreshold: number | undefined): void {
  if (minThreshold === undefined) return;
  if (!Number.isInteger(minThreshold) || minThreshold < 0) {
    throw new InvalidThresholdError(
      `Invalid minThreshold: ${minThreshold}. Threshold must be a non-negative integer.`,
    );
  }
}

let _client: Promise<ProofRegistryClient> | null = null;
let _clientKey = "";

export function resetClientForTesting(): void {
  _client = null;
  _clientKey = "";
  _sdk = null;
}

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

  _client.catch(() => {
    _sdk = null;
    _client = null;
    _clientKey = "";
  });
  return _client;
}

async function fanOut<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  await getClient().catch(() => null);
  return Promise.all(items.map(fn));
}

function isRetryable(error: any): boolean {
  if (
    error instanceof ConfigError ||
    error instanceof InvalidAddressError ||
    error instanceof InvalidClaimTypeError ||
    error instanceof InvalidIssuerError ||
    error instanceof InvalidThresholdError
  ) {
    return false;
  }
  if (error && typeof error.message === "string") {
    const msg = error.message.toLowerCase();
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

export async function withRetry<T>(
  operation: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const retries = opts?.retries ?? _config.retries;
  const baseDelayMs = opts?.baseDelayMs ?? _config.baseDelayMs;
  const maxDelayMs = opts?.maxDelayMs ?? _config.maxDelayMs;
  const jitter = opts?.jitter ?? _config.jitter;

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
  retryOptions?: RetryOptions,
): Promise<{ valid: boolean; verifiedAt: number; expiry: number } | null> {
  const client = await getClient(throwOnError);
  if (!client) return null;

  try {
    const { result } = await withRequestTimeout(
      () =>
        withRetry(
          () =>
            client.is_verified({
              holder: wallet,
              credential_type: claimType,
              trusted_issuers: trustedIssuers,
            }),
          retryOptions,
        ),
      requestTimeoutMs,
    );
    if (!result) return null;
    const [valid, verifiedAt, expiry] = result;
    return { valid, verifiedAt: Number(verifiedAt), expiry: Number(expiry) };
  } catch (err) {
    if (throwOnError) {
      if (err instanceof ConfigError) throw err;
      throw new RpcError(`is_verified RPC failed for claim "${claimType}"`, {
        cause: err,
      });
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
  retryOptions?: RetryOptions,
): Promise<boolean> {
  const client = await getClient(throwOnError);
  if (!client) return false;

  try {
    const { result } = await withRequestTimeout(
      () =>
        withRetry(
          () =>
            client.check_claim({
              holder: wallet,
              credential_type: claimType,
              min_threshold: BigInt(minThreshold),
              trusted_issuers: trustedIssuers,
            }),
          retryOptions,
        ),
      requestTimeoutMs,
    );
    return result ?? false;
  } catch (err) {
    if (throwOnError) {
      if (err instanceof ConfigError) throw err;
      throw new RpcError(`check_claim RPC failed for claim "${claimType}"`, {
        cause: err,
      });
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
    if (throwOnError) {
      throw new RpcError("Failed to validate Stellar address", { cause: err });
    }
    return false;
  }

  if (opts?.minThreshold !== undefined) {
    validateThreshold(opts.minThreshold);
    return readCheckClaim(
      normalizedWallet,
      claimType,
      opts.minThreshold,
      opts.trustedIssuers,
      throwOnError,
      opts.requestTimeoutMs,
      opts.retryOptions,
    );
  }

  const r = await readIsVerified(
    normalizedWallet,
    claimType,
    opts?.trustedIssuers,
    throwOnError,
    opts?.requestTimeoutMs,
    opts?.retryOptions,
  );
  return !!r && r.valid;
}

/**
 * Returns the full claim record (valid, verifiedAt, expiry) for a wallet and
 * credential type, or `null` if the wallet has no current proof of that type.
 */
export async function getClaim(
  wallet: string,
  claimType: string,
  opts?: Pick<ClaimOptions, "trustedIssuers" | "requestTimeoutMs" | "throwOnError" | "retryOptions">,
): Promise<{ valid: boolean; verifiedAt: number; expiry: number } | null> {
  warnIfMissingRegistryIdOnce();

  let normalizedWallet: string;
  try {
    normalizedWallet = await normalizeAndValidateWallet(wallet);
  } catch (err) {
    if (opts?.throwOnError && err instanceof InvalidAddressError) throw err;
    return null;
  }

  const r = await readIsVerified(
    normalizedWallet,
    claimType,
    opts?.trustedIssuers,
    opts?.throwOnError === true,
    opts?.requestTimeoutMs,
    opts?.retryOptions,
  );
  return r && r.valid ? r : null;
}

/**
 * Batched form of {@link hasClaim}: checks several claim types for one wallet.
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
  } catch (err) {
    if (opts?.throwOnError && err instanceof InvalidAddressError) throw err;
    for (const type of unique) {
      results[type] = false;
    }
    return results;
  }

  await fanOut(unique, async (t) => {
    try {
      const minThreshold = opts?.minThresholds?.[t];
      if (minThreshold !== undefined) {
        validateThreshold(minThreshold);
        results[t] = await readCheckClaim(
          normalizedWallet,
          t,
          minThreshold,
          opts?.trustedIssuers,
          opts?.throwOnError === true,
          opts?.requestTimeoutMs,
          opts?.retryOptions,
        );
        return;
      }
      const r = await readIsVerified(
        normalizedWallet,
        t,
        opts?.trustedIssuers,
        opts?.throwOnError === true,
        opts?.requestTimeoutMs,
        opts?.retryOptions,
      );
      results[t] = !!r && r.valid;
    } catch (err) {
      if (opts?.throwOnError) throw err;
      results[t] = false;
    }
  });

  return results;
}

/**
 * Verifies every claim in a selective-disclosure preset.
 */
export async function verifyPreset(
  wallet: string,
  claims: readonly PresetClaim[],
  opts?: Pick<BatchClaimOptions, "trustedIssuers" | "requestTimeoutMs" | "throwOnError" | "retryOptions">,
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
    throwOnError: opts?.throwOnError,
    retryOptions: opts?.retryOptions,
  });
  const allValid = types.length > 0 && types.every((t) => results[t] === true);
  return { results, allValid };
}

/**
 * Returns every active claim a wallet has proven across all known credential
 * types.
 */
export async function getClaims(
  wallet: string,
  opts?: Pick<ClaimOptions, "throwOnError" | "requestTimeoutMs" | "retryOptions">,
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
    try {
      const r = await readIsVerified(
        normalizedWallet,
        t,
        undefined,
        throwOnError,
        opts?.requestTimeoutMs,
        opts?.retryOptions,
      );
      return r && r.valid ? { type: t, verifiedAt: r.verifiedAt, expiry: r.expiry } : null;
    } catch (err) {
      if (throwOnError) throw err;
      return null;
    }
  });

  return results.filter((x): x is NonNullable<typeof x> => x !== null);
}

// ---------------------------------------------------------------------------
// URL builders & helpers
// ---------------------------------------------------------------------------

export function buildVerifyUrl(opts: {
  returnUrl: string;
  claim?: ClaimType;
  claims?: ClaimType[];
  wallet?: string;
  state?: string;
  baseUrl?: string;
  claimParams?: {
    threshold?: string;
    threshold_years?: string;
    restricted?: string | string[];
  };
}): string {
  const base = opts.baseUrl ?? _config.baseUrl;
  const url = new URL("/verify", base);
  url.searchParams.set("return_url", opts.returnUrl);

  if (opts.claim) {
    url.searchParams.set("claim", opts.claim);
  }
  if (opts.claims && opts.claims.length > 0) {
    url.searchParams.set("claims", opts.claims.join(","));
  }
  if (opts.wallet) {
    url.searchParams.set("wallet", opts.wallet);
  }
  if (opts.state) {
    url.searchParams.set("state", opts.state);
  }
  if (opts.claimParams) {
    if (opts.claimParams.threshold) {
      url.searchParams.set("param_threshold", opts.claimParams.threshold);
    }
    if (opts.claimParams.threshold_years) {
      url.searchParams.set("param_threshold_years", opts.claimParams.threshold_years);
    }
    if (opts.claimParams.restricted) {
      const restricted = Array.isArray(opts.claimParams.restricted)
        ? opts.claimParams.restricted.join(",")
        : opts.claimParams.restricted;
      url.searchParams.set("param_restricted", restricted);
    }
  }

  return url.toString();
}

export function buildIssuerUrl(opts: {
  returnUrl: string;
  claim?: ClaimType;
  wallet?: string;
  baseUrl?: string;
}): string {
  const base = opts.baseUrl ?? _config.baseUrl;
  const url = new URL("/issuer", base);
  url.searchParams.set("return_url", opts.returnUrl);
  if (opts.claim) url.searchParams.set("claim", opts.claim);
  if (opts.wallet) url.searchParams.set("wallet", opts.wallet);
  return url.toString();
}

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

export interface UntrustedReturnParams {
  verified: boolean;
  wallet: string | null;
  claims: string[];
  state: string | null;
}

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

// ---------------------------------------------------------------------------
// Watch claim polling
// ---------------------------------------------------------------------------

export interface WatchClaimOptions {
  pollMs?: number;
  timeoutMs?: number;
  minThreshold?: number;
  requestTimeoutMs?: number;
}

export interface WatchClaimCallbackOptions extends WatchClaimOptions {
  onChange: (verified: boolean) => void;
}

export function watchClaim(
  wallet: string,
  claimType: string,
  opts?: WatchClaimOptions,
): Promise<boolean>;

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
    poll();
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
      poll();
    });
  }
}

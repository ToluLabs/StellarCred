// @stellarcred/sdk â€” shared claim-checking core
//
// Authoritative module holding the complete claim-checking machinery:
// config, low-level ProofRegistry reads, and the public functions
// (`hasClaim`, `hasClaims`, `getClaim`, `getClaims`, `verifyPreset`, `watchClaim`)
// plus all associated types and error classes.
//
// `index.ts`, `core.ts`, `react.ts`, `server.ts`, and `challenge.ts` all import
// from here, so nothing in this module imports back from those files â€” keeping
// the module graph acyclic.

import type { Client as ProofRegistryClient } from "../../proof-registry/src/index";
import {
  IndexerError,
  evaluateClaimRow,
  fetchWalletClaims,
  findClaimRow,
  type IndexerClaimRow,
} from "./indexer";
// RpcError has been moved to ./errors.ts (issue #404)
import { RpcError, ContractError, ContractErrorCode, parseContractError } from "./errors";

export { IndexerError };
export type { IndexerClaimRow };

// ---------------------------------------------------------------------------
// Runtime environment detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the SDK is running in a browser (or browser-like) context.
 * Used only for development-mode boundary warnings â€” never throws.
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
 * @internal â€” test-only hook to reset the one-shot boundary violation flag
 * between test cases. Not part of the public API.
 */
export function __resetBoundaryWarningForTesting(): void {
  _warnedBoundaryViolation = false;
}

function warnOnClientServerBoundaryViolation(opts: { registryId?: string; rpcUrl?: string }): void {
  if (!isBrowser()) return;
  if (!isDev()) return;
  if (_warnedBoundaryViolation) return;

  const proc =
    typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {};

  const leakedServerVar =
    !!proc["STELLARCRED_REGISTRY_ID"] ||
    !!proc["STELLARCRED_RPC_URL"] ||
    !!proc["STELLARCRED_NETWORK_PASSPHRASE"] ||
    !!proc["STELLARCRED_BASE_URL"] ||
    !!proc["STELLARCRED_NETWORK"];

  const serverEnvRegistryId = proc["STELLARCRED_REGISTRY_ID"] ?? proc["PROOF_REGISTRY_ID"];
  const serverEnvRpcUrl = proc["STELLARCRED_RPC_URL"];
  const configMatchesServerVar =
    (opts.registryId !== undefined &&
      opts.registryId !== "" &&
      opts.registryId === serverEnvRegistryId) ||
    (opts.rpcUrl !== undefined && opts.rpcUrl !== "" && opts.rpcUrl === serverEnvRpcUrl);

  if (!leakedServerVar && !configMatchesServerVar) return;

  _warnedBoundaryViolation = true;

  console.warn(
    "[StellarCred] configure() was called in a browser context with values that " +
      "appear to come from server-only environment variables (e.g. STELLARCRED_REGISTRY_ID " +
      "or PROOF_REGISTRY_ID without the NEXT_PUBLIC_ prefix).\n\n" +
      "The ProofRegistry contract ID and RPC URL are read-only infrastructure config " +
      "that is safe to expose to the client â€” but they must reach the browser through " +
      "public env vars (NEXT_PUBLIC_PROOF_REGISTRY_ID / NEXT_PUBLIC_RPC_URL in Next.js, " +
      "VITE_* in Vite) rather than server-only names.\n\n" +
      "If you are verifying claims server-side (recommended for access control), " +
      "import from '@stellarcred/sdk/server' instead â€” the intent is explicit at " +
      "the import site and this warning will not fire.\n\n" +
      "See the SDK README Â§Trust boundary for details. " +
      "This warning only appears in development mode.",
  );
}

let _warnedIndexerKeyInBrowser = false;

/**
 * An indexer API key is a secret, unlike `registryId`/`rpcUrl` which are
 * read-only infrastructure config that is safe to publish. Shipping it to a
 * browser hands it to every visitor, so warn loudly rather than treating it as
 * another boundary-var mixup.
 */
function warnOnIndexerKeyInBrowser(indexerApiKey?: string): void {
  if (!isBrowser() || !isDev() || _warnedIndexerKeyInBrowser) return;
  if (!indexerApiKey) return;

  _warnedIndexerKeyInBrowser = true;

  console.warn(
    "[StellarCred] configure() was called in a browser context with an " +
      "`indexerApiKey`. That key is a secret and is now exposed to every visitor " +
      "of this site.\n\n" +
      "Read claims from the browser without a key (leave `indexerApiKey` unset), " +
      "or proxy indexer reads through your own backend and keep the key " +
      "server-side. Note also that the indexer's CORS policy does not allow the " +
      "X-API-Key header from a browser.\n\nThis warning only appears in development mode.",
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
  NETWORK_PRESETS[parseNetwork(env("STELLARCRED_NETWORK", "NEXT_PUBLIC_STELLAR_NETWORK"))];

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

/**
 * Where a claim read is sourced from. Defaults to `"chain"`.
 *
 * - `"chain"` — simulate against ProofRegistry. Trust-minimised: the only
 *   thing you trust is the contract. This is the default and the only mode
 *   that should gate access on its own.
 * - `"indexer"` — read from an operator-run indexer over HTTP. Much faster,
 *   but the indexer is an **off-chain cache of public chain data**. It can be
 *   stale, lagging, or wrong, and you are trusting whoever runs it. Never use
 *   this as the sole basis for a security decision.
 * - `"indexer-verified"` — read from the indexer, then confirm the answer
 *   against the chain and return the chain's result. Costs a chain read, so it
 *   is not faster than `"chain"`; its value is that a disagreement between the
 *   two is surfaced, which tells an operator their indexer has drifted.
 */
export type ClaimSource = "chain" | "indexer" | "indexer-verified";

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
  /**
   * Base URL of a StellarCred indexer, e.g. `https://indexer.example.com`.
   * Required before any read can use `source: "indexer"` or
   * `source: "indexer-verified"`; without it those reads fail soft exactly as
   * an unconfigured `registryId` does for chain reads.
   */
  indexerUrl?: string;
  /**
   * API key for indexers that gate `/claims` behind one. This is a secret —
   * there is deliberately no `NEXT_PUBLIC_` fallback for it, and configuring
   * it from a browser context warns in development.
   */
  indexerApiKey?: string;
  /**
   * How long indexer results for a wallet are reused, in milliseconds. Exists
   * so a `getClaims`/`hasClaims` fan-out over N credential types issues one
   * HTTP request instead of N. Set to `0` to disable. Only ever affects
   * `source: "indexer"` and `source: "indexer-verified"` reads — chain reads
   * are never cached.
   */
  indexerCacheMs?: number;
}

const DEFAULT_CONFIG: Required<SDKConfig> = {
  registryId: env("STELLARCRED_REGISTRY_ID", "NEXT_PUBLIC_PROOF_REGISTRY_ID"),
  rpcUrl: env("STELLARCRED_RPC_URL", "NEXT_PUBLIC_RPC_URL") || _preset.rpcUrl,
  networkPassphrase:
    env("STELLARCRED_NETWORK_PASSPHRASE", "NEXT_PUBLIC_NETWORK_PASSPHRASE") ||
    _preset.networkPassphrase,
  baseUrl:
    env("STELLARCRED_BASE_URL", "NEXT_PUBLIC_STELLARCRED_BASE_URL") || "https://stellarcred.xyz",
  requestTimeoutMs: 10_000,
  retries: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  jitter: true,
  indexerUrl: env("STELLARCRED_INDEXER_URL", "NEXT_PUBLIC_INDEXER_URL"),
  indexerApiKey: env("STELLARCRED_INDEXER_API_KEY"),
  indexerCacheMs: 2000,
};

let _config: Required<SDKConfig> = { ...DEFAULT_CONFIG };

/**
 * Override SDK defaults at runtime. Call this once at app startup before any
 * `hasClaim` / `getClaims` calls. Each key is optional â€” omitted keys keep
 * their env-var-derived or default values.
 */
export function configure(opts: SDKConfig): void {
  warnOnClientServerBoundaryViolation({
    registryId: opts.registryId,
    rpcUrl: opts.rpcUrl,
  });
  warnOnIndexerKeyInBrowser(opts.indexerApiKey);
  _config = { ..._config, ...opts };
  // The cached client is bound to the old config â€” drop it so the next read
  // rebuilds against the new one.
  _client = null;
  _clientKey = "";
  // Cached rows may have come from the previous indexerUrl/apiKey.
  clearIndexerCache();
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
  _warnedIndexerKeyInBrowser = false;
  clearIndexerCache();
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
 * Alias for `healthCheck().configured` â€” a quick boolean check.
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
  dryRun?: DryRunOptions;
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
  dryRun?: DryRunOptions;
}

export interface PresetClaim {
  type: ClaimType;
  minThreshold?: number;
}

export interface PresetVerificationResult {
  results: Partial<Record<ClaimType, boolean>>;
  allValid: boolean;
}

export type CredentialFailureReason =
  | "not_verified"
  | "expired"
  | "revoked"
  | "wrong_issuer"
  | "untrusted_issuer"
  | "unmet_threshold";

export interface ProofRecordDetails {
  verifiedAt: number;
  expiry: number;
  revoked: boolean;
  issuer?: string;
  threshold?: number;
  vkVersion: number;
  reason?: string;
}

export interface CredentialStatusResult {
  valid: boolean;
  status: "verified" | "rpc_failure" | CredentialFailureReason;
  record?: ProofRecordDetails | null;
  error?: string;
}

export type DryRunClaimState = CredentialStatusResult["status"];

export interface DryRunClaimFixture {
  wallet?: string;
  claimType: string;
  state: DryRunClaimState;
  verifiedAt?: number;
  expiry?: number;
  revoked?: boolean;
  issuer?: string;
  threshold?: number;
  vkVersion?: number;
  error?: string;
}

export interface DryRunOptions {
  enabled: true;
  claims: DryRunClaimFixture[];
  nowSeconds?: number;
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

function dryRunFixtureFor(
  wallet: string,
  claimType: string,
  dryRun?: DryRunOptions,
): DryRunClaimFixture | null {
  if (!dryRun?.enabled) return null;
  const normalizedWallet = wallet.trim();
  return (
    dryRun.claims.find(
      (fixture) =>
        fixture.claimType === claimType &&
        (!fixture.wallet || fixture.wallet.trim() === normalizedWallet),
    ) ?? null
  );
}

function dryRunStatus(
  wallet: string,
  claimType: string,
  opts?: ClaimOptions,
): CredentialStatusResult | null {
  const fixture = dryRunFixtureFor(wallet, claimType, opts?.dryRun);
  if (!fixture) {
    return opts?.dryRun?.enabled
      ? {
          valid: false,
          status: "not_verified",
          record: null,
          error: `Dry-run fixture missing for "${claimType}".`,
        }
      : null;
  }

  const nowSeconds = opts?.dryRun?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const record: ProofRecordDetails = {
    verifiedAt: fixture.verifiedAt ?? nowSeconds,
    expiry:
      fixture.expiry ??
      (fixture.state === "expired" ? nowSeconds - 1 : nowSeconds + 86_400),
    revoked: fixture.revoked ?? fixture.state === "revoked",
    issuer: fixture.issuer,
    threshold: fixture.threshold,
    vkVersion: fixture.vkVersion ?? 1,
  };

  if (fixture.state === "verified") {
    if (record.expiry <= nowSeconds) {
      return {
        valid: false,
        status: "expired",
        record,
        error: `Dry-run credential "${claimType}" is expired.`,
      };
    }
    if (record.revoked) {
      return {
        valid: false,
        status: "revoked",
        record,
        error: `Dry-run credential "${claimType}" is revoked.`,
      };
    }
    if (opts?.trustedIssuers?.length) {
      if (!record.issuer || !opts.trustedIssuers.includes(record.issuer)) {
        return {
          valid: false,
          status: "untrusted_issuer",
          record,
          error: `Dry-run issuer "${record.issuer ?? "unknown"}" is not trusted.`,
        };
      }
    }
    if (opts?.minThreshold !== undefined) {
      const provenThreshold = record.threshold ?? 0;
      if (provenThreshold < opts.minThreshold) {
        return {
          valid: false,
          status: "unmet_threshold",
          record,
          error: `Dry-run threshold (${provenThreshold}) is less than required minimum (${opts.minThreshold}).`,
        };
      }
    }
    return { valid: true, status: "verified", record };
  }

  return {
    valid: false,
    status: fixture.state,
    record:
      fixture.state === "not_verified" || fixture.state === "rpc_failure"
        ? null
        : record,
    error:
      fixture.error ??
      `Dry-run fixture for "${claimType}" returned ${fixture.state}.`,
  };
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
  _client = Promise.all([getSdk(), import("../../proof-registry/src/index")]).then(
    ([, { Client }]) =>
      new Client({
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
  warmChain = true,
): Promise<R[]> {
  // Indexer-only reads never touch ProofRegistry, so skip building a client
  // they would not use.
  if (warmChain) await getClient().catch(() => null);
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
  // Transient RPC/transport failures: HTTP 429/5xx, network timeouts, and
  // unknown error shapes that are not obviously terminal.
  if (error instanceof RpcError) {
    const status = error.status;
    if (status === undefined) return true;
    if (status === 429 || (status >= 500 && status < 600)) return true;
    return false;
  }
  if (error instanceof ContractError) {
    return error.isRetryable();
  }
  return true;
}

class ReadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`RPC read timed out after ${timeoutMs}ms`);
    this.name = "ReadTimeoutError";
  }
}

/**
 * Classification of a failure reason for submission paths that want to
 * display or branch on *why* a transient failure happened (rate-limited vs.
 * server error vs. network timeout) without parsing status codes themselves.
 */
export type TransientFailureKind =
  | { kind: "rate_limited"; statusCode: number; retryAfterMs?: number }
  | { kind: "server_error"; statusCode: number }
  | { kind: "network_error"; message: string };

/**
 * Inspect a thrown error from a submission or RPC path and return a structured
 * transient-failure descriptor when the error is retryable. Returns null for
 * non-retryable errors (configuration, validation, terminal contract panics).
 */
export function classifyTransientFailure(error: unknown): TransientFailureKind | null {
  if (!isRetryable(error)) return null;

  if (error instanceof RpcError) {
    const status = error.status;
    if (status === 429) {
      return { kind: "rate_limited", statusCode: 429 };
    }
    if (status !== undefined && status >= 500 && status < 600) {
      return { kind: "server_error", statusCode: status };
    }
    // An unknown/unset RpcError still counts as transient.
    return { kind: "network_error", message: error.message };
  }

  if (error instanceof ContractError) {
    if (error.code === ContractErrorCode.SubmissionsPaused) {
      return { kind: "server_error", statusCode: 503 };
    }
    return null;
  }

  if (error instanceof Error) {
    return { kind: "network_error", message: error.message };
  }

  return { kind: "network_error", message: String(error) };
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

export interface NormalizedRpcErrorOptions {
  /** Human-readable summary of what failed. */
  message: string;
  /** Original thrown value, if any. */
  cause?: unknown;
  /** HTTP status when the RPC responded with an error status. */
  status?: number;
  /** Parsed contract error when the failure was a contract panic. */
  contractError?: ContractError;
}

/**
 * Normalize an arbitrary thrown value from an RPC/submission path into an
 * actionable {@link RpcError} with a stable `name`, optional `status`, and an
 * optional parsed `contractError` with a numeric `code` and
 * `friendlyMessage`.
 *
 * Callers that want a code/message union should still inspect `contractError`
 * (for contract panics) or `status` (for transport errors).
 */
export function normalizeRpcError(raw: unknown, opts: NormalizedRpcErrorOptions): RpcError {
  let contractError: ContractError | undefined;
  let status: number | undefined;

  if (raw instanceof RpcError) {
    contractError = raw.contractError;
    status = raw.status;
  } else if (raw instanceof ContractError) {
    contractError = raw;
  } else if (typeof raw === "string") {
    contractError = parseContractError(raw) ?? undefined;
  } else if (raw && typeof raw === "object") {
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.message === "string") {
      contractError = parseContractError(candidate.message) ?? undefined;
    }
    if (typeof candidate.status === "number") status = candidate.status;
  }

  if (opts.status !== undefined) status = opts.status;
  if (contractError && !opts.contractError) opts.contractError = contractError;

  return new RpcError(opts.message, {
    cause: opts.cause ?? raw,
    status,
    contractError: opts.contractError,
  });
}

export async function withRetry<T>(operation: () => Promise<T>, opts?: RetryOptions): Promise<T> {
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

// ---------------------------------------------------------------------------
// Low-level read: optional indexer fast path (#613)
//
// Everything below is opt-in. `source: "chain"` (the default) never reaches
// this code, so the trust-minimised path is byte-for-byte what it was before.
// ---------------------------------------------------------------------------

interface IndexerCacheEntry {
  fetchedAt: number;
  rows: Promise<IndexerClaimRow[]>;
}

/**
 * Short-lived per-wallet memo of indexer rows. A `getClaims`/`hasClaims`
 * fan-out asks for N credential types but the indexer returns them all in one
 * response, so without this a single `getClaims` call would issue six
 * identical HTTP requests. Chain reads never touch this cache.
 */
const _indexerCache = new Map<string, IndexerCacheEntry>();

export function clearIndexerCache(): void {
  _indexerCache.clear();
}

/**
 * @internal — test-only hook mirroring {@link resetClientForTesting}.
 */
export function resetIndexerForTesting(): void {
  clearIndexerCache();
  _warnedMissingIndexerUrl = false;
  _warnedIndexerDrift = false;
}

let _warnedMissingIndexerUrl = false;
function warnIfMissingIndexerUrlOnce(): void {
  if (_config.indexerUrl) {
    _warnedMissingIndexerUrl = false;
    return;
  }
  if (_warnedMissingIndexerUrl || !isDev()) return;
  _warnedMissingIndexerUrl = true;

  console.warn(
    '[StellarCred] A claim read used `source: "indexer"` or "indexer-verified" ' +
      "but no `indexerUrl` is configured, so it fell back to returning " +
      "false/null. Set STELLARCRED_INDEXER_URL (or NEXT_PUBLIC_INDEXER_URL) or call " +
      "StellarCred.configure({ indexerUrl }). This warning only logs in development.",
  );
}

let _warnedIndexerDrift = false;
/**
 * Fires when `source: "indexer-verified"` finds the indexer and the chain
 * disagree. Surfacing this is the entire point of the mode, so unlike the
 * configuration warnings it is NOT gated on development mode — an operator
 * whose indexer has drifted needs to see it in production. Still rate-limited
 * to once per process.
 */
function warnOnIndexerDrift(
  claimType: string,
  indexerValid: boolean | null,
  chainValid: boolean | null,
): void {
  if (indexerValid === null || chainValid === null) return;
  if (indexerValid === chainValid) return;
  if (_warnedIndexerDrift) return;
  _warnedIndexerDrift = true;

  console.warn(
    `[StellarCred] Indexer disagreed with the chain for claim "${claimType}": ` +
      `indexer said ${indexerValid}, ProofRegistry said ${chainValid}. The chain ` +
      "result was used. This usually means the indexer is lagging or stale — " +
      "check its /health endpoint for ledger lag. This warning logs once per process.",
  );
}

async function readIndexerRows(
  wallet: string,
  throwOnError: boolean,
  requestTimeoutMs: number,
  retryOptions?: RetryOptions,
): Promise<IndexerClaimRow[] | null> {
  const { indexerUrl, indexerApiKey, indexerCacheMs } = _config;

  if (!indexerUrl) {
    if (throwOnError) {
      throw new ConfigError("StellarCred is not configured for indexer reads: missing indexerUrl");
    }
    warnIfMissingIndexerUrlOnce();
    return null;
  }

  const key = `${indexerUrl}|${wallet}`;
  const cached = _indexerCache.get(key);
  let pending: Promise<IndexerClaimRow[]>;

  if (cached && Date.now() - cached.fetchedAt < indexerCacheMs) {
    pending = cached.rows;
  } else {
    pending = withRequestTimeout(
      () =>
        withRetry(
          () =>
            fetchWalletClaims(wallet, {
              indexerUrl,
              apiKey: indexerApiKey,
            }),
          retryOptions,
        ),
      requestTimeoutMs,
    ).catch((err) => {
      // Never let a rejected promise linger in the cache and poison later reads.
      _indexerCache.delete(key);
      throw err;
    });
    if (indexerCacheMs > 0) {
      _indexerCache.set(key, { fetchedAt: Date.now(), rows: pending });
    }
  }

  try {
    return await pending;
  } catch (err) {
    if (throwOnError) {
      if (err instanceof ConfigError) throw err;
      if (err instanceof IndexerError) throw err;
      throw new IndexerError(`Indexer read failed for wallet "${wallet}"`, {
        cause: err,
      });
    }
    return null;
  }
}

async function readIsVerifiedFromIndexer(
  wallet: string,
  claimType: string,
  trustedIssuers?: string[],
  throwOnError = false,
  requestTimeoutMs = _config.requestTimeoutMs,
  retryOptions?: RetryOptions,
): Promise<{ valid: boolean; verifiedAt: number; expiry: number } | null> {
  const rows = await readIndexerRows(wallet, throwOnError, requestTimeoutMs, retryOptions);
  if (!rows) return null;

  const row = findClaimRow(rows, claimType);
  // Mirrors the contract's `(false, 0, 0)` for "never submitted" so callers can
  // still distinguish that from "submitted but no longer valid".
  if (!row) return { valid: false, verifiedAt: 0, expiry: 0 };

  return {
    valid: evaluateClaimRow(row, {
      trustedIssuers,
      nowSeconds: Math.floor(Date.now() / 1000),
    }),
    verifiedAt: row.verified_at,
    expiry: row.expiry,
  };
}

async function readCheckClaimFromIndexer(
  wallet: string,
  claimType: string,
  minThreshold: number,
  trustedIssuers?: string[],
  throwOnError = false,
  requestTimeoutMs = _config.requestTimeoutMs,
  retryOptions?: RetryOptions,
): Promise<boolean> {
  const rows = await readIndexerRows(wallet, throwOnError, requestTimeoutMs, retryOptions);
  if (!rows) return false;

  const row = findClaimRow(rows, claimType);
  if (!row) return false;

  return evaluateClaimRow(row, {
    trustedIssuers,
    minThreshold,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
}

async function readIsVerified(
  wallet: string,
  claimType: string,
  trustedIssuers?: string[],
  throwOnError = false,
  requestTimeoutMs = _config.requestTimeoutMs,
  retryOptions?: RetryOptions,
  source: ClaimSource = "chain",
): Promise<{ valid: boolean; verifiedAt: number; expiry: number } | null> {
  if (source === "chain") {
    return readIsVerifiedFromChain(
      wallet,
      claimType,
      trustedIssuers,
      throwOnError,
      requestTimeoutMs,
      retryOptions,
    );
  }

  const fromIndexer = await readIsVerifiedFromIndexer(
    wallet,
    claimType,
    trustedIssuers,
    // A failed indexer read must not abort an indexer-verified read: the chain
    // is authoritative anyway, so only surface errors for pure "indexer".
    source === "indexer" ? throwOnError : false,
    requestTimeoutMs,
    retryOptions,
  );

  if (source === "indexer") return fromIndexer;

  const fromChain = await readIsVerifiedFromChain(
    wallet,
    claimType,
    trustedIssuers,
    throwOnError,
    requestTimeoutMs,
    retryOptions,
  );
  warnOnIndexerDrift(claimType, fromIndexer?.valid ?? null, fromChain?.valid ?? null);
  return fromChain;
}

async function readCheckClaim(
  wallet: string,
  claimType: string,
  minThreshold: number,
  trustedIssuers?: string[],
  throwOnError = false,
  requestTimeoutMs = _config.requestTimeoutMs,
  retryOptions?: RetryOptions,
  source: ClaimSource = "chain",
): Promise<boolean> {
  if (source === "chain") {
    return readCheckClaimFromChain(
      wallet,
      claimType,
      minThreshold,
      trustedIssuers,
      throwOnError,
      requestTimeoutMs,
      retryOptions,
    );
  }

  const fromIndexer = await readCheckClaimFromIndexer(
    wallet,
    claimType,
    minThreshold,
    trustedIssuers,
    source === "indexer" ? throwOnError : false,
    requestTimeoutMs,
    retryOptions,
  );

  if (source === "indexer") return fromIndexer;

  const fromChain = await readCheckClaimFromChain(
    wallet,
    claimType,
    minThreshold,
    trustedIssuers,
    throwOnError,
    requestTimeoutMs,
    retryOptions,
  );
  warnOnIndexerDrift(claimType, fromIndexer, fromChain);
  return fromChain;
}

async function readIsVerifiedFromChain(
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

async function readCheckClaimFromChain(
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

async function readRecord(
  wallet: string,
  claimType: string,
  throwOnError = false,
  requestTimeoutMs = _config.requestTimeoutMs,
  retryOptions?: RetryOptions,
): Promise<ProofRecordDetails | null> {
  const client = await getClient(throwOnError);
  if (!client) return null;

  try {
    const { result } = await withRequestTimeout(
      () =>
        withRetry(
          () =>
            client.get_record({
              holder: wallet,
              credential_type: claimType,
            }),
          retryOptions,
        ),
      requestTimeoutMs,
    );
    if (!result) return null;
    const reasonMap: Record<number, string> = {
      0: "expired",
      1: "superseded",
      2: "fraud",
      3: "user_request",
      4: "other",
    };
    return {
      verifiedAt: Number(result.verified_at),
      expiry: Number(result.expiry),
      revoked: Boolean(result.revoked),
      issuer: result.issuer ? String(result.issuer) : undefined,
      threshold:
        result.threshold !== undefined && result.threshold !== null
          ? Number(result.threshold)
          : undefined,
      vkVersion: Number(result.vk_version),
      reason: result.reason !== undefined ? reasonMap[Number(result.reason)] || "other" : undefined,
    };
  } catch (err) {
    if (throwOnError) {
      if (err instanceof ConfigError) throw err;
      throw new RpcError(`get_record RPC failed for claim "${claimType}"`, {
        cause: err,
      });
    }
    return null;
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
  const throwOnError = opts?.throwOnError === true;

  if (opts?.dryRun?.enabled) {
    if (opts?.minThreshold !== undefined) {
      validateThreshold(opts.minThreshold);
    }
    const result = dryRunStatus(wallet, claimType, opts);
    if (result?.status === "rpc_failure" && throwOnError) {
      throw new RpcError(result.error ?? "Dry-run RPC failure");
    }
    return result?.valid === true;
  }

  warnIfMissingRegistryIdOnce();

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
      opts.source,
    );
  }

  const r = await readIsVerified(
    normalizedWallet,
    claimType,
    opts?.trustedIssuers,
    throwOnError,
    opts?.requestTimeoutMs,
    opts?.retryOptions,
    opts?.source,
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
  opts?: Pick<
    ClaimOptions,
    "trustedIssuers" | "requestTimeoutMs" | "throwOnError" | "retryOptions" | "dryRun"
  >,
): Promise<{ valid: boolean; verifiedAt: number; expiry: number } | null> {
  if (opts && "dryRun" in opts && opts.dryRun?.enabled) {
    const result = dryRunStatus(wallet, claimType, opts as ClaimOptions);
    return result?.valid && result.record
      ? {
          valid: true,
          verifiedAt: result.record.verifiedAt,
          expiry: result.record.expiry,
        }
      : null;
  }

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
    opts?.source,
  );
  return r && r.valid ? r : null;
}

/**
 * Returns the raw stored ProofRecord details (verifiedAt, expiry, revoked, issuer,
 * threshold, vkVersion) from ProofRegistry, or null if no record exists.
 */
export async function getClaimRecord(
  wallet: string,
  claimType: string,
  opts?: Pick<ClaimOptions, "requestTimeoutMs" | "throwOnError" | "retryOptions" | "dryRun">,
): Promise<ProofRecordDetails | null> {
  if (opts && "dryRun" in opts && opts.dryRun?.enabled) {
    return dryRunStatus(wallet, claimType, opts as ClaimOptions)?.record ?? null;
  }

  warnIfMissingRegistryIdOnce();

  let normalizedWallet: string;
  try {
    normalizedWallet = await normalizeAndValidateWallet(wallet);
  } catch (err) {
    if (opts?.throwOnError && err instanceof InvalidAddressError) throw err;
    return null;
  }

  return readRecord(
    normalizedWallet,
    claimType,
    opts?.throwOnError === true,
    opts?.requestTimeoutMs,
    opts?.retryOptions,
  );
}

/**
 * Inspects a wallet's credential claim on-chain and returns a detailed status result,
 * evaluating failure states: "not_verified", "expired", "revoked", "wrong_issuer",
 * "unmet_threshold", or "verified".
 */
export async function checkClaimStatus(
  wallet: string,
  claimType: string,
  opts?: ClaimOptions,
): Promise<CredentialStatusResult> {
  const throwOnError = opts?.throwOnError === true;

  if (opts?.dryRun?.enabled) {
    if (opts?.minThreshold !== undefined) {
      validateThreshold(opts.minThreshold);
    }
    const result = dryRunStatus(wallet, claimType, opts);
    if (result?.status === "rpc_failure" && throwOnError) {
      throw new RpcError(result.error ?? "Dry-run RPC failure");
    }
    return (
      result ?? {
        valid: false,
        status: "not_verified",
        record: null,
        error: `Dry-run fixture missing for "${claimType}".`,
      }
    );
  }

  warnIfMissingRegistryIdOnce();

  let normalizedWallet: string;
  try {
    normalizedWallet = await normalizeAndValidateWallet(wallet);
  } catch (err) {
    if (err instanceof InvalidAddressError) {
      if (throwOnError) throw err;
      return {
        valid: false,
        status: "not_verified",
        record: null,
        error: "Invalid Stellar address",
      };
    }
    if (throwOnError) {
      throw new RpcError("Failed to validate Stellar address", { cause: err });
    }
    return {
      valid: false,
      status: "not_verified",
      record: null,
      error: "Failed to validate Stellar address",
    };
  }

  if (opts?.minThreshold !== undefined) {
    validateThreshold(opts.minThreshold);
  }

  const record = await readRecord(
    normalizedWallet,
    claimType,
    throwOnError,
    opts?.requestTimeoutMs,
    opts?.retryOptions,
  );

  if (!record) {
    return {
      valid: false,
      status: "not_verified",
      record: null,
      error: `Wallet has no on-chain proof for "${claimType}".`,
    };
  }

  if (record.revoked) {
    return {
      valid: false,
      status: "revoked",
      record,
      error: `Credential "${claimType}" was revoked by issuer.`,
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (record.expiry <= nowSeconds) {
    return {
      valid: false,
      status: "expired",
      record,
      error: `Credential "${claimType}" expired at ${new Date(record.expiry * 1000).toISOString()}.`,
    };
  }

  if (opts?.trustedIssuers && opts.trustedIssuers.length > 0) {
    if (!record.issuer || !opts.trustedIssuers.includes(record.issuer)) {
      return {
        valid: false,
        status: "wrong_issuer",
        record,
        error: `Credential issuer "${record.issuer ?? "unknown"}" is not in trusted issuers list.`,
      };
    }
  }

  if (opts?.minThreshold !== undefined) {
    const proventhreshold = record.threshold ?? 0;
    if (proventhreshold < opts.minThreshold) {
      return {
        valid: false,
        status: "unmet_threshold",
        record,
        error: `Proven threshold (${proventhreshold}) is less than required minimum (${opts.minThreshold}).`,
      };
    }
  }

  return {
    valid: true,
    status: "verified",
    record,
  };
}

/**
 * Batched form of {@link hasClaim}: checks several claim types for one wallet.
 */
export async function hasClaims(
  wallet: string,
  types: readonly ClaimType[],
  opts?: BatchClaimOptions,
): Promise<Partial<Record<ClaimType, boolean>>> {
  const unique = Array.from(new Set(types));
  const results: Partial<Record<ClaimType, boolean>> = {};

  if (opts?.dryRun?.enabled) {
    for (const type of unique) {
      const minThreshold = opts.minThresholds?.[type];
      if (minThreshold !== undefined) {
        validateThreshold(minThreshold);
      }
      const result = dryRunStatus(wallet, type, {
        minThreshold,
        trustedIssuers: opts.trustedIssuers,
        throwOnError: opts.throwOnError,
        dryRun: opts.dryRun,
      });
      if (result?.status === "rpc_failure" && opts.throwOnError) {
        throw new RpcError(result.error ?? "Dry-run RPC failure");
      }
      results[type] = result?.valid === true;
    }
    return results;
  }

  warnIfMissingRegistryIdOnce();

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

  await fanOut(
    unique,
    async (t) => {
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
            opts?.source,
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
          opts?.source,
        );
        results[t] = !!r && r.valid;
      } catch (err) {
        if (opts?.throwOnError) throw err;
        results[t] = false;
      }
    },
    opts?.source !== "indexer",
  );

  return results;
}

/**
 * Verifies every claim in a selective-disclosure preset.
 */
export async function verifyPreset(
  wallet: string,
  claims: readonly PresetClaim[],
  opts?: Pick<
    BatchClaimOptions,
    "trustedIssuers" | "requestTimeoutMs" | "throwOnError" | "retryOptions" | "source"
  >,
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
    source: opts?.source,
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
  opts?: Pick<ClaimOptions, "throwOnError" | "requestTimeoutMs" | "retryOptions" | "dryRun">,
): Promise<Claim[]> {
  const throwOnError = opts?.throwOnError === true;

  if (opts?.dryRun?.enabled) {
    return CLAIM_TYPES.flatMap((type) => {
      const result = dryRunStatus(wallet, type, { dryRun: opts.dryRun });
      return result?.valid && result.record
        ? [{ type, verifiedAt: result.record.verifiedAt, expiry: result.record.expiry }]
        : [];
    });
  }

  warnIfMissingRegistryIdOnce();

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

  const results = await fanOut(
    CLAIM_TYPES,
    async (t) => {
      try {
        const r = await readIsVerified(
          normalizedWallet,
          t,
          undefined,
          throwOnError,
          opts?.requestTimeoutMs,
          opts?.retryOptions,
          opts?.source,
        );
        return r && r.valid ? { type: t, verifiedAt: r.verifiedAt, expiry: r.expiry } : null;
      } catch (err) {
        if (throwOnError) throw err;
        return null;
      }
    },
    opts?.source !== "indexer",
  );

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
  expiresInMinutes?: number;
  /**
   * When true, generate a URL-safe single-use token id (`jti`) and embed it
   * in the link. The verify page consumes it on first successful use and
   * rejects subsequent visits in the same browser session.
   */
  singleUse?: boolean;
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

  if (opts.expiresInMinutes !== undefined) {
    if (!Number.isFinite(opts.expiresInMinutes) || opts.expiresInMinutes <= 0) {
      throw new Error("expiresInMinutes must be a positive number");
    }
    const exp = Math.floor(Date.now() / 1000) + Math.floor(opts.expiresInMinutes * 60);
    url.searchParams.set("exp", String(exp));
  }

  if (opts.singleUse) {
    let jti: string;
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      jti = crypto.randomUUID().replace(/-/g, "");
    } else if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      jti = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    } else {
      throw new Error(
        "singleUse requires a crypto implementation with randomUUID or getRandomValues",
      );
    }
    url.searchParams.set("jti", jti);
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
  /**
   * See the warning on {@link ClaimOptions.source}. Note that a lagging indexer
   * can delay detection of a freshly-submitted claim, so a poll that ends in
   * {@link TimeoutError} may reflect indexer lag rather than a missing claim.
   */
  source?: ClaimSource;
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
  const source = opts?.source;
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
          source,
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
            source,
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

// ---------------------------------------------------------------------------
// Nullifier / Unique Personhood (#395)
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic per-app nullifier for cross-app unlinkable Sybil resistance (#395).
 * Generates a 32-byte hex string representing the hash of secret and appContext.
 */
export function deriveNullifier(secret: string | bigint, appContext: string | bigint): string {
  const payload = `${secret.toString()}::${appContext.toString()}`;
  let h1 = 0xdeadbeef ^ 42;
  let h2 = 0x41c6ce57 ^ 42;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const part1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const part2 = (h2 >>> 0).toString(16).padStart(8, "0");
  const part3 = (Math.imul(h1, 31) >>> 0).toString(16).padStart(8, "0");
  const part4 = (Math.imul(h2, 37) >>> 0).toString(16).padStart(8, "0");
  return `${part1}${part2}${part3}${part4}`.padEnd(64, "0");
}

/**
 * Checks on-chain whether a nullifier has already been recorded in a given application context.
 */
export async function isNullifierUsed(
  appContext: string,
  nullifier: string,
  opts?: { requestTimeoutMs?: number; throwOnError?: boolean },
): Promise<boolean> {
  const throwOnError = opts?.throwOnError === true;
  const client = (await getClient(throwOnError)) as any;
  if (!client) {
    return false;
  }
  if (typeof client.is_nullifier_used !== "function") {
    return false;
  }
  try {
    // The generated ProofRegistry bindings (packages/proof-registry) predate the
    // nullifier entrypoints (#395): the contract exposes `is_nullifier_used`, but
    // the generated client (and its spec) does not declare it yet. Call it through
    // the shape the contract actually implements so the SDK stays typed; once the
    // bindings are regenerated this narrows to the generated method.
    const { result } = await withRequestTimeout(
      () =>
        (
          client as unknown as {
            is_nullifier_used(args: {
              app_context: string;
              nullifier: string;
            }): Promise<{ result: boolean }>;
          }
        ).is_nullifier_used({
          app_context: appContext,
          nullifier,
        }),
      opts?.requestTimeoutMs ?? _config.requestTimeoutMs,
    );
    return result ?? false;
  } catch (err) {
    if (throwOnError) {
      if (err instanceof ConfigError) throw err;
      throw new RpcError(`Failed to check nullifier for context "${appContext}"`, {
        cause: err,
      });
    }
    return false;
  }
}

/**
 * High-level unique personhood gating (#395).
 * Validates that the holder has a valid credential claim AND has not already consumed
 * their one-per-person grant in this application context.
 */
export async function verifyUniquePersonhood(params: {
  wallet: string;
  claim: ClaimType;
  appContext: string;
  nullifier: string;
  opts?: ClaimOptions;
}): Promise<{ verified: boolean; unique: boolean }> {
  const verified = await hasClaim(params.wallet, params.claim, params.opts);
  if (!verified) {
    return { verified: false, unique: false };
  }

  const alreadyUsed = await isNullifierUsed(params.appContext, params.nullifier, {
    requestTimeoutMs: params.opts?.requestTimeoutMs,
    throwOnError: params.opts?.throwOnError,
  });

  return { verified: true, unique: !alreadyUsed };
}

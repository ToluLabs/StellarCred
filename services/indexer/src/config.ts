/**
 * config.ts — Load and validate all environment configuration.
 * Every other module imports from here; never from process.env directly.
 */

import { NETWORK_PRESETS, checkNetworkConsistency, parseNetwork } from "./networks";
import type { BreakerPolicy, RetryPolicy } from "./http-client";

export type DbDriver = "sqlite" | "postgres";

/**
 * Tuning for the shared outbound HTTP client (#761): retries with exponential
 * backoff for 429/5xx and a circuit breaker for a provider that stays down.
 */
export interface HttpClientConfig {
  retry: RetryPolicy;
  breaker: BreakerPolicy;
  /** Per-attempt request timeout in ms. */
  timeoutMs: number;
}

export interface Config {
  stellarNetwork: string;
  horizonUrl: string;
  rpcUrl: string;
  /** Network passphrase matching the selected network (preset or override). */
  networkPassphrase: string;
  proofRegistryContractId: string;
  dbDriver: DbDriver;
  sqlitePath: string;
  databaseUrl: string | undefined;
  pollIntervalMs: number;
  startLedger: number;
  port: number;
  /**
   * Number of ledgers to lag behind the network head before persisting.
   * This prevents near-head volatility (reorgs) from being indexed prematurely.
   * Default: 6 (≈30 seconds at ~5 s/ledger on Stellar).
   */
  finalityLag: number;
  corsOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rateLimitEnabled: boolean;
  /**
   * When set, /claims, /stats, and /recent require the key as either:
   *   Authorization: Bearer <key>   or   X-API-Key: <key>
   * Absent or empty → public mode. Treated as optional so Partial<Config>
   * exposes it in tests without requiring every caller to supply it.
   */
  apiKey?: string;
  /** HMAC key used to sign outbound claim lifecycle webhooks. */
  webhookSigningSecret?: string;
  /**
   * Run the on-chain data-integrity check (#612) on a schedule, re-reading a
   * rotating sample of indexed claims out of ProofRegistry state.
   */
  integrityCheckEnabled: boolean;
  /** Interval between integrity checks, in milliseconds. */
  integrityCheckIntervalMs: number;
  /** Claims compared against contract state per check. */
  integrityCheckSampleSize: number;
  /**
   * Outbound HTTP retry/circuit-breaker limits (#761). Optional like apiKey
   * so test fixtures built as full Config literals keep compiling; absent
   * means the client's documented defaults.
   */
  httpClient?: HttpClientConfig;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** Env int, clamped into [min, max]; a non-numeric value degrades to `def`. */
function clampedInt(name: string, def: number, min: number, max: number): number {
  const raw = Number(optional(name, String(def)));
  if (!Number.isFinite(raw)) return def;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

export function parseCorsOrigins(raw?: string): string[] {
  if (!raw || raw.trim() === "") {
    if (process.env.NODE_ENV === "production") {
      return [];
    }
    return ["http://localhost:3000"];
  }

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(): Config {
  const driver = optional("DB_DRIVER", "sqlite") as DbDriver;
  if (driver !== "sqlite" && driver !== "postgres") {
    throw new Error(`DB_DRIVER must be "sqlite" or "postgres", got: ${driver}`);
  }

  // ── Single network selector ────────────────────────────────────────────────
  // STELLAR_NETWORK (testnet | mainnet | futurenet) picks a coherent preset
  // for Horizon, RPC, and the network passphrase. Explicit env vars override
  // the preset — and the preflight below fails loudly if an override mixes
  // artifacts from a different network (e.g. mainnet passphrase + testnet
  // RPC), which would otherwise index the wrong chain silently.
  const rawNetwork = optional("STELLAR_NETWORK", "testnet");
  const network = parseNetwork(rawNetwork);
  if (!network) {
    throw new Error(
      `STELLAR_NETWORK must be one of testnet | mainnet | futurenet (aliases: public, main), got: "${rawNetwork}"`,
    );
  }
  const preset = NETWORK_PRESETS[network];
  const envHorizon = process.env["HORIZON_URL"];
  const envRpc = process.env["RPC_URL"];
  const envPassphrase = process.env["NETWORK_PASSPHRASE"];

  const mismatchProblems = checkNetworkConsistency({
    preset,
    horizonUrl: envHorizon,
    rpcUrl: envRpc,
    networkPassphrase: envPassphrase,
  });
  if (mismatchProblems.length > 0) {
    throw new Error(
      [
        `Mixed-network configuration detected (STELLAR_NETWORK=${network}):`,
        ...mismatchProblems.map((p) => `  - ${p}`),
        `Fix by setting STELLAR_NETWORK to the network your URLs/passphrase belong to, or removing the conflicting overrides.`,
      ].join("\n"),
    );
  }

  const rawCors = process.env["CORS_ALLOWED_ORIGINS"] ?? process.env["CORS_ORIGIN"];
  const windowSec = Number(optional("RATE_LIMIT_WINDOW_SECONDS", "60"));
  const maxReq = Number(
    process.env["RATE_LIMIT_MAX"] ??
      process.env["RATE_LIMIT_MAX_REQUESTS"] ??
      "120"
  );
  const rateLimitEnabled =
    optional("RATE_LIMIT_ENABLED", "true").toLowerCase() !== "false";
  const webhookSigningSecret = process.env["WEBHOOK_SIGNING_SECRET"]?.trim();
  if (webhookSigningSecret && webhookSigningSecret.length < 32) {
    throw new Error("WEBHOOK_SIGNING_SECRET must contain at least 32 characters");
  }

  // ── On-chain data-integrity checks (#612) ──────────────────────────────────
  // A periodic sampler keeps the derived claims table honest against the
  // contract it was derived from. Values are clamped rather than rejected so a
  // typo degrades to a sane schedule instead of taking the indexer down.
  const integrityIntervalSec = Number(optional("INTEGRITY_CHECK_INTERVAL_SECONDS", "900"));
  const integritySampleSize = Number(optional("INTEGRITY_CHECK_SAMPLE_SIZE", "25"));
  const integrityCheckEnabled =
    optional("INTEGRITY_CHECK_ENABLED", "true").toLowerCase() !== "false";

  // ── Outbound HTTP retry / circuit breaker (#761) ─────────────────────────
  // Clamped like the integrity settings: a typo must degrade to a sane limit,
  // not switch retry protection off or wedge the breaker permanently.
  const rawJitter = Number(optional("HTTP_RETRY_JITTER_RATIO", "0.2"));
  const jitterRatio = Number.isFinite(rawJitter) ? Math.min(1, Math.max(0, rawJitter)) : 0.2;

  return {
    stellarNetwork: network,
    horizonUrl: envHorizon ?? preset.horizonUrl,
    rpcUrl: envRpc ?? preset.rpcUrl,
    networkPassphrase: envPassphrase ?? preset.networkPassphrase,
    proofRegistryContractId: required("PROOF_REGISTRY_CONTRACT_ID"),
    dbDriver: driver,
    sqlitePath: optional("SQLITE_PATH", "./data/indexer.db"),
    databaseUrl: process.env["DATABASE_URL"],
    pollIntervalMs:
      Number(optional("POLL_INTERVAL_SECONDS", "6")) * 1000,
    startLedger: Number(optional("START_LEDGER", "0")),
    port: Number(optional("PORT", "3001")),
    finalityLag: Number(optional("FINALITY_LAG", "6")),
    corsOrigins: parseCorsOrigins(rawCors),
    rateLimitWindowMs: (Number.isFinite(windowSec) && windowSec > 0 ? windowSec : 60) * 1000,
    rateLimitMax: Number.isFinite(maxReq) && maxReq > 0 ? maxReq : 120,
    rateLimitEnabled,
    webhookSigningSecret,
    integrityCheckEnabled,
    integrityCheckIntervalMs:
      Number.isFinite(integrityIntervalSec) && integrityIntervalSec > 0
        ? integrityIntervalSec * 1000
        : 900_000,
    integrityCheckSampleSize:
      Number.isFinite(integritySampleSize) && integritySampleSize > 0
        ? Math.floor(integritySampleSize)
        : 25,
    httpClient: {
      retry: {
        maxAttempts: clampedInt("HTTP_MAX_ATTEMPTS", 3, 1, 10),
        baseDelayMs: clampedInt("HTTP_RETRY_BASE_MS", 500, 0, 10_000),
        maxDelayMs: clampedInt("HTTP_RETRY_MAX_DELAY_MS", 8_000, 0, 120_000),
        jitterRatio,
      },
      breaker: {
        failureThreshold: clampedInt("HTTP_BREAKER_FAILURE_THRESHOLD", 5, 1, 100),
        resetTimeoutMs: clampedInt("HTTP_BREAKER_RESET_MS", 30_000, 1_000, 3_600_000),
      },
      timeoutMs: clampedInt("HTTP_REQUEST_TIMEOUT_MS", 10_000, 100, 300_000),
    },
  };
}

// @stellarcred/sdk — opt-in telemetry with zero-PII sanitization
//
// Issue #1064: SDK diagnostic logging risks capturing private keys, credential
// claims, addresses, or proof witnesses in telemetry streams. This module is
// the only supported way to emit SDK diagnostics: it is **disabled until the
// integrator explicitly opts in**, and every event is scrubbed before it can
// leave the process.
//
// Two independent guarantees:
//
//   1. Opt-in. Nothing is recorded, buffered, or transmitted until
//      `configureTelemetry({ enabled: true, … })` is called. There is no
//      environment variable, no implicit endpoint, and no default sink.
//
//   2. Sanitization. Event names and attribute keys/values are filtered by
//      `sanitizeTelemetryEvent`:
//        - well-known secret shapes (Stellar G/C/S keys, 64/128-char hex
//          keys, JWTs, e-mail addresses, Bearer tokens, provider API keys)
//          are replaced with `[redacted]`;
//        - attribute keys that describe secrets, credentials, proofs,
//          witnesses, addresses, or identity fields are dropped entirely;
//        - non-primitive values are JSON-encoded with sensitive keys removed,
//          scrubbed, and truncated.
//
// Telemetry must never break the host application: `trackEvent` and
// `flushTelemetry` swallow transport and sink errors. Only explicit
// configuration (`configureTelemetry`) throws, because a misconfigured
// endpoint is a developer error worth surfacing at startup.
//
//   import { configureTelemetry, trackEvent } from "@stellarcred/sdk";
//
//   configureTelemetry({ enabled: true, endpoint: "https://telemetry.example.com/v1/events" });
//   trackEvent("claim.check", { source: "chain", outcome: "success" });
//
// See README §Telemetry (opt-in, zero-PII).

/** Replacement marker for any scrubbed value. */
export const TELEMETRY_REDACTED = "[redacted]";

export type TelemetryPrimitive = string | number | boolean;

/** Flat, non-identifying attributes attached to an event. */
export type TelemetryAttributes = Record<string, TelemetryPrimitive>;

/** A single sanitized telemetry event. */
export interface TelemetryEvent {
  /** Operation name, e.g. `"claim.check"`. Sanitized and normalised. */
  name: string;
  /** ISO-8601 timestamp recorded locally. Never derived from user input. */
  timestamp: string;
  /** Wall-clock duration in whole milliseconds, when instrumented. */
  durationMs?: number;
  /** Whether the instrumented operation succeeded or failed. */
  outcome?: "success" | "error";
  /** Sanitized attributes. Sensitive keys never reach this object. */
  attributes: TelemetryAttributes;
}

/** Receives batches of already-sanitized events. */
export type TelemetrySink = (events: readonly TelemetryEvent[]) => void | Promise<void>;

export interface TelemetryOptions {
  /**
   * Explicit opt-in. Telemetry stays completely inert unless this is `true`.
   * Calling `configureTelemetry({ enabled: false })` disables an active
   * configuration and discards any buffered events.
   */
  enabled: boolean;

  /**
   * HTTPS collector URL. Mutually exclusive with `sink` (but either is
   * enough). Credentials in the URL, query strings and fragments are
   * rejected so a key cannot be smuggled in through configuration.
   * `http://` is rejected except for loopback hosts when
   * `allowInsecureLocalhost: true`.
   */
  endpoint?: string;

  /** Custom sink, e.g. to forward into your own telemetry pipeline. */
  sink?: TelemetrySink;

  /** Stable application name (not a wallet address). Scrubbed before use. */
  appId?: string;

  /** Flush automatically once this many events are buffered. Default 20. */
  maxBatchSize?: number;

  /** Flush periodically, in milliseconds. `0` disables the timer. Default 30000. */
  flushIntervalMs?: number;

  /** Allow `http://localhost` endpoints for local development. Default false. */
  allowInsecureLocalhost?: boolean;
}

/** Thrown only for invalid explicit telemetry configuration. */
export class TelemetryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryConfigError";
  }
}

export interface TelemetryConfigSnapshot {
  enabled: boolean;
  endpoint: string | null;
  appId: string | null;
  maxBatchSize: number;
  flushIntervalMs: number;
}

const DEFAULT_MAX_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const MAX_ATTRIBUTES = 32;
const MAX_NAME_LENGTH = 64;
const MAX_KEY_LENGTH = 40;
const MAX_NESTED_LENGTH = 512;

// ── Sensitive-key detection ──────────────────────────────────────────────────

const SENSITIVE_TOKENS = new Set([
  "private",
  "privkey",
  "privatekey",
  "secret",
  "seed",
  "mnemonic",
  "password",
  "passphrase",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "auth",
  "signature",
  "sig",
  "credential",
  "credentials",
  "claim",
  "claims",
  "proof",
  "proofs",
  "witness",
  "witnesses",
  "nullifier",
  "address",
  "wallet",
  "account",
  "holder",
  "subject",
  "email",
  "phone",
  "dob",
  "birth",
  "birthdate",
  "ssn",
  "passport",
  "document",
  "name",
  "username",
  "firstname",
  "lastname",
  "nationality",
]);

const SENSITIVE_SUBSTRINGS = [
  "privatekey",
  "private_key",
  "secretkey",
  "secret_key",
  "apikey",
  "api_key",
  "licensekey",
  "license_key",
];

/**
 * True when an attribute key should be dropped before transmission.
 * Splits camelCase and snake_case so `walletAddress` and `wallet_address`
 * are both caught.
 */
export function isSensitiveTelemetryKey(key: string): boolean {
  const normalised = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .trim();
  if (SENSITIVE_SUBSTRINGS.some((needle) => normalised.includes(needle))) return true;
  return normalised
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) => SENSITIVE_TOKENS.has(token));
}

// ── Value scrubbing ──────────────────────────────────────────────────────────

// Stellar G… (public account), C… (contract) and S… (secret seed) strkeys.
const STELLAR_KEY_RE = /\b[GCS][A-Z2-7]{55}\b/g;
// Raw 32/64-byte keys and hashes: 64 or 128 hex characters, optionally 0x-prefixed.
const HEX_KEY_RE = /\b(?:0x)?[0-9a-fA-F]{64}(?:[0-9a-fA-F]{64})?\b/g;
// JWTs (three base64url segments).
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
// E-mail addresses.
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// `Bearer <token>` headers.
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi;
// Common provider API-key prefixes (Stripe/Segment-style).
const PROVIDER_KEY_RE = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}\b/g;

/**
 * Replace anything that looks like a secret, address, or identity value.
 * Exported so integrations can prove the same filter is applied to values
 * they collect themselves.
 */
export function sanitizeTelemetryValue(value: unknown): TelemetryPrimitive | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") return sanitizeTelemetryValue(value.toString());
  if (typeof value === "string") return scrubTelemetryString(value);
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    // Attributes are flat, but never trust the shape: stringify with
    // sensitive keys removed, then scrub the serialized form as well.
    try {
      const json = JSON.stringify(value, (key, nested) =>
        key && isSensitiveTelemetryKey(key) ? undefined : nested,
      );
      if (typeof json !== "string") return undefined;
      return scrubTelemetryString(json).slice(0, MAX_NESTED_LENGTH);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function scrubTelemetryString(input: string): string {
  return input
    .replace(JWT_RE, TELEMETRY_REDACTED)
    .replace(BEARER_RE, `Bearer ${TELEMETRY_REDACTED}`)
    .replace(PROVIDER_KEY_RE, TELEMETRY_REDACTED)
    .replace(EMAIL_RE, TELEMETRY_REDACTED)
    .replace(STELLAR_KEY_RE, TELEMETRY_REDACTED)
    .replace(HEX_KEY_RE, TELEMETRY_REDACTED);
}

/** Normalise and scrub an attribute key. Returns null when it is unusable. */
export function sanitizeTelemetryKey(key: string): string | null {
  if (typeof key !== "string") return null;
  const cleaned = scrubTelemetryString(key)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/** Normalise and scrub an event name. */
export function sanitizeTelemetryName(name: string): string {
  if (typeof name !== "string") return "unnamed.event";
  const cleaned = scrubTelemetryString(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : "unnamed.event";
}

/**
 * Sanitize an attribute bag: sensitive keys are dropped, every remaining
 * value is scrubbed, and the result is bounded in size.
 */
export function sanitizeTelemetryAttributes(input: unknown): TelemetryAttributes {
  const out: TelemetryAttributes = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) return out;

  let accepted = 0;
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (accepted >= MAX_ATTRIBUTES) break;
    const key = sanitizeTelemetryKey(rawKey);
    if (!key) continue;
    if (isSensitiveTelemetryKey(rawKey) || isSensitiveTelemetryKey(key)) continue;
    const value = sanitizeTelemetryValue(rawValue);
    if (value === undefined) continue;
    out[key] = value;
    accepted += 1;
  }
  return out;
}

// ── Configuration state ──────────────────────────────────────────────────────

interface ResolvedTelemetryConfig {
  enabled: boolean;
  endpoint: string | null;
  sink: TelemetrySink | null;
  appId: string | null;
  maxBatchSize: number;
  flushIntervalMs: number;
  extraSensitiveKeys: Set<string>;
}

function disabledConfig(): ResolvedTelemetryConfig {
  return {
    enabled: false,
    endpoint: null,
    sink: null,
    appId: null,
    maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
    flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
    extraSensitiveKeys: new Set(),
  };
}

let _config: ResolvedTelemetryConfig = disabledConfig();
const _buffer: TelemetryEvent[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;

function clearFlushTimer(): void {
  if (_flushTimer !== null) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}

function validateEndpoint(raw: string, allowInsecureLocalhost: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TelemetryConfigError("telemetry endpoint must be a valid absolute URL");
  }
  if (url.username || url.password) {
    throw new TelemetryConfigError(
      "telemetry endpoint must not embed credentials; send auth via your own sink",
    );
  }
  if (url.search || url.hash) {
    throw new TelemetryConfigError(
      "telemetry endpoint must not contain a query string or fragment (a key could leak into logs)",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  const secure = url.protocol === "https:";
  const insecureLoopback = url.protocol === "http:" && loopback && allowInsecureLocalhost;
  if (!secure && !insecureLoopback) {
    throw new TelemetryConfigError(
      "telemetry endpoint must use https:// (http:// is only allowed for loopback with allowInsecureLocalhost)",
    );
  }
  return url.toString();
}

function resolveOptions(opts: TelemetryOptions): ResolvedTelemetryConfig {
  if (!opts || opts.enabled !== true) {
    return disabledConfig();
  }

  const maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 1000) {
    throw new TelemetryConfigError("maxBatchSize must be an integer between 1 and 1000");
  }

  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  if (!Number.isFinite(flushIntervalMs) || flushIntervalMs < 0) {
    throw new TelemetryConfigError("flushIntervalMs must be a non-negative number");
  }

  if (opts.sink !== undefined && typeof opts.sink !== "function") {
    throw new TelemetryConfigError("sink must be a function");
  }

  const endpoint =
    opts.endpoint === undefined
      ? null
      : validateEndpoint(opts.endpoint, opts.allowInsecureLocalhost === true);

  if (!endpoint && !opts.sink) {
    throw new TelemetryConfigError(
      "telemetry requires either an endpoint or a sink; nothing would consume the events",
    );
  }

  let appId: string | null = null;
  if (opts.appId !== undefined) {
    const sanitized =
      typeof opts.appId === "string" ? sanitizeTelemetryValue(opts.appId) : undefined;
    appId = typeof sanitized === "string" ? sanitized.slice(0, MAX_NAME_LENGTH) : null;
  }

  return {
    enabled: true,
    endpoint,
    sink: opts.sink ?? null,
    appId,
    maxBatchSize,
    flushIntervalMs,
    extraSensitiveKeys: new Set(),
  };
}

/**
 * Opt in to telemetry. Until this is called with `enabled: true`, the SDK
 * records nothing at all.
 *
 * @throws {TelemetryConfigError} for an invalid endpoint, batch size, interval,
 *   or when neither `endpoint` nor `sink` is supplied.
 */
export function configureTelemetry(opts: TelemetryOptions): void {
  const next = resolveOptions(opts);
  clearFlushTimer();
  _buffer.length = 0;
  _config = next;

  if (_config.enabled && _config.flushIntervalMs > 0) {
    _flushTimer = setInterval(() => {
      void flushTelemetry();
    }, _config.flushIntervalMs);
    // Do not keep a Node.js process alive just for telemetry.
    const timer = _flushTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }
}

/** Turn telemetry off and drop anything still buffered. */
export function disableTelemetry(): void {
  configureTelemetry({ enabled: false });
}

/** True only after an explicit opt-in. */
export function isTelemetryEnabled(): boolean {
  return _config.enabled;
}

/** Public, secret-free view of the active configuration. */
export function getTelemetryConfig(): TelemetryConfigSnapshot {
  return {
    enabled: _config.enabled,
    endpoint: _config.endpoint,
    appId: _config.appId,
    maxBatchSize: _config.maxBatchSize,
    flushIntervalMs: _config.flushIntervalMs,
  };
}

/**
 * Restore the module to its initial, disabled state. Intended for tests and
 * for hosts that tear down and re-initialise the SDK in-process.
 */
export function resetTelemetry(): void {
  clearFlushTimer();
  _buffer.length = 0;
  _config = disabledConfig();
}

// ── Recording ────────────────────────────────────────────────────────────────

export interface TelemetryEventMeta {
  durationMs?: number;
  outcome?: "success" | "error";
}

/**
 * Record one sanitized event. A no-op unless telemetry is enabled.
 * Never throws: telemetry must not be able to break the host application.
 */
export function trackEvent(
  name: string,
  attributes: TelemetryAttributes = {},
  meta: TelemetryEventMeta = {},
): void {
  if (!_config.enabled) return;

  const event: TelemetryEvent = {
    name: sanitizeTelemetryName(name),
    timestamp: new Date().toISOString(),
    attributes: sanitizeTelemetryAttributes(attributes),
  };

  if (_config.appId) event.attributes.app_id = _config.appId;

  if (meta.durationMs !== undefined && Number.isFinite(meta.durationMs) && meta.durationMs >= 0) {
    event.durationMs = Math.round(meta.durationMs);
  }
  if (meta.outcome === "success" || meta.outcome === "error") {
    event.outcome = meta.outcome;
  }

  _buffer.push(event);
  if (_buffer.length >= _config.maxBatchSize) {
    void flushTelemetry();
  }
}

/**
 * Wrap an async operation, recording its duration and outcome. Only the
 * operation name and caller-supplied (sanitized) attributes are reported —
 * never the error message, stack, or result.
 */
export async function withTelemetry<T>(
  name: string,
  operation: () => Promise<T>,
  attributes: TelemetryAttributes = {},
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    trackEvent(name, attributes, { durationMs: Date.now() - startedAt, outcome: "success" });
    return result;
  } catch (error) {
    trackEvent(name, attributes, { durationMs: Date.now() - startedAt, outcome: "error" });
    throw error;
  }
}

async function postTelemetryBatch(
  endpoint: string,
  events: readonly TelemetryEvent[],
): Promise<void> {
  if (typeof fetch !== "function") return;
  await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    keepalive: events.length <= 32,
  });
}

/**
 * Send everything buffered. Called automatically on batch size and on the
 * configured interval; call it directly before a process exits.
 * Transport and sink failures are swallowed by design.
 */
export async function flushTelemetry(): Promise<void> {
  if (!_config.enabled) {
    _buffer.length = 0;
    return;
  }
  if (_buffer.length === 0) return;

  const batch = _buffer.splice(0, _buffer.length);
  const sink = _config.sink;
  const endpoint = _config.endpoint;

  try {
    if (sink) {
      await sink(
        batch.map((event) => ({
          ...event,
          attributes: { ...event.attributes },
        })),
      );
    } else if (endpoint) {
      await postTelemetryBatch(endpoint, batch);
    }
  } catch {
    // Telemetry is best-effort. Dropping a batch beats breaking the caller.
  }
}

/**
 * Namespace object re-exported as `StellarCred.telemetry`, so the whole
 * interface is reachable from the default export without growing the barrel.
 */
export const telemetry = {
  configure: configureTelemetry,
  getConfig: getTelemetryConfig,
  isEnabled: isTelemetryEnabled,
  track: trackEvent,
  withTiming: withTelemetry,
  flush: flushTelemetry,
  disable: disableTelemetry,
  reset: resetTelemetry,
  sanitizeAttributes: sanitizeTelemetryAttributes,
} as const;

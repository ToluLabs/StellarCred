import pino from "pino";

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
  level: LOG_LEVEL,
});


// Correlates one issuance across /api/issue -> /api/witness -> /api/plaid-balance
// (and any Persona relay round-trip) so every log line for a single request can
// be grepped by requestId.
// Note: resolveRequestId is now defined in middleware.ts to avoid crypto module
// imports in edge runtime

/**
 * Canonical request-id resolver shared by API route handlers.
 *
 * Accepts the inbound `x-request-id` header value and returns it when it is a
 * valid 1-64 character alphanumeric / dash / underscore string.  Otherwise
 * generates a random 32-char hex id.
 */
export function resolveRequestId(
  inbound: string | null | undefined,
): string {
  const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  if (inbound && REQUEST_ID_RE.test(inbound)) return inbound;
  const bytes = new Uint8Array(16);
  // crypto.getRandomValues is available in Node 19+ and all modern runtimes
  // (Web Crypto API).  Falls back to Math.random when unavailable (e.g.
  // non-Edge Node <19).
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Explicit allowlist of fields that are safe to log.
// Exported so that error-reporting.ts can apply the same gate to outgoing
// webhook payloads (issue #553).
export const SAFE_FIELDS = [
  "event",
  "credentialType",
  "issuerId",
  "walletAddress",
  "outcome",
  "durationMs",
  "requestId",
  "level",
  "time",
  "pid",
  "hostname",
  "error",
  "needsPersona",
  "method",
  "path",
  "status",
  "demoIssuer",
  "plaidMock",
  "personaDemo",
  "environment",
  "timestamp",
  "auditIndex",
  "auditHash",
  // Plaid multi-item aggregation: ordinals and counts only — never account
  // names, balances, or token identifiers.
  "itemIndex",
  "itemCount",
  "accountCount",
  "cspViolation",
  "sentryEventId",
];

export function stripSensitiveFields<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key in obj) {
    if (SAFE_FIELDS.includes(key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

// Branch-coverage note: the non-object guard below is exercised by the
// safeInfo/safeWarn/safeError tests so that both sides of the conditional are
// covered. Callers passing a non-object (e.g. null/undefined from untyped
// boundaries) get an empty, safe payload instead of a TypeError.
export function scrubPayload(obj: unknown): Record<string, unknown> {
  if (obj === null || typeof obj !== "object") return {};
  return stripSensitiveFields(obj as Record<string, unknown>) as Record<string, unknown>;
}

// Centralized safe-logging wrappers. Every call automatically scrubs the
// payload through stripSensitiveFields so call sites cannot accidentally log
// sensitive data. The underlying pino methods are invoked with the same
// (obj, msg) argument order as before, preserving existing log structure.
export function safeInfo(
  obj: Record<string, unknown>,
  msg?: string,
  ...args: unknown[],
): void {
  logger.info(scrubPayload(obj), msg, ...args);
}

export function safeWarn(
  obj: Record<string, unknown>,
  msg?: string,
  ...args: unknown[],
): void {
  logger.warn(scrubPayload(obj), msg, ...args);
}

export function safeError(
  obj: Record<string, unknown>,
  msg?: string,
  ...args: unknown[],
): void {
  logger.error(scrubPayload(obj), msg, ...args);
}

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

// Explicit allowlist of fields that are safe to log
const SAFE_FIELDS = [
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

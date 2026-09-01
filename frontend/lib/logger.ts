import pino from "pino";
import { randomBytes } from "crypto";

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
  level: LOG_LEVEL,
});

// Correlates one issuance across /api/issue -> /api/witness -> /api/plaid-balance
// (and any Persona relay round-trip) so every log line for a single request can
// be grepped by requestId. Accepts a client/upstream-supplied id so the id
// survives client-side round-trips (e.g. the Persona redirect); falls back to
// generating a fresh one. Restricted to a safe charset — this value is echoed
// back in the `x-request-id` response header and logged verbatim.
const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function resolveRequestId(inbound: string | null | undefined): string {
  if (inbound && REQUEST_ID_RE.test(inbound)) return inbound;
  return randomBytes(16).toString("hex");
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

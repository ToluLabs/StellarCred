import pino from "pino";

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
  level: LOG_LEVEL,
});

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

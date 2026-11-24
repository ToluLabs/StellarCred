// Structured error reporting and production telemetry (#941).

import { resolveRequestId, stripSensitiveFields } from "./logger";
import { safeErrorMessage } from "./error-reporting";

export type TelemetryCategory = "wallet" | "proof" | "api" | "auth" | "verification";
export type TelemetrySeverity = "info" | "warn" | "error" | "fatal";

export interface TelemetryEventInput {
  category: TelemetryCategory;
  severity: TelemetrySeverity;
  event: string;
  errorCode?: string;
  requestId?: string;
  walletAddress?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
  error?: unknown;
}

export interface TelemetryRecord {
  timestamp: string;
  category: TelemetryCategory;
  severity: TelemetrySeverity;
  event: string;
  errorCode: string | null;
  requestId: string;
  walletAddress: string | null;
  durationMs: number | null;
  context: Record<string, unknown>;
  errorMessage: string | null;
  environment: string;
}

const SENSITIVE_KEY_PATTERNS = [
  /secret/i,
  /private/i,
  /seed/i,
  /passphrase/i,
  /token/i,
  /password/i,
  /signature/i,
  /auth/i,
  /credential_data/i,
  /salt/i,
];

/**
 * Mask Stellar public keys for safe logging (e.g. GABC...XYZ).
 * Never leaks the full account identity across telemetry sinks.
 */
export function maskWalletAddress(address: string | null | undefined): string | null {
  if (!address || typeof address !== "string") return null;
  const trimmed = address.trim();
  if (trimmed.length < 10) return "[invalid-wallet]";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Redact sensitive properties from context payloads.
 */
export function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> {
  if (!context || typeof context !== "object") return {};
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (isSensitive) {
      cleaned[key] = "[redacted]";
      continue;
    }

    if (typeof value === "string") {
      cleaned[key] = safeErrorMessage(value);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      cleaned[key] = value;
    } else if (Array.isArray(value)) {
      cleaned[key] = `[array length=${value.length}]`;
    } else if (typeof value === "object") {
      cleaned[key] = sanitizeContext(value as Record<string, unknown>);
    } else {
      cleaned[key] = "[unsupported-type]";
    }
  }

  return stripSensitiveFields(cleaned) as Record<string, unknown>;
}

type TelemetryListener = (record: TelemetryRecord) => void;
const listeners = new Set<TelemetryListener>();

export function registerTelemetryListener(listener: TelemetryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Build a structured telemetry record with standardized correlation and redaction.
 */
export function buildTelemetryRecord(input: TelemetryEventInput): TelemetryRecord {
  const requestId = resolveRequestId(input.requestId);
  const errorMessage = input.error ? safeErrorMessage(input.error) : null;

  return {
    timestamp: new Date().toISOString(),
    category: input.category,
    severity: input.severity,
    event: input.event,
    errorCode: input.errorCode ?? null,
    requestId,
    walletAddress: maskWalletAddress(input.walletAddress),
    durationMs: typeof input.durationMs === "number" ? Math.max(0, input.durationMs) : null,
    context: sanitizeContext(input.context),
    errorMessage,
    environment: process.env.NODE_ENV ?? "development",
  };
}

/**
 * Emit a structured telemetry record to all registered listeners.
 */
export function emitTelemetry(input: TelemetryEventInput): TelemetryRecord {
  const record = buildTelemetryRecord(input);
  for (const listener of listeners) {
    try {
      listener(record);
    } catch {
      // listener failure suppressed
    }
  }
  return record;
}

export function recordWalletFailure(
  event: string,
  error: unknown,
  context?: Record<string, unknown>,
  walletAddress?: string,
): TelemetryRecord {
  return emitTelemetry({
    category: "wallet",
    severity: "error",
    event,
    errorCode: error instanceof Error ? error.name : "WALLET_ERROR",
    walletAddress,
    error,
    context,
  });
}

export function recordProofFailure(
  event: string,
  error: unknown,
  context?: Record<string, unknown>,
  durationMs?: number,
): TelemetryRecord {
  return emitTelemetry({
    category: "proof",
    severity: "error",
    event,
    errorCode: "PROOF_GENERATION_FAILED",
    durationMs,
    error,
    context,
  });
}

export function recordApiFailure(
  event: string,
  error: unknown,
  status: number,
  requestId?: string,
  context?: Record<string, unknown>,
): TelemetryRecord {
  return emitTelemetry({
    category: "api",
    severity: status >= 500 ? "error" : "warn",
    event,
    errorCode: `HTTP_${status}`,
    requestId,
    error,
    context,
  });
}

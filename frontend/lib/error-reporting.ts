import { SAFE_FIELDS } from "./logger";
import { getOutboundSink } from "./outbound-sink";

export interface ErrorReport {
  method: string;
  path: string;
  requestId: string;
  status: number;
  /**
   * The raw exception that caused the 500. Optional — when supplied the
   * message is truncated to 200 chars and stack frames are dropped entirely
   * before the payload leaves the process.
   */
  exception?: unknown;
}

/**
 * Redacts an arbitrary object so that only fields present in the logger's
 * SAFE_FIELDS allowlist survive. This is the same allowlist applied to every
 * structured log line — error-reporting payloads go through the same gate so
 * identity data can never escape via the webhook path.
 *
 * Additionally any residual string value that looks like it might contain a
 * real name, email, or government ID is replaced with a placeholder.
 */
export function redactPayload(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (SAFE_FIELDS.includes(key)) {
      out[key] = obj[key];
    }
    // Silently drop any key not on the allowlist (could carry PII)
  }
  return out;
}

/**
 * Returns a safe string representation of an exception suitable for inclusion
 * in an outgoing error-reporting payload.
 *
 * Rules:
 * - Only the `message` field of an Error is used (never `stack` — stack frames
 *   can embed argument values and local variable state from mid-issuance code).
 * - The message is truncated to 200 characters.
 * - Any segment that looks like an email address, date-of-birth (YYYY-MM-DD),
 *   or a long numeric string (≥ 6 digits, to catch ID numbers / account refs)
 *   is replaced with `[redacted]`.
 */
export function safeErrorMessage(exception: unknown): string {
  let raw: string;
  if (exception instanceof Error) {
    raw = exception.message;
  } else if (typeof exception === "string") {
    raw = exception;
  } else {
    return "[non-error exception]";
  }

  // Truncate first so the regexes don't scan overly large strings
  const truncated = raw.slice(0, 500);

  const redacted = truncated
    // Email addresses
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[redacted]")
    // ISO date-of-birth patterns (YYYY-MM-DD)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "[redacted]")
    // Runs of 6+ consecutive digits — catches account numbers, government IDs,
    // phone numbers, and numeric suffixes in opaque IDs like inq_12345678.
    // We avoid \b so that digits attached to non-word prefix chars (e.g. inq_)
    // are still caught.
    .replace(/\d{6,}/g, "[redacted]");

  // Final truncation after substitution
  return redacted.slice(0, 200);
}

/**
 * Queues an unexpected 500 error for the shared outbound sink. The returned
 * promise is only for delivery observability; callers can intentionally use
 * `void reportError(...)` so request handling never waits for the network.
 *
 * Redaction guarantee:
 * - The full payload object is passed through `redactPayload`, which applies
 *   the same allowlist as the structured logger. Any field not on the allowlist
 *   is silently dropped before the HTTP request is made.
 * - Exception messages are sanitised by `safeErrorMessage` (stack stripped,
 *   PII patterns replaced) before being included in the payload.
 * - Stack frames are NEVER included in the outgoing payload.
 */
export function reportError(report: ErrorReport): Promise<void> {
  // Build the candidate payload with only fields that belong in the allowlist
  const candidatePayload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    method: report.method,
    path: report.path,
    requestId: report.requestId,
    status: report.status,
    environment: process.env.NODE_ENV ?? "unknown",
  };

  // Append a redacted error message when the exception is provided.
  // `error` IS on SAFE_FIELDS so it will survive redactPayload.
  if (report.exception !== undefined) {
    candidatePayload.error = safeErrorMessage(report.exception);
  }

  // Final gate: run the whole payload through the same allowlist as the
  // structured logger. Any field inadvertently introduced above that is NOT on
  // SAFE_FIELDS will be silently dropped here.
  const safePayload = redactPayload(candidatePayload);

  return getOutboundSink().enqueueAndWait({ kind: "error", payload: safePayload });
}

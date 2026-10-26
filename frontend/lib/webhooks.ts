// frontend/lib/webhooks.ts
//
// Webhook signature verification, normalization, and reconciliation for
// asynchronous issuance callbacks from external identity providers (#846).

import crypto from "node:crypto";

export type WebhookProvider = "persona" | "plaid" | "custom" | string;
export type WebhookIssuanceStatus = "completed" | "failed" | "pending";

export interface NormalizedIssuanceEvent {
  eventId: string;
  provider: WebhookProvider;
  eventType: string;
  status: WebhookIssuanceStatus;
  credentialType: string;
  timestamp: number;
  inquiryId?: string;
  walletAddress?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

// Sensitive field keys that must NEVER be logged or stored in webhook metadata
const SENSITIVE_KEYS = new Set([
  "secret",
  "secret_key",
  "apikey",
  "api_key",
  "authorization",
  "password",
  "token",
  "access_token",
  "private_key",
  "privatekey",
  "ssn",
  "tax_id",
  "date_of_birth",
  "dob",
  "id_number",
]);

/**
 * Sanitizes an object by recursively removing sensitive keys.
 */
export function sanitizeWebhookPayload(obj: unknown): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      SENSITIVE_KEYS.has(lowerKey) ||
      lowerKey.includes("secret") ||
      lowerKey.includes("token") ||
      lowerKey.includes("key") ||
      lowerKey.includes("password") ||
      lowerKey.includes("auth")
    ) {
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeWebhookPayload(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Verifies HMAC-SHA256 signatures for inbound webhook callbacks.
 * Supports standard raw hex, `sha256=<hex>`, and timestamped signatures `t=<ts>,v1=<hex>`.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !secret || typeof rawBody !== "string") {
    return false;
  }

  try {
    let expectedSigHex: string;
    let actualSigHex: string;

    // Format 1: Timestamped header `t=123456,v1=abcdef...`
    if (signatureHeader.includes("t=") && signatureHeader.includes("v1=")) {
      const parts = signatureHeader.split(",").reduce<Record<string, string>>((acc, item) => {
        const [k, v] = item.trim().split("=");
        if (k && v) acc[k] = v;
        return acc;
      }, {});

      const timestamp = parts.t;
      actualSigHex = parts.v1;
      if (!timestamp || !actualSigHex) return false;

      // Bound timestamp skew to 5 minutes to prevent replay attacks
      const now = Math.floor(Date.now() / 1000);
      const parsedTime = parseInt(timestamp, 10);
      if (isNaN(parsedTime) || Math.abs(now - parsedTime) > 300) {
        return false;
      }

      expectedSigHex = crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
    } else {
      // Format 2: Direct hex or `sha256=<hex>`
      actualSigHex = signatureHeader.startsWith("sha256=")
        ? signatureHeader.slice(7)
        : signatureHeader;

      expectedSigHex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    }

    if (actualSigHex.length !== expectedSigHex.length) {
      return false;
    }

    const actualBuffer = Buffer.from(actualSigHex, "hex");
    const expectedBuffer = Buffer.from(expectedSigHex, "hex");

    if (actualBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Parses and normalizes diverse provider callback payloads into a standard issuance event.
 */
export function parseAndNormalizeCallback(rawInput: unknown): NormalizedIssuanceEvent | null {
  let parsed: Record<string, unknown>;

  if (typeof rawInput === "string") {
    try {
      parsed = JSON.parse(rawInput);
    } catch {
      return null;
    }
  } else if (typeof rawInput === "object" && rawInput !== null) {
    parsed = rawInput as Record<string, unknown>;
  } else {
    return null;
  }

  // Handle standard NormalizedIssuanceEvent
  if (
    typeof parsed.eventId === "string" &&
    typeof parsed.status === "string" &&
    typeof parsed.credentialType === "string"
  ) {
    const rawStatus = (parsed.status as string).toLowerCase();
    const status: WebhookIssuanceStatus =
      rawStatus === "completed" || rawStatus === "approved" || rawStatus === "success"
        ? "completed"
        : rawStatus === "failed" || rawStatus === "rejected" || rawStatus === "declined"
        ? "failed"
        : "pending";

    return {
      eventId: parsed.eventId,
      provider: (parsed.provider as string) ?? "custom",
      eventType: (parsed.eventType as string) ?? `issuance.${status}`,
      status,
      credentialType: parsed.credentialType,
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
      inquiryId: typeof parsed.inquiryId === "string" ? parsed.inquiryId : undefined,
      walletAddress: typeof parsed.walletAddress === "string" ? parsed.walletAddress : undefined,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      metadata: sanitizeWebhookPayload(parsed.metadata ?? {}),
    };
  }

  // Handle Persona webhook payload shape
  if (parsed.data && typeof parsed.data === "object") {
    const data = parsed.data as Record<string, unknown>;
    const attrs = (data.attributes ?? {}) as Record<string, unknown>;
    const inquiryId = (data.id as string) ?? (attrs.id as string) ?? "unknown_inquiry";
    const eventName = (parsed.name as string) ?? (attrs.status as string) ?? "inquiry.completed";
    const statusStr = ((attrs.status as string) ?? eventName).toLowerCase();

    const status: WebhookIssuanceStatus =
      statusStr.includes("approved") || statusStr.includes("completed")
        ? "completed"
        : statusStr.includes("declined") || statusStr.includes("failed")
        ? "failed"
        : "pending";

    // Extract wallet address and credential type from fields if present
    const fields = (attrs.fields ?? {}) as Record<string, { value?: unknown }>;
    const walletAddress = typeof fields.wallet_address?.value === "string"
      ? fields.wallet_address.value
      : undefined;
    const credentialType = typeof fields.credential_type?.value === "string"
      ? fields.credential_type.value
      : "kyc";

    return {
      eventId: (parsed.id as string) ?? `evt_${inquiryId}_${Date.now()}`,
      provider: "persona",
      eventType: eventName,
      status,
      credentialType,
      timestamp: Date.now(),
      inquiryId,
      walletAddress,
      metadata: sanitizeWebhookPayload(attrs),
    };
  }

  // Handle generic provider / legacy shape: { event_id, type, status, ... }
  if (parsed.event_id || parsed.id) {
    const eventId = String(parsed.event_id || parsed.id);
    const rawStatus = String(parsed.status || "pending").toLowerCase();
    const status: WebhookIssuanceStatus =
      rawStatus === "completed" || rawStatus === "approved" || rawStatus === "success"
        ? "completed"
        : rawStatus === "failed" || rawStatus === "rejected"
        ? "failed"
        : "pending";

    return {
      eventId,
      provider: String(parsed.provider || "custom"),
      eventType: String(parsed.event_type || parsed.type || `issuance.${status}`),
      status,
      credentialType: String(parsed.credential_type || parsed.credentialType || "kyc"),
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
      inquiryId: parsed.inquiry_id ? String(parsed.inquiry_id) : undefined,
      walletAddress: parsed.wallet_address ? String(parsed.wallet_address) : undefined,
      error: parsed.error ? String(parsed.error) : undefined,
      metadata: sanitizeWebhookPayload(parsed.metadata ?? parsed),
    };
  }

  return null;
}

// In-memory reconciliation cache for callback tracking
const callbackStore = new Map<string, NormalizedIssuanceEvent>();

export function recordIssuanceCallback(event: NormalizedIssuanceEvent): void {
  callbackStore.set(event.eventId, event);
}

export function getIssuanceCallback(eventId: string): NormalizedIssuanceEvent | undefined {
  return callbackStore.get(eventId);
}

export function clearIssuanceCallbacks(): void {
  callbackStore.clear();
}

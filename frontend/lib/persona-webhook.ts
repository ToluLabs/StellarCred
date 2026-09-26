// Server-side only — never shipped to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/persona-webhook.ts is server-only and must not be imported from client code.");
}

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Credential, CredentialType, ClaimParams } from "@stellarcred/issuer";

// ---------------------------------------------------------------------------
// Security & PII Protection
// ---------------------------------------------------------------------------
// Per issue specifications:
// - Verify HMAC signature against PERSONA_WEBHOOK_SECRET before processing.
// - Identity fields (name, id_number, etc.) from webhook payloads must NEVER
//   be persisted in any cache.
// - The result cache stores ONLY the derived commitment, signature, and
//   credential metadata with a short TTL (15 minutes).
// ---------------------------------------------------------------------------

export const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutes

export interface PendingInquiry {
  inquiryId: string;
  holder: string;
  issuerId: string;
  issuerName?: string;
  expiry?: string | number;
  credentialTypes: CredentialType[];
  claimParams?: ClaimParams;
  createdAt: number;
}

export interface InquiryResult {
  inquiryId: string;
  status: "completed" | "failed";
  credentials?: Credential[];
  error?: string;
  createdAt: number;
}

export interface PersonaWebhookEvent {
  eventId?: string;
  eventName: string;
  inquiryId: string;
  status: string;
  referenceId?: string;
  fields: Record<string, { value: unknown }>;
}

// Minimal ISO 3166-1 alpha-2 → numeric map for circuits.
export const ALPHA2_TO_NUMERIC: Record<string, string> = {
  NG: "566",
  US: "840",
  DE: "276",
  IN: "356",
  IR: "364",
  GB: "826",
  FR: "250",
  CA: "124",
  AU: "036",
  BR: "076",
  CN: "156",
  JP: "392",
  KR: "410",
  ZA: "710",
  GH: "288",
  KE: "404",
  EG: "818",
  MX: "484",
  AR: "032",
  SG: "702",
};

export function alpha2ToNumeric(code: string): string {
  return ALPHA2_TO_NUMERIC[code.toUpperCase()] ?? "0";
}

// In-memory caches with short TTL
const pendingInquiries = new Map<string, PendingInquiry>();
const inquiryResults = new Map<string, InquiryResult>();

function evictExpired(): void {
  const now = Date.now();
  for (const [id, item] of pendingInquiries.entries()) {
    if (now - item.createdAt > DEFAULT_CACHE_TTL_MS) {
      pendingInquiries.delete(id);
    }
  }
  for (const [id, item] of inquiryResults.entries()) {
    if (now - item.createdAt > DEFAULT_CACHE_TTL_MS) {
      inquiryResults.delete(id);
    }
  }
}

export function registerPendingInquiry(
  inquiryId: string,
  data: Omit<PendingInquiry, "inquiryId" | "createdAt">,
): void {
  evictExpired();
  pendingInquiries.set(inquiryId, {
    ...data,
    inquiryId,
    createdAt: Date.now(),
  });
}

export function getPendingInquiry(inquiryId: string): PendingInquiry | undefined {
  evictExpired();
  return pendingInquiries.get(inquiryId);
}

export function deletePendingInquiry(inquiryId: string): void {
  pendingInquiries.delete(inquiryId);
}

export function setInquiryResult(
  inquiryId: string,
  result: Omit<InquiryResult, "inquiryId" | "createdAt">,
): void {
  evictExpired();
  inquiryResults.set(inquiryId, {
    ...result,
    inquiryId,
    createdAt: Date.now(),
  });
}

export function getInquiryResult(inquiryId: string): InquiryResult | undefined {
  evictExpired();
  return inquiryResults.get(inquiryId);
}

export function deleteInquiryResult(inquiryId: string): void {
  inquiryResults.delete(inquiryId);
}

export function clearPersonaCaches(): void {
  pendingInquiries.clear();
  inquiryResults.clear();
}

/**
 * Verify Persona's webhook HMAC signature.
 *
 * Persona sends a `Persona-Signature` header of the form:
 *   t=<timestamp>,v1=<signature>
 * where `v1` is HMAC-SHA256 hex digest of `<timestamp>.<rawBody>` using the webhook secret.
 * Replay protection verifies the timestamp is within the tolerance window.
 */
export function verifyPersonaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  options?: { toleranceSeconds?: number; currentTimeSeconds?: number },
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const pairs = signatureHeader.split(",").map((p) => p.trim());
  let timestampStr: string | undefined;
  const signatures: string[] = [];

  for (const pair of pairs) {
    const [key, value] = pair.split("=");
    if (key === "t") timestampStr = value;
    if (key === "v1" && value) signatures.push(value);
  }

  if (!timestampStr || signatures.length === 0) {
    return false;
  }

  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const tolerance = options?.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  const now = options?.currentTimeSeconds ?? Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestamp) > tolerance) {
    return false;
  }

  const payloadToSign = `${timestampStr}.${rawBody}`;
  const expectedSignatureHex = createHmac("sha256", secret)
    .update(payloadToSign)
    .digest("hex");

  const expectedBuf = Buffer.from(expectedSignatureHex, "hex");

  for (const sig of signatures) {
    try {
      const sigBuf = Buffer.from(sig, "hex");
      if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    } catch {
      // Invalid hex string
      continue;
    }
  }

  return false;
}

/**
 * Parses Persona webhook events into a normalized structure.
 */
export function parsePersonaWebhook(rawBody: string): PersonaWebhookEvent | null {
  try {
    const json = JSON.parse(rawBody);
    const data = json.data ?? json;
    const attributes = data.attributes ?? {};
    const eventName = attributes.name ?? json.event ?? json.type ?? "";
    const payloadData = attributes.payload?.data ?? data;
    const payloadAttrs = payloadData.attributes ?? {};

    const inquiryId =
      payloadData.id ??
      attributes["inquiry-id"] ??
      payloadAttrs["inquiry-id"] ??
      json.inquiry_id ??
      "";

    const status = payloadAttrs.status ?? attributes.status ?? json.status ?? "";
    const referenceId =
      payloadAttrs["reference-id"] ??
      payloadAttrs.reference_id ??
      attributes["reference-id"] ??
      attributes.reference_id;

    const fields = (payloadAttrs.fields ?? attributes.fields ?? {}) as Record<
      string,
      { value: unknown }
    >;

    if (!inquiryId) {
      return null;
    }

    return {
      eventId: data.id,
      eventName,
      inquiryId,
      status,
      referenceId,
      fields,
    };
  } catch {
    return null;
  }
}

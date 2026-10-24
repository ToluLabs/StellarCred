// frontend/app/api/webhooks/issuance/route.ts
//
// Dedicated webhook endpoint to receive asynchronous issuance callbacks
// from external identity providers for automated state reconciliation (#846).

import { NextRequest, NextResponse } from "next/server";
import { logger, stripSensitiveFields } from "@/lib/logger";
import {
  verifyWebhookSignature,
  parseAndNormalizeCallback,
  recordIssuanceCallback,
} from "@/lib/webhooks";

export async function POST(req: NextRequest) {
  const secret = process.env.ISSUANCE_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
  if (!secret) {
    logger.error(
      stripSensitiveFields({ event: "issuance_webhook_secret_missing" }),
      "ISSUANCE_WEBHOOK_SECRET is not configured on server"
    );
    return NextResponse.json(
      { error: "Webhook secret is not configured" },
      { status: 500 }
    );
  }

  const signatureHeader =
    req.headers.get("x-issuance-signature") ||
    req.headers.get("x-webhook-signature") ||
    req.headers.get("webhook-signature") ||
    req.headers.get("persona-signature");

  const rawBody = await req.text();

  if (!verifyWebhookSignature(rawBody, signatureHeader, secret)) {
    logger.warn(
      stripSensitiveFields({ event: "issuance_webhook_invalid_signature" }),
      "Rejected issuance webhook: invalid or missing HMAC signature"
    );
    return NextResponse.json(
      { error: "Invalid or missing webhook signature" },
      { status: 401 }
    );
  }

  const normalized = parseAndNormalizeCallback(rawBody);
  if (!normalized) {
    logger.warn(
      stripSensitiveFields({ event: "issuance_webhook_malformed" }),
      "Rejected issuance webhook: malformed payload"
    );
    return NextResponse.json(
      { error: "Malformed webhook payload" },
      { status: 400 }
    );
  }

  // Record callback for state reconciliation
  recordIssuanceCallback(normalized);

  logger.info(
    stripSensitiveFields({
      event: "issuance_webhook_received",
      eventId: normalized.eventId,
      provider: normalized.provider,
      status: normalized.status,
      credentialType: normalized.credentialType,
    }),
    `Successfully processed issuance webhook callback: ${normalized.eventId}`
  );

  return NextResponse.json(
    {
      success: true,
      eventId: normalized.eventId,
      status: normalized.status,
      timestamp: normalized.timestamp,
    },
    { status: 200 }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Issuance-Signature, X-Webhook-Signature",
    },
  });
}

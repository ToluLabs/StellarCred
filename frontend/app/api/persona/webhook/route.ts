import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { logger, stripSensitiveFields } from "@/lib/logger";
import { getIssuerSigner } from "@/lib/issuer-signer";
import {
  verifyPersonaSignature,
  parsePersonaWebhook,
  getPendingInquiry,
  setInquiryResult,
  alpha2ToNumeric,
} from "@/lib/persona-webhook";
import type { CredentialType } from "@stellarcred/issuer";

const PERSONA_BASE = "https://withpersona.com/api/v1";
const PERSONA_VERSION = "2023-01-05";

async function retrievePersonaInquiry(inquiryId: string): Promise<{
  status: string;
  fields: Record<string, { value: unknown }>;
}> {
  const res = await fetch(`${PERSONA_BASE}/inquiries/${inquiryId}`, {
    headers: {
      Authorization: `Bearer ${env.PERSONA_API_KEY}`,
      "Content-Type": "application/json",
      "Persona-Version": PERSONA_VERSION,
    },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Persona: failed to retrieve inquiry — ${JSON.stringify(json)}`);
  }
  return {
    status: json.data.attributes.status as string,
    fields: (json.data.attributes.fields ?? {}) as Record<string, { value: unknown }>,
  };
}

export async function POST(req: NextRequest) {
  const secret = env.PERSONA_WEBHOOK_SECRET;
  if (!secret) {
    logger.error(
      stripSensitiveFields({ event: "persona_webhook_secret_missing" }),
      "PERSONA_WEBHOOK_SECRET is not configured",
    );
    return NextResponse.json(
      { error: "Webhook secret is not configured" },
      { status: 401 },
    );
  }

  const signatureHeader =
    req.headers.get("persona-signature") || req.headers.get("Persona-Signature");

  const rawBody = await req.text();

  if (!verifyPersonaSignature(rawBody, signatureHeader, secret)) {
    logger.warn(
      stripSensitiveFields({ event: "persona_webhook_invalid_signature" }),
      "Rejected Persona webhook: invalid or missing HMAC signature",
    );
    return NextResponse.json(
      { error: "Invalid or missing webhook signature" },
      { status: 401 },
    );
  }

  const event = parsePersonaWebhook(rawBody);
  if (!event || !event.inquiryId) {
    logger.warn(
      stripSensitiveFields({ event: "persona_webhook_malformed" }),
      "Malformed Persona webhook payload",
    );
    return NextResponse.json({ error: "Malformed webhook payload" }, { status: 400 });
  }

  logger.info(
    stripSensitiveFields({
      event: "persona_webhook_received",
      eventName: event.eventName,
      inquiryId: event.inquiryId,
      status: event.status,
    }),
  );

  const isCompletedOrApproved =
    event.eventName === "inquiry.completed" ||
    event.eventName === "inquiry.approved" ||
    event.status === "approved" ||
    event.status === "completed";

  if (!isCompletedOrApproved) {
    return NextResponse.json({ status: "ignored", eventName: event.eventName }, { status: 200 });
  }

  // If status is failed or declined, record failed status in cache
  if (event.status === "declined" || event.status === "failed") {
    setInquiryResult(event.inquiryId, {
      status: "failed",
      error: `Inquiry status: ${event.status}`,
    });
    return NextResponse.json({ status: "recorded_failed" }, { status: 200 });
  }

  try {
    let dob =
      String(
        event.fields["birthdate"]?.value ?? event.fields["birth-date"]?.value ?? "",
      ).trim() || undefined;

    let alpha2 =
      String(
        event.fields["selected-country-code"]?.value ??
          event.fields["country-code"]?.value ??
          event.fields["address-country-code"]?.value ??
          "",
      ).trim() || undefined;

    // If missing in payload and API key is set, fetch from Persona API
    if ((!dob || !alpha2) && env.PERSONA_API_KEY) {
      try {
        const fetched = await retrievePersonaInquiry(event.inquiryId);
        if (!dob) {
          dob =
            String(
              fetched.fields["birthdate"]?.value ?? fetched.fields["birth-date"]?.value ?? "",
            ).trim() || undefined;
        }
        if (!alpha2) {
          alpha2 =
            String(
              fetched.fields["selected-country-code"]?.value ??
                fetched.fields["country-code"]?.value ??
                fetched.fields["address-country-code"]?.value ??
                "",
            ).trim() || undefined;
        }
      } catch (err) {
        logger.warn(
          stripSensitiveFields({
            event: "persona_webhook_inquiry_fetch_failed",
            inquiryId: event.inquiryId,
            error: (err as Error).message,
          }),
        );
      }
    }

    const pending = getPendingInquiry(event.inquiryId);
    const holder =
      pending?.holder ?? (event.referenceId?.startsWith("G") ? event.referenceId : undefined);

    if (!holder) {
      logger.error(
        stripSensitiveFields({
          event: "persona_webhook_missing_holder",
          inquiryId: event.inquiryId,
        }),
      );
      return NextResponse.json(
        { error: "No holder address associated with inquiry" },
        { status: 400 },
      );
    }

    const credentialTypes = pending?.credentialTypes ?? (["kyc"] as CredentialType[]);
    const issuerId =
      pending?.issuerId ??
      env.NEXT_PUBLIC_ISSUER_ADDRESS ??
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const issuerName = pending?.issuerName ?? "StellarCred Authority";
    const expiry = pending?.expiry ?? "90 days";
    const claimParams = pending?.claimParams;

    const attributes: Record<string, string> = {};
    if (dob) attributes.date_of_birth = dob;
    if (alpha2) attributes.country_code = alpha2ToNumeric(alpha2);

    const signer = getIssuerSigner();
    const credentials = await signer.issueCredentials(credentialTypes, {
      holder,
      issuerId,
      issuerName,
      expiry,
      attribute: attributes,
      claimParams,
      requestId: `webhook_${event.inquiryId}`,
    });

    // Security requirement: persist ONLY the signed credential (commitment + signature),
    // NEVER any identity fields.
    setInquiryResult(event.inquiryId, {
      status: "completed",
      credentials,
    });

    logger.info(
      stripSensitiveFields({
        event: "persona_webhook_issuance_success",
        inquiryId: event.inquiryId,
        credentialCount: credentials.length,
      }),
    );

    return NextResponse.json({ status: "ok", inquiryId: event.inquiryId }, { status: 200 });
  } catch (error) {
    logger.error(
      stripSensitiveFields({
        event: "persona_webhook_processing_failed",
        inquiryId: event.inquiryId,
        error: (error as Error).message,
      }),
    );
    setInquiryResult(event.inquiryId, {
      status: "failed",
      error: (error as Error).message,
    });
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

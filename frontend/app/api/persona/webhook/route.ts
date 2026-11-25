import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { logger, stripSensitiveFields } from "@/lib/logger";
import { getIssuerSigner } from "@/lib/issuer-signer";
import {
  verifyPersonaSignature,
  parsePersonaWebhook,
  getPendingInquiry,
  setInquiryResult,
  getInquiryResult,
  deletePendingInquiry,
  beginInquiryProcessing,
  finishInquiryProcessing,
  alpha2ToNumeric,
} from "@/lib/persona-webhook";
import type { CredentialType } from "@stellarcred/issuer";
import { retrievePersonaInquiry } from "@/lib/persona";
import { classifyVerificationError, VerificationError } from "@/packages/sdk/src/errors";

function webhookErrorResponse(error: VerificationError): NextResponse {
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      category: error.category,
      retryable: error.retryable,
    },
    { status: error.httpStatus ?? 500 },
  );
}

export async function POST(req: NextRequest) {
  const secret = env.PERSONA_WEBHOOK_SECRET;
  if (!secret) {
    logger.error(
      stripSensitiveFields({ event: "persona_webhook_secret_missing" }),
      "PERSONA_WEBHOOK_SECRET is not configured",
    );
    return webhookErrorResponse(
      new VerificationError({
        category: "configuration_error",
        code: "persona_webhook_not_configured",
        httpStatus: 401,
      }),
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
    return webhookErrorResponse(
      new VerificationError({
        category: "authorization_error",
        code: "invalid_webhook_signature",
        httpStatus: 401,
      }),
    );
  }

  const event = parsePersonaWebhook(rawBody);
  if (!event || !event.inquiryId) {
    logger.warn(
      stripSensitiveFields({ event: "persona_webhook_malformed" }),
      "Malformed Persona webhook payload",
    );
    return webhookErrorResponse(
      new VerificationError({
        category: "invalid_input",
        code: "malformed_webhook",
        httpStatus: 400,
      }),
    );
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

  const existing = getInquiryResult(event.inquiryId);
  if (existing?.status === "completed") {
    return NextResponse.json(
      { status: "already_processed", inquiryId: event.inquiryId },
      { status: 200 },
    );
  }
  if (!beginInquiryProcessing(event.inquiryId, event.eventId)) {
    return NextResponse.json(
      { status: "already_processing", inquiryId: event.inquiryId },
      { status: 200 },
    );
  }

  // If status is failed or declined, record failed status in cache
  if (event.status === "declined" || event.status === "failed") {
    const error = new VerificationError({
      category: "policy_rejection",
      code: event.status === "declined" ? "persona_declined" : "persona_incomplete",
      httpStatus: 403,
    });
    setInquiryResult(event.inquiryId, {
      status: "failed",
      error: error.message,
      errorCategory: error.category,
      errorCode: error.code,
      retryable: error.retryable,
    });
    return NextResponse.json({ status: "recorded_failed" }, { status: 200 });
  }

  try {
    let dob =
      String(event.fields["birthdate"]?.value ?? event.fields["birth-date"]?.value ?? "").trim() ||
      undefined;

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
        const error = classifyVerificationError(err, {
          fallbackCategory: "network_error",
          fallbackCode: "persona_unavailable",
        });
        logger.warn(
          stripSensitiveFields({
            event: "persona_webhook_inquiry_fetch_failed",
            inquiryId: event.inquiryId,
            error: error.code,
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
      return webhookErrorResponse(
        new VerificationError({
          category: "invalid_input",
          code: "persona_holder_missing",
          httpStatus: 400,
        }),
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
    deletePendingInquiry(event.inquiryId);

    logger.info(
      stripSensitiveFields({
        event: "persona_webhook_issuance_success",
        inquiryId: event.inquiryId,
        credentialCount: credentials.length,
      }),
    );

    return NextResponse.json({ status: "ok", inquiryId: event.inquiryId }, { status: 200 });
  } catch (e) {
    const error = classifyVerificationError(e, {
      fallbackCategory: "network_error",
      fallbackCode: "issuance_failed",
    });
    logger.error(
      stripSensitiveFields({
        event: "persona_webhook_processing_failed",
        inquiryId: event.inquiryId,
        error: error.code,
      }),
    );
    setInquiryResult(event.inquiryId, {
      status: "failed",
      error: error.message,
      errorCategory: error.category,
      errorCode: error.code,
      retryable: error.retryable,
    });
    return webhookErrorResponse(error);
  } finally {
    finishInquiryProcessing(event.inquiryId);
  }
}

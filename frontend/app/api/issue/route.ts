import { NextRequest, NextResponse } from "next/server";
import {
  CREDENTIAL_TYPES,
  previewCredential,
  type ClaimParams,
  type CredentialType,
} from "@stellarcred/issuer";
import { fetchIssuerPubkey } from "@/lib/issuer-registry";
import { currentDeploymentRef } from "@/lib/deployment";
import { circuitVersionStampFor } from "@/lib/circuit-versions";
import { readJsonBody, bodyErrorResponse } from "../../../lib/request-limits";
import { logger, stripSensitiveFields, resolveRequestId } from "@/lib/logger";
import { reportError } from "@/lib/error-reporting";
import { env } from "@/lib/env";
import { fetchPlaidBalance } from "@/lib/plaid";
import {
  checkLimit,
  extractIp,
  hashForLog,
  tooManyRequestsResponse,
  LIMITS,
} from "@/lib/rate-limit";
import { bodyErrorResponse } from "@/lib/request-limits";
import { logger, stripSensitiveFields, resolveRequestId } from "@/lib/logger";
import {
  completedIdempotencyRecord,
  idempotencyGetAsync,
  idempotencySetAsync,
  idempotencyInFlightBegin,
  idempotencyInFlightSettle,
  idempotencyInFlightFail,
  isValidIdempotencyKey,
  MAX_KEY_LENGTH_BYTES,
  personaPendingIdempotencyRecord,
  type IdempotencyRecord,
} from "@/lib/idempotency";
import { createPersonaInquiry, resolvePersonaKYC } from "@/lib/persona";
import { registerPendingInquiry } from "@/lib/persona-webhook";

const SIM_ACCOUNT =
  env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// readonly CredentialType[] widened to string[] so .includes() accepts any
// user-supplied string during validation, before it's known to be valid.
const VALID_TYPES: readonly string[] = CREDENTIAL_TYPES;
import {
  normalizeIssueRequest,
  parseIssueBody,
  resolveIssuerClient,
  resolveRequestTenant,
  validateIssueRequest,
  validateIssuerRegistration,
  type ValidationFailure,
} from "./handlers/validate";
import { enforceIpRateLimit, enforceWalletRateLimit } from "./handlers/rateLimit";
import { runIssuanceFlow } from "./handlers/issuanceFlow";

/**
 * POST /api/issue — thin dispatcher.
 *
 * The work is split into focused modules so this file only sequences it:
 *
 *   handlers/validate.ts      tenant auth, parsing, normalisation, field,
 *                             tenant and issuer-registry checks
 *   handlers/rateLimit.ts     the per-IP and per-wallet limits
 *   handlers/issuanceFlow.ts  Persona, Plaid, signing, deployment/circuit stamps
 *
 * What stays here is request lifecycle: the idempotency cache (lookup, replay,
 * single-flight join, write-back), the ordering of those steps, and turning an
 * outcome into a response with `x-request-id` on it.
 */
export async function POST(req: NextRequest) {
  const requestId = resolveRequestId(req.headers.get("x-request-id"));

  // ── Idempotency-Key support ────────────────────────────────────────────────
  const rawKey = req.headers.get("Idempotency-Key")?.trim() || undefined;
  const idempotencyKey = rawKey && isValidIdempotencyKey(rawKey) ? rawKey : undefined;
  if (rawKey && !idempotencyKey) {
    logger.warn(
      stripSensitiveFields({
        event: "idempotency_key_rejected",
        requestId,
        reason:
          new TextEncoder().encode(rawKey).length > MAX_KEY_LENGTH_BYTES ? "too_long" : "invalid",
      }),
    );
  }

  if (idempotencyKey) {
    while (true) {
      const record = await idempotencyGetAsync(idempotencyKey);
      if (record) {
        logger.info(stripSensitiveFields({ event: "idempotency_hit", requestId }));
        return replayIdempotencyRecord(record, requestId);
      }

      const inFlight = idempotencyInFlightBegin(idempotencyKey);
      if (!inFlight) break;

      logger.info(stripSensitiveFields({ event: "idempotency_inflight_hit", requestId }));
      try {
        return replayIdempotencyRecord(await inFlight, requestId);
      } catch {
        // A failed leader releases the slot. Rejoining prevents simultaneous
        // retries from all becoming leaders.
      }
    }
  }

  // Per-IP limit runs before the body is read, and before the idempotency
  // cache, so a throttled IP never gets its 429 stored and replayed.
  const ipLimited = enforceIpRateLimit(req, requestId);
  if (ipLimited) {
    if (idempotencyKey) {
      idempotencyInFlightFail(idempotencyKey, new Error("rate limited"));
    }
    return ipLimited;
  }

  try {
    return await executeRequest(req, requestId, idempotencyKey);
  } catch (e) {
    if (idempotencyKey) idempotencyInFlightFail(idempotencyKey, e);
    throw e;
  }
}

/** A replay never re-sends credential material: only the Persona redirect is
 * reproducible, because it is just a URL the holder must still complete. */
function replayIdempotencyRecord(record: IdempotencyRecord, requestId: string): NextResponse {
  const headers = new Headers({
    "x-request-id": requestId,
    "X-Idempotent": "true",
  });

  if (record.kind === "persona_pending") {
    return NextResponse.json(
      {
        needsPersona: true,
        personaUrl: record.personaUrl,
        inquiryId: record.inquiryId,
      },
      { status: 202, headers },
    );
  }

  headers.set("X-Idempotency-Replay", "redacted");
  return NextResponse.json(
    {
      code: "IDEMPOTENCY_RESPONSE_REDACTED",
      error: "This Idempotency-Key already completed; credential data is not retained for replay.",
    },
    { status: 409, headers },
  );
}

/** Render a validation verdict as the JSON error response callers expect. */
function failureResponse(failure: ValidationFailure): NextResponse {
  return NextResponse.json({ error: failure.error }, { status: failure.status });
}

async function executeRequest(
  req: NextRequest,
  requestId: string,
  idempotencyKey: string | undefined,
) {
  const startTime = Date.now();
  let outcome: "success" | "failure" = "failure";
  let credentialTypes: string[] = [];

  type BodyType = {
    credential_types?: string[];
    type?: string;
    holder?: string;
    issuerId?: string;
    issuerName?: string;
    expiry?: string;
    attributes?: Record<string, string>;
    attribute?: string;
    claimParams?: ClaimParams;
    persona_inquiry_id?: string;
    returnUrl?: string;
    preview?: boolean;
  };
  // Tenant authentication comes first: a request that cannot prove which
  // tenant it belongs to must not have its body read or cached.
  const tenantRes = await resolveRequestTenant(req);
  if (!tenantRes.ok) {
    if (idempotencyKey) {
      idempotencyInFlightFail(idempotencyKey, new Error(tenantRes.error));
    }
    const res = NextResponse.json({ error: tenantRes.error }, { status: tenantRes.status });
    res.headers.set("x-request-id", requestId);
    return res;
  }
  const tenant = tenantRes.tenant;

  // A body that cannot be read or parsed is answered directly: it is not a
  // verdict on an issuance request, so it is neither cached nor logged as one.
  const parsed = await parseIssueBody(req);
  if (!parsed.ok) {
    if (idempotencyKey) {
      idempotencyInFlightFail(idempotencyKey, new Error("invalid request body"));
    }
    const res = bodyErrorResponse(parsed.error);
    res.headers.set("x-request-id", requestId);
    return res;
  }

  const request = normalizeIssueRequest(parsed.body, tenant);
  const walletAddress = request.holder;
  const issuerId = request.issuerId;

  const sendResponse = async (response: NextResponse, record?: IdempotencyRecord) => {
    const durationMs = Date.now() - startTime;
    response.headers.set("x-request-id", requestId);

    if (idempotencyKey) {
      try {
        // Only outcomes that can be replayed without retaining credential
        // material are cached: a 200 stores a hash, a Persona redirect stores
        // the inquiry URL. Everything else releases the in-flight slot.
        const completedRecord =
          record ??
          (response.status === 200
            ? completedIdempotencyRecord(response.status, await response.clone().text())
            : undefined);
        if (completedRecord) {
          await idempotencySetAsync(idempotencyKey, completedRecord);
          idempotencyInFlightSettle(idempotencyKey, completedRecord);
        } else {
          idempotencyInFlightFail(
            idempotencyKey,
            new Error("request did not complete an idempotent operation"),
          );
        }
      } catch (e) {
        idempotencyInFlightFail(idempotencyKey, e);
      }
    }

    for (const type of credentialTypes) {
      logger.info(
        stripSensitiveFields({
          event: "response_sent",
          credentialType: type,
          issuerId,
          walletAddress,
          outcome,
          durationMs,
          requestId,
        }),
      );
    }
    return response;
  };

  // ── Per-wallet rate limit ────────────────────────────────────────────────
  if (walletAddress) {
    const walletLimited = enforceWalletRateLimit(walletAddress, requestId);
    if (walletLimited) return sendResponse(walletLimited);
  }

  // `credentialTypes` is set only once the request is past the wallet limit,
  // so a throttled wallet still produces no `response_sent` lines.
  credentialTypes = request.credentialTypes;

  const attributes: Record<string, string> = { ...(body.attributes ?? {}) };
  if (body.attribute !== undefined && body.type) {
    if (body.type === "age") attributes.date_of_birth ??= body.attribute;
    else if (body.type === "income") attributes.income ??= body.attribute;
    else if (body.type === "jurisdiction") attributes.country_code ??= body.attribute;
    else if (body.type === "employment") attributes.seniority ??= body.attribute;
  }

  if (credentialTypes.length === 0) {
    return sendResponse(
      NextResponse.json(
        { error: "credential_types must contain at least one type" },
        { status: 400 },
      ),
    );
  }
  const invalid = credentialTypes.find((t) => !VALID_TYPES.includes(t));
  if (invalid) {
    for (const type of credentialTypes) {
      logger.info(
        stripSensitiveFields({
          event: "validation_result",
          credentialType: type,
          issuerId,
          walletAddress,
          outcome: "invalid_type",
          requestId,
        }),
      );
    }
    return sendResponse(
      NextResponse.json({ error: `Invalid credential type: ${invalid}` }, { status: 400 }),
    );
  }
  if (!holder) {
    return sendResponse(
      NextResponse.json({ error: "holder address is required" }, { status: 400 }),
    );
  }
  if (!issuerId) {
    return sendResponse(NextResponse.json({ error: "issuerId is required" }, { status: 400 }));
  }

  if (body.preview === true) {
    try {
      const previews = await Promise.all(
        Array.from(new Set(credentialTypes), (type) =>
          previewCredential({
            type: type as CredentialType,
            holder,
            issuerId,
            issuerName,
            expiry,
            attribute: attributes,
            claimParams,
          }),
        ),
      );
      outcome = "success";
      return sendResponse(NextResponse.json({ preview: true, credentials: previews }));
    } catch (e) {
      return sendResponse(NextResponse.json({ error: (e as Error).message }, { status: 400 }));
    }
  }

  if (env.NEXT_PUBLIC_ISSUER_REGISTRY_ID) {
    const registered = await fetchIssuerPubkey(issuerId, SIM_ACCOUNT);
    if (!registered) {
      return sendResponse(
        NextResponse.json(
          { error: "Selected issuer is not registered on IssuerRegistry." },
          { status: 400 },
        ),
      );
    }
    const { localIssuerPubkeyBytes } = await import("@/lib/issuer-service");
    const localKey = localIssuerPubkeyBytes();
    if (!Buffer.from(registered).equals(localKey)) {
  const validated = validateIssueRequest(request, requestId, tenant);
  if (!validated.ok) return sendResponse(failureResponse(validated.failure));

  const issuerClient = await resolveIssuerClient(tenant);
  const registrationFailure = await validateIssuerRegistration(
    validated.request.issuerId,
    issuerClient,
  );
  if (registrationFailure) {
    return sendResponse(failureResponse(registrationFailure));
  }

  const result = await runIssuanceFlow(validated.request, {
    requestId,
    origin: req.nextUrl.origin,
    issuerClient,
  });

  switch (result.kind) {
    case "persona":
      return sendResponse(
        NextResponse.json(
          {
            needsPersona: true,
            personaUrl: result.personaUrl,
            inquiryId: result.inquiryId,
          },
          { status: 403 },
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Identity verification via Persona
  // ---------------------------------------------------------------------------
  const needsIdentity = credentialTypes.includes("kyc");
  if (needsIdentity) {
    if (!env.PERSONA_API_KEY) {
      logger.info(
        stripSensitiveFields({
          event: "provider_call",
          credentialType: "kyc",
          issuerId,
          walletAddress,
          outcome: "demo_mode",
          requestId,
        }),
      );
    } else {
      const templateId = env.PERSONA_KYC_TEMPLATE_ID;
      if (!templateId) {
        return sendResponse(
          NextResponse.json(
            {
              error: "PERSONA_KYC_TEMPLATE_ID is required when PERSONA_API_KEY is set",
            },
            { status: 500 },
          ),
        );
      }
      const baseUrl = env.NEXT_PUBLIC_STELLARCRED_BASE_URL ?? req.nextUrl.origin;
      // Every Persona call in this block is wrapped so a provider failure
      // cannot escape the handler. lib/persona.ts embeds Persona's raw error
      // body in the thrown message, and Persona error bodies routinely echo
      // the identity fields Persona holds — an unhandled throw would carry
      // them into the framework's error output. The message is therefore
      // dropped here: not logged, not sent to the error sink, not returned.
      try {
        if (!personaInquiryId) {
          logger.info(
            stripSensitiveFields({
              event: "provider_call",
              credentialType: "kyc",
              issuerId,
              walletAddress,
              outcome: "inquiry_created",
              requestId,
            }),
          );
          const redirectUrl = returnUrl
            ? `${baseUrl}/verify?return_url=${encodeURIComponent(returnUrl)}`
            : `${baseUrl}/verify`;
          const { url, id } = await createPersonaInquiry(templateId, redirectUrl, holder);
          // Keep only the non-PII issuance context server-side so a webhook can
          // complete an approval even when the holder never returns to the tab.
          registerPendingInquiry(id, {
            holder,
            issuerId: issuerId ?? SIM_ACCOUNT,
            issuerName,
            expiry,
            credentialTypes: credentialTypes as CredentialType[],
            claimParams,
          });
          return sendResponse(
            NextResponse.json(
              { needsPersona: true, personaUrl: url, inquiryId: id },
              { status: 202 },
            ),
            personaPendingIdempotencyRecord(id, url),
          );
        }
        const kyc = await resolvePersonaKYC(personaInquiryId);
        if (!kyc.ok) {
          logger.info(
            stripSensitiveFields({
              event: "provider_call",
              credentialType: "kyc",
              issuerId,
              walletAddress,
              outcome: "verification_failed",
              requestId,
            }),
          );
          return sendResponse(
            NextResponse.json(
              { error: kyc.error ?? "Identity verification failed" },
              { status: 403 },
            ),
          );
        }
        logger.info(
          stripSensitiveFields({
            event: "provider_call",
            credentialType: "kyc",
            issuerId,
            walletAddress,
            outcome: "verified",
            requestId,
          }),
        );
        if (kyc.dob) attributes.date_of_birth = kyc.dob;
        if (kyc.countryNumeric) attributes.country_code = kyc.countryNumeric;
      } catch {
        logger.error(
          stripSensitiveFields({
            event: "provider_call",
            credentialType: "kyc",
            issuerId,
            walletAddress,
            outcome: "provider_unavailable",
            requestId,
          }),
        );
        return sendResponse(
          NextResponse.json(
            {
              error: "Identity verification service is unavailable. Please try again.",
            },
            { status: 502 },
          ),
        );
      }
    }
  }

  // Gate funds issuance on the Plaid balance attestation. Plaid is the source
  // of truth — we overwrite any user-supplied balance with the verified
  // aggregate (summed across every linked Plaid item). Only the aggregate is
  // committed and signed; per-source account data never leaves this server.
  // ---------------------------------------------------------------------------
  // Balance attestation via Plaid
  // ---------------------------------------------------------------------------
  const needsFunds = credentialTypes.includes("funds");
  if (needsFunds) {
    const plaid = await fetchPlaidBalance(requestId);
    if (!plaid.ok) {
      logger.info(
        stripSensitiveFields({
          event: "provider_call",
          credentialType: "funds",
          issuerId,
          walletAddress,
          outcome: "verification_failed",
          requestId,
        }),
      );
      return sendResponse(
        NextResponse.json({ error: plaid.error, code: plaid.code }, { status: plaid.status }),
      );
    }
    logger.info(
      stripSensitiveFields({
        event: "provider_call",
        credentialType: "funds",
        issuerId,
        walletAddress,
        outcome: "verified",
        requestId,
      }),
    );
    attributes.balance = String(plaid.balance ?? 0);
  }

  try {
    const { issueAndAuditCredentials } = await import("@/lib/issuer-service");
    const issuedCredentials = await issueAndAuditCredentials({
      credentialTypes,
      holder,
      issuerId,
      issuerName,
      expiry,
      attributes,
      claimParams,
      requestId,
    });
    // Stamp the deployment and the circuit version on every credential at mint
    // time (#545, #633). The circuit version is what lets the holder's device
    // detect — before proving, with a message naming both versions — that the
    // circuit this credential was issued against is no longer the one this app
    // serves, instead of surfacing it later as an invalid witness.
    const credentials = issuedCredentials.map((credential) => ({
      ...credential,
      deployment: currentDeploymentRef(),
      ...circuitVersionStampFor(credential.type),
    }));

    outcome = "success";
    return sendResponse(NextResponse.json({ credentials }));
  } catch (e) {
    for (const type of credentialTypes) {
      logger.error(
        stripSensitiveFields({
          event: "signing_failed",
          credentialType: type,
          issuerId,
          walletAddress,
          error: (e as Error).message,
          requestId,
        }),
      );
    }
    // Report the error to the webhook with the exception forwarded so that
    // safeErrorMessage can strip stack frames and PII patterns before any
    // data leaves the process (issue #553).
    void reportError({
      method: "POST",
      path: "/api/issue",
      requestId,
      status: 500,
      exception: e,
    });
    return sendResponse(NextResponse.json({ error: (e as Error).message }, { status: 500 }));
          { status: 202 },
        ),
        personaPendingIdempotencyRecord(result.inquiryId, result.personaUrl),
      );
    case "issued":
      outcome = "success";
      return sendResponse(NextResponse.json({ credentials: result.credentials }));
    case "error":
      return sendResponse(NextResponse.json(result.body, { status: result.status }));
  }
}

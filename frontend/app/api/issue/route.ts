import { NextRequest, NextResponse } from "next/server";
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
import {
  issueAndAuditCredentials,
  localIssuerPubkeyBytes,
  resolveIssuerSigningKey,
  createIssuerClient,
} from "@/lib/issuer-service";
import { validateTenantCredentialTypes } from "@/lib/tenancy";
import { requireTenantAuth } from "../_middleware";

const SIM_ACCOUNT =
  env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// readonly CredentialType[] widened to string[] so .includes() accepts any
// user-supplied string during validation, before it's known to be valid.
const VALID_TYPES: readonly string[] = CREDENTIAL_TYPES;

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
  };

  // Authentication: the tenant (if any) behind this request's API key.
  const tenantAuth = await requireTenantAuth(req);
  if (tenantAuth.error) {
    if (idempotencyKey) {
      idempotencyInFlightFail(idempotencyKey, new Error(tenantAuth.error));
    }
    const res = NextResponse.json({ error: tenantAuth.error }, { status: tenantAuth.status ?? 401 });
    res.headers.set("x-request-id", requestId);
    return res;
  }
  const tenant = tenantAuth.tenant;

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

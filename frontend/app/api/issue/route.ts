import { NextRequest, NextResponse } from "next/server";
import { CREDENTIAL_TYPES, type ClaimParams } from "@stellarcred/issuer";
import { fetchIssuerPubkey } from "@/lib/issuer-registry";
import { readJsonBody, bodyErrorResponse } from "@/lib/request-limits";
import {
  logger,
  stripSensitiveFields,
  resolveRequestId,
} from "@/lib/logger";
import { env } from "@/lib/env";
import { fetchPlaidBalance } from "@/lib/plaid";
import {
  checkLimit,
  extractIp,
  hashForLog,
  tooManyRequestsResponse,
  LIMITS,
} from "@/lib/rate-limit";
import {
  idempotencyGet,
  idempotencySet,
  idempotencyInFlightBegin,
  idempotencyInFlightSettle,
  idempotencyInFlightFail,
  isValidIdempotencyKey,
  MAX_KEY_LENGTH_BYTES,
  type CachedResponse,
} from "@/lib/idempotency";
import {
  createPersonaInquiry,
  resolvePersonaKYC,
} from "@/lib/persona";
import {
  issueAndAuditCredentials,
  localIssuerPubkeyBytes,
} from "@/lib/issuer-service";

const SIM_ACCOUNT =
  env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// readonly CredentialType[] widened to string[] so .includes() accepts any
// user-supplied string during validation, before it's known to be valid.
const VALID_TYPES: readonly string[] = CREDENTIAL_TYPES;

export async function POST(req: NextRequest) {
  const requestId = resolveRequestId(req.headers.get("x-request-id"));

  // ── Idempotency-Key support ────────────────────────────────────────────────
  const rawKey = req.headers.get("Idempotency-Key")?.trim() || undefined;
  const idempotencyKey =
    rawKey && isValidIdempotencyKey(rawKey) ? rawKey : undefined;
  if (rawKey && !idempotencyKey) {
    logger.warn(
      stripSensitiveFields({
        event: "idempotency_key_rejected",
        requestId,
        reason:
          new TextEncoder().encode(rawKey).length > MAX_KEY_LENGTH_BYTES
            ? "too_long"
            : "invalid",
      }),
    );
  }

  if (idempotencyKey) {
    // Cache hit — replay the original response
    const cached = idempotencyGet(idempotencyKey);
    if (cached) {
      logger.info(stripSensitiveFields({ event: "idempotency_hit", requestId }));
      return replayCached(cached, requestId);
    }

    // Concurrent duplicate — await leader
    const inFlight = idempotencyInFlightBegin(idempotencyKey);
    if (inFlight) {
      logger.info(
        stripSensitiveFields({ event: "idempotency_inflight_hit", requestId }),
      );
      try {
        return replayCached(await inFlight, requestId);
      } catch {
        idempotencyInFlightBegin(idempotencyKey);
      }
    }
  }

  // ── Rate limiting ────────────────────────────────────────────────────────
  const ip = extractIp(req);
  const windowMs = LIMITS.windowMs();
  const ipResult = checkLimit(`issue:ip:${ip}`, LIMITS.issuePerIp(), windowMs);
  if (ipResult.throttled) {
    logger.warn(
      stripSensitiveFields({
        event: "rate_limited",
        route: "issue",
        dimension: "ip",
        ipToken: hashForLog(ip),
        requestId,
      }),
    );
    return tooManyRequestsResponse(ipResult.retryAfterMs);
  }

  try {
    return await executeRequest(req, requestId, idempotencyKey);
  } catch (e) {
    if (idempotencyKey) idempotencyInFlightFail(idempotencyKey, e);
    throw e;
  }
}

/** Reconstruct a NextResponse from a cached entry, tagging it as replayed. */
function replayCached(cached: CachedResponse, requestId: string): NextResponse {
  const headers = new Headers(cached.headers as Record<string, string>);
  headers.set("x-request-id", requestId);
  headers.set("X-Idempotent", "true");
  return new NextResponse(cached.body, { status: cached.status, headers });
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

  const parsed = await readJsonBody<BodyType>(req);
  if (!parsed.ok) {
    const res = bodyErrorResponse(parsed.error);
    res.headers.set("x-request-id", requestId);
    return res;
  }
  const body = parsed.body;

  const {
    holder,
    issuerId,
    issuerName = "StellarCred Authority",
    expiry = "90 days",
    claimParams,
    persona_inquiry_id: personaInquiryId,
    returnUrl,
  } = body;
  const walletAddress = holder;

  const sendResponse = async (response: NextResponse) => {
    const durationMs = Date.now() - startTime;
    response.headers.set("x-request-id", requestId);

    if (idempotencyKey) {
      try {
        const cloned = response.clone();
        const bodyText = await cloned.text();
        const entry: CachedResponse = {
          status: response.status,
          body: bodyText,
          headers: Object.fromEntries(response.headers.entries()),
          createdAt: Date.now(),
        };
        idempotencySet(idempotencyKey, entry);
        idempotencyInFlightSettle(idempotencyKey, entry);
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
  if (holder) {
    const walletResult = checkLimit(
      `issue:wallet:${holder}`,
      LIMITS.issuePerWallet(),
      LIMITS.windowMs(),
    );
    if (walletResult.throttled) {
      logger.warn(
        stripSensitiveFields({
          event: "rate_limited",
          route: "issue",
          dimension: "wallet",
          walletToken: hashForLog(holder),
          requestId,
        }),
      );
      return sendResponse(tooManyRequestsResponse(walletResult.retryAfterMs));
    }
  }

  // Normalize to multi-claim shape
  credentialTypes = body.credential_types ?? (body.type ? [body.type] : []);
  for (const type of credentialTypes) {
    logger.info(
      stripSensitiveFields({
        event: "request_received",
        credentialType: type,
        issuerId,
        walletAddress,
        requestId,
      }),
    );
  }

  const attributes: Record<string, string> = { ...(body.attributes ?? {}) };
  if (body.attribute !== undefined && body.type) {
    if (body.type === "age") attributes.date_of_birth ??= body.attribute;
    else if (body.type === "income") attributes.income ??= body.attribute;
    else if (body.type === "jurisdiction")
      attributes.country_code ??= body.attribute;
    else if (body.type === "employment")
      attributes.seniority ??= body.attribute;
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
      NextResponse.json(
        { error: `Invalid credential type: ${invalid}` },
        { status: 400 },
      ),
    );
  }
  if (!holder) {
    return sendResponse(
      NextResponse.json(
        { error: "holder address is required" },
        { status: 400 },
      ),
    );
  }
  if (!issuerId) {
    return sendResponse(
      NextResponse.json({ error: "issuerId is required" }, { status: 400 }),
    );
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
    const localKey = localIssuerPubkeyBytes();
    if (!Buffer.from(registered).equals(localKey)) {
      return sendResponse(
        NextResponse.json(
          {
            error:
              "ISSUER_PRIVATE_KEY does not match the selected issuer's registered public key on IssuerRegistry. Choose the issuer that matches your server key, or update ISSUER_PRIVATE_KEY.",
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
              error:
                "PERSONA_KYC_TEMPLATE_ID is required when PERSONA_API_KEY is set",
            },
            { status: 500 },
          ),
        );
      }
      const baseUrl =
        env.NEXT_PUBLIC_STELLARCRED_BASE_URL ?? req.nextUrl.origin;
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
        return sendResponse(
          NextResponse.json(
            { needsPersona: true, personaUrl: url, inquiryId: id },
            { status: 202 },
          ),
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
    }
  }

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
        NextResponse.json(
          { error: plaid.error, code: plaid.code },
          { status: plaid.status },
        ),
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

  // ---------------------------------------------------------------------------
  // Signing & Issuance
  // ---------------------------------------------------------------------------
  try {
    const credentials = await issueAndAuditCredentials({
      credentialTypes,
      holder,
      issuerId,
      issuerName,
      expiry,
      attributes,
      claimParams,
      requestId,
    });

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
    return sendResponse(
      NextResponse.json({ error: (e as Error).message }, { status: 500 }),
    );
  }
}
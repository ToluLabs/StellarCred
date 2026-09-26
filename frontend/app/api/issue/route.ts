import { NextRequest, NextResponse } from "next/server";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  IssuerClient,
  CREDENTIAL_TYPES,
  type CredentialType,
  type ClaimParams,
} from "@stellarcred/issuer";
import { fetchIssuerPubkey } from "@/lib/issuer-registry";
import { readJsonBody, bodyErrorResponse } from "../../../lib/request-limits";
import {
  logger,
  stripSensitiveFields,
  resolveRequestId,
} from "../../../lib/logger";
import { env } from "../../../lib/env";
import { fetchPlaidBalance } from "../../../lib/plaid";
import {
  checkLimit,
  extractIp,
  hashForLog,
  tooManyRequestsResponse,
  LIMITS,
} from "../../../lib/rate-limit";
import {
  idempotencyGet,
  idempotencySet,
  idempotencyInFlightBegin,
  idempotencyInFlightSettle,
  idempotencyInFlightFail,
  isValidIdempotencyKey,
  MAX_KEY_LENGTH_BYTES,
  type CachedResponse,
} from "../../../lib/idempotency";
import {
  auditLogAppend,
  auditLogBootstrap,
  auditLogFilePath,
  auditLogPersist,
} from "../../../lib/audit-log";

// Server-side only — never shipped to the browser.
// Set ISSUER_PRIVATE_KEY in .env.local to the 64-char hex secp256k1 private
// key whose public key was registered in IssuerRegistry. The registered pubkey
// and the signing key must match or ProofRegistry will reject every proof.
// Falls back to a deterministic demo key so the app runs without one set —
// this fallback is intentionally app-specific and not part of @stellarcred/issuer.
const DEMO_SK_HEX =
  env.ISSUER_PRIVATE_KEY ||
  Buffer.from(
    sha256(new TextEncoder().encode("stellarcred-demo-issuer")),
  ).toString("hex");

if (!env.ISSUER_PRIVATE_KEY) {
  logger.warn(
    stripSensitiveFields({ event: "demo_issuer_key_active" }),
    "USING PUBLIC DEMO ISSUER KEY — not for production. Set ISSUER_PRIVATE_KEY to use a real issuer key.",
  );
}

const issuer = new IssuerClient({ privateKey: DEMO_SK_HEX });
const SIM_ACCOUNT =
  env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// The server's own public key (x || y, 64 bytes) — derived from the same key
// `issuer` signs with, via the package's publicKey(), not re-derived locally.
// Used to confirm the selected issuerId's on-chain registered key actually
// matches this server's signing key before issuing.
function localIssuerPubkeyBytes(): Buffer {
  const { x, y } = issuer.publicKey();
  return Buffer.from([...x, ...y]);
}

// ---------------------------------------------------------------------------
// Persona identity verification relay
// ---------------------------------------------------------------------------
// Two templates are supported:
//   PERSONA_KYC_TEMPLATE_ID  — government ID flow; issues kyc + age + jurisdiction
//   PERSONA_AGE_TEMPLATE_ID  — selfie age estimation; issues age credential only
//
// If PERSONA_API_KEY is not set → demo fallback (always passes).
// If PERSONA_API_KEY is set but the relevant template ID is missing → loud error.
// ---------------------------------------------------------------------------

const PERSONA_BASE = "https://withpersona.com/api/v1";
const PERSONA_VERSION = "2023-01-05";

function personaHeaders() {
  return {
    Authorization: `Bearer ${env.PERSONA_API_KEY}`,
    "Content-Type": "application/json",
    "Persona-Version": PERSONA_VERSION,
  };
}

async function createPersonaInquiry(
  templateId: string,
  redirectUri: string,
): Promise<{ url: string; id: string }> {
  const res = await fetch(`${PERSONA_BASE}/inquiries`, {
    method: "POST",
    headers: personaHeaders(),
    body: JSON.stringify({
      data: {
        attributes: {
          "inquiry-template-id": templateId,
          "redirect-uri": redirectUri,
        },
      },
    }),
  });
  const json = await res.json();
  if (!res.ok)
    throw new Error(
      `Persona: failed to create inquiry — ${JSON.stringify(json)}`,
    );
  const id: string = json.data.id;
  // Persona hosted flow URL
  const url = `https://withpersona.com/verify?inquiry-id=${id}`;
  return { url, id };
}

async function retrievePersonaInquiry(inquiryId: string): Promise<{
  status: string;
  fields: Record<string, { value: unknown }>;
}> {
  const res = await fetch(`${PERSONA_BASE}/inquiries/${inquiryId}`, {
    headers: personaHeaders(),
  });
  const json = await res.json();
  if (!res.ok)
    throw new Error(
      `Persona: failed to retrieve inquiry — ${JSON.stringify(json)}`,
    );
  return {
    status: json.data.attributes.status as string,
    fields: (json.data.attributes.fields ?? {}) as Record<
      string,
      { value: unknown }
    >,
  };
}

// Minimal ISO 3166-1 alpha-2 → numeric map for countries we care about.
// Persona returns alpha-2 codes; our jurisdiction circuit uses numeric.
const ALPHA2_TO_NUMERIC: Record<string, string> = {
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

function alpha2ToNumeric(code: string): string {
  return ALPHA2_TO_NUMERIC[code.toUpperCase()] ?? "0";
}

// Called after user returns from Persona KYC (gov ID) inquiry.
// Returns DOB and country so we can issue age + jurisdiction credentials.
async function resolvePersonaKYC(inquiryId: string): Promise<{
  ok: boolean;
  dob?: string;
  countryNumeric?: string;
  error?: string;
}> {
  const { status, fields } = await retrievePersonaInquiry(inquiryId);
  if (status !== "approved") {
    return { ok: false, error: `Persona KYC inquiry status: ${status}` };
  }
  const dob =
    String(
      fields["birthdate"]?.value ?? fields["birth-date"]?.value ?? "",
    ).trim() || undefined;
  const alpha2 =
    String(
      fields["selected-country-code"]?.value ??
        fields["country-code"]?.value ??
        fields["address-country-code"]?.value ??
        "",
    ).trim() || undefined;
  return {
    ok: true,
    dob,
    countryNumeric: alpha2 ? alpha2ToNumeric(alpha2) : undefined,
  };
}

// Resolved Plaid conflict
// readonly CredentialType[] widened to string[] so .includes() accepts any
// user-supplied string during validation, before it's known to be valid.
const VALID_TYPES: readonly string[] = CREDENTIAL_TYPES;

export async function POST(req: NextRequest) {
  const requestId = resolveRequestId(req.headers.get("x-request-id"));

  // ── Idempotency-Key support ────────────────────────────────────────────────
  // A retried /api/issue request (network blip, double-click) can trigger
  // duplicate signing/provider calls. Accept an Idempotency-Key header so
  // identical retries return the cached original result without re-processing.
  // Keys are validated (non-empty, printable, ≤ 256 bytes) before use so an
  // oversized header cannot be stored verbatim and amplify memory usage.
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
    // Cache hit — replay the original response (X-Idempotent: true so clients
    // can tell this is a replayed, not fresh, result).
    const cached = idempotencyGet(idempotencyKey);
    if (cached) {
      logger.info(stripSensitiveFields({ event: "idempotency_hit", requestId }));
      return replayCached(cached, requestId);
    }

    // Concurrent duplicate — another request with this key is already
    // executing. Await its result and replay it instead of running the
    // provider calls / signing a second time.
    const inFlight = idempotencyInFlightBegin(idempotencyKey);
    if (inFlight) {
      logger.info(
        stripSensitiveFields({ event: "idempotency_inflight_hit", requestId }),
      );
      try {
        return replayCached(await inFlight, requestId);
      } catch {
        // The leader failed before producing a response — process this
        // request normally instead of replaying the leader's error. Re-acquire
        // the in-flight slot so a third concurrent duplicate joining while we
        // execute is still de-duplicated instead of running in parallel.
        idempotencyInFlightBegin(idempotencyKey);
      }
    }
  }

  // ── Rate limiting ────────────────────────────────────────────────────────
  // Applied after idempotency: a request that hits the idempotency cache is
  // already free — it's a replay, not a new issuance. New requests (including
  // the first leg of a Persona KYC redirect flow) count against both the IP
  // and, when the wallet address is available in the URL params, the wallet
  // limit. The wallet address from the body is checked separately inside
  // executeRequest once the body is parsed; the pre-body IP check is cheap and
  // blocks floods before any body is read.
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
    // Release any duplicate waiting on this key so it can retry itself.
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
  let issuerId: string | undefined;
  let walletAddress: string | undefined;

  const sendResponse = async (response: NextResponse) => {
    const durationMs = Date.now() - startTime;
    response.headers.set("x-request-id", requestId);

    // Cache this response under the idempotency key if provided, and release
    // any concurrent duplicate that joined the in-flight slot.
    if (idempotencyKey) {
      try {
        const cloned = response.clone();
        const body = await cloned.text();
        const entry: CachedResponse = {
          status: response.status,
          body,
          headers: Object.fromEntries(response.headers.entries()),
          createdAt: Date.now(),
        };
        idempotencySet(idempotencyKey, entry);
        idempotencyInFlightSettle(idempotencyKey, entry);
      } catch (e) {
        // If cloning/caching fails (edge case), don't break the response —
        // but do fail any waiting duplicate so it can retry for itself.
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

  type BodyType = {
    credential_types?: string[];
    // Legacy single-type shape — still accepted for backward compatibility.
    type?: string;
    holder?: string;
    issuerId?: string;
    issuerName?: string;
    expiry?: string;
    attributes?: Record<string, string>;
    attribute?: string;
    claimParams?: ClaimParams;
    // Set by the frontend after the user returns from Persona's hosted flow.
    persona_inquiry_id?: string;
    returnUrl?: string;
  };

  const parsed = await readJsonBody<BodyType>(req);
  if (!parsed.ok) {
    return sendResponse(bodyErrorResponse(parsed.error));
  }
  const body = parsed.body;

  const {
    holder,
    issuerId: reqIssuerId,
    issuerName = "StellarCred Authority",
    expiry = "90 days",
    claimParams,
    persona_inquiry_id: personaInquiryId,
    returnUrl,
  } = body;
  issuerId = reqIssuerId;
  walletAddress = holder;

  // ── Per-wallet rate limit ────────────────────────────────────────────────
  // Checked here (after body parse) because the wallet address lives in the
  // body. Returns 429 before any provider call or signing work is started.
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

  // Normalize to the multi-claim shape. Legacy callers send { type, attribute };
  // map that single attribute onto the right key in `attributes`.
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
  // needsKyc = any of kyc / jurisdiction, OR age when KYC template is available
  // needsAgeOnly = age-only request when only the selfie age template is available
  //
  // Decision tree:
  //   PERSONA_API_KEY not set                           → demo fallback (always passes)
  //   PERSONA_API_KEY set, KYC types requested:
  //     PERSONA_KYC_TEMPLATE_ID not set                → 500 (misconfiguration)
  //     no inquiry_id yet                              → 202 + Persona URL (redirect)
  //     inquiry_id present                             → verify + extract DOB/country
  //   PERSONA_API_KEY set, age-only requested:
  //     PERSONA_AGE_TEMPLATE_ID not set                → 500 (misconfiguration)
  //     no inquiry_id yet                              → 202 + Persona URL (redirect)
  //     inquiry_id present                             → verify + extract min_age
  // ---------------------------------------------------------------------------
  // Gate the kyc credential on Persona identity verification (gov ID flow).
  // Age and jurisdiction are standalone — user-provided values, no external verification.
  // If PERSONA_API_KEY is not set → demo fallback, verification skipped.
  // If PERSONA_API_KEY is set but PERSONA_KYC_TEMPLATE_ID is missing → 500.
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
      // lib/env.ts already requires PERSONA_KYC_TEMPLATE_ID whenever
      // PERSONA_API_KEY is set, so this branch is unreachable in practice —
      // the misconfiguration this used to catch is now a startup failure
      // instead of a per-request 500. Kept as defense-in-depth.
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
        // First request — create a Persona inquiry and ask the frontend to redirect.
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
        const { url, id } = await createPersonaInquiry(templateId, redirectUrl);
        return sendResponse(
          NextResponse.json(
            { needsPersona: true, personaUrl: url, inquiryId: id },
            { status: 202 },
          ),
        );
      }
      // Second request — user returned from Persona, verify the completed inquiry.
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

  // Gate funds issuance on Plaid balance attestation. Plaid is the source of
  // truth — we overwrite any user-supplied balance with the verified figure.
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

  try {
    // De-duplicate types so the same claim isn't issued twice in one call.
    const uniqueTypes = Array.from(new Set(credentialTypes));
    const credentials = [];
    for (const type of uniqueTypes) {
      logger.info(
        stripSensitiveFields({
          event: "signing_started",
          credentialType: type,
          issuerId,
          walletAddress,
          requestId,
        }),
      );
      const credential = await issuer.issue({
        type: type as CredentialType,
        holder,
        issuerId,
        issuerName,
        expiry,
        attribute: attributes,
        claimParams,
      });
      credentials.push(credential);
      logger.info(
        stripSensitiveFields({
          event: "signing_success",
          credentialType: type,
          issuerId,
          walletAddress,
          requestId,
        }),
      );
    }

    // ── Hash-chained, PII-free issuance audit log ───────────────────────────
    // Append one entry per signed commitment. Entries carry ONLY the
    // commitment (a Poseidon2 hash — not the underlying attribute), the
    // issuer id, the issuance timestamp, and the request id — never
    // first_name/last_name/id_number/wallet address. Each entry chains to the
    // previous entry's hash so tampering is detectable via the
    // `pnpm verify:audit-log` command (docs/audit-log.md).
    try {
      await auditLogBootstrap(auditLogFilePath());
      for (const credential of credentials) {
        const entry = auditLogAppend({
          timestamp: credential.issuedAt,
          requestId,
          issuer: issuerId ?? "",
          commitment: credential.commitment,
        });
        logger.info(
          stripSensitiveFields({
            event: "audit_log_appended",
            credentialType: credential.type,
            issuerId,
            requestId,
            auditIndex: entry.index,
            auditHash: entry.hash,
          }),
        );
      }
      await auditLogPersist(auditLogFilePath());
    } catch (auditError) {
      // The audit log must never break issuance; surface the failure loudly
      // so operators know the trail is incomplete.
      logger.error(
        stripSensitiveFields({
          event: "audit_log_persist_failed",
          issuerId,
          walletAddress,
          error: (auditError as Error).message,
          requestId,
        }),
      );
    }

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
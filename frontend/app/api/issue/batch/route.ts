import { NextRequest, NextResponse } from "next/server";
import { CREDENTIAL_TYPES, type ClaimParams, type Credential } from "@stellarcred/issuer";
import { fetchIssuerPubkey } from "@/lib/issuer-registry";
import { circuitVersionStampFor } from "@/lib/circuit-versions";
import { readJsonBody, bodyErrorResponse } from "@/lib/request-limits";
import { logger, stripSensitiveFields, resolveRequestId } from "@/lib/logger";
import { env } from "@/lib/env";
import {
  checkLimit,
  extractIp,
  hashForLog,
  tooManyRequestsResponse,
  LIMITS,
} from "@/lib/rate-limit";
import {
  completedIdempotencyRecord,
  idempotencyGetAsync,
  idempotencySetAsync,
  idempotencyInFlightBegin,
  idempotencyInFlightSettle,
  idempotencyInFlightFail,
  isValidIdempotencyKey,
  MAX_KEY_LENGTH_BYTES,
} from "@/lib/idempotency";
import {
  issueAndAuditCredentials,
  localIssuerPubkeyBytes,
  resolveIssuerSigningKey,
  createIssuerClient,
} from "@/lib/issuer-service";
import { resolveTenant, validateTenantCredentialTypes } from "@/lib/tenancy";
import { normalizeAttributes } from "@/lib/attribute-normalizer";
import { equals } from "@/lib/crypto";

const SIM_ACCOUNT =
  env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const VALID_TYPES: readonly string[] = CREDENTIAL_TYPES;
const MAX_BATCH_SIZE = 50;

export interface BatchItemRequest {
  credential_types?: string[];
  type?: string;
  holder: string;
  issuerId?: string;
  issuerName?: string;
  expiry?: string;
  attributes?: Record<string, string>;
  attribute?: string;
  claimParams?: ClaimParams;
}

export type BatchItemResult =
  | {
      index: number;
      success: true;
      holder: string;
      credentials: Credential[];
    }
  | {
      index: number;
      success: false;
      holder?: string;
      error: string;
    };

export interface BatchIssueResponse {
  total: number;
  successful: number;
  failed: number;
  results: BatchItemResult[];
}

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
        return replayIdempotencyRecord(requestId);
      }

      const inFlight = idempotencyInFlightBegin(idempotencyKey);
      if (!inFlight) break;

      logger.info(stripSensitiveFields({ event: "idempotency_inflight_hit", requestId }));
      try {
        await inFlight;
        return replayIdempotencyRecord(requestId);
      } catch {
        // A failed leader releases the slot. Rejoining prevents simultaneous
        // retries from all becoming leaders.
      }
    }
  }

  // ── Rate limiting (IP level) ───────────────────────────────────────────────
  const ip = extractIp(req);
  const windowMs = LIMITS.windowMs();
  const ipResult = checkLimit(`issue:batch:ip:${ip}`, LIMITS.issuePerIp(), windowMs);
  if (ipResult.throttled) {
    logger.warn(
      stripSensitiveFields({
        event: "rate_limited",
        route: "issue_batch",
        dimension: "ip",
        ipToken: hashForLog(ip),
        requestId,
      }),
    );
    if (idempotencyKey) {
      idempotencyInFlightFail(idempotencyKey, new Error("rate limited"));
    }
    return tooManyRequestsResponse(ipResult.retryAfterMs);
  }

  try {
    return await executeBatchRequest(req, requestId, idempotencyKey);
  } catch (e) {
    if (idempotencyKey) idempotencyInFlightFail(idempotencyKey, e);
    throw e;
  }
}

function replayIdempotencyRecord(requestId: string): NextResponse {
  const headers = new Headers({
    "x-request-id": requestId,
    "X-Idempotent": "true",
    "X-Idempotency-Replay": "redacted",
  });

  return NextResponse.json(
    {
      code: "IDEMPOTENCY_RESPONSE_REDACTED",
      error: "This Idempotency-Key already completed; credential data is not retained for replay.",
    },
    { status: 409, headers },
  );
}

async function executeBatchRequest(
  req: NextRequest,
  requestId: string,
  idempotencyKey: string | undefined,
) {
  const startTime = Date.now();

  type RawBatchBody =
    | BatchItemRequest[]
    | {
        requests?: BatchItemRequest[];
        batch?: BatchItemRequest[];
        items?: BatchItemRequest[];
      };

  const tenantRes = await resolveTenant(req);
  if (tenantRes.error) {
    if (idempotencyKey) {
      idempotencyInFlightFail(idempotencyKey, new Error(tenantRes.error));
    }
    const res = NextResponse.json({ error: tenantRes.error }, { status: tenantRes.status ?? 401 });
    res.headers.set("x-request-id", requestId);
    return res;
  }
  const tenant = tenantRes.tenant;

  const parsed = await readJsonBody<RawBatchBody>(req);
  if (!parsed.ok) {
    if (idempotencyKey) {
      idempotencyInFlightFail(idempotencyKey, new Error("invalid request body"));
    }
    const res = bodyErrorResponse(parsed.error);
    res.headers.set("x-request-id", requestId);
    return res;
  }

  const raw = parsed.body;
  let items: BatchItemRequest[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === "object") {
    items = raw.requests ?? raw.batch ?? raw.items ?? [];
  }

  const sendResponse = async (response: NextResponse) => {
    response.headers.set("x-request-id", requestId);

    if (idempotencyKey) {
      try {
        if (response.status === 200) {
          const record = completedIdempotencyRecord(response.status, await response.clone().text());
          await idempotencySetAsync(idempotencyKey, record);
          idempotencyInFlightSettle(idempotencyKey, record);
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
    return response;
  };

  if (!Array.isArray(items) || items.length === 0) {
    return sendResponse(
      NextResponse.json(
        { error: "Batch request must contain a non-empty array of items." },
        { status: 400 },
      ),
    );
  }

  if (items.length > MAX_BATCH_SIZE) {
    return sendResponse(
      NextResponse.json(
        {
          error: `Batch size exceeds maximum allowed of ${MAX_BATCH_SIZE} items. Received ${items.length}.`,
        },
        { status: 400 },
      ),
    );
  }

  let customIssuerClient: ReturnType<typeof createIssuerClient> | undefined;
  if (tenant) {
    const signingKey = await resolveIssuerSigningKey(tenant.config.signingKeySecretRef);
    customIssuerClient = createIssuerClient(signingKey);
  }

  // Pre-validate issuer registration if configured
  const cachedIssuerKeyCheck = new Map<string, boolean>();

  const results: BatchItemResult[] = [];
  let successful = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const index = i;

    if (!item || typeof item !== "object") {
      results.push({ index, success: false, error: "Invalid item payload" });
      failed++;
      continue;
    }

    const holder = item.holder?.trim();
    const rawIssuerId = item.issuerId?.trim();
    const issuerId = rawIssuerId ?? tenant?.config.issuerId ?? SIM_ACCOUNT;
    const issuerName = item.issuerName ?? tenant?.config.issuerName ?? "StellarCred Authority";
    const expiry = item.expiry ?? "90 days";

    if (!holder) {
      results.push({ index, success: false, error: "holder address is required" });
      failed++;
      continue;
    }

    if (tenant && rawIssuerId && rawIssuerId !== tenant.config.issuerId) {
      results.push({
        index,
        success: false,
        holder,
        error: `Unauthorized issuerId for tenant '${tenant.id}'. Configured issuerId is '${tenant.config.issuerId}'.`,
      });
      failed++;
      continue;
    }

    // Per-wallet rate limiting
    const walletResult = checkLimit(
      `issue:wallet:${holder}`,
      LIMITS.issuePerWallet(),
      LIMITS.windowMs(),
    );
    if (walletResult.throttled) {
      results.push({
        index,
        success: false,
        holder,
        error: `Rate limit exceeded for holder. Try again in ${Math.ceil(walletResult.retryAfterMs / 1000)}s`,
      });
      failed++;
      continue;
    }

    const credentialTypes = item.credential_types ?? (item.type ? [item.type] : []);
    if (credentialTypes.length === 0) {
      results.push({
        index,
        success: false,
        holder,
        error: "credential_types must contain at least one type",
      });
      failed++;
      continue;
    }

    const invalidType = credentialTypes.find((t) => !VALID_TYPES.includes(t));
    if (invalidType) {
      results.push({
        index,
        success: false,
        holder,
        error: `Invalid credential type: ${invalidType}`,
      });
      failed++;
      continue;
    }

    if (tenant) {
      const typeCheck = validateTenantCredentialTypes(tenant, credentialTypes);
      if (!typeCheck.allowed) {
        results.push({
          index,
          success: false,
          holder,
          error: `Tenant '${tenant.id}' is not authorized to issue credential type '${typeCheck.disallowedType}'.`,
        });
        failed++;
        continue;
      }
    }

    // Check issuer registry key match if configured
    if (env.NEXT_PUBLIC_ISSUER_REGISTRY_ID) {
      if (!cachedIssuerKeyCheck.has(issuerId)) {
        const registered = await fetchIssuerPubkey(issuerId, SIM_ACCOUNT);
        if (!registered) {
          cachedIssuerKeyCheck.set(issuerId, false);
        } else {
          const localKey = localIssuerPubkeyBytes(customIssuerClient);
          const matches = equals(registered, localKey);
          cachedIssuerKeyCheck.set(issuerId, matches);
        }
      }

      if (!cachedIssuerKeyCheck.get(issuerId)) {
        results.push({
          index,
          success: false,
          holder,
          error: "Selected issuer is not registered or private key mismatch on IssuerRegistry.",
        });
        failed++;
        continue;
      }
    }

    const attributes: Record<string, string> = normalizeAttributes(
      item.type,
      item.attribute,
      item.attributes,
    );

    try {
      const credentials = await issueAndAuditCredentials({
        credentialTypes,
        holder,
        issuerId,
        issuerName,
        expiry,
        attributes,
        claimParams: item.claimParams,
        requestId: `${requestId}-${i}`,
        issuerClient: customIssuerClient,
      });

      results.push({
        index,
        success: true,
        holder,
        // Record the circuit each credential was issued against, exactly as the
        // single-issue route does, so the holder's device can detect a
        // superseded circuit before proving rather than via a failed witness.
        credentials: credentials.map((credential) => ({
          ...credential,
          ...circuitVersionStampFor(credential.type),
        })),
      });
      successful++;
    } catch (err) {
      results.push({
        index,
        success: false,
        holder,
        error: (err as Error).message || "Signing failed",
      });
      failed++;
    }
  }

  logger.info(
    stripSensitiveFields({
      event: "batch_issue_completed",
      total: items.length,
      successful,
      failed,
      durationMs: Date.now() - startTime,
      requestId,
    }),
  );

  const payload: BatchIssueResponse = {
    total: items.length,
    successful,
    failed,
    results,
  };

  return sendResponse(NextResponse.json(payload, { status: 200 }));
}

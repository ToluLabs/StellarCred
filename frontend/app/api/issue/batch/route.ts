import { NextRequest, NextResponse } from "next/server";
import { CREDENTIAL_TYPES, type ClaimParams, type Credential } from "@stellarcred/issuer";
import { fetchIssuerPubkey } from "@/lib/issuer-registry";
import { readJsonBody, bodyErrorResponse } from "@/lib/request-limits";
import {
  logger,
  stripSensitiveFields,
  resolveRequestId,
} from "@/lib/logger";
import { env } from "@/lib/env";
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
  issueAndAuditCredentials,
  localIssuerPubkeyBytes,
} from "@/lib/issuer-service";

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
    const cached = idempotencyGet(idempotencyKey);
    if (cached) {
      logger.info(stripSensitiveFields({ event: "idempotency_hit", requestId }));
      return replayCached(cached, requestId);
    }

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
    return tooManyRequestsResponse(ipResult.retryAfterMs);
  }

  try {
    return await executeBatchRequest(req, requestId, idempotencyKey);
  } catch (e) {
    if (idempotencyKey) idempotencyInFlightFail(idempotencyKey, e);
    throw e;
  }
}

function replayCached(cached: CachedResponse, requestId: string): NextResponse {
  const headers = new Headers(cached.headers as Record<string, string>);
  headers.set("x-request-id", requestId);
  headers.set("X-Idempotent", "true");
  return new NextResponse(cached.body, { status: cached.status, headers });
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

  const parsed = await readJsonBody<RawBatchBody>(req);
  if (!parsed.ok) {
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
    const issuerId = item.issuerId?.trim() ?? SIM_ACCOUNT;
    const issuerName = item.issuerName ?? "StellarCred Authority";
    const expiry = item.expiry ?? "90 days";

    if (!holder) {
      results.push({ index, success: false, error: "holder address is required" });
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

    // Check issuer registry key match if configured
    if (env.NEXT_PUBLIC_ISSUER_REGISTRY_ID) {
      if (!cachedIssuerKeyCheck.has(issuerId)) {
        const registered = await fetchIssuerPubkey(issuerId, SIM_ACCOUNT);
        if (!registered) {
          cachedIssuerKeyCheck.set(issuerId, false);
        } else {
          const localKey = localIssuerPubkeyBytes();
          const matches = Buffer.from(registered).equals(localKey);
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

    const attributes: Record<string, string> = { ...(item.attributes ?? {}) };
    if (item.attribute !== undefined && item.type) {
      if (item.type === "age") attributes.date_of_birth ??= item.attribute;
      else if (item.type === "income") attributes.income ??= item.attribute;
      else if (item.type === "jurisdiction") attributes.country_code ??= item.attribute;
      else if (item.type === "employment") attributes.seniority ??= item.attribute;
    }

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
      });

      results.push({
        index,
        success: true,
        holder,
        credentials,
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

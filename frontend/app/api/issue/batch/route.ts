import { NextRequest, NextResponse } from "next/server";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  IssuerClient,
  CREDENTIAL_TYPES,
  type CredentialType,
  type ClaimParams,
  type Credential,
} from "@stellarcred/issuer";
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

export const MAX_BATCH_SIZE = 50;

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

function localIssuerPubkeyBytes(): Buffer {
  const { x, y } = issuer.publicKey();
  return Buffer.from([...x, ...y]);
}

const VALID_TYPES: readonly string[] = CREDENTIAL_TYPES;

export interface BatchItem {
  holder?: string;
  credential_types?: string[];
  type?: string;
  issuerId?: string;
  issuerName?: string;
  expiry?: string | number;
  attributes?: Record<string, string>;
  attribute?: string;
  claimParams?: ClaimParams;
}

export interface BatchRequestBody {
  issuerId?: string;
  issuerName?: string;
  expiry?: string;
  items?: BatchItem[];
}

export interface BatchItemResult {
  index: number;
  success: boolean;
  credentials?: Credential[];
  error?: string;
}

export interface BatchResponse {
  total: number;
  successful: number;
  failed: number;
  results: BatchItemResult[];
}

export async function POST(req: NextRequest) {
  const requestId = resolveRequestId(req.headers.get("x-request-id"));

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

  const ip = extractIp(req);
  const windowMs = LIMITS.windowMs();
  const ipResult = checkLimit(`issue:ip:${ip}`, LIMITS.issuePerIp(), windowMs);
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

  const sendResponse = async (response: NextResponse) => {
    const durationMs = Date.now() - startTime;
    response.headers.set("x-request-id", requestId);

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
        idempotencyInFlightFail(idempotencyKey, e);
      }
    }

    logger.info(
      stripSensitiveFields({
        event: "batch_response_sent",
        status: response.status,
        durationMs,
        requestId,
      }),
    );
    return response;
  };

  const parsed = await readJsonBody<BatchRequestBody | BatchItem[]>(req);
  if (!parsed.ok) {
    return sendResponse(bodyErrorResponse(parsed.error));
  }

  const raw = parsed.body;
  let items: BatchItem[] = [];
  let defaultIssuerId: string | undefined;
  let defaultIssuerName: string = "StellarCred Authority";
  let defaultExpiry: string = "90 days";

  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === "object") {
    items = raw.items ?? [];
    defaultIssuerId = raw.issuerId;
    if (raw.issuerName) defaultIssuerName = raw.issuerName;
    if (raw.expiry) defaultExpiry = raw.expiry;
  }

  if (!Array.isArray(items) || items.length === 0) {
    return sendResponse(
      NextResponse.json(
        { error: "Batch must contain at least one item in 'items' array" },
        { status: 400 },
      ),
    );
  }

  if (items.length > MAX_BATCH_SIZE) {
    return sendResponse(
      NextResponse.json(
        { error: `Batch size exceeds maximum limit of ${MAX_BATCH_SIZE} items` },
        { status: 400 },
      ),
    );
  }

  logger.info(
    stripSensitiveFields({
      event: "batch_request_received",
      itemCount: items.length,
      requestId,
    }),
  );

  // Check rate limits for unique wallets in the batch
  const uniqueWallets = Array.from(
    new Set(items.map((it) => it.holder).filter(Boolean)),
  ) as string[];

  for (const wallet of uniqueWallets) {
    const walletResult = checkLimit(
      `issue:wallet:${wallet}`,
      LIMITS.issuePerWallet(),
      LIMITS.windowMs(),
    );
    if (walletResult.throttled) {
      logger.warn(
        stripSensitiveFields({
          event: "rate_limited",
          route: "issue_batch",
          dimension: "wallet",
          walletToken: hashForLog(wallet),
          requestId,
        }),
      );
      return sendResponse(tooManyRequestsResponse(walletResult.retryAfterMs));
    }
  }

  // Pre-validate issuer registration if on-chain registry is configured
  if (env.NEXT_PUBLIC_ISSUER_REGISTRY_ID) {
    const checkedIssuers = new Set<string>();
    for (const it of items) {
      const issuerId = it.issuerId ?? defaultIssuerId;
      if (issuerId && !checkedIssuers.has(issuerId)) {
        checkedIssuers.add(issuerId);
        const registered = await fetchIssuerPubkey(issuerId, SIM_ACCOUNT);
        if (!registered) {
          return sendResponse(
            NextResponse.json(
              { error: `Selected issuer '${issuerId}' is not registered on IssuerRegistry.` },
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
                  "ISSUER_PRIVATE_KEY does not match the selected issuer's registered public key on IssuerRegistry.",
              },
              { status: 403 },
            ),
          );
        }
      }
    }
  }

  // Process items with partial-failure semantics
  const results: BatchItemResult[] = [];
  let successful = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const holder = item.holder;
    const itemIssuerId = item.issuerId ?? defaultIssuerId;
    const itemIssuerName = item.issuerName ?? defaultIssuerName;
    const itemExpiry = item.expiry ?? defaultExpiry;
    const claimParams = item.claimParams;

    const credentialTypes = item.credential_types ?? (item.type ? [item.type] : []);

    if (!holder) {
      results.push({
        index: i,
        success: false,
        error: "holder address is required",
      });
      failed++;
      continue;
    }

    if (!itemIssuerId) {
      results.push({
        index: i,
        success: false,
        error: "issuerId is required",
      });
      failed++;
      continue;
    }

    if (credentialTypes.length === 0) {
      results.push({
        index: i,
        success: false,
        error: "credential_types must contain at least one type",
      });
      failed++;
      continue;
    }

    const invalidType = credentialTypes.find((t) => !VALID_TYPES.includes(t));
    if (invalidType) {
      results.push({
        index: i,
        success: false,
        error: `Invalid credential type: ${invalidType}`,
      });
      failed++;
      continue;
    }

    // Build attribute map
    const attributes: Record<string, string> = { ...(item.attributes ?? {}) };
    if (item.attribute !== undefined && item.type) {
      if (item.type === "age") attributes.date_of_birth ??= item.attribute;
      else if (item.type === "income") attributes.income ??= item.attribute;
      else if (item.type === "jurisdiction") attributes.country_code ??= item.attribute;
      else if (item.type === "employment") attributes.seniority ??= item.attribute;
    }

    try {
      const uniqueTypes = Array.from(new Set(credentialTypes));
      const credentials: Credential[] = [];

      for (const type of uniqueTypes) {
        const credential = await issuer.issue({
          type: type as CredentialType,
          holder,
          issuerId: itemIssuerId,
          issuerName: itemIssuerName,
          expiry: itemExpiry,
          attribute: attributes,
          claimParams,
        });
        credentials.push(credential);
      }

      results.push({
        index: i,
        success: true,
        credentials,
      });
      successful++;
    } catch (err) {
      results.push({
        index: i,
        success: false,
        error: (err as Error).message,
      });
      failed++;
    }
  }

  const responseBody: BatchResponse = {
    total: items.length,
    successful,
    failed,
    results,
  };

  return sendResponse(NextResponse.json(responseBody, { status: 200 }));
}

/**
 * validate.ts — request parsing and validation for POST /api/issue.
 *
 * Everything between "bytes on the wire" and "a request the issuance flow can
 * act on" lives here: tenant authentication, the size-guarded JSON read,
 * normalisation of the two accepted body shapes (multi-claim
 * `credential_types`, and the legacy single `type` + `attribute` pair), the
 * ordered field checks, the tenant boundaries, and the issuer registration
 * check that confirms the selected issuer's on-chain key is the key this
 * server signs with.
 *
 * The split is deliberate, because the route needs the pieces at different
 * moments:
 *
 *   resolveRequestTenant()       async — authenticates the caller, if any
 *   normalizeIssueRequest()      pure — no validation, no logging
 *   validateIssueRequest()       ordered field checks + validation logging
 *   resolveIssuerClient()        async — tenant signing key from the vault
 *   validateIssuerRegistration() async — reads IssuerRegistry
 *
 * The *order* of the checks is part of the route's behaviour: a request that
 * is wrong in several ways must still get the same first failure it always
 * did, so the sequence stays here rather than at the call site.
 */

import type { NextRequest } from "next/server";
import { CREDENTIAL_TYPES, type ClaimParams, type IssuerClient } from "@stellarcred/issuer";
import { fetchIssuerPubkey } from "@/lib/issuer-registry";
import { equals } from "@/lib/crypto";
import { env } from "@/lib/env";
import { logger, stripSensitiveFields } from "@/lib/logger";
import {
  createIssuerClient,
  localIssuerPubkeyBytes,
  resolveIssuerSigningKey,
} from "@/lib/issuer-service";
import { readJsonBody, type BodyResult } from "@/lib/request-limits";
import { resolveTenant, validateTenantCredentialTypes, type Tenant } from "@/lib/tenancy";

const SIM_ACCOUNT =
  env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// readonly CredentialType[] widened to string[] so .includes() accepts any
// user-supplied string during validation, before it's known to be valid.
export const VALID_TYPES: readonly string[] = CREDENTIAL_TYPES;

/** The request body POST /api/issue accepts. Both shapes are optional. */
export interface IssueBody {
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
}

/**
 * A body that has been normalised but not yet validated. Every field the
 * client may omit is either defaulted or explicitly optional here — the
 * required fields stay optional until {@link validateIssueRequest} narrows
 * them, so a missing one is reported rather than crashed on.
 */
export interface NormalizedIssueRequest {
  credentialTypes: string[];
  holder?: string;
  /** Body `issuerId`, or the authenticated tenant's configured issuer. */
  issuerId?: string;
  issuerName: string;
  expiry: string;
  attributes: Record<string, string>;
  claimParams?: ClaimParams;
  personaInquiryId?: string;
  returnUrl?: string;
}

/** A normalised request whose required fields have been proven present. */
export interface IssueRequest extends NormalizedIssueRequest {
  holder: string;
  issuerId: string;
}

/** A client- or configuration-caused rejection, safe to render verbatim. */
export interface ValidationFailure {
  status: 400 | 401 | 403 | 500;
  error: string;
}

export type ValidationResult =
  { ok: true; request: IssueRequest } | { ok: false; failure: ValidationFailure };

/** The authenticated tenant, or a rejection when authentication failed. */
export type TenantResolution =
  { ok: true; tenant: Tenant | null } | { ok: false; status: number; error: string };

/**
 * Authenticate the caller. Requests without tenant credentials take the
 * default (single-issuer) path; requests with a bad or cross-tenant key are
 * rejected before the body is read.
 */
export async function resolveRequestTenant(req: NextRequest): Promise<TenantResolution> {
  const result = await resolveTenant(req);
  if (result.error) {
    return { ok: false, status: result.status ?? 401, error: result.error };
  }
  return { ok: true, tenant: result.tenant };
}

/**
 * Read and parse the body through the shared size guard. A failure here is a
 * 400/413 that the route answers directly (it is not a validation verdict on
 * the issuance request, and must not be cached as one).
 */
export function parseIssueBody(req: NextRequest): Promise<BodyResult<IssueBody>> {
  return readJsonBody<IssueBody>(req);
}

/**
 * Collapse both accepted body shapes into one request object.
 *
 * Pure: no logging, no validation, no provider calls. `credential_types` wins
 * over `type`; the legacy `attribute` string is folded into `attributes`
 * (without overwriting an explicitly supplied attribute), which is what the
 * single-type callers have always relied on. The issuer defaults to the
 * authenticated tenant's configured issuer.
 */
export function normalizeIssueRequest(
  body: IssueBody,
  tenant?: Tenant | null,
): NormalizedIssueRequest {
  const credentialTypes = body.credential_types ?? (body.type ? [body.type] : []);

  const attributes: Record<string, string> = { ...(body.attributes ?? {}) };
  if (body.attribute !== undefined && body.type) {
    if (body.type === "age") attributes.date_of_birth ??= body.attribute;
    else if (body.type === "income") attributes.income ??= body.attribute;
    else if (body.type === "jurisdiction") attributes.country_code ??= body.attribute;
    else if (body.type === "employment") attributes.seniority ??= body.attribute;
  }

  return {
    credentialTypes,
    holder: body.holder,
    issuerId: body.issuerId ?? tenant?.config.issuerId,
    issuerName: body.issuerName ?? tenant?.config.issuerName ?? "StellarCred Authority",
    expiry: body.expiry ?? "90 days",
    attributes,
    claimParams: body.claimParams,
    personaInquiryId: body.persona_inquiry_id,
    returnUrl: body.returnUrl,
  };
}

/**
 * Run the ordered field checks, emitting the two log events this stage has
 * always emitted (`request_received` per requested type, and
 * `validation_result` when a type is rejected).
 *
 * When a tenant is authenticated, its boundaries are enforced directly after
 * the generic field checks, in the same order as the single-route
 * implementation: a cross-tenant `issuerId` is a 403, then a credential type
 * outside the tenant's allow-list is a 403.
 */
export function validateIssueRequest(
  request: NormalizedIssueRequest,
  requestId: string,
  tenant?: Tenant | null,
): ValidationResult {
  const { credentialTypes, holder, issuerId } = request;

  for (const type of credentialTypes) {
    logger.info(
      stripSensitiveFields({
        event: "request_received",
        credentialType: type,
        issuerId,
        walletAddress: holder,
        requestId,
      }),
    );
  }

  if (credentialTypes.length === 0) {
    return {
      ok: false,
      failure: {
        status: 400,
        error: "credential_types must contain at least one type",
      },
    };
  }

  const invalid = credentialTypes.find((t) => !VALID_TYPES.includes(t));
  if (invalid) {
    for (const type of credentialTypes) {
      logger.info(
        stripSensitiveFields({
          event: "validation_result",
          credentialType: type,
          issuerId,
          walletAddress: holder,
          outcome: "invalid_type",
          requestId,
        }),
      );
    }
    return {
      ok: false,
      failure: { status: 400, error: `Invalid credential type: ${invalid}` },
    };
  }

  if (!holder) {
    return {
      ok: false,
      failure: { status: 400, error: "holder address is required" },
    };
  }

  if (!issuerId) {
    return {
      ok: false,
      failure: { status: 400, error: "issuerId is required" },
    };
  }

  // Cross-tenant issuer restriction: a tenant may only issue as the issuer it
  // is configured with, even when the body names another registered issuer.
  if (tenant && request.issuerId !== tenant.config.issuerId) {
    return {
      ok: false,
      failure: {
        status: 403,
        error: `Unauthorized issuerId for tenant '${tenant.id}'. Configured issuerId is '${tenant.config.issuerId}'.`,
      },
    };
  }

  if (tenant) {
    const typeCheck = validateTenantCredentialTypes(tenant, credentialTypes);
    if (!typeCheck.allowed) {
      return {
        ok: false,
        failure: {
          status: 403,
          error: `Tenant '${tenant.id}' is not authorized to issue credential type '${typeCheck.disallowedType}'.`,
        },
      };
    }
  }

  return { ok: true, request: { ...request, holder, issuerId } };
}

/**
 * Resolve the tenant's signing key and build a client for it. Untenanted
 * requests return `undefined`, which makes the issuer service fall back to the
 * server's own key.
 */
export async function resolveIssuerClient(
  tenant: Tenant | null | undefined,
): Promise<IssuerClient | undefined> {
  if (!tenant) return undefined;
  const signingKey = await resolveIssuerSigningKey(tenant.config.signingKeySecretRef);
  return createIssuerClient(signingKey);
}

/**
 * Confirm the selected issuer can actually be served by this deployment, when
 * an IssuerRegistry is configured.
 *
 * Two independent failures, reported distinctly because the remedy differs:
 * an unregistered issuer is a caller error (pick another issuer), while a
 * key mismatch is a server misconfiguration (the signing key does not belong
 * to that issuer).
 */
export async function validateIssuerRegistration(
  issuerId: string,
  issuerClient?: IssuerClient,
): Promise<ValidationFailure | null> {
  if (!env.NEXT_PUBLIC_ISSUER_REGISTRY_ID) return null;

  const registered = await fetchIssuerPubkey(issuerId, SIM_ACCOUNT);
  if (!registered) {
    return {
      status: 400,
      error: "Selected issuer is not registered on IssuerRegistry.",
    };
  }

  const localKey = localIssuerPubkeyBytes(issuerClient);
  if (!equals(registered, localKey)) {
    return {
      status: 403,
      error:
        "ISSUER_PRIVATE_KEY does not match the selected issuer's registered public key on IssuerRegistry. Choose the issuer that matches your server key, or update ISSUER_PRIVATE_KEY.",
    };
  }

  return null;
}

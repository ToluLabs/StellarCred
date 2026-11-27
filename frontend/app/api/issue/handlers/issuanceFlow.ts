/**
 * issuanceFlow.ts — what actually has to happen for a validated issuance
 * request to become signed credentials.
 *
 * The route's only job is to decide *whether* to run this; the sequence —
 * identity (Persona), then balance (Plaid), then signing and stamping — lives
 * here, so a new credential type or provider shows up in one place.
 *
 * The provider stages are deliberately sequential and short-circuiting: a KYC
 * request that has not completed Persona is answered with the redirect, and
 * nothing downstream runs; a failed balance attestation never reaches signing.
 *
 * Two invariants this module is responsible for:
 *
 * 1. **Provider error text never escapes.** Provider exceptions and response
 *    bodies can echo identity fields. They are classified at the boundary and
 *    only fixed safe messages and diagnostic codes leave this module.
 * 2. **Plaid is the source of truth for `balance`.** A caller-supplied value is
 *    overwritten with the verified aggregate. Only that aggregate is signed;
 *    per-source account detail never leaves this function.
 */

import type { Credential, CredentialType, IssuerClient } from "@stellarcred/issuer";
import { createPersonaInquiry, resolvePersonaKYC } from "@/lib/persona";
import { registerPendingInquiry } from "@/lib/persona-webhook";
import { fetchPlaidBalance } from "@/lib/plaid";
import { issueAndAuditCredentials } from "@/lib/issuer-service";
import { currentDeploymentRef, type DeploymentRef } from "@/lib/deployment";
import { circuitVersionStampFor, type CircuitVersionStamp } from "@/lib/circuit-versions";
import { reportError } from "@/lib/error-reporting";
import { env } from "@/lib/env";
import { logger, stripSensitiveFields } from "@/lib/logger";
import { recordError } from "@/lib/metrics";
import type { IssueRequest } from "./validate";
import { classifyVerificationError, VerificationError } from "../../../../packages/sdk/src/errors";

function errorBody(error: VerificationError): Record<string, unknown> {
  return {
    error: error.message,
    code: error.code,
    category: error.category,
    retryable: error.retryable,
  };
}

export interface IssuanceContext {
  requestId: string;
  /** Origin to fall back to for the Persona redirect when BASE_URL is unset. */
  origin: string;
  /** Tenant signing client; omitted for the default single-issuer flow. */
  issuerClient?: IssuerClient;
}

/** A signed credential plus the deployment / circuit it was minted against. */
export type IssuedCredential = Credential & CircuitVersionStamp & { deployment: DeploymentRef };

export type IssuanceOutcome =
  /** The holder must complete (or resume) a Persona inquiry first. */
  | { kind: "persona"; personaUrl: string; inquiryId: string }
  | { kind: "issued"; credentials: IssuedCredential[] }
  /** A provider rejection or signing failure, ready to render as-is. */
  | { kind: "error"; status: number; body: Record<string, unknown> };

/**
 * Run the provider chain and issuance for a validated request.
 *
 * Returns an outcome rather than a `NextResponse` so the route stays the one
 * place that shapes responses, sets `x-request-id`, and writes the idempotency
 * cache — the flow only says what happened.
 */
export async function runIssuanceFlow(
  request: IssueRequest,
  ctx: IssuanceContext,
): Promise<IssuanceOutcome> {
  const { requestId, origin, issuerClient } = ctx;
  const {
    credentialTypes,
    holder,
    issuerId,
    issuerName,
    expiry,
    claimParams,
    personaInquiryId,
    returnUrl,
  } = request;

  // Copy: the flow owns these from here on (KYC and Plaid both write into it).
  const attributes: Record<string, string> = { ...request.attributes };

  // ---------------------------------------------------------------------------
  // Identity verification via Persona
  // ---------------------------------------------------------------------------
  if (credentialTypes.includes("kyc")) {
    if (!env.PERSONA_API_KEY) {
      logger.info(
        stripSensitiveFields({
          event: "provider_call",
          credentialType: "kyc",
          issuerId,
          walletAddress: holder,
          outcome: "demo_mode",
          requestId,
        }),
      );
    } else {
      const templateId = env.PERSONA_KYC_TEMPLATE_ID;
      if (!templateId) {
        return {
          kind: "error",
          status: 500,
          body: errorBody(
            new VerificationError({
              category: "configuration_error",
              code: "persona_not_configured",
              httpStatus: 500,
            }),
          ),
        };
      }
      const baseUrl = env.NEXT_PUBLIC_STELLARCRED_BASE_URL ?? origin;

      // Every Persona call in this block is wrapped so a provider failure
      // cannot escape the handler. See invariant (1) in the module header.
      try {
        if (!personaInquiryId) {
          logger.info(
            stripSensitiveFields({
              event: "provider_call",
              credentialType: "kyc",
              issuerId,
              walletAddress: holder,
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
            issuerId,
            issuerName,
            expiry,
            credentialTypes: credentialTypes as CredentialType[],
            claimParams,
          });
          return { kind: "persona", personaUrl: url, inquiryId: id };
        }

        const kyc = await resolvePersonaKYC(personaInquiryId);
        if (!kyc.ok) {
          logger.info(
            stripSensitiveFields({
              event: "provider_call",
              credentialType: "kyc",
              issuerId,
              walletAddress: holder,
              outcome: "verification_failed",
              requestId,
            }),
          );
          const error = new VerificationError({
            category: kyc.errorCategory ?? "policy_rejection",
            code: kyc.errorCode ?? "persona_incomplete",
            httpStatus: 403,
          });
          return {
            kind: "error",
            status: 403,
            body: errorBody(error),
          };
        }

        logger.info(
          stripSensitiveFields({
            event: "provider_call",
            credentialType: "kyc",
            issuerId,
            walletAddress: holder,
            outcome: "verified",
            requestId,
          }),
        );
        if (kyc.dob) attributes.date_of_birth = kyc.dob;
        if (kyc.countryNumeric) attributes.country_code = kyc.countryNumeric;
      } catch (e) {
        const error = classifyVerificationError(e, {
          fallbackCategory: "network_error",
          fallbackCode: "persona_unavailable",
        });
        logger.error(
          stripSensitiveFields({
            event: "provider_call",
            credentialType: "kyc",
            issuerId,
            walletAddress: holder,
            outcome: error.code,
            requestId,
          }),
        );
        return {
          kind: "error",
          status: error.httpStatus ?? 502,
          body: errorBody(error),
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Balance attestation via Plaid
  // ---------------------------------------------------------------------------
  if (credentialTypes.includes("funds")) {
    const plaid = await fetchPlaidBalance(requestId);
    if (!plaid.ok) {
      logger.info(
        stripSensitiveFields({
          event: "provider_call",
          credentialType: "funds",
          issuerId,
          walletAddress: holder,
          outcome: "verification_failed",
          requestId,
        }),
      );
      const error = new VerificationError({
        category: "network_error",
        code: plaid.code,
        httpStatus: plaid.status,
      });
      return {
        kind: "error",
        status: plaid.status,
        body: errorBody(error),
      };
    }

    logger.info(
      stripSensitiveFields({
        event: "provider_call",
        credentialType: "funds",
        issuerId,
        walletAddress: holder,
        outcome: "verified",
        requestId,
      }),
    );
    attributes.balance = String(plaid.balance ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Signing
  // ---------------------------------------------------------------------------
  try {
    const issuedCredentials = await issueAndAuditCredentials({
      credentialTypes,
      holder,
      issuerId,
      issuerName,
      expiry,
      attributes,
      claimParams,
      requestId,
      issuerClient,
    });

    // Stamp the deployment and the circuit version on every credential at mint
    // time (#545, #633). The circuit version is what lets the holder's device
    // detect — before proving, with a message naming both versions — that the
    // circuit this credential was issued against is no longer the one this app
    // serves, instead of surfacing it later as an invalid witness.
    const credentials: IssuedCredential[] = issuedCredentials.map((credential) => ({
      ...credential,
      deployment: currentDeploymentRef(),
      ...circuitVersionStampFor(credential.type),
    }));

    return { kind: "issued", credentials };
  } catch (e) {
    const error = classifyVerificationError(e, {
      fallbackCategory: "network_error",
      fallbackCode: "issuance_failed",
    });
    for (const type of credentialTypes) {
      logger.error(
        stripSensitiveFields({
          event: "signing_failed",
          credentialType: type,
          issuerId,
          walletAddress: holder,
          error: error.code,
          requestId,
        }),
      );
    }
    void reportError({
      method: "POST",
      path: "/api/issue",
      requestId,
      status: 500,
      exception: error,
    });
    recordError("issue", "signing_error");
    return {
      kind: "error",
      status: 500,
      body: errorBody(error),
    };
  }
}

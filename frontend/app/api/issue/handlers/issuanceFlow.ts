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
 * 1. **Provider error text never escapes.** `lib/persona.ts` embeds Persona's
 *    response body in the thrown error, and Persona's bodies echo the identity
 *    fields it holds. The catch below therefore drops the message entirely:
 *    not logged, not reported, not returned.
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
import type { IssueRequest } from "./validate";

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
          body: {
            error: "PERSONA_KYC_TEMPLATE_ID is required when PERSONA_API_KEY is set",
          },
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
          return {
            kind: "error",
            status: 403,
            body: { error: kyc.error ?? "Identity verification failed" },
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
      } catch {
        logger.error(
          stripSensitiveFields({
            event: "provider_call",
            credentialType: "kyc",
            issuerId,
            walletAddress: holder,
            outcome: "provider_unavailable",
            requestId,
          }),
        );
        return {
          kind: "error",
          status: 502,
          body: {
            error: "Identity verification service is unavailable. Please try again.",
          },
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
      return {
        kind: "error",
        status: plaid.status,
        body: { error: plaid.error, code: plaid.code },
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
    for (const type of credentialTypes) {
      logger.error(
        stripSensitiveFields({
          event: "signing_failed",
          credentialType: type,
          issuerId,
          walletAddress: holder,
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
    return {
      kind: "error",
      status: 500,
      body: { error: (e as Error).message },
    };
  }
}

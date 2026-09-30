"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  parseTrustedIssuersParam,
  validateVerifyParams,
  parseVerifyParams,
  type VerifyError,
} from "@/lib/verifyParams";
import { isVerifyNonceConsumed } from "@/lib/verify-nonce";
import { TYPE_META } from "@/lib/credential";
import type { CredentialType } from "@/lib/stellar";

const VALID_CLAIMS = Object.keys(TYPE_META) as CredentialType[];

export interface ClaimParamsFromUrl {
  threshold_years?: string;
  threshold?: string;
  restricted?: string[];
  mode?: string;
}

export function useVerifyParams() {
  const searchParams = useSearchParams();

  // Structured parse of every /verify query param — the single source of
  // truth for whether this link is usable. Expired / malformed / consumed
  // links are rejected here, before any form is rendered.
  const parsedLink = useMemo(
    () =>
      parseVerifyParams({
        return_url: searchParams.get("return_url"),
        claim: searchParams.get("claim"),
        threshold_years: searchParams.get("threshold_years"),
        threshold: searchParams.get("threshold"),
        min_threshold: searchParams.get("min_threshold"),
        restricted: searchParams.get("restricted"),
        inquiry_id: searchParams.get("inquiry-id"),
        exp: searchParams.get("exp"),
        jti: searchParams.get("jti"),
      }),
    [searchParams],
  );

  const [linkError, setLinkError] = useState<VerifyError | null>(
    parsedLink.ok ? null : parsedLink.error ?? null,
  );

  useEffect(() => {
    if (!parsedLink.ok) {
      setLinkError(parsedLink.error ?? null);
      return;
    }
    if (parsedLink.jti && isVerifyNonceConsumed(parsedLink.jti)) {
      setLinkError({
        code: "consumed_link",
        title: "This verification link has already been used",
        detail:
          "Each single-use verification link can only be opened once. Ask the service that sent you here for a fresh link.",
      });
    } else {
      setLinkError(null);
    }
  }, [parsedLink]);

  const returnUrl = searchParams.get("return_url");
  const personaInquiryId = searchParams.get("inquiry-id");
  const claimParam = searchParams.get("claim") as CredentialType | null;
  const requiredClaim =
    claimParam && VALID_CLAIMS.includes(claimParam) ? claimParam : null;
  const locked = !!requiredClaim;

  const trustedIssuersParam = searchParams.get("trusted_issuers");
  const parsedTrustedIssuers = parseTrustedIssuersParam(trustedIssuersParam);
  const trustedIssuers = parsedTrustedIssuers.ok
    ? parsedTrustedIssuers.issuers
    : [];
  const trustedIssuerGate =
    trustedIssuers.length > 0 ? trustedIssuers : undefined;

  const paramValidation = validateVerifyParams({
    returnUrl,
    claim: claimParam,
    thresholdYears: searchParams.get("threshold_years"),
    threshold: searchParams.get("threshold"),
    restricted: searchParams.get("restricted"),
    trustedIssuers: trustedIssuersParam,
    currentOrigin:
      typeof window !== "undefined" ? window.location.origin : undefined,
  });

  const minThresholdParam = searchParams.get("min_threshold") ?? undefined;
  const claimParamsFromUrl: ClaimParamsFromUrl = {
    threshold_years:
      searchParams.get("threshold_years") ??
      (claimParam === "age" ? minThresholdParam : undefined),
    threshold:
      searchParams.get("threshold") ??
      (["funds", "income", "accreditation", "employment"].includes(
        claimParam ?? "",
      )
        ? minThresholdParam
        : undefined),
    restricted:
      searchParams.get("restricted")?.split(",").filter(Boolean) ?? undefined,
    mode: searchParams.get("mode") ?? undefined,
  };

  const paramErrors = [
    paramValidation.claimError,
    paramValidation.thresholdYearsError,
    paramValidation.thresholdError,
    paramValidation.restrictedError,
    paramValidation.trustedIssuersError,
  ].filter(Boolean) as string[];

  const [urlError, setUrlError] = useState("");
  const [requestingDomain, setRequestingDomain] = useState("");

  useEffect(() => {
    if (returnUrl) {
      const result = validateVerifyParams({
        returnUrl,
        claim: null,
        thresholdYears: null,
        threshold: null,
        restricted: null,
        currentOrigin:
          typeof window !== "undefined" ? window.location.origin : undefined,
      });

      if (result.returnUrlError) {
        setUrlError(result.returnUrlError);
        setRequestingDomain("");
      } else {
        setUrlError("");
        try {
          if (returnUrl.startsWith("/")) {
            setRequestingDomain(
              typeof window !== "undefined" ? window.location.hostname : "",
            );
          } else {
            setRequestingDomain(new URL(returnUrl).hostname);
          }
        } catch {
          setRequestingDomain("");
        }
      }
    } else {
      setUrlError("");
      setRequestingDomain("");
    }
  }, [returnUrl]);

  return {
    parsedLink,
    linkError,
    setLinkError,
    returnUrl,
    personaInquiryId,
    claimParam,
    requiredClaim,
    locked,
    trustedIssuersParam,
    trustedIssuers,
    trustedIssuerGate,
    claimParamsFromUrl,
    paramValidation,
    paramErrors,
    urlError,
    setUrlError,
    requestingDomain,
  };
}

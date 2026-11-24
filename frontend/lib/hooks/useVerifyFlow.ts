"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { saveCredential, TYPE_META, type Credential } from "@/lib/credential";
import type { CredentialType } from "@/lib/stellar";
import {
  eligibleIssuers,
  isProtocolAccepted,
  pickDefaultIssuer,
} from "@/lib/issuer-choice";
import type { RegisteredIssuer } from "@/lib/issuer-registry";
import { savePersonaPending } from "@/lib/persona-pending";
import { getOrCreateRequestId } from "@/lib/verify-session";
import { performVerifyRedirect } from "@/lib/verify-redirect";
import type { ClaimParamsFromUrl } from "./useVerifyParams";

export const TYPES = Object.entries(TYPE_META) as [
  CredentialType,
  (typeof TYPE_META)[CredentialType],
][];

export const VALID_CLAIMS = TYPES.map(([k]) => k);

const DEMO_ISSUER_ID = process.env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "";

export interface UseVerifyFlowOptions {
  address: string | null;
  requiredClaim: CredentialType | null;
  trustedIssuerGate?: string[];
  claimParamsFromUrl: ClaimParamsFromUrl;
  returnUrl?: string | null;
  urlError?: string;
  setUrlError: (err: string) => void;
  parsedLink: {
    ok: boolean;
    jti?: string;
    exp?: number;
  };
  router: {
    push: (url: string) => void;
  };
  toast: {
    success: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export function useVerifyFlow({
  address,
  requiredClaim,
  trustedIssuerGate,
  claimParamsFromUrl,
  returnUrl,
  urlError,
  setUrlError,
  parsedLink,
  router,
  toast,
}: UseVerifyFlowOptions) {
  const [selected, setSelected] = useState<CredentialType | null>(
    requiredClaim ?? TYPES[0]?.[0] ?? null,
  );

  const [attributes, setAttributes] = useState<Record<string, string>>({
    date_of_birth: "1995-06-15",
    income: "250000",
    net_worth: "1500000",
    country_code: "566",
    seniority: "5",
  });

  const [expiry, setExpiry] = useState("90 days");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const justIssuedClaims = useRef<string[]>([]);

  // Jurisdiction mode: "0" = denylist (block), "1" = allowlist (allow)
  const [jurisdictionMode, setJurisdictionMode] = useState<string>(
    claimParamsFromUrl.mode ?? "0",
  );

  // #620 — several registered issuers can attest the same claim type, so let
  // the holder pick which one issues to them.
  const [issuers, setIssuers] = useState<RegisteredIssuer[]>([]);
  const [selectedIssuerId, setSelectedIssuerId] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/issuers")
      .then((res) => (res.ok ? res.json() : { issuers: [] }))
      .then((data: { issuers?: RegisteredIssuer[] }) => {
        if (!cancelled) setIssuers(data.issuers ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const issuersForType = useMemo(
    () => eligibleIssuers(issuers, selected),
    [issuers, selected],
  );

  const selectedIssuer = useMemo(
    () =>
      issuersForType.find((issuer) => issuer.id === selectedIssuerId) ?? null,
    [issuersForType, selectedIssuerId],
  );

  // Default to an issuer the protocol accepts; re-default whenever the
  // eligible set no longer contains the current pick (claim type switched,
  // registry loaded late).
  useEffect(() => {
    if (issuersForType.some((issuer) => issuer.id === selectedIssuerId)) return;
    setSelectedIssuerId(pickDefaultIssuer(issuersForType, trustedIssuerGate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issuersForType, trustedIssuerGate]);

  const issuerAccepted = selectedIssuer
    ? isProtocolAccepted(selectedIssuer.id, trustedIssuerGate)
    : true;
  const anyAccepted =
    trustedIssuerGate === undefined ||
    issuersForType.some((issuer) =>
      isProtocolAccepted(issuer.id, trustedIssuerGate),
    );

  const [plaidBalance, setPlaidBalance] = useState<number | null>(null);
  const [plaidAccounts, setPlaidAccounts] = useState<
    { name: string; available: number }[]
  >([]);
  const [plaidSources, setPlaidSources] = useState<number | null>(null);
  const [plaidMock, setPlaidMock] = useState(false);

  const fundsSelected = selected === "funds";
  useEffect(() => {
    if (!fundsSelected) return;
    setPlaidBalance(null);
    fetch("/api/plaid-balance", {
      headers: { "x-request-id": getOrCreateRequestId() },
    })
      .then((r) => r.json())
      .then(
        (d: {
          balance?: number;
          sources?: number;
          accounts?: { name: string; available: number }[];
          mock?: boolean;
          error?: string;
        }) => {
          if (d.balance !== undefined) {
            setPlaidBalance(d.balance);
            setPlaidAccounts(d.accounts ?? []);
            setPlaidSources(d.sources ?? null);
            setPlaidMock(!!d.mock);
          }
        },
      )
      .catch(() => {});
  }, [fundsSelected]);

  function setAttr(key: string, val: string) {
    setAttributes((a: Record<string, string>) => ({ ...a, [key]: val }));
  }

  // Where the user is sent after a successful issue.
  function redirectAfterIssue() {
    performVerifyRedirect({
      returnUrl,
      urlError,
      address,
      justIssuedClaims: justIssuedClaims.current,
      parsedLink,
      onSetUrlError: setUrlError,
      router,
    });
  }

  const handleSuccess = async (credentials: Credential[]) => {
    await Promise.all(credentials.map((c) => saveCredential(c)));
    justIssuedClaims.current = credentials
      .map((c) => c.type)
      .filter((t) => VALID_CLAIMS.includes(t as CredentialType));

    setDone(true);
    toast.success(
      credentials.length > 1
        ? "Credentials issued successfully"
        : "Credential issued successfully",
    );
    setTimeout(redirectAfterIssue, 1500);
  };

  async function onRequest() {
    if (!address || !selected) return;
    setBusy(true);
    setError("");
    const requestId = getOrCreateRequestId();
    try {
      // The holder's pick when a registered issuer covers this claim type;
      // otherwise the demo issuer configured for this deployment.
      const issuerId = selectedIssuer?.id ?? DEMO_ISSUER_ID;
      const issuerName = selectedIssuer?.name ?? "StellarCred Authority";
      if (!issuerId) {
        throw new Error(
          "NEXT_PUBLIC_ISSUER_ADDRESS is not set — cannot issue credentials",
        );
      }
      const payload = {
        credential_types: [selected],
        holder: address,
        issuerId,
        issuerName,
        expiry,
        attributes,
        claimParams: {
          ...claimParamsFromUrl,
          ...(selected === "jurisdiction" ? { mode: jurisdictionMode } : {}),
        },
      } as const;
      const res = await fetch("/api/issue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify({
          ...payload,
          returnUrl: returnUrl ?? undefined,
        }),
      });
      // 202 means Persona identity verification is required — redirect user.
      if (res.status === 202) {
        const { personaUrl } = (await res.json()) as { personaUrl: string };
        // Stash only what resuming issuance needs. savePersonaPending
        // whitelist-strips `attributes` (PII) and fails loudly if any banned
        // key would be serialized; the server re-derives DOB/country from the
        // verified Persona inquiry on resume, so they're not needed here.
        savePersonaPending({
          credential_types: [...payload.credential_types],
          holder: payload.holder,
          issuerId: payload.issuerId,
          issuerName: payload.issuerName,
          expiry: payload.expiry,
          claimParams: { ...payload.claimParams },
        });
        window.location.href = personaUrl;
        return; // don't clear busy — page is navigating away
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? "Issuing failed");
      }
      const { credentials } = (await res.json()) as {
        credentials: Credential[];
      };
      await handleSuccess(credentials);
    } catch (e) {
      const message = (e as Error).message;
      setError(`${message} (ref: ${requestId})`);
      toast.error(`Credential issuance failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  return {
    selected,
    setSelected,
    attributes,
    setAttr,
    expiry,
    setExpiry,
    busy,
    setBusy,
    error,
    setError,
    done,
    setDone,
    jurisdictionMode,
    setJurisdictionMode,
    issuers,
    issuersForType,
    selectedIssuerId,
    setSelectedIssuerId,
    selectedIssuer,
    issuerAccepted,
    anyAccepted,
    plaidBalance,
    plaidAccounts,
    plaidSources,
    plaidMock,
    justIssuedClaims,
    redirectAfterIssue,
    handleSuccess,
    onRequest,
  };
}

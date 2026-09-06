"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  IconArrowRight,
  IconLoader2,
  IconCheck,
  IconBuildingBank,
  IconQrcode,
} from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet } from "@/lib/wallet-context";
import { saveCredential, TYPE_META, type Credential } from "@/lib/credential";
import type { CredentialType } from "@/lib/stellar";
import { useToast } from "@/components/Toast";
import { parseVerifyParams, validateVerifyParams, type VerifyError } from "@/lib/verifyParams";
import { VerifyLinkError } from "@/app/verify/VerifyLinkError";
import { QrScanner } from "@/components/QrScanner";
import { ConfigBanner } from "@/components/ConfigBanner";
import { issuanceConfigured } from "@/lib/config";
import {
  savePersonaPending,
  loadPersonaPending,
  clearStalePersonaPending,
} from "@/lib/persona-pending";

const TYPES = Object.entries(TYPE_META) as [
  CredentialType,
  (typeof TYPE_META)[CredentialType],
][];

const COUNTRIES = [
  { code: "566", name: "Nigeria" },
  { code: "276", name: "Germany" },
  { code: "356", name: "India" },
  { code: "840", name: "United States (restricted)" },
  { code: "364", name: "Iran (restricted)" },
];

const DEMO_ISSUER_ID = process.env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "";

const VALID_CLAIMS = TYPES.map(([k]) => k);

// One id per verify session, sent as `x-request-id` on every /api/issue and
// /api/plaid-balance call so server logs for a single issuance — including
// across the Persona redirect round-trip — can be correlated together.
function getOrCreateRequestId(): string {
  if (typeof window === "undefined") return "";
  const KEY = "sc_request_id";
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

function VerifyInner() {
  const router = useRouter();
  const { address } = useWallet();
  const searchParams = useSearchParams();
  const toast = useToast();

  // When a protocol redirects here it can specify where to send the user back
  // (return_url) and exactly which claim it requires (claim). A required claim
  // locks the selector — the user can't pick something the protocol didn't ask
  // for.
  const returnUrl = searchParams.get("return_url");
  const personaInquiryId = searchParams.get("inquiry-id");
  const claimParam = searchParams.get("claim") as CredentialType | null;
  const requiredClaim =
    claimParam && VALID_CLAIMS.includes(claimParam) ? claimParam : null;
  const locked = !!requiredClaim;

  // Parse and validate every verification-link parameter up front. If the link
  // is malformed (bad claim type / bad threshold / missing return URL), render
  // an explicit invalid-link screen instead of a blank page, a stuck spinner,
  // or a silent proceed.
  const verification = parseVerifyParams({
    return_url: searchParams.get("return_url"),
    claim: searchParams.get("claim"),
    threshold_years: searchParams.get("threshold_years"),
    threshold: searchParams.get("threshold"),
    min_threshold: searchParams.get("min_threshold"),
    restricted: searchParams.get("restricted"),
    inquiry_id: searchParams.get("inquiry-id"),
  });
  const linkError: VerifyError | null = verification.ok ? null : (verification.error ?? null);

  // Validate all query params up-front; block the flow on any invalid value.
  const paramValidation = validateVerifyParams({
    returnUrl,
    claim: claimParam,
    thresholdYears: searchParams.get("threshold_years"),
    threshold: searchParams.get("threshold"),
    restricted: searchParams.get("restricted"),
    currentOrigin: typeof window !== "undefined" ? window.location.origin : undefined,
  });

  // Protocol-supplied proof parameters. These flow into the issued credential
  // so the witness route can use them at prove time instead of hardcoded values.
  const minThresholdParam = searchParams.get("min_threshold") ?? undefined;
    const claimParamsFromUrl = {
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
  const [selected, setSelected] = useState<CredentialType | null>(
    requiredClaim ?? TYPES[0]?.[0] ?? null,
  );
  const radioRefs = useRef<Record<string, HTMLDivElement | null>>({});
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
  const [urlError, setUrlError] = useState("");
  const [requestingDomain, setRequestingDomain] = useState("");
  // Param validation errors surfaced from validateVerifyParams
  const paramErrors = [
    paramValidation.claimError,
    paramValidation.thresholdYearsError,
    paramValidation.thresholdError,
    paramValidation.restrictedError,
  ].filter(Boolean) as string[];
  const [done, setDone] = useState(false);
  const [scanning, setScanning] = useState(false);
  const justIssuedClaims = useRef<string[]>([]);
  // Jurisdiction mode: "0" = denylist (block), "1" = allowlist (allow)
  const [jurisdictionMode, setJurisdictionMode] = useState<string>(
    claimParamsFromUrl.mode ?? "0",
  );

  // A protocol can display this scanned code instead of a clickable link
  // (e.g. on a kiosk or a screen the phone doesn't have a direct link to) —
  // it's the exact same /verify?return_url=...&claim=... URL buildVerifyUrl
  // produces, so scanning it just navigates there like clicking the link would.
  function onScanRequest(text: string) {
    setScanning(false);
    let dest: URL;
    try {
      dest = new URL(text, window.location.origin);
    } catch {
      toast.error("That QR code isn't a valid StellarCred verify request.");
      return;
    }
    // A real verify request always has return_url — reject anything else
    // outright rather than treating an arbitrary scanned URL as trustworthy.
    if (dest.pathname !== "/verify" || !dest.searchParams.has("return_url")) {
      toast.error("That QR code isn't a valid StellarCred verify request.");
      return;
    }
    if (dest.origin === window.location.origin) {
      // The scanned URL itself is same-origin, but its embedded return_url
      // is where the wallet address ends up after issuance — a QR can stay
      // on stellarcred.xyz throughout and still smuggle in a cross-origin
      // return_url, so that param needs the same confirmation the top-level
      // origin check gets below.
      const embeddedReturnUrl = dest.searchParams.get("return_url");
      if (embeddedReturnUrl && !embeddedReturnUrl.startsWith("/")) {
        let returnDest: URL | null = null;
        try {
          returnDest = new URL(embeddedReturnUrl);
        } catch {
          toast.error("That QR code isn't a valid StellarCred verify request.");
          return;
        }
        if (returnDest.protocol !== "https:") {
          toast.error("That QR code isn't a valid StellarCred verify request.");
          return;
        }
        if (returnDest.origin !== window.location.origin) {
          if (!window.confirm(`This code will request verification on behalf of ${returnDest.hostname}, and your wallet address will be sent there once you finish. Continue?`)) {
            return;
          }
        }
      }
      router.push(dest.pathname + dest.search);
    } else if (dest.protocol === "https:") {
      // Leaving the app entirely on a scanned code's say-so is exactly the
      // shape of an open-redirect/phishing risk (a malicious QR could point
      // anywhere) — confirm the destination with the user first instead of
      // silently redirecting.
      if (!window.confirm(`This code will take you to ${dest.hostname} to continue verification there. Continue?`)) {
        return;
      }
      window.location.href = dest.toString();
    } else {
      toast.error("That QR code isn't a valid StellarCred verify request.");
    }
  }

  useEffect(() => {
    if (returnUrl) {
      // Use the extracted validator so error messages are consistent and testable.
      const result = validateVerifyParams({
        returnUrl,
        claim: null,
        thresholdYears: null,
        threshold: null,
        restricted: null,
        currentOrigin: window.location.origin,
      });

      if (result.returnUrlError) {
        setUrlError(result.returnUrlError);
        setRequestingDomain("");
      } else {
        setUrlError("");
        try {
          if (returnUrl.startsWith("/")) {
            setRequestingDomain(window.location.hostname);
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
  const [plaidBalance, setPlaidBalance] = useState<number | null>(null);
  const [plaidAccounts, setPlaidAccounts] = useState<
    { name: string; available: number }[]
  >([]);
  const [plaidMock, setPlaidMock] = useState(false);

  const fundsSelected = selected === "funds";
  useEffect(() => {
    if (!fundsSelected) return;
    setPlaidBalance(null);
    fetch("/api/plaid-balance", { headers: { "x-request-id": getOrCreateRequestId() } })
      .then((r) => r.json())
      .then(
        (d: {
          balance?: number;
          accounts?: { name: string; available: number }[];
          mock?: boolean;
          error?: string;
        }) => {
          if (d.balance !== undefined) {
            setPlaidBalance(d.balance);
            setPlaidAccounts(d.accounts ?? []);
            setPlaidMock(!!d.mock);
          }
        },
      )
      .catch(() => {});
  }, [fundsSelected]);

  // Guarantee cleanup on abandonment: if the user comes back from Persona
  // without an inquiry-id (cancelled mid-flow) — or never left — any lingering
  // sc_persona_pending blob is wiped on mount. loadPersonaPending() clears on
  // read for the success/failure paths below.
  useEffect(() => {
    clearStalePersonaPending(Boolean(personaInquiryId));
  }, [personaInquiryId]);

  // When Persona redirects back to /verify?inquiry-id=XXX, resume the pending
  // issue request that was stored in sessionStorage before the redirect.
  useEffect(() => {
    if (!personaInquiryId || !address) return;
    // Read-and-clear: the blob is removed before the resumed call is made,
    // so it's gone whether the issue succeeds or fails.
    const pending = loadPersonaPending();
    if (!pending) return;
    setBusy(true);
    setError("");
    const requestId = getOrCreateRequestId();
    fetch("/api/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ ...pending, persona_inquiry_id: personaInquiryId }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const d = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            d?.error ?? "Issuing failed after identity verification",
          );
        }
        return res.json() as Promise<{
          credentials: import("@/lib/credential").Credential[];
        }>;
      })
      .then(async ({ credentials }) => {
        await Promise.all(credentials.map((c) => saveCredential(c)));
        justIssuedClaims.current = credentials.map((c) => c.type).filter((t) => VALID_CLAIMS.includes(t as CredentialType));

        setDone(true);
        toast.success(
          credentials.length > 1
            ? "Credentials issued successfully"
            : "Credential issued successfully",
        );
        setTimeout(redirectAfterIssue, 1500);
      })
      .catch((e) => {
        const message = (e as Error).message;
        setError(`${message} (ref: ${requestId})`);
        toast.error(`Credential issuance failed: ${message}`);
      })
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaInquiryId, address]);

  function setAttr(key: string, val: string) {
    setAttributes((a: Record<string, string>) => ({ ...a, [key]: val }));
  }

  const handleBack = () => {
    router.push("/");
  };

  // Where the user is sent after a successful issue.
  function redirectAfterIssue() {
    if (returnUrl && !urlError && address) {
      let dest;
      try {
        if (returnUrl.startsWith("/")) {
          dest = new URL(returnUrl, window.location.origin);
        } else {
          dest = new URL(returnUrl);
        }

        // Validate protocol for safety
        if (
          dest.protocol !== "https:" &&
          dest.origin !== window.location.origin
        ) {
          setUrlError("Invalid return URL: Must use HTTPS protocol.");
          router.push("/holder");
          return;
        }

        dest.searchParams.set("sc_verified", "true");
        dest.searchParams.set("sc_wallet", address);
        if (justIssuedClaims.current.length > 0) {
          dest.searchParams.set("sc_claims", justIssuedClaims.current.join(","));
        }

        if (dest.origin === window.location.origin) {
          router.push(dest.pathname + dest.search);
        } else {
          // Never router.push an external URL — do a real browser navigation.
          window.location.href = dest.toString();
        }
      } catch {
        setUrlError("Invalid return URL: Must be a well-formed URL.");
        router.push("/holder");
      }
    } else {
      router.push("/holder");
    }
  }

  async function onRequest() {
    if (!address || !selected) return;
    setBusy(true);
    setError("");
    const requestId = getOrCreateRequestId();
    try {
      if (!DEMO_ISSUER_ID) {
        throw new Error(
          "NEXT_PUBLIC_ISSUER_ADDRESS is not set — cannot issue credentials",
        );
      }
      const payload = {
        credential_types: [selected],
        holder: address,
        issuerId: DEMO_ISSUER_ID,
        issuerName: "StellarCred Authority",
        expiry,
        attributes,
        claimParams: {
          ...claimParamsFromUrl,
          ...(selected === "jurisdiction" ? { mode: jurisdictionMode } : {}),
        },
      } as const;
      const res = await fetch("/api/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-request-id": requestId },
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
      await Promise.all(credentials.map((c) => saveCredential(c)));
      justIssuedClaims.current = credentials.map((c) => c.type).filter((t) => VALID_CLAIMS.includes(t as CredentialType));
      setDone(true);
      toast.success(
        credentials.length > 1
          ? "Credentials issued successfully"
          : "Credential issued successfully",
      );
      setTimeout(redirectAfterIssue, 1500);
    } catch (e) {
      const message = (e as Error).message;
      setError(`${message} (ref: ${requestId})`);
      toast.error(`Credential issuance failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="between" style={{ marginBottom: "2rem" }}>
        <div>
          <span className="eyebrow">Verify</span>
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>
            Get verified
          </h1>
        </div>
        <WalletButton />
      </div>

      {/* Same shared check as /api/ready — surfaces misconfiguration before
          the user fills anything in, instead of failing mid-issue. */}
      <ConfigBanner requireIssuance />

      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        {!locked && (
          <div style={{ textAlign: "right", marginBottom: "0.75rem" }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setScanning(true)}>
              <IconQrcode size={14} />
              Scan QR
            </button>
          </div>
        )}

        {scanning && (
          <QrScanner
            title="Scan a verify request"
            hint="Point your camera at the QR code a protocol displayed."
            onScan={onScanRequest}
            onClose={() => setScanning(false)}
          />
        )}

        <div className="card">
          {linkError ? (
            <VerifyLinkError error={linkError} onBack={handleBack} />
          ) : !address ? (
            <div style={{ textAlign: "center", padding: "2rem 0" }}>
              <p
                className="muted"
                style={{ marginBottom: "1.25rem", fontSize: "0.9rem" }}
              >
                Connect your wallet to request credentials for your address.
              </p>
              <WalletButton />
            </div>
          ) : done ? (
            <div
              className="reveal"
              style={{ textAlign: "center", padding: "2rem 0" }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: "var(--accent-soft)",
                  marginBottom: "1rem",
                }}
              >
                <IconCheck size={24} color="var(--accent)" stroke={2.5} />
              </span>
              <div style={{ fontWeight: 500 }}>
                {requestingDomain && !urlError
                  ? "Verified"
                  : "Credential saved"}
              </div>
              <div
                className="muted"
                style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}
              >
                {requestingDomain && !urlError
                  ? `Returning to ${requestingDomain}…`
                  : "Credential saved — redirecting to your wallet…"}
              </div>
            </div>
          ) : (
            <>
              {(urlError || paramErrors.length > 0) && (
                <div style={{
                  padding: "0.75rem 1rem",
                  borderRadius: "var(--radius)",
                  background: "rgba(240, 96, 77, 0.1)",
                  border: "1px solid rgba(240, 96, 77, 0.2)",
                  color: "var(--danger)",
                  fontSize: "0.8125rem",
                  marginBottom: "1rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.3rem",
                }}>
                  {urlError && <span>{urlError}</span>}
                  {paramErrors.map((e, i) => <span key={i}>{e}</span>)}
                </div>
              )}
              {requestingDomain && !urlError && (
                <div
                  style={{
                    padding: "0.6rem 0.8rem",
                    borderRadius: "var(--radius-xs)",
                    background: "rgba(62, 207, 142, 0.05)",
                    border: "1px solid rgba(62, 207, 142, 0.15)",
                    fontSize: "0.8125rem",
                    marginBottom: "1.25rem",
                    color: "var(--muted)",
                  }}
                >
                  Requested by{" "}
                  <strong style={{ color: "var(--accent)" }}>
                    {requestingDomain}
                  </strong>
                </div>
              )}
              <label className="field-label" id="credential-type-label">Credential type</label>
              {locked && (
                <p
                  className="faint"
                  style={{ fontSize: "0.8125rem", margin: "0.4rem 0 0" }}
                >
                  A protocol requested the{" "}
                  <strong style={{ color: "var(--accent)" }}>
                    {requiredClaim}
                  </strong>{" "}
                  credential.
                </p>
              )}
              <div
                className="stack"
                role="radiogroup"
                aria-labelledby="credential-type-label"
                style={{
                  gap: "0.5rem",
                  marginTop: "0.5rem",
                  marginBottom: "1.25rem",
                }}
              >
                {TYPES.map(([key, m]) => {
                  const on = selected === key;
                  if (locked && key !== requiredClaim) return null;
                  const visibleTypes = locked
                    ? TYPES.filter(([k]) => k === requiredClaim)
                    : TYPES;
                  return (
                    <div
                      key={key}
                      ref={(el) => {
                        radioRefs.current[key] = el;
                      }}
                      onClick={() => {
                        if (!locked) setSelected(key);
                      }}
                      onKeyDown={(e) => {
                        if (locked) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(key);
                        } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                          e.preventDefault();
                          const i = visibleTypes.findIndex(([k]) => k === key);
                          const [nextKey] = visibleTypes[(i + 1) % visibleTypes.length];
                          setSelected(nextKey);
                          radioRefs.current[nextKey]?.focus();
                        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                          e.preventDefault();
                          const i = visibleTypes.findIndex(([k]) => k === key);
                          const [prevKey] = visibleTypes[(i - 1 + visibleTypes.length) % visibleTypes.length];
                          setSelected(prevKey);
                          radioRefs.current[prevKey]?.focus();
                        }
                      }}
                      role="radio"
                      aria-checked={on}
                      aria-label={m.title}
                      tabIndex={on ? 0 : -1}
                      style={{
                        padding: "0.75rem 0.9rem",
                        borderRadius: "var(--radius)",
                        border: `1px solid ${on ? "rgba(62,207,142,0.4)" : "var(--border)"}`,
                        background: on
                          ? "rgba(62,207,142,0.05)"
                          : "transparent",
                        cursor: locked ? "default" : "pointer",
                        transition:
                          "border-color 0.2s var(--ease), background 0.2s var(--ease)",
                      }}
                    >
                      <div className="between" style={{ alignItems: "center" }}>
                        <span className="row" style={{ gap: "0.6rem" }}>
                          <span
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: "50%",
                              display: "grid",
                              placeItems: "center",
                              border: `2px solid ${on ? "var(--accent)" : "var(--border)"}`,
                              flexShrink: 0,
                            }}
                          >
                            {on && (
                              <span
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: "50%",
                                  background: "var(--accent)",
                                }}
                              />
                            )}
                          </span>
                          <span style={{ fontWeight: 500, fontSize: "0.9rem" }}>
                            {m.title}
                          </span>
                        </span>
                        <span
                          className="mono faint"
                          style={{ fontSize: "0.72rem" }}
                        >
                          {key === "funds" && claimParamsFromUrl.threshold
                            ? `balance > $${Number(claimParamsFromUrl.threshold).toLocaleString("en-US")}`
                            : key === "age" &&
                                claimParamsFromUrl.threshold_years
                              ? `age ≥ ${claimParamsFromUrl.threshold_years}`
                              : key === "income" && claimParamsFromUrl.threshold
                                ? `income > $${Number(claimParamsFromUrl.threshold).toLocaleString("en-US")}`
                                : key === "accreditation" &&
                                    claimParamsFromUrl.threshold
                                  ? `net worth ≥ $${Number(claimParamsFromUrl.threshold).toLocaleString("en-US")}`
                                  : key === "employment" &&
                                      claimParamsFromUrl.threshold
                                    ? `seniority ≥ ${claimParamsFromUrl.threshold} yrs`
                                    : m.claim}
                        </span>
                      </div>

                      {on && key === "kyc" && (
                        <p
                          className="faint"
                          style={{ fontSize: "0.75rem", margin: "0.5rem 0 0" }}
                        >
                          You&rsquo;ll be taken to a secure identity
                          verification flow. No personal data is stored by
                          StellarCred.
                        </p>
                      )}
                      {on && key === "age" && (
                        <div
                          style={{ marginTop: "0.75rem" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <label className="field-label" htmlFor="attr-date-of-birth">{m.attribute}</label>
                          <input
                            id="attr-date-of-birth"
                            type="date"
                            value={attributes.date_of_birth}
                            onChange={(e) =>
                              setAttr("date_of_birth", e.target.value)
                            }
                          />
                        </div>
                      )}
                      {on && key === "income" && (
                        <div
                          style={{ marginTop: "0.75rem" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <label className="field-label" htmlFor="attr-income">{m.attribute}</label>
                          <input
                            id="attr-income"
                            type="number"
                            value={attributes.income}
                            onChange={(e) => setAttr("income", e.target.value)}
                          />
                        </div>
                      )}
                      {on && key === "accreditation" && (
                        <div
                          style={{ marginTop: "0.75rem" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <label className="field-label" htmlFor="attr-net-worth">{m.attribute}</label>
                          <input
                            id="attr-net-worth"
                            type="number"
                            value={attributes.net_worth}
                            onChange={(e) =>
                              setAttr("net_worth", e.target.value)
                            }
                          />
                        </div>
                      )}
                      {on && key === "funds" && (
                        <div
                          style={{ marginTop: "0.75rem" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {plaidBalance === null ? (
                            <p
                              className="faint"
                              style={{
                                fontSize: "0.75rem",
                                margin: 0,
                                display: "flex",
                                alignItems: "center",
                                gap: "0.4rem",
                              }}
                            >
                              <IconLoader2 size={12} className="spin" />
                              Reading balance from Plaid…
                            </p>
                          ) : (
                            <div
                              style={{
                                padding: "0.65rem 0.9rem",
                                borderRadius: "var(--radius)",
                                background: "rgba(62,207,142,0.05)",
                                border: "1px solid rgba(62,207,142,0.2)",
                              }}
                            >
                              <div
                                className="between"
                                style={{
                                  alignItems: "center",
                                  marginBottom:
                                    plaidAccounts.length > 1 ? "0.5rem" : 0,
                                }}
                              >
                                <span
                                  className="row"
                                  style={{
                                    gap: "0.4rem",
                                    fontSize: "0.75rem",
                                    color: "var(--faint)",
                                  }}
                                >
                                  <IconBuildingBank size={12} stroke={1.6} />
                                  {plaidMock
                                    ? "Mock balance"
                                    : "Verified balance (Plaid)"}
                                </span>
                                <span
                                  style={{
                                    fontWeight: 600,
                                    fontSize: "1rem",
                                    color: "var(--text)",
                                  }}
                                >
                                  ${plaidBalance.toLocaleString("en-US")}
                                </span>
                              </div>
                              {plaidAccounts.length > 1 && (
                                <div
                                  className="stack"
                                  style={{ gap: "0.2rem" }}
                                >
                                  {plaidAccounts.map((a) => (
                                    <div
                                      key={a.name}
                                      className="between"
                                      style={{ fontSize: "0.72rem" }}
                                    >
                                      <span className="faint">{a.name}</span>
                                      <span
                                        className="mono"
                                        style={{ color: "var(--muted)" }}
                                      >
                                        ${a.available.toLocaleString("en-US")}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <hr
                                style={{
                                  margin: "0.5rem 0",
                                  borderColor: "rgba(62,207,142,0.15)",
                                }}
                              />
                              <div
                                className="between"
                                style={{ alignItems: "center" }}
                              >
                                <span
                                  className="faint"
                                  style={{ fontSize: "0.72rem" }}
                                >
                                  Proof will certify
                                </span>
                                <span
                                  style={{
                                    fontSize: "0.8rem",
                                    fontWeight: 500,
                                    color: "var(--accent)",
                                  }}
                                >
                                  balance ≥ $
                                  {Number(
                                    claimParamsFromUrl.threshold ?? "10000",
                                  ).toLocaleString("en-US")}
                                </span>
                              </div>
                              <p
                                className="faint"
                                style={{
                                  fontSize: "0.72rem",
                                  margin: "0.35rem 0 0",
                                }}
                              >
                                Your exact balance is never stored or revealed
                                on-chain — only this threshold is public.
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                     {on && key === "jurisdiction" && (
                        <div
                          style={{ marginTop: "0.75rem" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <label className="field-label" style={{ marginBottom: "0.35rem" }}>Mode</label>
                          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
                            <button
                              type="button"
                              className={`btn btn-sm ${jurisdictionMode === "0" ? "btn-primary" : "btn-outline"}`}
                              style={{ flex: 1, fontSize: "0.78rem", padding: "0.4rem 0.75rem" }}
                              onClick={() => setJurisdictionMode("0")}
                            >
                              Block countries
                            </button>
                            <button
                              type="button"
                              className={`btn btn-sm ${jurisdictionMode === "1" ? "btn-primary" : "btn-outline"}`}
                              style={{ flex: 1, fontSize: "0.78rem", padding: "0.4rem 0.75rem" }}
                              onClick={() => setJurisdictionMode("1")}
                            >
                              Allow countries
                            </button>
                          </div>
                          <label className="field-label" htmlFor="attr-country-code">{m.attribute}</label>
                          <select
                            id="attr-country-code"
                            value={attributes.country_code}
                            onChange={(e) =>
                              setAttr("country_code", e.target.value)
                            }
                          >
                            {COUNTRIES.map((c) => (
                              <option key={c.code} value={c.code}>
                                {c.name} ({c.code})
                              </option>
                            ))}
                          </select>
                          <p className="faint" style={{ fontSize: "0.72rem", margin: "0.35rem 0 0" }}>
                            {jurisdictionMode === "0"
                              ? "Proves your country is NOT in the restricted list — your country is never revealed on-chain."
                              : "Proves your country IS in the allowed list — your country is never revealed on-chain."}
                          </p>
                        </div>
                      )}
                      {on && key === "employment" && (
                        <div
                          style={{ marginTop: "0.75rem" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <label className="field-label" htmlFor="attr-seniority">{m.attribute}</label>
                          <input
                            id="attr-seniority"
                            type="number"
                            value={attributes.seniority}
                            onChange={(e) =>
                              setAttr("seniority", e.target.value)
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ marginBottom: "1.5rem" }}>
                <label className="field-label" htmlFor="validity-period">Validity period</label>
                <select
                  id="validity-period"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                >
                  {["30 days", "90 days", "1 year"].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div
                className="line"
                style={{
                  marginBottom: "1.5rem",
                  padding: "0.75rem 1rem",
                  borderRadius: "var(--radius)",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid var(--border)",
                }}
              >
                <span className="faint" style={{ fontSize: "0.8125rem" }}>
                  Issued to
                </span>
                <span
                  className="mono"
                  style={{ fontSize: "0.8125rem", color: "var(--muted)" }}
                >
                  {address.slice(0, 6)}…{address.slice(-4)}
                </span>
              </div>

              <button
                className="btn btn-primary"
                style={{ width: "100%" }}
                disabled={
                  busy ||
                  !selected ||
                  !!urlError ||
                  paramErrors.length > 0 ||
                  // Fail loudly up front: without the issuer address +
                  // IssuerRegistry contract ID this request can't succeed.
                  !issuanceConfigured()
                }
                title={
                  issuanceConfigured()
                    ? undefined
                    : "App not configured — NEXT_PUBLIC_ISSUER_ADDRESS / IssuerRegistry missing"
                }
                onClick={onRequest}
              >
                {busy ? (
                  <>
                    <IconLoader2 size={15} className="spin" />
                    {selected === "kyc"
                      ? "Redirecting to verification…"
                      : "Creating credential…"}
                  </>
                ) : (
                  <>
                    {selected === "kyc" ? "Verify identity" : "Get credential"}
                    <IconArrowRight size={15} />
                  </>
                )}
              </button>

              {(error || urlError) && (
                <p
                  style={{
                    marginTop: "0.75rem",
                    fontSize: "0.8125rem",
                    color: "var(--danger)",
                  }}
                >
                  {error || urlError}
                </p>
              )}

              <p
                className="faint"
                style={{
                  marginTop: "1.25rem",
                  fontSize: "0.8125rem",
                  lineHeight: 1.6,
                }}
              >
                Each claim is committed with Poseidon2 and stays private. You
                prove a statement about it — never the underlying value.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default function VerifyPageClient() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}

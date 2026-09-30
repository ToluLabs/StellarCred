"use client";

import { Suspense } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight, IconLoader2 } from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet } from "@/lib/wallet-context";
import { useToast } from "@/components/Toast";
import VerifyLinkError from "./VerifyLinkError";
import { ConfigBanner } from "@/components/ConfigBanner";
import { issuanceConfigured } from "@/lib/config";
import { useVerifyParams } from "@/lib/hooks/useVerifyParams";
import { usePersonaResume } from "@/lib/hooks/usePersonaResume";
import { useVerifyFlow } from "@/lib/hooks/useVerifyFlow";
import {
  VerifyHeader,
  VerifyDoneView,
  CredentialTypeSelector,
  IssuerSelector,
  VerifyQrScannerModal,
} from "@/components/verify";

function VerifyInner() {
  const router = useRouter();
  const { address } = useWallet();
  const toast = useToast();

  const {
    parsedLink,
    linkError,
    returnUrl,
    personaInquiryId,
    requiredClaim,
    locked,
    trustedIssuerGate,
    claimParamsFromUrl,
    paramErrors,
    urlError,
    setUrlError,
    requestingDomain,
  } = useVerifyParams();

  const {
    selected,
    setSelected,
    attributes,
    setAttr,
    expiry,
    setExpiry,
    busy,
    setBusy,
    error,
    done,
    jurisdictionMode,
    setJurisdictionMode,
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
    handleSuccess,
    onRequest,
  } = useVerifyFlow({
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
  });

  usePersonaResume({
    personaInquiryId,
    address,
    onSuccess: handleSuccess,
    onBusyChange: setBusy,
  });

  return (
    <>
      <VerifyHeader />

      {/* Same shared check as /api/ready — surfaces misconfiguration before
          the user fills anything in, instead of failing mid-issue. */}
      <ConfigBanner requireIssuance />

      {linkError ? (
        <VerifyLinkError error={linkError} onBack={() => router.push("/")} />
      ) : (
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          <VerifyQrScannerModal locked={locked} />

          <div className="card">
            {!address ? (
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
              <VerifyDoneView
                requestingDomain={requestingDomain}
                urlError={urlError}
              />
            ) : (
              <>
                {(urlError || paramErrors.length > 0) && (
                  <div
                    style={{
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
                    }}
                  >
                    {urlError && <span>{urlError}</span>}
                    {paramErrors.map((e, i) => (
                      <span key={i}>{e}</span>
                    ))}
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

                <CredentialTypeSelector
                  selected={selected}
                  setSelected={setSelected}
                  requiredClaim={requiredClaim}
                  locked={locked}
                  attributes={attributes}
                  setAttr={setAttr}
                  claimParamsFromUrl={claimParamsFromUrl}
                  jurisdictionMode={jurisdictionMode}
                  setJurisdictionMode={setJurisdictionMode}
                  plaidBalance={plaidBalance}
                  plaidAccounts={plaidAccounts}
                  plaidSources={plaidSources}
                  plaidMock={plaidMock}
                />

                <IssuerSelector
                  issuersForType={issuersForType}
                  selectedIssuerId={selectedIssuerId}
                  setSelectedIssuerId={setSelectedIssuerId}
                  trustedIssuerGate={trustedIssuerGate}
                  anyAccepted={anyAccepted}
                  requestingDomain={requestingDomain}
                />

                <div style={{ marginBottom: "1.5rem" }}>
                  <label className="field-label" htmlFor="validity-period">
                    Validity period
                  </label>
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

                {selectedIssuer && !issuerAccepted && (
                  <div
                    style={{
                      marginBottom: "1.25rem",
                      padding: "0.7rem 0.9rem",
                      borderRadius: "var(--radius)",
                      background: "rgba(240, 96, 77, 0.08)",
                      border: "1px solid rgba(240, 96, 77, 0.25)",
                      color: "var(--danger)",
                      fontSize: "0.8125rem",
                      lineHeight: 1.6,
                    }}
                  >
                    <strong>{selectedIssuer.name}</strong> is not on{" "}
                    {requestingDomain || "this protocol"}&apos;s trusted-issuer
                    list. The credential will still be issued, but the protocol
                    will reject a proof from it — pick an issuer marked
                    &ldquo;Accepted by protocol&rdquo; to pass its gate.
                  </div>
                )}

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
      )}
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

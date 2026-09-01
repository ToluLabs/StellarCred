"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams, notFound } from "next/navigation";
import {
  IconLock,
  IconCheck,
  IconCircle,
  IconArrowRight,
  IconArrowLeft,
  IconLoader2,
  IconAlertCircle,
  IconRefresh,
  IconQrcode,
} from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet, usePreviewMode } from "@/lib/wallet-context";
import { Badge } from "@/components/Badge";
import { ConfigBanner } from "@/components/ConfigBanner";
import { QrCodeModal } from "@/components/QrCodeModal";
import { getProtocol, type Protocol } from "@/lib/protocols";
import { useProtocolAccessCheck } from "@/lib/use-protocol-access";

function ProtocolDetailBody({
  protocol,
  activeWallet,
  networkKey,
  isPreview,
  scVerified,
}: {
  protocol: Protocol;
  activeWallet: string | null;
  networkKey: string | boolean;
  isPreview: boolean;
  scVerified: boolean;
}) {
  const { state, statuses, retry, eligible, checking } = useProtocolAccessCheck(
    protocol.requirements,
    activeWallet,
    { isPreview: isPreview && Boolean(activeWallet), networkKey },
  );
  const [inputValue, setInputValue] = useState(protocol.inputDefault);
  const [showQr, setShowQr] = useState(false);

  return (
    <>
      <div className="between" style={{ marginBottom: "2rem" }}>
        <div>
          <Link
            href="/apps"
            className="row faint"
            style={{
              fontSize: "0.8125rem",
              gap: "0.35rem",
              marginBottom: "0.5rem",
              textDecoration: "none",
            }}
          >
            <IconArrowLeft size={13} /> Apps
          </Link>
          <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
            <span style={{ color: "var(--accent)" }}>{protocol.icon}</span>
            <h1 style={{ fontSize: "2rem", margin: 0 }}>{protocol.name}</h1>
          </div>
          <p className="mono faint" style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>
            {protocol.tagline}
          </p>
        </div>
        <WalletButton />
      </div>

      {scVerified && (
        <div
          className="reveal"
          style={{
            marginBottom: "1.5rem",
            padding: "0.85rem 1rem",
            borderRadius: "var(--radius)",
            background: "rgba(62,207,142,0.08)",
            border: "1px solid rgba(62,207,142,0.35)",
            fontSize: "0.875rem",
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
          }}
        >
          <IconCheck size={18} color="var(--accent)" stroke={2.5} />
          <span>
            <strong>Verification complete.</strong>{" "}
            <span className="muted">You were returned here from StellarCred automatically.</span>
          </span>
        </div>
      )}

      <ConfigBanner />

      <div className="grid grid-2" style={{ alignItems: "start", gap: "1.5rem" }}>
        <div className="card">
          <p
            className="muted"
            style={{ fontSize: "0.875rem", lineHeight: 1.7, marginBottom: "1.5rem" }}
          >
            {protocol.description}
          </p>

          <div
            style={{
              padding: "0.65rem 0.9rem",
              borderRadius: "var(--radius)",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid var(--border)",
              marginBottom: "1.5rem",
            }}
          >
            <div className="faint" style={{ fontSize: "0.72rem", marginBottom: "0.2rem" }}>
              {protocol.stat.label}
            </div>
            <div style={{ fontWeight: 600, fontSize: "1.75rem", letterSpacing: "-0.03em" }}>
              {protocol.stat.value}
            </div>
            <div className="mono faint" style={{ fontSize: "0.7rem" }}>
              {protocol.stat.sub}
            </div>
          </div>

          <span className="eyebrow" style={{ marginBottom: "0.4rem", display: "block" }}>
            Requirements
          </span>
          <div className="stack" style={{ marginBottom: "1.25rem" }}>
            {protocol.requirements.map((r, i) => (
              <div className="line" key={r.label}>
                <span className="row" style={{ gap: "0.6rem" }}>
                  {checking ? (
                    <IconLoader2 size={15} color="var(--faint)" className="spin" />
                  ) : state === "error" ? (
                    <IconAlertCircle size={15} color="var(--danger)" />
                  ) : statuses[i] ? (
                    <IconCheck size={15} color="var(--accent)" stroke={2.5} />
                  ) : (
                    <IconCircle size={15} color="var(--faint)" />
                  )}
                  <span
                    style={{
                      fontSize: "0.875rem",
                      color:
                        !checking && state !== "error" && statuses[i]
                          ? "var(--text)"
                          : "var(--muted)",
                    }}
                  >
                    {r.label}
                  </span>
                </span>
                {checking ? (
                  <Badge variant="pending">Checking</Badge>
                ) : state === "error" ? (
                  <Badge variant="denied">Unavailable</Badge>
                ) : statuses[i] ? (
                  <Badge variant="verified">Proved</Badge>
                ) : (
                  <Badge variant="pending">Needed</Badge>
                )}
              </div>
            ))}
          </div>

          {state === "error" && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: "100%", marginBottom: "0.75rem" }}
              onClick={retry}
            >
              <IconRefresh size={14} />
              Retry access check
            </button>
          )}

          {state === "denied" && !isPreview && (
            <div className="row" style={{ gap: "0.5rem" }}>
              <Link
                href={protocol.verifyUrl}
                className="btn btn-secondary"
                style={{ flex: 1 }}
              >
                Get verified
                <IconArrowRight size={14} />
              </Link>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                title="Scan to verify on another device"
                onClick={() => setShowQr(true)}
              >
                <IconQrcode size={16} />
              </button>
            </div>
          )}

          {showQr && (
            <QrCodeModal
              title="Verify on another device"
              value={
                typeof window !== "undefined"
                  ? new URL(protocol.verifyUrl, window.location.origin).toString()
                  : protocol.verifyUrl
              }
              hint={`Scan with a phone to continue this ${protocol.name} verification request there.`}
              onClose={() => setShowQr(false)}
            />
          )}

          {!activeWallet && (
            <p className="faint" style={{ marginTop: "0.75rem", fontSize: "0.8rem" }}>
              Connect your wallet to check eligibility.
            </p>
          )}
        </div>

        <div
          className="card"
          style={{
            borderColor: eligible ? "rgba(62,207,142,0.4)" : "var(--border)",
            transition: "border-color 0.5s var(--ease)",
          }}
        >
          <div className="between" style={{ marginBottom: "1.5rem" }}>
            <span className="eyebrow">{protocol.actionLabel}</span>
            {state === "loading" && (
              <span className="row faint" style={{ gap: "0.35rem", fontSize: "0.75rem" }}>
                <IconLoader2 size={14} className="spin" />
                Checking…
              </span>
            )}
            {state === "granted" && <Badge variant="verified">Access granted</Badge>}
            {state === "denied" && <Badge variant="denied">Access denied</Badge>}
            {state === "error" && <Badge variant="denied">Check failed</Badge>}
          </div>

          <label className="field-label" htmlFor="protocol-input">
            {protocol.inputLabel}
          </label>
          <input
            id="protocol-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={!eligible}
            style={{ opacity: eligible ? 1 : 0.5 }}
          />

          <button
            className="btn btn-primary"
            style={{
              marginTop: "0.9rem",
              width: "100%",
              opacity: eligible ? 1 : 0.45,
              transition: "opacity 0.4s var(--ease)",
            }}
            disabled={!eligible || isPreview}
          >
            {isPreview ? (
              "Connect wallet to check access"
            ) : eligible ? (
              protocol.actionLabel
            ) : (
              <>
                <IconLock size={14} /> Prove eligibility first
              </>
            )}
          </button>

          <p className="faint" style={{ marginTop: "1.25rem", fontSize: "0.8125rem", lineHeight: 1.6 }}>
            {eligible
              ? `${protocol.name} read ProofRegistry.check_claim and found valid proofs for your address. No personal data was shared.`
              : `${protocol.name} only reads ProofRegistry.check_claim for your address — it never sees the credential data behind your proofs.`}
          </p>
        </div>
      </div>
    </>
  );
}

function ProtocolDetailInner() {
  const { id } = useParams<{ id: string }>();
  const { address, networkMismatch } = useWallet();
  const searchParams = useSearchParams();

  const scVerified = searchParams.get("sc_verified") === "true";
  const scWallet = searchParams.get("sc_wallet");
  const activeWallet = address || scWallet || null;
  const isPreview = usePreviewMode();
  const networkKey = networkMismatch ? "mismatch" : "ok";

  const protocol = getProtocol(id);

  if (!protocol) {
    notFound();
  }

  return (
    <ProtocolDetailBody
      protocol={protocol}
      activeWallet={activeWallet}
      networkKey={networkKey}
      isPreview={isPreview}
      scVerified={scVerified}
    />
  );
}

export default function ProtocolDetailPage() {
  return (
    <Suspense fallback={null}>
      <ProtocolDetailInner />
    </Suspense>
  );
}
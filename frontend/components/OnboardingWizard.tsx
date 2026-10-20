"use client";

// Guided onboarding flow (#807). A single wizard walks first-time users
// through the core loop — wallet setup, credential creation, issuer-trust
// verification — with contextual guidance on every step. All copy and the
// step-gating rules live in lib/onboarding-guidance.ts so they stay testable;
// this file is presentation and side-effect wiring only.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  IconWallet,
  IconArrowRight,
  IconArrowLeft,
  IconCheck,
  IconLicense,
  IconShieldCheck,
  IconCpu,
  IconX,
  IconLoader2,
  IconSparkles,
  IconHelp,
  IconBulb,
  IconAlertTriangle,
  IconInfoCircle,
  IconRefresh,
  IconExternalLink,
} from "@tabler/icons-react";
import { truncateMiddle } from "@/lib/format";
import { useWallet } from "@/lib/wallet-context";
import { getWalletErrorInfo, getWalletReportUrl } from "@/lib/wallet";
import { useOnboarding, ONBOARDING_STEPS, type OnboardingStep } from "@/lib/onboarding";
import {
  STEP_GUIDANCE,
  TRUST_STATUS_GUIDANCE,
  TRUST_CHECK_ERROR_GUIDANCE,
  canProceed,
  blockedReason,
  trustChecklist,
  type TrustSeverity,
} from "@/lib/onboarding-guidance";
import { saveCredential, loadCredentials, TYPE_META } from "@/lib/credential";
import type { Credential } from "@/lib/credential";
import { checkIssuerStatus } from "@/lib/issuer-registry";
import type { IssuerStatus } from "@/lib/issuer-registry";
import { useToast } from "@/components/Toast";

const ACCENT = "var(--accent)";

const STEP_ICONS: Record<OnboardingStep, React.ReactNode> = {
  welcome: <IconSparkles size={20} stroke={1.5} />,
  "connect-wallet": <IconWallet size={20} stroke={1.5} />,
  "get-credential": <IconLicense size={20} stroke={1.5} />,
  "verify-trust": <IconShieldCheck size={20} stroke={1.5} />,
  "generate-proof": <IconCpu size={20} stroke={1.5} />,
  unlock: <IconCheck size={20} stroke={2} />,
};

/* ── Shared presentation bits ────────────────────────────────────────────── */

const SEVERITY_COLORS: Record<TrustSeverity, { fg: string; border: string; bg: string }> = {
  success: { fg: ACCENT, border: "rgba(62, 207, 142, 0.25)", bg: "rgba(62, 207, 142, 0.07)" },
  info: {
    fg: "var(--info, #6aa6ff)",
    border: "rgba(106, 166, 255, 0.3)",
    bg: "rgba(106, 166, 255, 0.07)",
  },
  warning: {
    fg: "var(--warn, #e8b04b)",
    border: "rgba(232, 176, 75, 0.3)",
    bg: "rgba(232, 176, 75, 0.07)",
  },
  danger: {
    fg: "var(--danger)",
    border: "rgba(240, 100, 90, 0.3)",
    bg: "rgba(240, 100, 90, 0.07)",
  },
};

function StatusBox({
  severity,
  title,
  children,
}: {
  severity: TrustSeverity;
  title: string;
  children?: React.ReactNode;
}) {
  const c = SEVERITY_COLORS[severity];
  const Icon =
    severity === "success" ? IconCheck : severity === "danger" ? IconAlertTriangle : IconInfoCircle;
  return (
    <div
      style={{
        padding: "0.9rem 1rem",
        borderRadius: "var(--radius)",
        background: c.bg,
        border: `1px solid ${c.border}`,
        textAlign: "left",
      }}
    >
      <div
        className="row"
        style={{ gap: "0.5rem", alignItems: "center", marginBottom: children ? "0.4rem" : 0 }}
      >
        <Icon size={16} color={c.fg} stroke={2.2} aria-hidden />
        <span style={{ fontWeight: 500, fontSize: "0.9rem" }}>{title}</span>
      </div>
      {children && (
        <div style={{ fontSize: "0.8125rem", lineHeight: 1.6, color: "var(--muted)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Contextual "good to know" guidance shown under every step. */
function GuidanceTip({ text }: { text: string }) {
  return (
    <div
      className="row"
      style={{
        gap: "0.55rem",
        alignItems: "flex-start",
        marginTop: "1.1rem",
        padding: "0.7rem 0.85rem",
        borderRadius: "var(--radius-sm)",
        border: "1px dashed var(--border)",
        background: "rgba(128,128,128,0.04)",
      }}
    >
      <IconBulb
        size={15}
        stroke={1.6}
        style={{ marginTop: 2, color: "var(--faint)", flexShrink: 0 }}
        aria-hidden
      />
      <p style={{ fontSize: "0.76rem", lineHeight: 1.6, color: "var(--muted)", margin: 0 }}>
        {text}
      </p>
    </div>
  );
}

/** Horizontal roadmap: one chip per step, visited ones are clickable. */
function StepRail({ current, onJump }: { current: number; onJump: (index: number) => void }) {
  return (
    <div
      className="row"
      style={{ gap: "0.25rem", justifyContent: "space-between", marginBottom: "1.1rem" }}
      aria-label="Onboarding progress"
    >
      {ONBOARDING_STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        const reachable = i <= current;
        return (
          <button
            key={step}
            type="button"
            onClick={() => reachable && onJump(i)}
            disabled={!reachable}
            aria-current={active ? "step" : undefined}
            aria-label={`Step ${i + 1}: ${STEP_GUIDANCE[step].railLabel}${done ? " (done)" : ""}`}
            title={done ? `Back to: ${STEP_GUIDANCE[step].title}` : undefined}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.3rem",
              background: "none",
              border: "none",
              padding: "0.2rem 0",
              cursor: reachable ? "pointer" : "default",
              color: active ? ACCENT : done ? "var(--muted)" : "var(--faint)",
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                fontSize: "0.62rem",
                fontWeight: 600,
                background: active || done ? "rgba(62, 207, 142, 0.12)" : "transparent",
                border: `1.5px solid ${active ? ACCENT : done ? "rgba(62, 207, 142, 0.5)" : "var(--border)"}`,
                transition: "all 0.25s var(--ease)",
              }}
            >
              {done ? <IconCheck size={12} stroke={2.5} /> : i + 1}
            </span>
            <span
              style={{
                fontSize: "0.6rem",
                letterSpacing: "0.02em",
                textTransform: "uppercase",
                color: active ? ACCENT : "var(--faint)",
                whiteSpace: "nowrap",
              }}
            >
              {STEP_GUIDANCE[step].railLabel}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Step content ────────────────────────────────────────────────────────── */

function WelcomeStep() {
  const coreSteps: OnboardingStep[] = ["connect-wallet", "get-credential", "verify-trust"];
  return (
    <div>
      <p className="muted" style={{ fontSize: "0.875rem", lineHeight: 1.65 }}>
        {STEP_GUIDANCE.welcome.summary}
      </p>
      <div style={{ display: "grid", gap: "0.5rem", marginTop: "1rem" }}>
        {coreSteps.map((step, i) => (
          <div
            key={step}
            className="row"
            style={{
              gap: "0.7rem",
              alignItems: "center",
              padding: "0.6rem 0.75rem",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
            }}
          >
            <span style={{ color: ACCENT, flexShrink: 0 }}>{STEP_ICONS[step]}</span>
            <div>
              <div style={{ fontSize: "0.84rem", fontWeight: 500 }}>
                {i + 1}. {STEP_GUIDANCE[step].title}
              </div>
              <div className="muted" style={{ fontSize: "0.75rem", lineHeight: 1.5 }}>
                {STEP_GUIDANCE[step].railLabel === "Trust"
                  ? "Confirm the registry trusts the issuer who signed your credential."
                  : step === "connect-wallet"
                    ? "A Stellar wallet is the identity your credentials are sealed to."
                    : "Hold a signed, privacy-preserving attestation in your browser."}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectWalletStep() {
  const { address, connecting, error, networkMismatch, connect } = useWallet();
  const guidance = STEP_GUIDANCE["connect-wallet"];

  return (
    <div>
      <p
        className="muted"
        style={{ fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "1.1rem" }}
      >
        {guidance.summary}
      </p>

      {address ? (
        <StatusBox severity="success" title="Wallet connected">
          <span className="mono" style={{ fontSize: "0.8rem" }}>
            {truncateMiddle(address, 8, 6)}
          </span>
          {networkMismatch && (
            <div style={{ marginTop: "0.5rem" }}>
              <StatusBox severity="warning" title="Wrong network detected">
                Your wallet is not on the network StellarCred is configured for. Switch networks in
                your wallet — onboarding can continue, but proofs will fail until it matches.
              </StatusBox>
            </div>
          )}
        </StatusBox>
      ) : (
        <div style={{ textAlign: "center" }}>
          <button className="btn btn-primary" onClick={connect} disabled={connecting}>
            <IconWallet size={14} />
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
          <p className="faint" style={{ fontSize: "0.75rem", marginTop: "0.7rem" }}>
            Freighter, Albedo, xBull, Lobstr, Ledger, WalletConnect and more are supported.
          </p>
        </div>
      )}

      {/* Contextual guidance for whatever went wrong, per error kind. */}
      {error &&
        !address &&
        (() => {
          const info = getWalletErrorInfo(error);
          const severity: TrustSeverity = info.benign ? "info" : "danger";
          return (
            <div style={{ marginTop: "1rem" }}>
              <StatusBox severity={severity} title={info.title}>
                {info.message}
              </StatusBox>
              <div
                className="row"
                style={{
                  gap: "0.6rem",
                  marginTop: "0.7rem",
                  justifyContent: "center",
                  flexWrap: "wrap",
                }}
              >
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={connect}
                  disabled={connecting}
                >
                  <IconRefresh size={13} />
                  Try again
                </button>
                {info.action === "install" && error.installUrl && (
                  <a
                    className="btn btn-secondary btn-sm"
                    href={error.installUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Install {error.walletName ?? "a wallet"}
                    <IconExternalLink size={12} />
                  </a>
                )}
                {info.action === "retry-report" && (
                  <a
                    className="btn btn-ghost btn-sm"
                    href={getWalletReportUrl()}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Report this
                    <IconExternalLink size={12} />
                  </a>
                )}
              </div>
            </div>
          );
        })()}
    </div>
  );
}

function GetCredentialStep({
  address,
  credential,
  onIssued,
}: {
  address: string;
  credential: Credential | null;
  onIssued: () => void;
}) {
  const toast = useToast();
  const guidance = STEP_GUIDANCE["get-credential"];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onRequest() {
    if (!address) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credential_types: ["age"],
          holder: address,
          issuerId: process.env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "",
          issuerName: "StellarCred Authority",
          expiry: "30 days",
          attributes: {
            date_of_birth: "1995-06-15",
          },
          claimParams: {},
        }),
      });
      if (res.status === 202) {
        // Persona redirect — skip for onboarding, show message
        setError(
          "Identity verification required — this step needs a non-KYC credential type for the demo.",
        );
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Issuing failed");
      }
      const { credentials } = (await res.json()) as { credentials: Credential[] };
      credentials.forEach((c) => saveCredential(c));
      onIssued();
      toast.success("Demo credential issued!");
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      toast.error(`Issuance failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!address) {
    return (
      <p className="muted" style={{ fontSize: "0.875rem" }}>
        Connect your wallet first — then the credential is sealed to that address.
      </p>
    );
  }

  if (credential) {
    return (
      <StatusBox severity="success" title="Credential in your wallet">
        <div style={{ display: "grid", gap: "0.25rem" }}>
          <span>
            <strong>{credential.title || TYPE_META[credential.type].title}</strong> — attests{" "}
            &ldquo;{credential.claim || TYPE_META[credential.type].claim}&rdquo; from{" "}
            {credential.issuer}.
          </span>
          <span className="mono" style={{ fontSize: "0.72rem" }}>
            commitment {truncateMiddle(credential.commitment, 10, 8)} · expires in{" "}
            {credential.expiry}
          </span>
        </div>
      </StatusBox>
    );
  }

  return (
    <div>
      <p
        className="muted"
        style={{ fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "1.1rem" }}
      >
        {guidance.summary}
      </p>
      <div style={{ textAlign: "center" }}>
        <button className="btn btn-primary" onClick={onRequest} disabled={busy}>
          {busy ? (
            <>
              <IconLoader2 size={14} className="spin" />
              Creating…
            </>
          ) : (
            <>
              Get age credential
              <IconArrowRight size={14} />
            </>
          )}
        </button>
        {error && (
          <div style={{ marginTop: "1rem", textAlign: "left" }}>
            <StatusBox severity="danger" title="Couldn't issue the credential">
              {error}
            </StatusBox>
          </div>
        )}
      </div>
    </div>
  );
}

function TrustVerifyStep({
  credential,
  address,
  status,
  failed,
  busy,
  onRun,
}: {
  credential: Credential | null;
  address: string;
  status: IssuerStatus | null;
  failed: boolean;
  busy: boolean;
  onRun: () => void;
}) {
  const guidance = STEP_GUIDANCE["verify-trust"];

  if (!address || !credential) {
    return (
      <p className="muted" style={{ fontSize: "0.875rem" }}>
        Finish the wallet and credential steps first — the trust check runs against the issuer of
        the credential you hold.
      </p>
    );
  }

  // The check result drives the badge, message and checklist. A hard failure
  // of the check itself gets its own guidance (distinct from "unknown").
  const result = failed
    ? TRUST_CHECK_ERROR_GUIDANCE
    : status
      ? TRUST_STATUS_GUIDANCE[status]
      : null;
  const rows = trustChecklist(status);

  return (
    <div>
      <p className="muted" style={{ fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "1rem" }}>
        {guidance.summary}
      </p>

      <div
        className="mono"
        style={{
          fontSize: "0.74rem",
          color: "var(--muted)",
          padding: "0.5rem 0.7rem",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)",
          marginBottom: "1rem",
          overflowWrap: "break-word",
        }}
      >
        {credential.issuer} ← {truncateMiddle(credential.commitment, 8, 6)} ({credential.type})
      </div>

      <div style={{ display: "grid", gap: "0.45rem", marginBottom: "1.1rem" }}>
        {rows.map((row) => (
          <div key={row.label} className="row" style={{ gap: "0.5rem", alignItems: "flex-start" }}>
            {row.ok === null ? (
              busy ? (
                <IconLoader2
                  size={14}
                  className="spin"
                  style={{ color: "var(--faint)", marginTop: 2, flexShrink: 0 }}
                  aria-hidden
                />
              ) : (
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: "1.5px solid var(--border)",
                    marginTop: 1,
                    flexShrink: 0,
                    display: "inline-block",
                  }}
                  aria-hidden
                />
              )
            ) : row.ok ? (
              <IconCheck
                size={14}
                stroke={2.5}
                color={ACCENT}
                style={{ marginTop: 2, flexShrink: 0 }}
                aria-hidden
              />
            ) : (
              <IconX
                size={14}
                stroke={2.5}
                color="var(--danger)"
                style={{ marginTop: 2, flexShrink: 0 }}
                aria-hidden
              />
            )}
            <span
              style={{
                fontSize: "0.8rem",
                lineHeight: 1.5,
                color: row.ok === false ? "var(--danger)" : "var(--text)",
              }}
            >
              {row.label}
            </span>
          </div>
        ))}
      </div>

      {result ? (
        <StatusBox severity={result.severity} title={result.label}>
          {result.message}
        </StatusBox>
      ) : (
        <p className="faint" style={{ fontSize: "0.75rem", marginBottom: "0.6rem" }}>
          {busy ? "Checking the on-chain registry…" : "The registry check hasn't run yet."}
        </p>
      )}

      <div style={{ textAlign: "center", marginTop: "0.9rem" }}>
        <button className="btn btn-secondary btn-sm" onClick={onRun} disabled={busy}>
          {busy ? (
            <>
              <IconLoader2 size={13} className="spin" />
              Checking…
            </>
          ) : (
            <>
              <IconRefresh size={13} />
              {result ? "Run the check again" : "Run trust check"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function GenerateProofStep({ credential }: { credential: Credential | null }) {
  const guidance = STEP_GUIDANCE["generate-proof"];
  return (
    <div>
      <p
        className="muted"
        style={{ fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "1.1rem" }}
      >
        {guidance.summary}
      </p>
      <div style={{ textAlign: "center" }}>
        <Link href="/holder" className="btn btn-primary">
          {credential
            ? `Prove “${credential.claim || TYPE_META[credential.type].claim}”`
            : "Go to dashboard"}
          <IconArrowRight size={14} />
        </Link>
        <p className="faint" style={{ fontSize: "0.75rem", marginTop: "0.75rem" }}>
          Click &ldquo;Generate proof&rdquo; on your credential card, then submit it on-chain.
        </p>
        <p style={{ marginTop: "0.9rem" }}>
          <Link href="/verify" className="btn btn-ghost btn-sm">
            Or earn a real credential first
            <IconArrowRight size={13} />
          </Link>
        </p>
      </div>
    </div>
  );
}

function UnlockStep({ trustStatus }: { trustStatus: IssuerStatus | null }) {
  const guidance = STEP_GUIDANCE.unlock;
  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "rgba(62, 207, 142, 0.1)",
          border: "1px solid rgba(62, 207, 142, 0.25)",
          display: "grid",
          placeItems: "center",
          margin: "0 auto 1.1rem",
          color: ACCENT,
        }}
      >
        <IconCheck size={28} stroke={2} />
      </div>
      <p
        className="muted"
        style={{ fontSize: "0.9rem", lineHeight: 1.7, margin: "0 auto 1.1rem", maxWidth: 400 }}
      >
        {guidance.summary}
        {trustStatus === "active" || trustStatus === "key_retired"
          ? " Your issuer is confirmed trusted on-chain, so those proofs will be accepted."
          : ""}
      </p>
      <div className="row" style={{ gap: "0.6rem", justifyContent: "center", flexWrap: "wrap" }}>
        <Link href="/apps" className="btn btn-primary btn-sm">
          Browse apps
          <IconArrowRight size={14} />
        </Link>
        <Link href="/holder" className="btn btn-secondary btn-sm">
          Open dashboard
        </Link>
      </div>
    </div>
  );
}

/* ── Main wizard ─────────────────────────────────────────────────────────── */

interface TrustState {
  checked: boolean;
  running: boolean;
  status: IssuerStatus | null;
  failed: boolean;
}

const INITIAL_TRUST: TrustState = { checked: false, running: false, status: null, failed: false };

export function OnboardingWizard() {
  const { currentStep, isVisible, mounted, nextStep, prevStep, goToStep, dismiss } =
    useOnboarding();
  const { address } = useWallet();
  const [mounted2, setMounted2] = useState(false);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [trust, setTrust] = useState<TrustState>(INITIAL_TRUST);

  useEffect(() => setMounted2(true), []);

  const refreshCredential = useCallback(() => {
    loadCredentials().then((creds) => {
      setCredential(creds.find((c) => c.type === "age") ?? creds[0] ?? null);
    });
  }, []);

  // (Re)read the store whenever the wizard shows or the step changes, so
  // issuance done here — or on the dashboard — is reflected in the gates.
  useEffect(() => {
    if (isVisible) refreshCredential();
  }, [isVisible, currentStep, refreshCredential]);

  // A new credential supersedes any earlier trust result.
  const commitment = credential?.commitment;
  useEffect(() => {
    setTrust(INITIAL_TRUST);
  }, [commitment]);

  const runTrustCheck = useCallback(async () => {
    if (!credential || !address) return;
    setTrust((t) => ({ ...t, running: true, failed: false }));
    let status: IssuerStatus | null = null;
    let failed = false;
    try {
      status = await checkIssuerStatus(
        credential.issuerId,
        credential.type,
        credential.issuerPubX,
        credential.issuerPubY,
        address,
      );
    } catch {
      failed = true;
    }
    setTrust({ checked: true, running: false, status, failed });
  }, [credential, address]);

  // Walk the user through the check: run it automatically once when the step
  // opens, so the guidance is about a real result, not an empty screen.
  useEffect(() => {
    if (
      currentStep === "verify-trust" &&
      credential &&
      address &&
      !trust.checked &&
      !trust.running
    ) {
      void runTrustCheck();
    }
    // trust.checked/running are intentionally not deps: this fires on entry only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, credential, address, runTrustCheck]);

  // Auto-dismiss after completing the final step
  useEffect(() => {
    if (currentStep === "unlock" && isVisible) {
      const timer = setTimeout(dismiss, 10_000);
      return () => clearTimeout(timer);
    }
  }, [currentStep, isVisible, dismiss]);

  if (!mounted || !mounted2 || !isVisible) return null;

  const stepIndex = ONBOARDING_STEPS.indexOf(currentStep);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === ONBOARDING_STEPS.length - 1;
  const guidance = STEP_GUIDANCE[currentStep];

  const signals = {
    walletConnected: !!address,
    hasCredential: !!credential,
    trustChecked: trust.checked,
  };
  const proceed = canProceed(currentStep, signals);
  const whyBlocked = blockedReason(currentStep, signals);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        animation: "obFadeIn 0.25s var(--ease)",
        padding: "1rem",
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Onboarding wizard"
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 600,
          maxHeight: "92vh",
          overflowY: "auto",
          padding: "1.75rem",
          position: "relative",
          animation: "obSlideUp 0.3s var(--ease)",
        }}
      >
        {/* Close button */}
        <button
          className="btn btn-ghost btn-sm"
          onClick={dismiss}
          aria-label="Skip onboarding"
          style={{
            position: "absolute",
            top: "0.75rem",
            right: "0.75rem",
            padding: "0.3rem",
            color: "var(--faint)",
          }}
        >
          <IconX size={15} />
        </button>

        <StepRail current={stepIndex} onJump={goToStep} />

        <div
          className="row"
          style={{ gap: "0.7rem", alignItems: "center", marginBottom: "0.5rem" }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "var(--radius-sm)",
              background: "rgba(62, 207, 142, 0.08)",
              border: "1px solid rgba(62, 207, 142, 0.18)",
              display: "grid",
              placeItems: "center",
              color: ACCENT,
              flexShrink: 0,
            }}
          >
            {STEP_ICONS[currentStep]}
          </div>
          <div>
            <div
              className="faint"
              style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.06em" }}
            >
              Step {stepIndex + 1} of {ONBOARDING_STEPS.length}
            </div>
            <h2 style={{ fontSize: "1.2rem", lineHeight: 1.3 }}>{guidance.title}</h2>
          </div>
        </div>

        {currentStep === "welcome" ? (
          <WelcomeStep />
        ) : currentStep === "connect-wallet" ? (
          <ConnectWalletStep />
        ) : currentStep === "get-credential" ? (
          <GetCredentialStep
            address={address}
            credential={credential}
            onIssued={refreshCredential}
          />
        ) : currentStep === "verify-trust" ? (
          <TrustVerifyStep
            credential={credential}
            address={address}
            status={trust.status}
            failed={trust.failed}
            busy={trust.running}
            onRun={runTrustCheck}
          />
        ) : currentStep === "generate-proof" ? (
          <GenerateProofStep credential={credential} />
        ) : (
          <UnlockStep trustStatus={trust.status} />
        )}

        <GuidanceTip text={guidance.tip} />

        {/* Navigation */}
        <div
          className="between"
          style={{ marginTop: "1.5rem", gap: "0.5rem", alignItems: "center" }}
        >
          {!isFirst ? (
            <button className="btn btn-ghost btn-sm" onClick={prevStep}>
              <IconArrowLeft size={14} />
              Back
            </button>
          ) : (
            <button
              className="btn btn-ghost btn-sm"
              onClick={dismiss}
              style={{ color: "var(--faint)" }}
            >
              Skip tour
            </button>
          )}

          <div className="row" style={{ gap: "0.7rem", alignItems: "center" }}>
            {!proceed && whyBlocked && (
              <span
                className="faint"
                style={{ fontSize: "0.72rem", maxWidth: 200, textAlign: "right" }}
              >
                {whyBlocked}
              </span>
            )}
            {!isLast ? (
              <button
                className="btn btn-primary btn-sm"
                onClick={nextStep}
                disabled={!proceed}
                title={whyBlocked}
              >
                Next
                <IconArrowRight size={14} />
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={dismiss}>
                Get started
                <IconArrowRight size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Help link */}
        <div style={{ textAlign: "center", marginTop: "1rem" }}>
          <Link
            href="/docs"
            className="faint"
            style={{
              fontSize: "0.72rem",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.3rem",
              textDecoration: "none",
            }}
            onClick={dismiss}
          >
            <IconHelp size={11} />
            Learn more in the docs
          </Link>
        </div>
      </div>

      <style>{`
        @keyframes obFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes obSlideUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

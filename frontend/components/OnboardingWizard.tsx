"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  IconWallet,
  IconArrowRight,
  IconArrowLeft,
  IconCheck,
  IconRocket,
  IconLicense,
  IconCpu,
  IconLock,
  IconX,
  IconLoader2,
  IconSparkles,
  IconHelp,
} from "@tabler/icons-react";
import { useWallet } from "@/lib/wallet-context";
import {
  useOnboarding,
  ONBOARDING_STEPS,
  type OnboardingStep,
} from "@/lib/onboarding";
import { saveCredential, loadCredentials } from "@/lib/credential";
import type { Credential } from "@/lib/credential";
import { useToast } from "@/components/Toast";

/* ── Step icons ──────────────────────────────────────────────────────────── */

const STEP_ICONS: Record<OnboardingStep, React.ReactNode> = {
  welcome: <IconRocket size={20} stroke={1.5} />,
  "connect-wallet": <IconWallet size={20} stroke={1.5} />,
  "get-credential": <IconLicense size={20} stroke={1.5} />,
  "generate-proof": <IconCpu size={20} stroke={1.5} />,
  unlock: <IconLock size={20} stroke={1.5} />,
};

const STEP_TITLES: Record<OnboardingStep, string> = {
  welcome: "Welcome to StellarCred",
  "connect-wallet": "Connect your wallet",
  "get-credential": "Get a demo credential",
  "generate-proof": "Generate a proof",
  unlock: "You're verified!",
};

const STEP_DESCRIPTIONS: Record<OnboardingStep, string> = {
  welcome:
    "Prove facts about yourself without revealing personal data. Let's walk through the core loop once.",
  "connect-wallet":
    "Connect a Stellar wallet on testnet. Your credentials live in this browser — never on a server.",
  "get-credential":
    "Request a demo age credential from the StellarCred Authority. This proves you're over 18.",
  "generate-proof":
    "Generate a zero-knowledge proof locally. Only the claim leaves; the data behind it never does.",
  unlock:
    "Your proof is on-chain. Any Stellar protocol can verify it in one contract call.",
};

/* ── Progress bar ────────────────────────────────────────────────────────── */

function ProgressBar({ progress }: { progress: number }) {
  return (
    <div
      style={{
        height: 3,
        borderRadius: 2,
        background: "var(--border)",
        overflow: "hidden",
        marginBottom: "1.5rem",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.round(progress * 100)}%`,
          background: "var(--accent)",
          borderRadius: 2,
          transition: "width 0.4s var(--ease)",
        }}
      />
    </div>
  );
}

/* ── Step indicators ─────────────────────────────────────────────────────── */

function StepDots({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  return (
    <div
      className="row"
      style={{ gap: "0.4rem", justifyContent: "center", marginBottom: "1.25rem" }}
    >
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            width: i === current ? 20 : 6,
            height: 6,
            borderRadius: 3,
            background:
              i < current
                ? "var(--accent)"
                : i === current
                  ? "var(--accent)"
                  : "var(--border)",
            transition: "all 0.3s var(--ease)",
          }}
        />
      ))}
    </div>
  );
}

/* ── Individual step content ─────────────────────────────────────────────── */

function WelcomeStep() {
  return (
    <div style={{ textAlign: "center", padding: "1rem 0" }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "rgba(62, 207, 142, 0.1)",
          border: "1px solid rgba(62, 207, 142, 0.25)",
          display: "grid",
          placeItems: "center",
          margin: "0 auto 1.25rem",
          color: "var(--accent)",
        }}
      >
        <IconSparkles size={26} stroke={1.5} />
      </div>
      <p
        className="muted"
        style={{
          fontSize: "0.9rem",
          lineHeight: 1.7,
          maxWidth: 380,
          margin: "0 auto",
        }}
      >
        {STEP_DESCRIPTIONS.welcome}
      </p>
    </div>
  );
}

function ConnectWalletStep() {
  const { address, connecting, connect } = useWallet();

  return (
    <div style={{ textAlign: "center", padding: "1rem 0" }}>
      {address ? (
        <div
          style={{
            padding: "1rem",
            borderRadius: "var(--radius)",
            background: "rgba(62, 207, 142, 0.07)",
            border: "1px solid rgba(62, 207, 142, 0.2)",
          }}
        >
          <div
            className="row"
            style={{
              gap: "0.5rem",
              justifyContent: "center",
              alignItems: "center",
              marginBottom: "0.5rem",
            }}
          >
            <IconCheck size={16} color="var(--accent)" stroke={2.5} />
            <span style={{ fontWeight: 500, fontSize: "0.9rem" }}>
              Wallet connected
            </span>
          </div>
          <span
            className="mono"
            style={{ fontSize: "0.8rem", color: "var(--muted)" }}
          >
            {address.slice(0, 6)}…{address.slice(-4)}
          </span>
        </div>
      ) : (
        <div>
          <p
            className="muted"
            style={{
              fontSize: "0.875rem",
              lineHeight: 1.6,
              marginBottom: "1.25rem",
            }}
          >
            {STEP_DESCRIPTIONS["connect-wallet"]}
          </p>
          <button
            className="btn btn-primary"
            onClick={connect}
            disabled={connecting}
          >
            <IconWallet size={14} />
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      )}
    </div>
  );
}

function GetCredentialStep() {
  const { address } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  // Check if user already has a credential
  useEffect(() => {
    const creds = loadCredentials();
    if (creds.some((c) => c.type === "age")) {
      setDone(true);
    }
  }, []);

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
        setError("Identity verification required — this step needs a non-KYC credential type for the demo.");
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Issuing failed");
      }
      const { credentials } = (await res.json()) as { credentials: Credential[] };
      credentials.forEach((c) => saveCredential(c));
      setDone(true);
      toast.success("Demo credential issued!");
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      toast.error(`Issuance failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ textAlign: "center", padding: "1rem 0" }}>
      {!address ? (
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          Please connect your wallet first.
        </p>
      ) : done ? (
        <div
          style={{
            padding: "1rem",
            borderRadius: "var(--radius)",
            background: "rgba(62, 207, 142, 0.07)",
            border: "1px solid rgba(62, 207, 142, 0.2)",
          }}
        >
          <div
            className="row"
            style={{
              gap: "0.5rem",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <IconCheck size={16} color="var(--accent)" stroke={2.5} />
            <span style={{ fontWeight: 500, fontSize: "0.9rem" }}>
              Credential held
            </span>
          </div>
        </div>
      ) : (
        <div>
          <p
            className="muted"
            style={{
              fontSize: "0.875rem",
              lineHeight: 1.6,
              marginBottom: "1.25rem",
            }}
          >
            {STEP_DESCRIPTIONS["get-credential"]}
          </p>
          <button
            className="btn btn-primary"
            onClick={onRequest}
            disabled={busy}
          >
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
            <p
              style={{
                marginTop: "0.75rem",
                fontSize: "0.8125rem",
                color: "var(--danger)",
              }}
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function GenerateProofStep() {
  const { address } = useWallet();
  const [hasCredential, setHasCredential] = useState(false);

  useEffect(() => {
    const creds = loadCredentials();
    setHasCredential(creds.some((c) => c.type === "age"));
  }, []);

  return (
    <div style={{ textAlign: "center", padding: "1rem 0" }}>
      {!address ? (
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          Please connect your wallet first.
        </p>
      ) : !hasCredential ? (
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          Please get a credential first.
        </p>
      ) : (
        <div>
          <p
            className="muted"
            style={{
              fontSize: "0.875rem",
              lineHeight: 1.6,
              marginBottom: "1.25rem",
            }}
          >
            {STEP_DESCRIPTIONS["generate-proof"]}
          </p>
          <Link href="/holder" className="btn btn-primary">
            Go to dashboard
            <IconArrowRight size={14} />
          </Link>
          <p
            className="faint"
            style={{ fontSize: "0.75rem", marginTop: "0.75rem" }}
          >
            Click &ldquo;Generate proof&rdquo; on your credential card.
          </p>
        </div>
      )}
    </div>
  );
}

function UnlockStep() {
  return (
    <div style={{ textAlign: "center", padding: "1rem 0" }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "rgba(62, 207, 142, 0.1)",
          border: "1px solid rgba(62, 207, 142, 0.25)",
          display: "grid",
          placeItems: "center",
          margin: "0 auto 1.25rem",
          color: "var(--accent)",
        }}
      >
        <IconCheck size={28} stroke={2} />
      </div>
      <p
        className="muted"
        style={{
          fontSize: "0.9rem",
          lineHeight: 1.7,
          maxWidth: 380,
          margin: "0 auto 1.5rem",
        }}
      >
        {STEP_DESCRIPTIONS.unlock}
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

/* ── Step content router ─────────────────────────────────────────────────── */

function StepContent({ step }: { step: OnboardingStep }) {
  switch (step) {
    case "welcome":
      return <WelcomeStep />;
    case "connect-wallet":
      return <ConnectWalletStep />;
    case "get-credential":
      return <GetCredentialStep />;
    case "generate-proof":
      return <GenerateProofStep />;
    case "unlock":
      return <UnlockStep />;
  }
}

/* ── Main wizard component ───────────────────────────────────────────────── */

export function OnboardingWizard() {
  const {
    currentStep,
    isVisible,
    progress,
    mounted,
    nextStep,
    prevStep,
    dismiss,
  } = useOnboarding();
  const { address } = useWallet();
  const [mounted2, setMounted2] = useState(false);

  useEffect(() => setMounted2(true), []);

  // Auto-dismiss after completing the unlock step
  useEffect(() => {
    if (currentStep === "unlock" && isVisible) {
      const timer = setTimeout(dismiss, 8000);
      return () => clearTimeout(timer);
    }
  }, [currentStep, isVisible, dismiss]);

  if (!mounted || !mounted2 || !isVisible) return null;

  const stepIndex = ONBOARDING_STEPS.indexOf(currentStep);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === ONBOARDING_STEPS.length - 1;

  // Determine if the "Next" button should be disabled
  const canProceed =
    currentStep === "welcome" ||
    currentStep === "unlock" ||
    (currentStep === "connect-wallet" && !!address) ||
    (currentStep === "get-credential" &&
      loadCredentials().some((c) => c.type === "age")) ||
    currentStep === "generate-proof";

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
        animation: "fadeIn 0.25s var(--ease)",
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Onboarding wizard"
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 440,
          margin: "1rem",
          padding: "1.75rem",
          position: "relative",
          animation: "slideUp 0.3s var(--ease)",
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

        {/* Step indicator */}
        <StepDots current={stepIndex} total={ONBOARDING_STEPS.length} />
        <ProgressBar progress={progress} />

        {/* Step icon */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "var(--radius-sm)",
            background: "rgba(62, 207, 142, 0.08)",
            border: "1px solid rgba(62, 207, 142, 0.18)",
            display: "grid",
            placeItems: "center",
            margin: "0 auto 1rem",
            color: "var(--accent)",
          }}
        >
          {STEP_ICONS[currentStep]}
        </div>

        {/* Title */}
        <h2
          style={{
            fontSize: "1.25rem",
            textAlign: "center",
            marginBottom: "0.5rem",
          }}
        >
          {STEP_TITLES[currentStep]}
        </h2>

        {/* Step content */}
        <StepContent step={currentStep} />

        {/* Navigation */}
        <div
          className="between"
          style={{ marginTop: "1.75rem", gap: "0.5rem" }}
        >
          {!isFirst ? (
            <button
              className="btn btn-ghost btn-sm"
              onClick={prevStep}
            >
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

          {!isLast ? (
            <button
              className="btn btn-primary btn-sm"
              onClick={nextStep}
              disabled={!canProceed}
              title={
                !canProceed
                  ? currentStep === "connect-wallet"
                    ? "Connect a wallet first"
                    : currentStep === "get-credential"
                      ? "Get a credential first"
                      : undefined
                  : undefined
              }
            >
              Next
              <IconArrowRight size={14} />
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={dismiss}
            >
              Get started
              <IconArrowRight size={14} />
            </button>
          )}
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

      {/* Inline keyframes for animations */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

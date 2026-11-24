/**
 * lib/onboarding-guidance.ts
 *
 * Pure content + gating for the guided onboarding flow (#807). The wizard
 * component renders from this module; nothing here touches React, storage or
 * the network, so the contextual guidance copy and the step-progression rules
 * can be unit-tested in isolation.
 */

import type { IssuerStatus } from "./issuer-registry";
import type { OnboardingStep } from "./onboarding";

export interface StepGuidance {
  /** Short imperative headline, e.g. "Connect your wallet". */
  title: string;
  /** What the step does and why it matters — shown under the headline. */
  summary: string;
  /** Contextual guidance callout ("Good to know") for the step. */
  tip: string;
  /** One-line label used in the wizard's roadmap rail. */
  railLabel: string;
}

export const STEP_GUIDANCE: Record<OnboardingStep, StepGuidance> = {
  welcome: {
    title: "Welcome to StellarCred",
    summary:
      "Prove facts about yourself without revealing personal data. This walkthrough takes you through the full loop once: a wallet, a credential, and a proof anyone can verify.",
    tip: "Your credentials live in this browser only — never on a server. You can replay this tour anytime with the “Tour” button in the header.",
    railLabel: "Welcome",
  },
  "connect-wallet": {
    title: "Set up your wallet",
    summary:
      "Connect a Stellar wallet on testnet. Your wallet address is the identity your credentials are bound to — proofs are always submitted by its key.",
    tip: "Credentials are sealed to the address that received them, so use the same wallet every time. Nothing is sent to us when you connect; the wallet only shares its public address.",
    railLabel: "Wallet",
  },
  "get-credential": {
    title: "Create your credential",
    summary:
      "Request a demo age credential from the StellarCred Authority. It attests “age ≥ 18” without carrying your date of birth — only a cryptographic commitment is stored.",
    tip: "The credential is encrypted at rest in your browser with a key derived from your unlock passphrase. Back it up from the dashboard before clearing site data.",
    railLabel: "Credential",
  },
  "verify-trust": {
    title: "Verify issuer trust",
    summary:
      "Protocols only accept proofs from issuers registered on-chain. This check reads the issuer of your new credential from the IssuerRegistry contract and confirms its signing key is still trusted.",
    tip: "A trusted issuer is what makes a proof meaningful: anyone verifying on-chain re-runs this same check, so seeing “Trusted” here means your future proofs will be accepted.",
    railLabel: "Trust",
  },
  "generate-proof": {
    title: "Generate a proof",
    summary:
      "Generate a zero-knowledge proof locally. Only the claim (“age ≥ 18”) and the proof leave your device — the data behind it never does.",
    tip: "Proving runs entirely in your browser, so the first proof takes a few seconds to load the circuit. Onboarding stays available until you finish.",
    railLabel: "Proof",
  },
  unlock: {
    title: "You're ready",
    summary:
      "Wallet, credential, trust — the core loop is done. Any Stellar protocol can now verify your proofs in a single contract call.",
    tip: "Explore apps that accept StellarCred proofs, or open your dashboard to generate a real proof on-chain.",
    railLabel: "Finish",
  },
};

export type TrustSeverity = "success" | "warning" | "danger" | "info";

export interface TrustStatusGuidance {
  /** Badge label for the status. */
  label: string;
  /** Plain-language meaning of the status, aimed at a first-time holder. */
  message: string;
  severity: TrustSeverity;
}

export const TRUST_STATUS_GUIDANCE: Record<IssuerStatus, TrustStatusGuidance> = {
  active: {
    label: "Trusted",
    message:
      "The issuer is registered on-chain and its signing key is accepted. Proofs from this credential will pass the protocol's trusted-issuer gate.",
    severity: "success",
  },
  key_retired: {
    label: "Trusted (key retiring)",
    message:
      "The issuer rotated to a new signing key, but this credential's key is still inside its validity window. Proofs work now; the issuer's newer credentials use the new key.",
    severity: "info",
  },
  key_revoked: {
    label: "Key revoked",
    message:
      "This issuer's signing key was emergency-revoked, so proofs from this credential may be rejected. Wait for the issuer to install a replacement key, or get a fresh credential.",
    severity: "danger",
  },
  issuer_revoked: {
    label: "Issuer revoked",
    message:
      "This issuer was permanently removed from the registry, so protocols will reject its credentials. Get a new credential from a trusted issuer to continue.",
    severity: "danger",
  },
  unknown: {
    label: "Couldn't check",
    message:
      "The registry couldn't be reached right now. This does not block onboarding — the same check runs automatically whenever you prove, and you can retry here.",
    severity: "warning",
  },
};

/** Fallback used when a check threw before producing any status. */
export const TRUST_CHECK_ERROR_GUIDANCE: TrustStatusGuidance = {
  label: "Check failed",
  message:
    "The trust check hit an error. Try again — if the network is unreachable it will keep working once connectivity returns.",
  severity: "danger",
};

/** Live signals the wizard collects while the user works through a step. */
export interface OnboardingSignals {
  walletConnected: boolean;
  /** Holder already has a credential to carry into later steps. */
  hasCredential: boolean;
  /** The issuer-trust check has completed (any outcome, not just success). */
  trustChecked: boolean;
}

/**
 * Whether "Next" is enabled on `step`. The trust step unlocks once the check
 * has *run* — any outcome, including "unknown" or an error — so the user is
 * walked through the verification but never trapped by an unreachable
 * registry (#626 convention: a failing issuer check must not block proving).
 */
export function canProceed(step: OnboardingStep, s: OnboardingSignals): boolean {
  switch (step) {
    case "welcome":
    case "generate-proof":
    case "unlock":
      return true;
    case "connect-wallet":
      return s.walletConnected;
    case "get-credential":
      return s.hasCredential;
    case "verify-trust":
      return s.trustChecked;
  }
}

/**
 * Why the step can't advance yet — rendered as tooltip/helper text beside the
 * disabled "Next" button. Returns undefined when the step is unblocked.
 */
export function blockedReason(step: OnboardingStep, s: OnboardingSignals): string | undefined {
  if (canProceed(step, s)) return undefined;
  switch (step) {
    case "connect-wallet":
      return "Connect a wallet to continue.";
    case "get-credential":
      return "Request your demo credential to continue.";
    case "verify-trust":
      return "Run the trust check above to continue.";
    default:
      return undefined;
  }
}

export interface TrustChecklistItem {
  label: string;
  /** null while the check is still running or the result is "unknown". */
  ok: boolean | null;
}

/**
 * The three things a first-time holder should see confirmed on the trust step.
 * `ok` is null while the check is running or when the outcome was "unknown" —
 * an unreachable registry is "couldn't tell", not "failed".
 */
export function trustChecklist(status: IssuerStatus | null): TrustChecklistItem[] {
  const settled = status !== null && status !== "unknown";
  const issuerRegistered =
    status === "active" || status === "key_retired" || status === "key_revoked";
  const keyAccepted = status === "active" || status === "key_retired";
  return [
    {
      label: "Issuer registered in the on-chain IssuerRegistry",
      ok: settled ? issuerRegistered : null,
    },
    {
      label: "Credential's signing key still accepted by the registry",
      ok: settled ? keyAccepted : null,
    },
    {
      label: "Proofs from this credential will pass the trusted-issuer gate",
      ok: settled ? keyAccepted : null,
    },
  ];
}

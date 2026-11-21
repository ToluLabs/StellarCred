// Tests for the pure onboarding guidance module (lib/onboarding-guidance.ts),
// backing the guided onboarding flow redesign (#807).

import { describe, it, expect } from "vitest";
import {
  STEP_GUIDANCE,
  TRUST_STATUS_GUIDANCE,
  TRUST_CHECK_ERROR_GUIDANCE,
  canProceed,
  blockedReason,
  trustChecklist,
  type OnboardingSignals,
} from "../onboarding-guidance";
import { ONBOARDING_STEPS, type OnboardingStep } from "../onboarding";
import type { IssuerStatus } from "../issuer-registry";

const NO_SIGNALS: OnboardingSignals = {
  walletConnected: false,
  hasCredential: false,
  trustChecked: false,
};

describe("STEP_GUIDANCE", () => {
  it("covers every wizard step with non-empty title, summary and tip", () => {
    for (const step of ONBOARDING_STEPS) {
      const g = STEP_GUIDANCE[step];
      expect(g.title, step).not.toBe("");
      expect(g.summary, step).not.toBe("");
      expect(g.tip, step).not.toBe("");
      expect(g.railLabel, step).not.toBe("");
    }
  });

  it("includes the wallet, credential and trust-verification steps the issue requires", () => {
    expect(ONBOARDING_STEPS).toContain("connect-wallet");
    expect(ONBOARDING_STEPS).toContain("get-credential");
    expect(ONBOARDING_STEPS).toContain("verify-trust");
  });
});

describe("TRUST_STATUS_GUIDANCE", () => {
  const STATUSES: IssuerStatus[] = [
    "active",
    "key_retired",
    "key_revoked",
    "issuer_revoked",
    "unknown",
  ];

  it("has guidance for every issuer status, with a severity", () => {
    for (const status of STATUSES) {
      const g = TRUST_STATUS_GUIDANCE[status];
      expect(g.label, status).not.toBe("");
      expect(g.message, status).not.toBe("");
      expect(["success", "warning", "danger", "info"]).toContain(g.severity);
    }
  });

  it("maps statuses to severities that match the #626 semantics", () => {
    expect(TRUST_STATUS_GUIDANCE.active.severity).toBe("success");
    expect(TRUST_STATUS_GUIDANCE.key_retired.severity).toBe("info");
    expect(TRUST_STATUS_GUIDANCE.key_revoked.severity).toBe("danger");
    expect(TRUST_STATUS_GUIDANCE.issuer_revoked.severity).toBe("danger");
    // Unknown must not be alarming enough to block the user.
    expect(TRUST_STATUS_GUIDANCE.unknown.severity).toBe("warning");
    expect(TRUST_CHECK_ERROR_GUIDANCE.severity).toBe("danger");
  });
});

describe("canProceed / blockedReason", () => {
  it("never blocks free steps", () => {
    for (const step of ["welcome", "generate-proof", "unlock"] as OnboardingStep[]) {
      expect(canProceed(step, NO_SIGNALS), step).toBe(true);
      expect(blockedReason(step, NO_SIGNALS), step).toBeUndefined();
    }
  });

  it("gates wallet/credential/trust steps on their signals", () => {
    expect(canProceed("connect-wallet", NO_SIGNALS)).toBe(false);
    expect(canProceed("connect-wallet", { ...NO_SIGNALS, walletConnected: true })).toBe(true);

    expect(canProceed("get-credential", NO_SIGNALS)).toBe(false);
    expect(canProceed("get-credential", { ...NO_SIGNALS, hasCredential: true })).toBe(true);

    // A *completed* run unblocks — even a failed or unknown outcome. An
    // unreachable registry must not trap the user in onboarding.
    expect(canProceed("verify-trust", NO_SIGNALS)).toBe(false);
    expect(canProceed("verify-trust", { ...NO_SIGNALS, hasCredential: true })).toBe(false);
    expect(canProceed("verify-trust", { ...NO_SIGNALS, trustChecked: true })).toBe(true);
  });

  it("explains every blocked step with guidance text", () => {
    for (const step of ONBOARDING_STEPS) {
      if (!canProceed(step, NO_SIGNALS)) {
        expect(blockedReason(step, NO_SIGNALS), step).toBeTruthy();
      }
    }
  });
});

describe("trustChecklist", () => {
  it("shows three undecided rows while running or unknown", () => {
    for (const status of [null, "unknown"] as const) {
      const rows = trustChecklist(status);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.ok === null)).toBe(true);
    }
  });

  it("marks trusted issuers fully green", () => {
    for (const status of ["active", "key_retired"] as IssuerStatus[]) {
      expect(trustChecklist(status).every((r) => r.ok === true)).toBe(true);
    }
  });

  it("distinguishes issuer revocation from key revocation", () => {
    const keyRevoked = trustChecklist("key_revoked");
    expect(keyRevoked[0].ok).toBe(true); // issuer is still registered
    expect(keyRevoked[1].ok).toBe(false);
    expect(keyRevoked[2].ok).toBe(false);

    const issuerRevoked = trustChecklist("issuer_revoked");
    expect(issuerRevoked[0].ok).toBe(false);
    expect(issuerRevoked[1].ok).toBe(false);
    expect(issuerRevoked[2].ok).toBe(false);
  });
});

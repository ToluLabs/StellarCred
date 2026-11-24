import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VerifyLinkError } from "./VerifyLinkError";
import type { VerifyError } from "@/lib/verifyParams";

const CASES: VerifyError[] = [
  {
    code: "missing_return_url",
    title: "This verification link is missing its return URL",
    detail: "Ask the service that sent you here for a fresh link.",
  },
  {
    code: "bad_claim",
    title: "\u201cxyzzy\u201d is not a credential we support",
    detail: "The link asked for an unrecognised credential type.",
  },
  {
    code: "bad_threshold",
    title: "This claim threshold is invalid",
    detail: "The funds gate expects a whole-number threshold.",
  },
  {
    code: "bad_restricted",
    title: "The restricted-countries list is malformed",
    detail: "The restricted parameter should be numeric country codes.",
  },
  {
    code: "bad_return_url",
    title: "This verification link has an invalid return URL",
    detail: "The return URL must be a secure web address.",
  },
];

describe("VerifyLinkError", () => {
  it.each(CASES)("renders an actionable error UI for code $code", (err) => {
    render(<VerifyLinkError error={err} onBack={() => {}} />);
    expect(screen.getByTestId("verify-link-error")).toBeTruthy();
    expect(screen.getByText("Verification link unavailable")).toBeTruthy();
    expect(screen.getByTestId("verify-error-title").textContent).toBe(err.title);
  });

  it("shows the specific title and detail for each malformed param", () => {
    for (const err of CASES) {
      const { unmount } = render(<VerifyLinkError error={err} onBack={() => {}} />);
      expect(screen.getByTestId("verify-error-title").textContent).toContain(err.title);
      expect(screen.getByText(err.detail)).toBeTruthy();
      unmount();
    }
  });

  it("offers a way forward (credentials + back home) instead of a dead end", () => {
    const onBack = vi.fn();
    render(<VerifyLinkError error={CASES[0]} onBack={onBack} />);
    expect(screen.getByText("Go to your credentials").getAttribute("href")).toBe("/holder");
    const back = screen.getByText("Back home");
    back.click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
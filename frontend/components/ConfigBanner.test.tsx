import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfigBanner } from "./ConfigBanner";

// Guards the regression that broke the PR: a mangled merge left the legacy
// inline-styled banner markup spliced inside the new CSS-class banner, which
// produced invalid JSX (and would render duplicated content).
//
// Under vitest the contract-ID env vars are unset, so the banner renders with
// the "App not fully configured" branch — deterministic without extra setup.
describe("ConfigBanner", () => {
  it("renders exactly one new-style banner with no legacy markup spliced in", () => {
    const { container } = render(<ConfigBanner />);

    expect(container.querySelectorAll(".config-banner")).toHaveLength(1);
    expect(container.querySelectorAll(".config-banner__icon")).toHaveLength(1);
    expect(container.querySelectorAll(".config-banner__text")).toHaveLength(1);
    expect(container.querySelectorAll(".config-banner__strong")).toHaveLength(1);

    // The old inline-styled block must not be present.
    expect(container.querySelector(".row")).toBeNull();
    expect(container.querySelector(".muted")).toBeNull();

    // Heading text rendered exactly once (the mangled block duplicated it).
    expect(screen.getAllByText("App not fully configured.")).toHaveLength(1);
  });

  it("lists the active network and the missing env vars", () => {
    render(<ConfigBanner />);

    const bannerText = screen.getByText(/Active network:/);
    expect(bannerText.textContent).toContain("Active network:");
    expect(bannerText.textContent).toContain("missing env vars");
  });
});

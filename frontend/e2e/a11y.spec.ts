import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const PAGES = [
  "/",
  "/holder",
  "/verify",
  "/verifier",
  "/issuer",
  "/apps",
  "/apps/lendfi",
  "/developers",
  "/docs",
];

const KNOWN_EXCEPTIONS: { rule: string; rationale: string; path?: string }[] = [
  // Documented allowed exceptions will go here.
  // Example: { rule: "color-contrast", rationale: "Brand colors on the hero banner", path: "/" }
];

for (const path of PAGES) {
  test(`${path} has no serious or critical WCAG violations (beyond known exceptions)`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const seriousOrCritical = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical"
    );

    const unexpectedViolations = seriousOrCritical.filter((violation) => {
      return !KNOWN_EXCEPTIONS.some(
        (ex) => ex.rule === violation.id && (!ex.path || ex.path === path)
      );
    });

    expect(
      unexpectedViolations,
      `Unexpected serious/critical a11y violations on ${path}:\n${JSON.stringify(unexpectedViolations, null, 2)}`
    ).toEqual([]);
  });
}

test("skip link is keyboard-reachable and jumps to main content", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skipLink = page.locator(".skip-link");
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

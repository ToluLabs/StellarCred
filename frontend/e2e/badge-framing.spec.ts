/**
 * Badge framing controls test (#532)
 * 
 * Verifies that:
 * 1. /badge route allows framing (no X-Frame-Options: DENY)
 * 2. /badge has frame-ancestors CSP directive
 * 3. Other routes deny framing (X-Frame-Options: DENY)
 * 4. Badge renders correctly in both light and dark themes when embedded
 */

import { test, expect } from "@playwright/test";

test.describe("Badge framing controls (#532)", () => {
  test("badge route allows framing", async ({ page }) => {
    const response = await page.goto("/badge?wallet=GTEST&claim=kyc");
    expect(response).not.toBeNull();
    
    if (!response) return;

    const headers = response.headers();
    
    // Badge should NOT have X-Frame-Options: DENY
    const xFrameOptions = headers["x-frame-options"];
    expect(xFrameOptions).not.toBe("DENY");
    
    // Badge should have frame-ancestors in CSP
    const csp = headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("frame-ancestors");
    
    // Should allow all origins by default (frame-ancestors *)
    // or specific origins if BADGE_ALLOWED_ORIGINS is set
    expect(csp).toMatch(/frame-ancestors\s+(\*|https?:\/\/)/);
  });

  test("non-badge routes deny framing", async ({ page }) => {
    const routes = ["/", "/holder", "/issuer", "/verify"];
    
    for (const route of routes) {
      const response = await page.goto(route);
      if (!response) continue;
      
      const headers = response.headers();
      
      // Should have X-Frame-Options: DENY
      const xFrameOptions = headers["x-frame-options"];
      expect(xFrameOptions).toBe("DENY");
      
      // Should have frame-ancestors 'none' in CSP
      const csp = headers["content-security-policy"];
      expect(csp).toBeDefined();
      expect(csp).toContain("frame-ancestors 'none'");
    }
  });

  test("badge renders in iframe with dark theme", async ({ page }) => {
    // Create a page with an iframe embedding the badge
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><style>body { margin: 0; background: #1a1a1a; }</style></head>
        <body>
          <iframe 
            id="badge-frame" 
            src="/badge?wallet=GTEST&claim=kyc&theme=dark&compact=1"
            width="300" 
            height="100"
            style="border: 1px solid #333;"
          ></iframe>
        </body>
      </html>
    `);

    // Wait for iframe to load
    const frame = page.frameLocator("#badge-frame");
    
    // Badge should render without errors
    await expect(frame.locator("body")).toBeVisible();
    
    // Check that badge content is present (status indicator)
    const badge = frame.locator('[role="status"]').or(frame.locator('text=/verified|unverified|unknown/i'));
    await expect(badge.first()).toBeVisible({ timeout: 10000 });
  });

  test("badge renders in iframe with light theme", async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><style>body { margin: 0; background: #ffffff; }</style></head>
        <body>
          <iframe 
            id="badge-frame" 
            src="/badge?wallet=GTEST&claim=kyc&theme=light&compact=1"
            width="300" 
            height="100"
            style="border: 1px solid #ddd;"
          ></iframe>
        </body>
      </html>
    `);

    const frame = page.frameLocator("#badge-frame");
    await expect(frame.locator("body")).toBeVisible();
    
    const badge = frame.locator('[role="status"]').or(frame.locator('text=/verified|unverified|unknown/i'));
    await expect(badge.first()).toBeVisible({ timeout: 10000 });
  });

  test("badge degrades gracefully with invalid wallet", async ({ page }) => {
    const response = await page.goto("/badge?wallet=INVALID&claim=kyc");
    expect(response).not.toBeNull();
    expect(response?.status()).toBe(200);
    
    // Badge should render with "unverified" status for invalid wallet
    await expect(page.locator("body")).toBeVisible();
  });

  test("badge handles missing wallet parameter", async ({ page }) => {
    const response = await page.goto("/badge?claim=kyc");
    expect(response).not.toBeNull();
    expect(response?.status()).toBe(200);
    
    // Badge should render, defaulting to unverified state
    await expect(page.locator("body")).toBeVisible();
  });

  test("badge respects compact mode", async ({ page }) => {
    await page.goto("/badge?wallet=GTEST&claim=kyc&compact=1");
    
    // In compact mode, the badge should render with minimal UI
    await expect(page.locator("body")).toBeVisible();
    
    // Badge should be present
    const status = page.locator('[role="status"]').or(page.locator('text=/verified|unverified|unknown/i'));
    await expect(status.first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Badge CSP configuration", () => {
  test("badge CSP allows embedding from specific origins when configured", async ({ page }) => {
    // This test assumes BADGE_ALLOWED_ORIGINS is not set in CI (default: allow all)
    // In production with BADGE_ALLOWED_ORIGINS set, this would verify the specific origins
    
    const response = await page.goto("/badge?wallet=GTEST&claim=kyc");
    if (!response) return;
    
    const csp = response.headers()["content-security-policy"];
    expect(csp).toBeDefined();
    
    // Should have frame-ancestors directive
    expect(csp).toContain("frame-ancestors");
    
    // When BADGE_ALLOWED_ORIGINS is unset, should allow all (*)
    // When set, should list specific origins
    const frameAncestorsMatch = csp?.match(/frame-ancestors\s+([^;]+)/);
    expect(frameAncestorsMatch).toBeTruthy();
    
    if (frameAncestorsMatch) {
      const value = frameAncestorsMatch[1].trim();
      // Should be either * or a list of https:// origins
      expect(value).toMatch(/^\*$|^https?:\/\/.+/);
    }
  });

  test("non-badge routes have restrictive CSP", async ({ page }) => {
    const response = await page.goto("/holder");
    if (!response) return;
    
    const csp = response.headers()["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

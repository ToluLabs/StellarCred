/**
 * WCAG 2.1 Contrast Ratio Tests
 *
 * Tests that all text colors meet WCAG AA requirements:
 * - Normal text: minimum 4.5:1 contrast ratio
 * - Large text (18pt+ or 14pt+ bold): minimum 3:1 contrast ratio
 *
 * This test suite validates the dark mode color palette defined in globals.css
 * to ensure accessibility compliance for issue #1051.
 */

import { describe, it, expect } from "vitest";

/**
 * Calculate relative luminance of an RGB color
 * Formula from WCAG 2.1: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const val = c / 255;
    return val <= 0.04045 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate contrast ratio between two colors
 * Formula from WCAG 2.1: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
function getContrastRatio(rgb1: [number, number, number], rgb2: [number, number, number]): number {
  const lum1 = getLuminance(...rgb1);
  const lum2 = getLuminance(...rgb2);
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Convert hex color to RGB tuple
 */
function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) throw new Error(`Invalid hex color: ${hex}`);
  return [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)];
}

describe("Dark Mode Contrast Ratios (WCAG AA Compliance)", () => {
  // Dark mode background colors
  const backgrounds = {
    bg: hexToRgb("#05050a"),
    bgRaised: hexToRgb("#0b0b12"),
    bgSoft: hexToRgb("#0f0f18"),
    card: hexToRgb("#0b0b12"),
  };

  // CURRENT dark mode text colors (before fix)
  const currentColors = {
    text: hexToRgb("#eeeef5"),
    muted: hexToRgb("#888899"),
    faint: hexToRgb("#4e4e60"),
    accent: hexToRgb("#3ecf8e"),
    warn: hexToRgb("#e3b341"),
    danger: hexToRgb("#f0604d"),
  };

  // PROPOSED dark mode text colors (accessibility-compliant)
  const proposedColors = {
    text: hexToRgb("#f5f5fa"), // Brighter white for better contrast
    muted: hexToRgb("#a8a8b8"), // Lighter muted text
    faint: hexToRgb("#7d7d8f"), // Lighter faint text
    accent: hexToRgb("#4aeaa4"), // Brighter accent green
    accentDim: hexToRgb("#3ecf8e"), // For large text / less critical uses
    warn: hexToRgb("#fac558"), // Brighter warning yellow
    danger: hexToRgb("#ff7368"), // Brighter danger red
  };

  describe("Current Colors (Baseline - may fail)", () => {
    it("should test current --text color contrast", () => {
      const ratio = getContrastRatio(currentColors.text, backgrounds.bg);
      console.log(`Current --text (#eeeef5) on --bg: ${ratio.toFixed(2)}:1`);
      // This might pass or fail - we're just measuring
    });

    it("should test current --muted color contrast", () => {
      const ratio = getContrastRatio(currentColors.muted, backgrounds.bg);
      console.log(`Current --muted (#888899) on --bg: ${ratio.toFixed(2)}:1`);
      expect(ratio).toBeGreaterThanOrEqual(4.5); // Existing muted token already passes AA.
    });

    it("should test current --faint color contrast", () => {
      const ratio = getContrastRatio(currentColors.faint, backgrounds.bg);
      console.log(`Current --faint (#4e4e60) on --bg: ${ratio.toFixed(2)}:1`);
      expect(ratio).toBeLessThan(4.5); // Expected to fail
    });

    it("should test current badge colors on card backgrounds", () => {
      const verifiedRatio = getContrastRatio(currentColors.accent, backgrounds.card);
      const pendingRatio = getContrastRatio(currentColors.warn, backgrounds.card);
      const deniedRatio = getContrastRatio(currentColors.danger, backgrounds.card);

      console.log(`Current badge-verified (#3ecf8e) on card: ${verifiedRatio.toFixed(2)}:1`);
      console.log(`Current badge-pending (#e3b341) on card: ${pendingRatio.toFixed(2)}:1`);
      console.log(`Current badge-denied (#f0604d) on card: ${deniedRatio.toFixed(2)}:1`);
    });
  });

  describe("Proposed Colors (Must Pass WCAG AA)", () => {
    it("should meet 4.5:1 for --text on all backgrounds", () => {
      Object.entries(backgrounds).forEach(([name, bg]) => {
        const ratio = getContrastRatio(proposedColors.text, bg);
        console.log(`Proposed --text on ${name}: ${ratio.toFixed(2)}:1`);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    });

    it("should meet 4.5:1 for --muted on all backgrounds", () => {
      Object.entries(backgrounds).forEach(([name, bg]) => {
        const ratio = getContrastRatio(proposedColors.muted, bg);
        console.log(`Proposed --muted on ${name}: ${ratio.toFixed(2)}:1`);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    });

    it("should meet 4.5:1 for --faint on all backgrounds", () => {
      Object.entries(backgrounds).forEach(([name, bg]) => {
        const ratio = getContrastRatio(proposedColors.faint, bg);
        console.log(`Proposed --faint on ${name}: ${ratio.toFixed(2)}:1`);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    });

    it("should meet 4.5:1 for badge-verified (accent) on card background", () => {
      const ratio = getContrastRatio(proposedColors.accent, backgrounds.card);
      console.log(`Proposed badge-verified on card: ${ratio.toFixed(2)}:1`);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it("should meet 4.5:1 for badge-pending (warn) on card background", () => {
      const ratio = getContrastRatio(proposedColors.warn, backgrounds.card);
      console.log(`Proposed badge-pending on card: ${ratio.toFixed(2)}:1`);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it("should meet 4.5:1 for badge-denied (danger) on card background", () => {
      const ratio = getContrastRatio(proposedColors.danger, backgrounds.card);
      console.log(`Proposed badge-denied on card: ${ratio.toFixed(2)}:1`);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it("should meet 4.5:1 for status badges on soft backgrounds", () => {
      // Badges often appear on bgSoft backgrounds in tables
      const verifiedRatio = getContrastRatio(proposedColors.accent, backgrounds.bgSoft);
      const pendingRatio = getContrastRatio(proposedColors.warn, backgrounds.bgSoft);
      const deniedRatio = getContrastRatio(proposedColors.danger, backgrounds.bgSoft);

      console.log(`Proposed badge-verified on bgSoft: ${verifiedRatio.toFixed(2)}:1`);
      console.log(`Proposed badge-pending on bgSoft: ${pendingRatio.toFixed(2)}:1`);
      console.log(`Proposed badge-denied on bgSoft: ${deniedRatio.toFixed(2)}:1`);

      expect(verifiedRatio).toBeGreaterThanOrEqual(4.5);
      expect(pendingRatio).toBeGreaterThanOrEqual(4.5);
      expect(deniedRatio).toBeGreaterThanOrEqual(4.5);
    });

    it("should meet 3:1 for accent-dim on backgrounds (large text usage)", () => {
      // accentDim is used for less critical elements or larger text
      Object.entries(backgrounds).forEach(([name, bg]) => {
        const ratio = getContrastRatio(proposedColors.accentDim, bg);
        console.log(`Proposed accent-dim on ${name}: ${ratio.toFixed(2)}:1`);
        expect(ratio).toBeGreaterThanOrEqual(3.0);
      });
    });
  });

  describe("Border Contrast (UI Component Boundaries)", () => {
    it("should ensure borders are visible against backgrounds", () => {
      // Composite the translucent border over each dark surface before measuring.
      Object.entries(backgrounds).forEach(([name, background]) => {
        const alpha = 0.36;
        const border = [255, 255, 255].map((channel, index) =>
          Math.round(channel * alpha + background[index] * (1 - alpha)),
        ) as [number, number, number];
        const ratio = getContrastRatio(border, background);
        console.log(`Border-strong on ${name}: ${ratio.toFixed(2)}:1`);
        expect(ratio).toBeGreaterThanOrEqual(3);
      });
    });
  });

  describe("Inline Status Colors (SubmissionHistory component)", () => {
    it("should meet 4.5:1 for inline status badges", () => {
      // SubmissionHistory uses inline styles with these exact colors
      const confirmedColor = hexToRgb("#3ecf8e");
      const pendingColor = hexToRgb("#f59e0b");
      const failedColor = hexToRgb("#f0604d");

      // These appear on card backgrounds
      const confirmedRatio = getContrastRatio(confirmedColor, backgrounds.card);
      const pendingRatio = getContrastRatio(pendingColor, backgrounds.card);
      const failedRatio = getContrastRatio(failedColor, backgrounds.card);

      console.log(`Submission confirmed color: ${confirmedRatio.toFixed(2)}:1`);
      console.log(`Submission pending color: ${pendingRatio.toFixed(2)}:1`);
      console.log(`Submission failed color: ${failedRatio.toFixed(2)}:1`);

      expect(confirmedRatio).toBeGreaterThanOrEqual(4.5);
      expect(pendingRatio).toBeGreaterThanOrEqual(4.5);
      expect(failedRatio).toBeGreaterThanOrEqual(4.5);
    });
  });
});

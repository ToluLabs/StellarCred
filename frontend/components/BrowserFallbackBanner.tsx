"use client";

import dynamic from "next/dynamic";

/**
 * BrowserFallbackBanner — Safe fallback UI for unsupported browser capabilities (Issue #939).
 *
 * Lazy-loaded via next/dynamic with ssr: false to prevent inflating the first-load
 * critical JS bundle on initial page load, while still rendering client-side
 * when unsupported browser capabilities are detected.
 */
export const BrowserFallbackBanner = dynamic(
  () => import("./BrowserFallbackBannerContent").then((m) => m.BrowserFallbackBannerContent),
  { ssr: false },
);

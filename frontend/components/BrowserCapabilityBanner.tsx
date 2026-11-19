"use client";

/**
 * Browser capability warning banner.
 *
 * Displays warnings when the browser lacks certain capabilities required by StellarCred.
 * Shows critical errors (app cannot function) and non-critical warnings (reduced functionality).
 *
 * Issue #900: Add graceful degradation for unsupported browser capabilities
 */

import { useEffect, useState } from "react";
import { IconAlertTriangle, IconInfoCircle, IconX } from "@tabler/icons-react";
import {
  checkBrowserCapabilities,
  getUnsupportedBrowserMessage,
  type BrowserCapabilities,
} from "@/lib/browser-capabilities";

interface BrowserCapabilityBannerProps {
  /** Optional callback when banner is dismissed */
  onDismiss?: () => void;
}

export function BrowserCapabilityBanner({ onDismiss }: BrowserCapabilityBannerProps) {
  const capabilities = useBrowserCapabilities();
  const [dismissed, setDismissed] = useState(false);

  // null during SSR and the first client render, so server and client markup match.
  if (!capabilities || dismissed) {
    return null;
  }

  const hasCriticalErrors = capabilities.unsupportedCritical.length > 0;
  const nonCriticalWarnings = capabilities.checks.filter((c) => !c.critical && !c.supported);

  // Everything we need works — render nothing.
  if (!hasCriticalErrors && nonCriticalWarnings.length === 0) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  const tone = hasCriticalErrors
    ? {
        color: "var(--danger)",
        border: "1px solid rgba(240, 96, 77, 0.35)",
        background: "rgba(240, 96, 77, 0.1)",
      }
    : {
        color: "var(--warn)",
        border: "1px solid rgba(227, 179, 65, 0.3)",
        background: "rgba(227, 179, 65, 0.08)",
      };
  const Icon = hasCriticalErrors ? IconAlertTriangle : IconInfoCircle;

  return (
    <div
      role={hasCriticalErrors ? "alert" : "status"}
      data-testid="browser-capability-banner"
      data-severity={hasCriticalErrors ? "critical" : "warning"}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "0.75rem",
        padding: "0.75rem 1.5rem",
        borderBottom: tone.border,
        background: tone.background,
        fontSize: "0.8125rem",
        color: "var(--text)",
      }}
    >
      <Icon size={18} style={{ color: tone.color, flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        {hasCriticalErrors ? (
          <>
            <strong style={{ color: tone.color }}>Browser not supported</strong>
            <p style={{ margin: "0.25rem 0 0.5rem" }}>{getUnsupportedBrowserMessage(capabilities)}</p>
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {capabilities.unsupportedCritical.map((check) => (
                <li key={check.name}>
                  <strong>{check.name}:</strong> {check.error}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <strong style={{ color: tone.color }}>Limited browser support</strong>
            <p style={{ margin: "0.25rem 0 0.5rem" }}>
              Some features are not available. The app will run with reduced functionality.
            </p>
            <details>
              <summary style={{ cursor: "pointer" }}>View details</summary>
              <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
                {nonCriticalWarnings.map((check) => (
                  <li key={check.name}>
                    <strong>{check.name}:</strong> {check.error}
                    {check.fallbackDescription ? <span> ({check.fallbackDescription})</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss browser capability notice"
        style={{
          background: "transparent",
          border: 0,
          padding: 4,
          cursor: "pointer",
          color: tone.color,
          lineHeight: 0,
        }}
      >
        <IconX size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Hook to check browser capabilities on the client side.
 * Returns null during SSR and until the first effect has run.
 */
export function useBrowserCapabilities(): BrowserCapabilities | null {
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null);

  useEffect(() => {
    setCapabilities(checkBrowserCapabilities());
  }, []);

  return capabilities;
}

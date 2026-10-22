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
import { checkBrowserCapabilities, getUnsupportedBrowserMessage, type BrowserCapabilities } from "@/lib/browser-capabilities";
import { AlertTriangle, Info, X } from "@tabler/icons-react";

interface BrowserCapabilityBannerProps {
  /** Optional callback when banner is dismissed */
  onDismiss?: () => void;
}

export function BrowserCapabilityBanner({ onDismiss }: BrowserCapabilityBannerProps) {
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const caps = checkBrowserCapabilities();
    setCapabilities(caps);
  }, []);

  if (!capabilities || dismissed) {
    return null;
  }

  // If fully supported, don't show anything
  if (capabilities.isFullySupported) {
    return null;
  }

  const hasCriticalErrors = capabilities.unsupportedCritical.length > 0;
  const nonCriticalWarnings = capabilities.checks.filter((c) => !c.critical && !c.supported);

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  // Critical error - app cannot function
  if (hasCriticalErrors) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-red-50 dark:bg-red-950 border-b border-red-200 dark:border-red-800">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-red-900 dark:text-red-100 mb-2">
                Browser Not Supported
              </h3>
              <p className="text-sm text-red-800 dark:text-red-200 mb-3">
                {getUnsupportedBrowserMessage(capabilities)}
              </p>
              <div className="space-y-2 mb-3">
                {capabilities.unsupportedCritical.map((check) => (
                  <div key={check.name} className="text-sm text-red-700 dark:text-red-300">
                    <strong>{check.name}:</strong> {check.error}
                  </div>
                ))}
              </div>
              <p className="text-sm text-red-700 dark:text-red-300">
                Please update your browser or switch to a modern browser like Chrome, Firefox, Safari, or Edge.
              </p>
            </div>
            <button
              onClick={handleDismiss}
              className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 transition-colors"
              aria-label="Dismiss"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Non-critical warnings - reduced functionality
  if (nonCriticalWarnings.length > 0) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-yellow-50 dark:bg-yellow-950 border-b border-yellow-200 dark:border-yellow-800">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-start gap-3">
            <Info className="w-5 h-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-yellow-900 dark:text-yellow-100 mb-1">
                Limited Browser Support
              </h3>
              <p className="text-xs text-yellow-800 dark:text-yellow-200 mb-2">
                Some features are not available. The app will run with reduced functionality.
              </p>
              <details className="text-xs text-yellow-700 dark:text-yellow-300">
                <summary className="cursor-pointer hover:underline">View details</summary>
                <ul className="mt-2 space-y-1 list-disc list-inside">
                  {nonCriticalWarnings.map((check) => (
                    <li key={check.name}>
                      <strong>{check.name}:</strong> {check.error}
                      {check.fallbackDescription && <span className="ml-2">({check.fallbackDescription})</span>}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
            <button
              onClick={handleDismiss}
              className="text-yellow-600 dark:text-yellow-400 hover:text-yellow-800 dark:hover:text-yellow-200 transition-colors"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

/**
 * Hook to check browser capabilities on the client side.
 * Returns null during SSR.
 */
export function useBrowserCapabilities(): BrowserCapabilities | null {
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null);

  useEffect(() => {
    setCapabilities(checkBrowserCapabilities());
  }, []);

  return capabilities;
}

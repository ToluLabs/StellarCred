"use client";

/**
 * useBrowserCompatibility — Hook for observing and managing browser capability
 * detection and fallback mode state (Issue #939).
 */

import { useCallback, useState } from "react";
import {
  detectBrowserCapabilities,
  type BrowserCompatibilityReport,
  type CapabilityIssue,
  type CapabilityKey,
  type EnvironmentOverrides,
} from "../browser-compatibility";

const DISMISSED_STORAGE_KEY = "stellarcred:dismissed_capability_warnings";

export interface UseBrowserCompatibilityReturn {
  report: BrowserCompatibilityReport;
  activeIssues: CapabilityIssue[];
  dismissedKeys: string[];
  dismissIssue: (key: CapabilityKey) => void;
  dismissAll: () => void;
  resetDismissals: () => void;
  recheck: () => void;
  isFallbackActive: boolean;
}

export function useBrowserCompatibility(
  overrides?: EnvironmentOverrides,
): UseBrowserCompatibilityReturn {
  const [report, setReport] = useState<BrowserCompatibilityReport>(() =>
    detectBrowserCapabilities(overrides),
  );
  const [dismissedKeys, setDismissedKeys] = useState<string[]>(() => {
    try {
      if (typeof window !== "undefined" && window.sessionStorage) {
        const saved = window.sessionStorage.getItem(DISMISSED_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }
      }
    } catch {
      // Session storage unavailable
    }
    return [];
  });

  const saveDismissed = useCallback((keys: string[]) => {
    setDismissedKeys(keys);
    try {
      if (typeof window !== "undefined" && window.sessionStorage) {
        window.sessionStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(keys));
      }
    } catch {
      // Storage blocked; keep in memory
    }
  }, []);

  const recheck = useCallback(() => {
    setReport(detectBrowserCapabilities(overrides));
  }, [overrides]);

  const dismissIssue = useCallback(
    (key: CapabilityKey) => {
      if (!dismissedKeys.includes(key)) {
        saveDismissed([...dismissedKeys, key]);
      }
    },
    [dismissedKeys, saveDismissed],
  );

  const dismissAll = useCallback(() => {
    const allKeys = report.issues.map((i) => i.id);
    saveDismissed(Array.from(new Set([...dismissedKeys, ...allKeys])));
  }, [report.issues, dismissedKeys, saveDismissed]);

  const resetDismissals = useCallback(() => {
    saveDismissed([]);
  }, [saveDismissed]);

  const activeIssues = report.issues.filter((issue) => !dismissedKeys.includes(issue.id));

  const isFallbackActive = report.hasBlockingIssues || report.hasDegradedIssues;

  return {
    report,
    activeIssues,
    dismissedKeys,
    dismissIssue,
    dismissAll,
    resetDismissals,
    recheck,
    isFallbackActive,
  };
}

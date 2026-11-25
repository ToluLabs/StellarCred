/**
 * browser-compatibility.ts — Safe fallback mode & capability detection (Issue #939).
 *
 * Detects missing browser or device capabilities at runtime (e.g. WebCrypto,
 * WebAssembly, Web Workers, local storage, secure context, wallet extensions),
 * reports friendly warnings, and provides actionable next steps and safe
 * fallback modes (like preview mode or alternative wallet connection methods)
 * without crashing or creating dead-end states.
 */

export type CapabilityKey =
  | "crypto"
  | "subtleCrypto"
  | "webAssembly"
  | "webWorker"
  | "storage"
  | "secureContext"
  | "walletExtension"
  | "webUsb";

export type CapabilitySeverity = "error" | "warning" | "info";

export interface CapabilityAction {
  label: string;
  type: "preview-mode" | "reload" | "dismiss" | "link";
  url?: string;
}

export interface CapabilityIssue {
  id: CapabilityKey;
  name: string;
  severity: CapabilitySeverity;
  title: string;
  description: string;
  impact: string;
  actionableSteps: string[];
  fallbackAvailable: boolean;
  fallbackModeDescription: string;
  actions?: CapabilityAction[];
}

export interface BrowserCapabilities {
  crypto: boolean;
  subtleCrypto: boolean;
  webAssembly: boolean;
  webWorker: boolean;
  storage: boolean;
  secureContext: boolean;
  walletExtension: boolean;
  webUsb: boolean;
}

export interface BrowserCompatibilityReport {
  isCompatible: boolean;
  hasBlockingIssues: boolean;
  hasDegradedIssues: boolean;
  capabilities: BrowserCapabilities;
  issues: CapabilityIssue[];
  summary: string;
}

export interface EnvironmentOverrides {
  window?: unknown;
  crypto?: unknown;
  subtleCrypto?: unknown;
  webAssembly?: unknown;
  worker?: unknown;
  storage?: unknown;
  isSecureContext?: boolean;
  protocol?: string;
  hostname?: string;
  walletDetected?: boolean;
  webUsb?: unknown;
}

/**
 * Checks if basic WebCrypto (getRandomValues) is available.
 */
export function isCryptoSupported(env?: EnvironmentOverrides): boolean {
  if (env && "crypto" in env) {
    if (!env.crypto) return false;
    const c = env.crypto as { getRandomValues?: unknown };
    return typeof c.getRandomValues === "function";
  }
  if (typeof window === "undefined") return true;
  try {
    return (
      typeof window.crypto !== "undefined" && typeof window.crypto.getRandomValues === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Checks if subtle crypto (WebCrypto SubtleCrypto) is available.
 * Note: Modern browsers require a secure context (HTTPS/localhost) for SubtleCrypto.
 */
export function isSubtleCryptoSupported(env?: EnvironmentOverrides): boolean {
  if (env && "subtleCrypto" in env) {
    return Boolean(env.subtleCrypto);
  }
  if (env && "crypto" in env) {
    if (!env.crypto) return false;
    const c = env.crypto as { subtle?: unknown };
    return Boolean(c.subtle);
  }
  if (typeof window === "undefined") return true;
  try {
    return typeof window.crypto !== "undefined" && typeof window.crypto.subtle !== "undefined";
  } catch {
    return false;
  }
}

/**
 * Checks if WebAssembly is supported and instantiable.
 */
export function isWebAssemblySupported(env?: EnvironmentOverrides): boolean {
  if (env && "webAssembly" in env) {
    if (!env.webAssembly) return false;
    const wa = env.webAssembly as { instantiate?: unknown };
    return typeof wa.instantiate === "function";
  }
  if (typeof window === "undefined") return true;
  try {
    return typeof WebAssembly !== "undefined" && typeof WebAssembly.instantiate === "function";
  } catch {
    return false;
  }
}

/**
 * Checks if Web Workers can be instantiated.
 */
export function isWebWorkerSupported(env?: EnvironmentOverrides): boolean {
  if (env && "worker" in env) {
    return Boolean(env.worker);
  }
  if (typeof window === "undefined") return true;
  try {
    return typeof Worker !== "undefined";
  } catch {
    return false;
  }
}

/**
 * Checks if localStorage is available and writable.
 */
export function isStorageSupported(env?: EnvironmentOverrides): boolean {
  if (env && "storage" in env) {
    return Boolean(env.storage);
  }
  if (typeof window === "undefined") return true;
  try {
    const testKey = "__stellarcred_cap_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if the page is running in a secure context (HTTPS or localhost).
 */
export function isSecureContextSupported(env?: EnvironmentOverrides): boolean {
  if (env && "isSecureContext" in env && typeof env.isSecureContext === "boolean") {
    return env.isSecureContext;
  }
  if (env && ("protocol" in env || "hostname" in env)) {
    const proto = env.protocol ?? "https:";
    const host = env.hostname ?? "localhost";
    return proto === "https:" || host === "localhost" || host === "127.0.0.1";
  }
  if (typeof window === "undefined") return true;
  try {
    if (typeof window.isSecureContext === "boolean") {
      return window.isSecureContext;
    }
    const proto = window.location?.protocol;
    const host = window.location?.hostname;
    return proto === "https:" || host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Checks if a browser wallet extension (Freighter, etc.) is detected.
 */
export function isWalletExtensionDetected(env?: EnvironmentOverrides): boolean {
  if (env && "walletDetected" in env && typeof env.walletDetected === "boolean") {
    return env.walletDetected;
  }
  if (typeof window === "undefined") return false;
  try {
    const w = window as unknown as Record<string, unknown>;
    return Boolean(w.freighterApi ?? w.freighter);
  } catch {
    return false;
  }
}

/**
 * Checks if WebUSB is available for hardware wallet connections (Ledger).
 */
export function isWebUsbSupported(env?: EnvironmentOverrides): boolean {
  if (env && "webUsb" in env) {
    return Boolean(env.webUsb);
  }
  if (typeof navigator === "undefined") return false;
  try {
    return Boolean(navigator.usb);
  } catch {
    return false;
  }
}

/**
 * Run a full runtime compatibility inspection and return a detailed report
 * with issues, severity levels, and actionable fallback recommendations.
 */
export function detectBrowserCapabilities(env?: EnvironmentOverrides): BrowserCompatibilityReport {
  const crypto = isCryptoSupported(env);
  const subtleCrypto = isSubtleCryptoSupported(env);
  const webAssembly = isWebAssemblySupported(env);
  const webWorker = isWebWorkerSupported(env);
  const storage = isStorageSupported(env);
  const secureContext = isSecureContextSupported(env);
  const walletExtension = isWalletExtensionDetected(env);
  const webUsb = isWebUsbSupported(env);

  const issues: CapabilityIssue[] = [];

  // Insecure context (blocks WebCrypto SubtleCrypto and WebUSB in browsers)
  if (!secureContext) {
    issues.push({
      id: "secureContext",
      name: "Secure Context (HTTPS)",
      severity: "warning",
      title: "Insecure connection detected",
      description:
        "The application is running over an unencrypted (HTTP) connection. Modern browsers restrict cryptographic and hardware APIs in non-secure origins.",
      impact: "Cryptographic operations and hardware wallet access may be blocked or degraded.",
      actionableSteps: [
        "Reload the application using HTTPS (e.g. https://...).",
        "If testing locally, use localhost or 127.0.0.1 instead of an IP address.",
        "You can continue in Preview Mode to view credentials without signing.",
      ],
      fallbackAvailable: true,
      fallbackModeDescription:
        "Preview Mode is active. You can browse credentials and templates without making on-chain transactions.",
      actions: [{ label: "Switch to Preview Mode", type: "preview-mode" }],
    });
  }

  // WebCrypto (getRandomValues or SubtleCrypto)
  if (!crypto) {
    issues.push({
      id: "crypto",
      name: "WebCrypto API",
      severity: "error",
      title: "Cryptographic features unavailable",
      description:
        "Your browser environment does not support window.crypto.getRandomValues, which is required for generating secure cryptographic entropy and nonces.",
      impact: "Credential commitment generation and proofs cannot be computed safely.",
      actionableSteps: [
        "Update your browser to a modern, supported version (Chrome 88+, Firefox 78+, Safari 14+, Edge 88+).",
        "Open this page directly in a primary browser rather than an embedded webview.",
        "Use Preview Mode to safely explore the application without generating proofs.",
      ],
      fallbackAvailable: true,
      fallbackModeDescription:
        "Safe Fallback Active: Proof generation is disabled to avoid corrupt credentials, but preview views remain accessible.",
      actions: [{ label: "Enable Preview Mode", type: "preview-mode" }],
    });
  } else if (!subtleCrypto) {
    issues.push({
      id: "subtleCrypto",
      name: "SubtleCrypto API",
      severity: "warning",
      title: "SubtleCrypto unavailable",
      description:
        "WebCrypto SubtleCrypto is not accessible. This commonly occurs in non-HTTPS environments or legacy browsers.",
      impact: "Certain client-side hashing and cryptographic verification steps may fail.",
      actionableSteps: [
        "Ensure the site is served over HTTPS.",
        "Use a modern desktop or mobile browser.",
        "Continue in Preview Mode if you only need to inspect credentials.",
      ],
      fallbackAvailable: true,
      fallbackModeDescription:
        "Degraded Mode: Advanced crypto features are paused, while read-only credential viewing remains safe.",
      actions: [{ label: "Continue in Preview Mode", type: "preview-mode" }],
    });
  }

  // WebAssembly
  if (!webAssembly) {
    issues.push({
      id: "webAssembly",
      name: "WebAssembly",
      severity: "error",
      title: "WebAssembly not supported",
      description:
        "Zero-knowledge proof verification and generation require WebAssembly to execute Noir and Barretenberg (UltraHonk) circuits.",
      impact:
        "Client-side ZK proof generation and local circuit execution cannot run in this browser.",
      actionableSteps: [
        "Switch to a browser that supports WebAssembly (Chrome, Firefox, Safari, Edge, Brave).",
        "Check that WebAssembly has not been disabled by security extensions or browser flags.",
        "Use Preview Mode to explore credential schemas, verification links, and read-only attributes.",
      ],
      fallbackAvailable: true,
      fallbackModeDescription:
        "ZK Prover Fallback: Proof calculation is disabled; credentials can still be viewed in Preview Mode.",
      actions: [{ label: "Use Preview Mode", type: "preview-mode" }],
    });
  }

  // Web Workers
  if (!webWorker) {
    issues.push({
      id: "webWorker",
      name: "Web Workers",
      severity: "info",
      title: "Web Workers unavailable",
      description:
        "Background Web Worker threads are unavailable or restricted by browser policies.",
      impact:
        "Proving will run inline on the main thread, which may temporarily pause UI animations during proof computation.",
      actionableSteps: [
        "Ensure script execution and workers are permitted by your browser settings.",
        "No action needed: proving automatically falls back to main-thread execution.",
      ],
      fallbackAvailable: true,
      fallbackModeDescription:
        "Main-Thread Fallback: Proving automatically executes inline without crashing.",
    });
  }

  // Storage
  if (!storage) {
    issues.push({
      id: "storage",
      name: "Local Storage",
      severity: "warning",
      title: "Storage access blocked (Private Mode)",
      description:
        "Local storage is disabled or blocked (commonly in private browsing mode or restrictive privacy configurations).",
      impact:
        "Credentials and wallet connection sessions will not persist after reloading or closing the tab.",
      actionableSteps: [
        "Disable strict private browsing or allow storage permissions for this domain.",
        "Export your credentials as JSON or QR code before closing this tab to prevent data loss.",
      ],
      fallbackAvailable: true,
      fallbackModeDescription:
        "In-Memory Session Active: Your session will work normally until the tab is closed.",
    });
  }

  const hasBlockingIssues = issues.some((i) => i.severity === "error");
  const hasDegradedIssues = issues.some((i) => i.severity === "warning");
  const isCompatible = issues.length === 0;

  let summary = "All required browser capabilities are supported.";
  if (hasBlockingIssues) {
    summary =
      "Critical browser capabilities missing: ZK proof or crypto features are unavailable. Use Preview Mode or a modern browser.";
  } else if (hasDegradedIssues) {
    summary =
      "Some browser features are degraded (e.g. storage or HTTPS context). The app remains usable with safe fallbacks.";
  } else if (issues.length > 0) {
    summary = "Minor browser capability notice: Safe fallback modes are active.";
  }

  return {
    isCompatible,
    hasBlockingIssues,
    hasDegradedIssues,
    capabilities: {
      crypto,
      subtleCrypto,
      webAssembly,
      webWorker,
      storage,
      secureContext,
      walletExtension,
      webUsb,
    },
    issues,
    summary,
  };
}

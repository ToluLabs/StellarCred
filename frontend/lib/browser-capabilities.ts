/**
 * Browser capability detection and graceful degradation.
 *
 * This module provides unified detection of browser features required by StellarCred,
 * with clear error messages and fallback behavior for unsupported environments.
 *
 * Features checked:
 * - WebAssembly (required for ZK proof generation via bb.js)
 * - Web Workers (required for off-main-thread proving)
 * - Cross-origin isolation (required for SharedArrayBuffer/multithreading)
 * - localStorage/sessionStorage (required for credential storage)
 * - Web Crypto API (required for cryptographic operations)
 * - BigInt (required for large integer arithmetic)
 *
 * Issue #900: Add graceful degradation for unsupported browser capabilities
 */

export interface CapabilityCheck {
  /** Human-readable name of the capability */
  name: string;
  /** Whether the capability is supported */
  supported: boolean;
  /** Error message explaining why it's not supported (if applicable) */
  error?: string;
  /** Whether this is a critical feature (app cannot function without it) */
  critical: boolean;
  /** Whether graceful degradation is available */
  hasFallback: boolean;
  /** Description of the fallback behavior */
  fallbackDescription?: string;
}

export interface BrowserCapabilities {
  /** All capability checks */
  checks: CapabilityCheck[];
  /** Whether all critical capabilities are supported */
  isFullySupported: boolean;
  /** Whether the browser can at least provide basic functionality */
  hasBasicSupport: boolean;
  /** Summary of unsupported critical features */
  unsupportedCritical: CapabilityCheck[];
}

/**
 * Check WebAssembly support.
 *
 * WebAssembly is required for bb.js (UltraHonk prover).
 * This is a critical feature with no fallback.
 */
function checkWebAssembly(): CapabilityCheck {
  if (typeof WebAssembly === "undefined") {
    return {
      name: "WebAssembly",
      supported: false,
      error: "WebAssembly is not available in this browser",
      critical: true,
      hasFallback: false,
    };
  }

  // Try to validate WebAssembly actually works
  try {
    const module = new WebAssembly.Module(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    if (!(module instanceof WebAssembly.Module)) {
      throw new Error("WebAssembly module instantiation failed");
    }
    return {
      name: "WebAssembly",
      supported: true,
      critical: true,
      hasFallback: false,
    };
  } catch (err) {
    return {
      name: "WebAssembly",
      supported: false,
      error: `WebAssembly is available but initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      critical: true,
      hasFallback: false,
    };
  }
}

/**
 * Check Web Workers support.
 *
 * Web Workers are required for off-main-thread proving.
 * Has a fallback: proving can run on the main thread (slower, may jank UI).
 */
function checkWebWorkers(): CapabilityCheck {
  if (typeof Worker === "undefined") {
    return {
      name: "Web Workers",
      supported: false,
      error: "Web Workers are not available in this browser",
      critical: false,
      hasFallback: true,
      fallbackDescription: "Proof generation will run on the main thread, which may cause UI jank",
    };
  }

  return {
    name: "Web Workers",
    supported: true,
    critical: false,
    hasFallback: true,
  };
}

/**
 * Check cross-origin isolation (COOP/COEP headers).
 *
 * Required for SharedArrayBuffer and multithreaded proving.
 * Has a fallback: can fall back to single-threaded proving.
 */
function checkCrossOriginIsolation(): CapabilityCheck {
  if (typeof globalThis === "undefined") {
    return {
      name: "Cross-origin isolation",
      supported: false,
      error: "Cannot check cross-origin isolation in non-browser environment",
      critical: false,
      hasFallback: true,
      fallbackDescription: "Proving will run in single-threaded mode",
    };
  }

  const isolated = Boolean(globalThis.crossOriginIsolated);
  if (!isolated) {
    return {
      name: "Cross-origin isolation",
      supported: false,
      error: "Cross-origin isolation is not enabled (COOP/COEP headers missing)",
      critical: false,
      hasFallback: true,
      fallbackDescription: "Proving will run in single-threaded mode, which is slower",
    };
  }

  return {
    name: "Cross-origin isolation",
    supported: true,
    critical: false,
    hasFallback: true,
  };
}

/**
 * Check localStorage availability.
 *
 * Required for credential storage.
 * Has a fallback: credentials can be exported/imported manually, but app cannot persist them.
 */
function checkLocalStorage(): CapabilityCheck {
  if (typeof window === "undefined") {
    return {
      name: "localStorage",
      supported: false,
      error: "localStorage is not available in this environment",
      critical: false,
      hasFallback: true,
      fallbackDescription: "Credentials cannot be persisted; you must export and import them manually",
    };
  }

  try {
    const testKey = "__storage_test__";
    window.localStorage.setItem(testKey, "test");
    window.localStorage.removeItem(testKey);
    return {
      name: "localStorage",
      supported: true,
      critical: false,
      hasFallback: true,
    };
  } catch (err) {
    return {
      name: "localStorage",
      supported: false,
      error: `localStorage is blocked (private mode or storage quota exceeded): ${err instanceof Error ? err.message : String(err)}`,
      critical: false,
      hasFallback: true,
      fallbackDescription: "Credentials cannot be persisted; you must export and import them manually",
    };
  }
}

/**
 * Check sessionStorage availability.
 *
 * Used for temporary session data.
 * Has a fallback: some features may not work correctly.
 */
function checkSessionStorage(): CapabilityCheck {
  if (typeof window === "undefined") {
    return {
      name: "sessionStorage",
      supported: false,
      error: "sessionStorage is not available in this environment",
      critical: false,
      hasFallback: true,
      fallbackDescription: "Some session-based features may not work correctly",
    };
  }

  try {
    const testKey = "__session_test__";
    window.sessionStorage.setItem(testKey, "test");
    window.sessionStorage.removeItem(testKey);
    return {
      name: "sessionStorage",
      supported: true,
      critical: false,
      hasFallback: true,
    };
  } catch (err) {
    return {
      name: "sessionStorage",
      supported: false,
      error: `sessionStorage is blocked: ${err instanceof Error ? err.message : String(err)}`,
      critical: false,
      hasFallback: true,
      fallbackDescription: "Some session-based features may not work correctly",
    };
  }
}

/**
 * Check Web Crypto API support.
 *
 * Required for cryptographic operations (signatures, encryption).
 * This is a critical feature with no fallback.
 */
function checkWebCrypto(): CapabilityCheck {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return {
      name: "Web Crypto API",
      supported: false,
      error: "Web Crypto API is not available in this browser",
      critical: true,
      hasFallback: false,
    };
  }

  // Verify critical crypto operations work
  try {
    // Test random number generation
    const array = new Uint8Array(1);
    crypto.getRandomValues(array);

    // Test that we can access subtle crypto
    if (typeof crypto.subtle !== "object") {
      throw new Error("crypto.subtle is not an object");
    }

    return {
      name: "Web Crypto API",
      supported: true,
      critical: true,
      hasFallback: false,
    };
  } catch (err) {
    return {
      name: "Web Crypto API",
      supported: false,
      error: `Web Crypto API is available but operations failed: ${err instanceof Error ? err.message : String(err)}`,
      critical: true,
      hasFallback: false,
    };
  }
}

/**
 * Check BigInt support.
 *
 * Required for large integer arithmetic (field elements, contract values).
 * This is a critical feature with no fallback.
 */
function checkBigInt(): CapabilityCheck {
  if (typeof BigInt === "undefined") {
    return {
      name: "BigInt",
      supported: false,
      error: "BigInt is not available in this browser",
      critical: true,
      hasFallback: false,
    };
  }

  try {
    // Test basic BigInt operations
    const a = BigInt("12345678901234567890");
    const b = BigInt("98765432109876543210");
    const sum = a + b;
    if (typeof sum !== "bigint") {
      throw new Error("BigInt operations failed");
    }
    return {
      name: "BigInt",
      supported: true,
      critical: true,
      hasFallback: false,
    };
  } catch (err) {
    return {
      name: "BigInt",
      supported: false,
      error: `BigInt is available but operations failed: ${err instanceof Error ? err.message : String(err)}`,
      critical: true,
      hasFallback: false,
    };
  }
}

/**
 * Check SharedArrayBuffer support.
 *
 * Required for multithreaded proving with bb.js.
 * Has a fallback: can fall back to single-threaded proving.
 */
function checkSharedArrayBuffer(): CapabilityCheck {
  if (typeof SharedArrayBuffer === "undefined") {
    return {
      name: "SharedArrayBuffer",
      supported: false,
      error: "SharedArrayBuffer is not available (requires cross-origin isolation)",
      critical: false,
      hasFallback: true,
      fallbackDescription: "Proving will run in single-threaded mode",
    };
  }

  return {
    name: "SharedArrayBuffer",
    supported: true,
    critical: false,
    hasFallback: true,
  };
}

/**
 * Run all capability checks and return a comprehensive report.
 */
export function checkBrowserCapabilities(): BrowserCapabilities {
  const checks: CapabilityCheck[] = [
    checkWebAssembly(),
    checkWebWorkers(),
    checkCrossOriginIsolation(),
    checkLocalStorage(),
    checkSessionStorage(),
    checkWebCrypto(),
    checkBigInt(),
    checkSharedArrayBuffer(),
  ];

  const unsupportedCritical = checks.filter((c) => c.critical && !c.supported);
  const isFullySupported = unsupportedCritical.length === 0;

  // Basic support means at least WebAssembly and Web Crypto work
  const hasBasicSupport =
    checks.find((c) => c.name === "WebAssembly")?.supported === true &&
    checks.find((c) => c.name === "Web Crypto API")?.supported === true;

  return {
    checks,
    isFullySupported,
    hasBasicSupport,
    unsupportedCritical,
  };
}

/**
 * Get a user-friendly error message for unsupported browsers.
 */
export function getUnsupportedBrowserMessage(capabilities: BrowserCapabilities): string {
  if (capabilities.isFullySupported) {
    return "";
  }

  const criticalErrors = capabilities.unsupportedCritical
    .map((c) => c.error || `${c.name} is not supported`)
    .join("; ");

  if (criticalErrors) {
    return `Your browser is missing critical features required by StellarCred: ${criticalErrors}. Please use a modern browser like Chrome, Firefox, Safari, or Edge.`;
  }

  const nonCritical = capabilities.checks.filter((c) => !c.critical && !c.supported);
  if (nonCritical.length > 0) {
    const warnings = nonCritical.map((c) => c.name).join(", ");
    return `Some features are not available: ${warnings}. The app will run with reduced functionality.`;
  }

  return "";
}

/**
 * Check if the browser is supported and throw if not.
 * Use this at app initialization to fail fast for unsupported browsers.
 */
export function requireBrowserCapabilities(): void {
  const capabilities = checkBrowserCapabilities();

  if (!capabilities.hasBasicSupport) {
    const message = getUnsupportedBrowserMessage(capabilities);
    throw new Error(message);
  }
}

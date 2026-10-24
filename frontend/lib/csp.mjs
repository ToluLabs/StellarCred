/**
 * @file Content Security Policy builder and nonce generator.
 * Plain JS with JSDoc types so next.config.mjs can import it.
 * Edge-safe: uses only Web Crypto API (crypto.getRandomValues) and btoa.
 */

export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp-endpoint";

/**
 * Resolves the CSP operational mode from an environment variable or config value.
 * Returns "enforce" only when value is exactly the string "enforce" (after .trim().toLowerCase()),
 * and "report-only" for everything else, including undefined and typos.
 *
 * @param {unknown} [value]
 * @returns {"enforce" | "report-only"}
 */
export function resolveCspMode(value) {
  if (typeof value === "string" && value.trim().toLowerCase() === "enforce") {
    return "enforce";
  }
  return "report-only";
}

/**
 * Resolves the frame-ancestors directive value for the embeddable /badge route (#532).
 * Returns the space-separated list of origins if BADGE_ALLOWED_ORIGINS is configured,
 * or "*" to allow embedding from any origin.
 *
 * @param {string} [allowedOrigins] - Comma-separated list of permitted origins.
 * @returns {string} frame-ancestors value (e.g. "*" or "https://example.com https://app.org").
 */
export function resolveBadgeFrameAncestors(allowedOrigins) {
  if (typeof allowedOrigins === "string" && allowedOrigins.trim()) {
    const origins = allowedOrigins
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (origins.length > 0) {
      return origins.join(" ");
    }
  }
  return "*";
}

/**
 * Generates a cryptographically random 16-byte nonce encoded in Base64.
 *
 * @returns {string} Base64-encoded nonce.
 */
export function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * @typedef {Object} BuildCspOptions
 * @property {boolean} [strict=false] - Whether to produce the stricter policy with nonces.
 * @property {string} [nonce] - Nonce for script-src in strict mode.
 * @property {boolean} [walletConnectEnabled=false] - Whether WalletConnect hosts should be permitted.
 * @property {string} [rpcUrl] - Optional custom Soroban RPC URL.
 * @property {string} [indexerUrl] - Optional custom Indexer URL.
 * @property {string} [reportEndpoint] - Optional CSP violation report endpoint URL.
 * @property {string} [frameAncestors] - Optional frame-ancestors value (defaults to 'none' in strict mode).
 */

/**
 * Builds the Content-Security-Policy header string.
 *
 * @param {BuildCspOptions} [options]
 * @returns {string} Content-Security-Policy header value.
 */
export function buildCsp(options = {}) {
  const {
    strict = false,
    nonce,
    walletConnectEnabled = false,
    rpcUrl,
    indexerUrl,
    reportEndpoint,
    frameAncestors,
  } = options;

  if (strict && !nonce) {
    throw new Error("buildCsp: strict mode requires a nonce");
  }

  const wcEnabled = Boolean(walletConnectEnabled);

  // 'wasm-unsafe-eval' in script-src is required for WASM instantiation and
  // is unrelated to cross-origin isolation.
  // In strict mode, do not use 'strict-dynamic', because it would ignore 'self'
  // and complicate the /bb/* and /workers/proof-worker.js loading.
  const scriptSrc = strict
    ? `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`
    : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";

  const csp = [
    "default-src 'self'",
    ...(strict ? [] : ["object-src 'none'", "base-uri 'self'", "form-action 'self'"]),
    scriptSrc,
    // React and Next emit inline style attributes, and nonces can't cover them.
    "style-src 'self' 'unsafe-inline'",
    // Wallet icons for the Stellar Wallets Kit picker: stellar.creit.tech hosts
    // Albedo/Freighter/xBull/Rabet/Lobstr/Hana/Klever/WalletConnect's, storage.herewallet.app
    // hosts HOT Wallet's — needed for every wallet the kit shows, not just WalletConnect,
    // so these two stay unconditional. explorer-api.walletconnect.com is WalletConnect's
    // own wallet list, shown only if its QR pairing screen is opened.
    // Verified against the actual requests the picker modal makes in a real browser
    // (next build && next start), not just package source greps.
    `img-src 'self' data: https://stellar.creit.tech https://storage.herewallet.app${
      wcEnabled ? " https://explorer-api.walletconnect.com" : ""
    }`,
    // contracts.ts ("use client") calls getAccount / prepareTransaction /
    // sendTransaction against the Soroban RPC from the browser — must be
    // allowed here or proof submission and on-chain verification break.
    // The relay/explorer/verify entries are required by lib/wallet.ts's
    // WalletConnectModule — hardcoded by @walletconnect/core and
    // @walletconnect/modal-core, not configurable via env.
    `connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org${
      wcEnabled
        ? " wss://relay.walletconnect.com wss://relay.walletconnect.org https://explorer-api.walletconnect.com https://verify.walletconnect.com https://verify.walletconnect.org"
        : ""
    }${rpcUrl ? " " + rpcUrl : ""}${indexerUrl ? " " + indexerUrl : ""}`,
  ];

  if (wcEnabled) {
    // verify.walletconnect.{com,org} is WalletConnect's domain-verification
    // iframe (loaded by @walletconnect/sign-client); without this it's
    // silently blocked and WalletConnect connect attempts hang.
    csp.push("frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org");
  }

  if (strict) {
    csp.push("object-src 'none'");
    csp.push("base-uri 'self'");
    csp.push("form-action 'self'");
    if (frameAncestors) {
      csp.push(`frame-ancestors ${frameAncestors}`);
    } else {
      csp.push("frame-ancestors 'none'");
    }
    csp.push("worker-src 'self'");
    csp.push("manifest-src 'self'");
  } else if (frameAncestors) {
    csp.push(`frame-ancestors ${frameAncestors}`);
  }

  if (reportEndpoint) {
    csp.push(`report-uri ${reportEndpoint}`);
    csp.push(`report-to ${CSP_REPORT_GROUP}`);
  }

  return csp.join("; ") + ";";
}

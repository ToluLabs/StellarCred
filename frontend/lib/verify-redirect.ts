import { consumeVerifyNonce } from "./verify-nonce";

export interface VerifyRedirectOptions {
  returnUrl?: string | null;
  urlError?: string;
  address?: string | null;
  justIssuedClaims?: string[];
  parsedLink?: {
    ok: boolean;
    jti?: string;
    exp?: number;
  };
  currentOrigin?: string;
  onSetUrlError?: (error: string) => void;
  router: {
    push: (url: string) => void;
  };
  navigation?: {
    setHref: (url: string) => void;
  };
}

export interface ResolvedRedirectTarget {
  kind: "internal" | "external";
  url: string;
}

/**
 * Validates a return URL for redirect safety (#978).
 * Enforces allowed schemes (https only for external, same-origin relative paths),
 * prevents protocol-relative bypasses, userinfo authority tricks, and dangerous schemes.
 */
export function validateReturnUrl(
  rawUrl: string,
  currentOrigin: string,
): { ok: boolean; error?: string; url?: URL } {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { ok: false, error: "Return URL must be a non-empty string." };
  }

  const trimmed = rawUrl.trim();

  // Reject protocol-relative URLs (//attacker.com) and backslash bypasses
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\") || trimmed.startsWith("\\\\")) {
    return {
      ok: false,
      error: "Invalid return URL: Protocol-relative URLs are not permitted.",
    };
  }

  // Reject dangerous schemes
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("file:") ||
    lower.startsWith("blob:")
  ) {
    return { ok: false, error: "Invalid return URL: Unsafe scheme." };
  }

  let dest: URL;
  try {
    if (trimmed.startsWith("/")) {
      dest = new URL(trimmed, currentOrigin);
      if (dest.origin !== new URL(currentOrigin).origin) {
        return {
          ok: false,
          error: "Invalid return URL: Open redirect detected.",
        };
      }
    } else {
      dest = new URL(trimmed);
    }
  } catch {
    return {
      ok: false,
      error: "Invalid return URL: Must be a well-formed URL.",
    };
  }

  let originObj: URL;
  try {
    originObj = new URL(currentOrigin);
  } catch {
    originObj = new URL("http://localhost");
  }

  const isSameOrigin = dest.origin === originObj.origin;
  if (!isSameOrigin && dest.protocol !== "https:") {
    return {
      ok: false,
      error: "Invalid return URL: Must use HTTPS protocol.",
    };
  }

  // Disallow userinfo (e.g. https://good.com@attacker.com)
  if (dest.username || dest.password) {
    return {
      ok: false,
      error: "Invalid return URL: Credentials in URL are forbidden.",
    };
  }

  return { ok: true, url: dest };
}

/**
 * Pure calculation of the redirect destination URL and navigation type.
 * Ensures external URLs strictly require HTTPS and returns an error for invalid protocols or URLs.
 */
export function resolveVerifyRedirect(options: {
  returnUrl?: string | null;
  address?: string | null;
  justIssuedClaims?: string[];
  currentOrigin: string;
}): { target: ResolvedRedirectTarget } | { error: string } | null {
  const { returnUrl, address, justIssuedClaims, currentOrigin } = options;

  if (!returnUrl || !address) {
    return null;
  }

  const validation = validateReturnUrl(returnUrl, currentOrigin);
  if (!validation.ok || !validation.url) {
    return { error: validation.error ?? "Invalid return URL." };
  }

  const dest = validation.url;

  dest.searchParams.set("sc_verified", "true");
  dest.searchParams.set("sc_wallet", address);
  if (justIssuedClaims && justIssuedClaims.length > 0) {
    dest.searchParams.set("sc_claims", justIssuedClaims.join(","));
  }

  let originObj: URL;
  try {
    originObj = new URL(currentOrigin);
  } catch {
    originObj = new URL("http://localhost");
  }

  if (dest.origin === originObj.origin) {
    return {
      target: {
        kind: "internal",
        url: dest.pathname + dest.search,
      },
    };
  }

  return {
    target: {
      kind: "external",
      url: dest.toString(),
    },
  };
}

/**
 * Executes post-issuance redirection:
 * 1. Consumes single-use nonce if present in parsedLink.
 * 2. If valid returnUrl, routes to target (internal via router.push, external via window.location.href).
 *    Never passes external URLs to router.push.
 * 3. Falls back to router.push("/holder").
 */
export function performVerifyRedirect(options: VerifyRedirectOptions): void {
  const {
    returnUrl,
    urlError,
    address,
    justIssuedClaims = [],
    parsedLink,
    currentOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost",
    onSetUrlError,
    router,
    navigation = {
      setHref: (url: string) => {
        if (typeof window !== "undefined") {
          window.location.href = url;
        }
      },
    },
  } = options;

  if (parsedLink?.ok && parsedLink.jti) {
    consumeVerifyNonce(parsedLink.jti, parsedLink.exp ?? 0);
  }

  if (returnUrl && !urlError && address) {
    const resolved = resolveVerifyRedirect({
      returnUrl,
      address,
      justIssuedClaims,
      currentOrigin,
    });

    if (resolved && "target" in resolved) {
      if (resolved.target.kind === "internal") {
        router.push(resolved.target.url);
      } else {
        // Never router.push an external URL - do a real browser navigation.
        navigation.setHref(resolved.target.url);
      }
      return;
    }

    if (resolved && "error" in resolved) {
      onSetUrlError?.(resolved.error);
      router.push("/holder");
      return;
    }
  }

  router.push("/holder");
}

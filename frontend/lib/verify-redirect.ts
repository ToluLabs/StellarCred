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

  let dest: URL;
  try {
    if (returnUrl.startsWith("/")) {
      dest = new URL(returnUrl, currentOrigin);
    } else {
      dest = new URL(returnUrl);
    }
  } catch {
    return { error: "Invalid return URL: Must be a well-formed URL." };
  }

  // Validate protocol for safety: external URLs MUST use https
  if (dest.protocol !== "https:" && dest.origin !== currentOrigin) {
    return { error: "Invalid return URL: Must use HTTPS protocol." };
  }

  dest.searchParams.set("sc_verified", "true");
  dest.searchParams.set("sc_wallet", address);
  if (justIssuedClaims && justIssuedClaims.length > 0) {
    dest.searchParams.set("sc_claims", justIssuedClaims.join(","));
  }

  if (dest.origin === currentOrigin) {
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
        // Never router.push an external URL — do a real browser navigation.
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

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization";

// Endpoints meant for cross-origin integrator consumption (issue #639): the
// capability descriptor carries nothing sensitive and must be readable from
// any origin so the SDK can bootstrap from any site. Unlike the APP_ORIGIN-
// gated paths above, these get a permissive wildcard.
const PUBLIC_CORS_PATHS = ["/api/capabilities"];

export function isPublicCorsPath(pathname: string): boolean {
  return PUBLIC_CORS_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function getPublicCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
  };
}

function getAllowedOrigin(): string {
  const configured = process.env.APP_ORIGIN;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") return "";
  return "http://localhost:3000";
}

export function getCorsHeaders(): Record<string, string> {
  const origin = getAllowedOrigin();
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    Vary: "Origin",
  };
}

export function isOriginAllowed(requestOrigin: string | null): boolean {
  if (!requestOrigin) return false;
  const allowed = getAllowedOrigin();
  if (!allowed) return false;
  return requestOrigin === allowed;
}

/**
 * Pure functions for parsing and sanitizing CSP violation reports.
 * Edge-safe and I/O-free.
 */

const KEYWORDS = new Set(["inline", "eval", "wasm-eval", "self", ""]);
const BARE_TOKEN_REGEX = /^[a-z][a-z0-9+.-]{0,30}$/;

/**
 * Sanitizes a URL or CSP keyword for safe logging.
 *
 * - Keywords inline, eval, wasm-eval, self, and "" are preserved as is.
 * - Bare tokens matching /^[a-z][a-z0-9+.-]{0,30}$/ (e.g. data, blob, https, wss) are preserved as is.
 * - Parseable http/https/ws/wss URLs become origin + pathname only (no query, no hash, no credentials).
 * - Any other scheme (data:, blob:, filesystem:, chrome-extension:, etc.) becomes scheme name only.
 * - Anything unparseable becomes "invalid".
 * - Every result is truncated to 200 characters.
 */
export function sanitizeUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "invalid";
  }

  if (KEYWORDS.has(value) || BARE_TOKEN_REGEX.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ws:" ||
      url.protocol === "wss:"
    ) {
      const sanitized = `${url.origin}${url.pathname}`;
      return sanitized.slice(0, 200);
    }
    const scheme = url.protocol.replace(/:$/, "");
    return scheme.slice(0, 200);
  } catch {
    return "invalid";
  }
}

export interface CspViolation {
  documentUri: string;
  blockedUri: string;
  sourceFile: string;
  effectiveDirective: string;
  disposition: string;
  lineNumber?: number;
  columnNumber?: number;
  statusCode?: number;
}

export function parseDirective(val: unknown): string {
  if (typeof val === "string") {
    const firstToken = val.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (/^[a-z-]{1,64}$/.test(firstToken)) {
      return firstToken;
    }
  }
  return "unknown";
}

function parseDisposition(val: unknown): string {
  if (typeof val === "string") {
    const normalized = val.toLowerCase().trim();
    if (normalized === "report" || normalized === "enforce") {
      return normalized;
    }
  }
  return "unknown";
}

function parseFiniteInt(val: unknown): number | undefined {
  if (typeof val === "number") {
    return Number.isInteger(val) && Number.isFinite(val) ? val : undefined;
  }
  if (typeof val === "string" && /^-?\d+$/.test(val.trim())) {
    const num = Number(val.trim());
    return Number.isSafeInteger(num) ? num : undefined;
  }
  return undefined;
}

/**
 * Extracts and sanitizes violation fields from a report object.
 */
function extractViolation(
  raw: Record<string, unknown>,
  fallbackUrl?: unknown,
): CspViolation {
  const docUri =
    raw["documentURL"] ??
    raw["document-uri"] ??
    raw["documentUri"] ??
    fallbackUrl;
  const blockedUri =
    raw["blockedURL"] ?? raw["blocked-uri"] ?? raw["blockedUri"];
  const sourceFile = raw["sourceFile"] ?? raw["source-file"];
  const directive =
    raw["effectiveDirective"] ??
    raw["effective-directive"] ??
    raw["violatedDirective"] ??
    raw["violated-directive"];
  const disposition = raw["disposition"];
  const line = raw["lineNumber"] ?? raw["line-number"];
  const column = raw["columnNumber"] ?? raw["column-number"];
  const status = raw["statusCode"] ?? raw["status-code"];

  const violation: CspViolation = {
    documentUri: sanitizeUrl(docUri),
    blockedUri: sanitizeUrl(blockedUri),
    sourceFile: sanitizeUrl(sourceFile),
    effectiveDirective: parseDirective(directive),
    disposition: parseDisposition(disposition),
  };

  const lineNum = parseFiniteInt(line);
  if (lineNum !== undefined) violation.lineNumber = lineNum;

  const colNum = parseFiniteInt(column);
  if (colNum !== undefined) violation.columnNumber = colNum;

  const statusNum = parseFiniteInt(status);
  if (statusNum !== undefined) violation.statusCode = statusNum;

  return violation;
}

/**
 * Normalizes CSP violation reports from either Legacy or Reporting API format.
 * Returns at most 10 sanitized entries. Never throws on garbage input.
 */
export function normalizeReports(payload: unknown): CspViolation[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  try {
    if (Array.isArray(payload)) {
      const results: CspViolation[] = [];
      for (const item of payload) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        if (entry.type !== "csp-violation") continue;

        const body =
          typeof entry.body === "object" && entry.body !== null
            ? (entry.body as Record<string, unknown>)
            : {};

        results.push(extractViolation(body, entry.url));
        if (results.length >= 10) break;
      }
      return results;
    }

    if ("csp-report" in payload) {
      const report = (payload as Record<string, unknown>)["csp-report"];
      if (!report || typeof report !== "object" || Array.isArray(report)) {
        return [];
      }
      return [extractViolation(report as Record<string, unknown>)];
    }

    return [];
  } catch {
    return [];
  }
}

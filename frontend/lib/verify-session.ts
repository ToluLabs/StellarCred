/**
 * One id per verify session, sent as `x-request-id` on every /api/issue and
 * /api/plaid-balance call so server logs for a single issuance — including
 * across the Persona redirect round-trip — can be correlated together.
 */
export function getOrCreateRequestId(): string {
  if (typeof window === "undefined") return "";
  const KEY = "sc_request_id";
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = window.crypto?.randomUUID
        ? window.crypto.randomUUID()
        : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }
}

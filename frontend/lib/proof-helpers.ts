import type { Credential } from "./credential";

// ── Credential expiry helpers ─────────────────────────────────────────────────

/** Parse "90 days", "30 days" etc from the credential's expiry string. */
export function credTtlSecs(cred: Credential): number {
  const match = cred.expiry?.match(/(\d+)/);
  return (match ? parseInt(match[1]) : 30) * 86_400;
}

export function proofStatus(cred: Credential): "unproved" | "proved" | "expired" {
  if (!cred.provedAt) return "unproved";
  return cred.provedAt + credTtlSecs(cred) > Math.floor(Date.now() / 1000)
    ? "proved"
    : "expired";
}

export function isExpiringSoon(cred: Credential, windowDays = 7): boolean {
  if (!cred.provedAt) return false;
  const now = Math.floor(Date.now() / 1000);
  const expiry = cred.provedAt + credTtlSecs(cred);
  return expiry > now && expiry <= now + windowDays * 86_400;
}

export function daysRemaining(cred: Credential): number {
  if (!cred.provedAt) return 0;
  const secsLeft = cred.provedAt + credTtlSecs(cred) - Math.floor(Date.now() / 1000);
  return Math.max(0, Math.ceil(secsLeft / 86_400));
}

export function credExpiryTimestamp(cred: Credential): number {
  return cred.issuedAt + credTtlSecs(cred);
}

export function credIsExpired(cred: Credential): boolean {
  return credExpiryTimestamp(cred) <= Math.floor(Date.now() / 1000);
}

export function credExpiryWithinDays(cred: Credential, days: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const ts = credExpiryTimestamp(cred);
  return ts > now && ts <= now + days * 86_400;
}

export function formatExpiryDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

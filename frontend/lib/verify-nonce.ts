/**
 * lib/verify-nonce.ts
 *
 * Single-use enforcement for verify links carrying a `jti` (JWT-style token id).
 *
 * Stateless across tabs: the token id + its expiry are stored in sessionStorage
 * the first time the link is opened. Any subsequent open of the same `jti` in
 * the same browser session is rejected — mirroring the MemoryChallengeStore
 * pattern in @stellarcred/sdk (challenge.ts), but keyed per-browser-session
 * rather than in server memory.
 */

const KEY = "sc_verify_consumed";

interface ConsumedEntry {
  consumedAt: number;
  expiresAt: number;
}

type ConsumedMap = Record<string, ConsumedEntry>;

function readMap(): ConsumedMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ConsumedMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: ConsumedMap): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage full / disabled — fail open, verification still proceeds */
  }
}

export function pruneConsumed(
  map: ConsumedMap,
  nowSeconds: number,
): ConsumedMap {
  const next: ConsumedMap = {};
  for (const [jti, entry] of Object.entries(map)) {
    if (entry.expiresAt === 0 || entry.expiresAt > nowSeconds) {
      next[jti] = entry;
    }
  }
  return next;
}

export function isVerifyNonceConsumed(
  jti: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!jti) return false;
  const map = pruneConsumed(readMap(), nowSeconds);
  writeMap(map);
  return Object.prototype.hasOwnProperty.call(map, jti);
}

export function consumeVerifyNonce(
  jti: string,
  expiresAt: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!jti) return true;
  const map = pruneConsumed(readMap(), nowSeconds);
  if (Object.prototype.hasOwnProperty.call(map, jti)) {
    writeMap(map);
    return false;
  }
  map[jti] = { consumedAt: nowSeconds, expiresAt: expiresAt || 0 };
  writeMap(map);
  return true;
}

export function __clearVerifyNoncesForTesting(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

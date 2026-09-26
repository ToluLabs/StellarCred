// Local proof caching / reuse.
//
// Generating a proof is the most expensive step in the holder flow (server-side
// witness + browser WASM UltraHonk). If a holder already produced a valid proof
// for an unchanged credential, re-proving wastes time and compute. We cache the
// generated proof bytes locally and reuse them when everything that affects the
// proof is still identical.
//
// A proof is a pure function of:
//   - the credential commitment (itself derived from type, value, salt, issuer)
//   - the claim parameters baked into the credential (thresholds / restricted)
//   - the circuit / verification-key version the proof was generated with
//
// So a cache entry is keyed by exactly those three things. We only reuse an
// entry when it still matches the on-chain record (unexpired, not revoked),
// and we invalidate it on expiry, revocation, VK version change, or any change
// to the claim parameters.

import type { Credential } from "./credential";
import type { CircuitArtifact } from "./proof";

export interface ProofCacheEntry {
  /** Deterministic cache key (see {@link buildProofKey}). */
  key: string;
  type: string;
  commitment: string;
  /** Canonicalised claim params that were part of the proof. */
  claimParams?: Credential["claimParams"];
  /** Circuit / VK version the proof was generated against. */
  vkVersion: string;
  /** Proof bytes stored as a JSON-safe number[] (Uint8Array isn't JSON-safe). */
  proof: number[];
  /** Public inputs stored as a JSON-safe number[]. */
  publicInputs: number[];
  /** Unix ms when the entry was created. */
  createdAt: number;
  /** Unix seconds when this proof was last submitted on-chain. */
  provedAt?: number;
  /** Validity window (seconds) after provedAt while the on-chain record lives. */
  ttlSecs?: number;
  /** Set when the on-chain record was observed revoked/expired — never reuse. */
  revoked?: boolean;
}

const CACHE_KEY = "stellarcred:proof-cache";
const MAX_ENTRIES = 50;

/**
 * The advertised circuit/VK version for cached proofs. We derive it from the
 * actual circuit bytecode at write time (see {@link resolveVkVersion}), so a
 * bumped circuit automatically invalidates every cached proof — but callers can
 * also compare against this constant when the artifact isn't fetchable.
 */
export const DEFAULT_VK_VERSION = "circuit-v1";

// --------------------------------------------------------------------------- //
// Keying
// --------------------------------------------------------------------------- //

/** Keep a stable object shape so the JSON key is order-independent. */
function canonicalClaimParams(p?: Credential["claimParams"]): Credential["claimParams"] | undefined {
  if (!p) return undefined;
  const out: Credential["claimParams"] = {};
  if (p.threshold_years !== undefined) out.threshold_years = p.threshold_years;
  if (p.threshold !== undefined) out.threshold = p.threshold;
  if (p.restricted) out.restricted = [...p.restricted].sort();
  return out;
}

/**
 * Build the deterministic cache key for a credential. Everything that
 * influences the proof output is included, so any change to the type,
 * commitment, claim params, or VK version yields a different key and therefore
 * a cache miss (i.e. the old proof is invalidated and a new one is generated).
 */
export function buildProofKey(input: {
  type: string;
  commitment: string;
  claimParams?: Credential["claimParams"];
  vkVersion: string;
}): string {
  return JSON.stringify({
    type: input.type,
    commitment: input.commitment,
    claimParams: canonicalClaimParams(input.claimParams),
    vkVersion: input.vkVersion,
  });
}

// --------------------------------------------------------------------------- //
// Storage
// --------------------------------------------------------------------------- //

export interface ProofCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): ProofCacheStorage | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  return window.localStorage;
}

export function loadProofCache(storage?: ProofCacheStorage | null): ProofCacheEntry[] {
  const store = storage ?? defaultStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ProofCacheEntry[];
  } catch {
    return [];
  }
}

function persistProofCache(entries: ProofCacheEntry[], storage?: ProofCacheStorage | null): void {
  const store = storage ?? defaultStorage();
  if (!store) return;
  try {
    store.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage can be full or unavailable (private mode) — caching is
    // best-effort and never blocks proving.
  }
}

// --------------------------------------------------------------------------- //
// Read / write
// --------------------------------------------------------------------------- //

/**
 * Whether a matching cached entry is still usable, i.e. not invalidated by
 * expiry, revocation, an on-chain record that is no longer valid, or a proof
 * that predates the current validity window.
 */
export function cacheEntryUsable(
  entry: ProofCacheEntry,
  opts: {
    /** Unix seconds "now"; defaults to Date.now()/1000. */
    now?: number;
    /**
     * When false the on-chain record is gone/invalid/revoked, so the cached
     * proof must not be reused even though the bytes would still verify.
     */
    onChainStillValid?: boolean;
  } = {},
): boolean {
  if (entry.revoked) return false;
  if (opts.onChainStillValid === false) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (entry.provedAt !== undefined && entry.ttlSecs !== undefined) {
    if (now > entry.provedAt + entry.ttlSecs) return false; // expired on-chain
  }
  return true;
}

/**
 * Look up a usable proof for the exact cache key. Returns the entry (for reuse)
 * or null. A structurally-matching but no-longer-usable entry is removed so it
 * doesn't shadow a fresh proof later.
 */
export function getCachedProof(
  key: string,
  opts: {
    onChainStillValid?: boolean;
  } = {},
  storage?: ProofCacheStorage | null,
): ProofCacheEntry | null {
  const entries = loadProofCache(storage);
  const idx = entries.findIndex((e) => e.key === key);
  if (idx === -1) return null;
  const entry = entries[idx];
  if (!cacheEntryUsable(entry, { onChainStillValid: opts.onChainStillValid })) {
    const next = [...entries.slice(0, idx), ...entries.slice(idx + 1)];
    persistProofCache(next, storage);
    return null;
  }
  return entry;
}

/** Store a freshly generated proof under the given key. */
export function saveProof(
  key: string,
  data: {
    type: string;
    commitment: string;
    claimParams?: Credential["claimParams"];
    vkVersion: string;
    proof: Uint8Array;
    publicInputs: Uint8Array;
  },
  storage?: ProofCacheStorage | null,
): void {
  const entries = loadProofCache(storage);
  const next: ProofCacheEntry = {
    key,
    type: data.type,
    commitment: data.commitment,
    claimParams: canonicalClaimParams(data.claimParams),
    vkVersion: data.vkVersion,
    proof: Array.from(data.proof),
    publicInputs: Array.from(data.publicInputs),
    createdAt: Date.now(),
  };
  // Keep a single entry per key (replace any stale one) and cap total size.
  const withoutKey = entries.filter((e) => e.key !== key);
  const next_ = [next, ...withoutKey].slice(0, MAX_ENTRIES);
  persistProofCache(next_, storage);
}

/**
 * Record that a cached proof was successfully submitted on-chain, so its
 * validity window is tracked and it can be reused until it expires.
 */
export function markProofProved(
  key: string,
  opts: { ttlSecs: number },
  storage?: ProofCacheStorage | null,
): void {
  const entries = loadProofCache(storage);
  const next = entries.map((e) =>
    e.key === key
      ? { ...e, provedAt: Math.floor(Date.now() / 1000), ttlSecs: opts.ttlSecs, revoked: false }
      : e,
  );
  persistProofCache(next, storage);
}

/** Invalidate (remove) the cached proof for a given key — e.g. on revocation. */
export function invalidateProof(key: string, storage?: ProofCacheStorage | null): void {
  const entries = loadProofCache(storage);
  const next = entries.filter((e) => e.key !== key);
  persistProofCache(next, storage);
}

/** Remove every cached proof belonging to a credential commitment. */
export function removeCredentialProofs(commitment: string, storage?: ProofCacheStorage | null): void {
  const entries = loadProofCache(storage);
  const next = entries.filter((e) => e.commitment !== commitment);
  persistProofCache(next, storage);
}

// --------------------------------------------------------------------------- //
// VK version resolution
// --------------------------------------------------------------------------- //

/**
 * Derive the VK version from the actual circuit artifact being used. Because
 * the verification key is deterministic from the compiled circuit bytecode, a
 * change in the deployed circuit (or toolchain) changes the bytecode and thus
 * this version — which automatically invalidates every cached proof that was
 * generated against any earlier circuit.
 */
export async function resolveVkVersion(type: string): Promise<string> {
  try {
    const res = await fetch(`/circuits/${type}.json`);
    if (!res.ok) return DEFAULT_VK_VERSION;
    const artifact = (await res.json()) as Partial<CircuitArtifact>;
    const bytecode = artifact?.bytecode;
    if (!bytecode) return DEFAULT_VK_VERSION;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(bytecode)),
    );
    // A short, stable, comparable fingerprint of the circuit.
    return "circuit-" + bytesToHex(new Uint8Array(digest).slice(0, 8));
  } catch {
    // Circuit not reachable — fall back to the build-time version marker so we
    // still try a cache hit rather than throwing away the optimisation.
    return DEFAULT_VK_VERSION;
  }
}

export function bytesToHex(u8: Uint8Array): string {
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Rehydrate a cached entry into the shape the submission path expects. */
export function entryToGeneratedProof(entry: ProofCacheEntry): {
  proof: Uint8Array;
  publicInputs: Uint8Array;
} {
  return {
    proof: Uint8Array.from(entry.proof),
    publicInputs: Uint8Array.from(entry.publicInputs),
  };
}
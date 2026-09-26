"use client";

// Selective disclosure presets (#386): a holder-defined, named bundle of
// claim types (+ optional thresholds) — e.g. "Investor onboarding" meaning
// kyc + accreditation + jurisdiction — generated once and shared as a deep
// link a protocol can verify in one call via the SDK's `verifyPreset`.
//
// Presets carry no secret material (no salt/commitment/witness — just claim
// type names and public thresholds), unlike `credential.ts`'s stored
// credentials, so there is nothing here that needs encryption-at-rest beyond
// the same-origin isolation localStorage already provides.

import { safeGetItem, safeSetItem } from "./safe-storage";
// Presets are typed against the SDK's own `ClaimType`, not the app's wider
// `CredentialType` (stellar.ts) — the SDK's `hasClaim`/`hasClaims` (and so
// `verifyPreset`) only know how to check the types in `CLAIM_TYPES`
// (currently missing "employment"), so a preset built from a broader type
// set could name a claim nothing could ever verify.
import { CLAIM_TYPES, type ClaimType } from "@stellarcred/sdk";

export interface PresetClaim {
  type: ClaimType;
  /** Same semantics as the SDK's `ClaimOptions.minThreshold` — omit for a binary claim. */
  minThreshold?: number;
}

export interface Preset {
  id: string;
  name: string;
  claims: PresetClaim[];
  createdAt: number;
}

export const PRESETS_STORAGE_KEY = "stellarcred:presets";

export function loadPresets(): Preset[] {
  try {
    const raw = safeGetItem(PRESETS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Preset[]) : [];
  } catch {
    return [];
  }
}

function persist(next: Preset[]): Preset[] {
  try {
    safeSetItem(PRESETS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode / quota exceeded) — in-memory value
    // is still returned so the UI stays consistent for this session, same
    // fallback credential.ts's saveCredential uses.
  }
  return next;
}

/**
 * Create or update a preset. Passing an existing `id` overwrites that
 * preset in place (used for editing); omitting it creates a new one.
 */
export function savePreset(input: {
  id?: string;
  name: string;
  claims: PresetClaim[];
}): Preset[] {
  const all = loadPresets();
  const id = input.id ?? crypto.randomUUID();
  const existing = all.find((p) => p.id === id);
  const preset: Preset = {
    id,
    name: input.name,
    claims: input.claims,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  return persist([preset, ...all.filter((p) => p.id !== id)]);
}

export function removePreset(id: string): Preset[] {
  return persist(loadPresets().filter((p) => p.id !== id));
}

// ---- Shareable deep link ---------------------------------------------------
// Encodes only the (type, minThreshold) list, not the id/name/createdAt — a
// verifier only needs to know what to check, not how the holder filed it
// locally. Compact form: "kyc,age:21,funds:50000".

export function encodePresetClaims(claims: readonly PresetClaim[]): string {
  return claims
    .map((c) => (c.minThreshold !== undefined ? `${c.type}:${c.minThreshold}` : c.type))
    .join(",");
}

/**
 * Decode a `?c=` query value back into a claim list. Untrusted input (it
 * arrives via a URL a third party could hand-craft): unrecognised credential
 * types and non-finite thresholds are silently dropped rather than thrown,
 * so a malformed or tampered link degrades to "fewer claims checked" instead
 * of crashing the verify page.
 */
export function decodePresetClaims(encoded: string): PresetClaim[] {
  const validTypes: readonly string[] = CLAIM_TYPES;
  const claims: PresetClaim[] = [];
  for (const raw of encoded.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const [type, thresholdRaw] = entry.split(":");
    if (!type || !validTypes.includes(type)) continue;
    const claim: PresetClaim = { type: type as ClaimType };
    if (thresholdRaw !== undefined && thresholdRaw !== "") {
      const n = Number(thresholdRaw);
      if (Number.isFinite(n)) claim.minThreshold = n;
    }
    claims.push(claim);
  }
  return claims;
}

/** Build the shareable `/verify-preset` deep link for a preset. */
export function buildPresetShareUrl(
  baseUrl: string,
  name: string,
  claims: readonly PresetClaim[],
): string {
  const url = new URL("/verify-preset", baseUrl);
  url.searchParams.set("name", name);
  url.searchParams.set("c", encodePresetClaims(claims));
  return url.toString();
}

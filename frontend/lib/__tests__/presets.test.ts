import { describe, it, expect, beforeEach, vi } from "vitest";

// This test environment's window.localStorage is non-functional (every
// method is `undefined` — a pre-existing jsdom/vitest quirk, also hit by
// credential-sync.test.ts and confirmed present on a clean checkout, not
// something introduced here). safe-storage.ts's real implementation just
// wraps window.localStorage, so it can't be exercised through it in this
// environment either — mock it with a plain in-memory store instead, which
// tests presets.ts's own CRUD/encoding logic without depending on jsdom's
// storage support.
const memoryStore = new Map<string, string>();
vi.mock("../safe-storage", () => ({
  safeGetItem: (key: string) => memoryStore.get(key) ?? null,
  safeSetItem: (key: string, value: string) => {
    memoryStore.set(key, value);
  },
  safeRemoveItem: (key: string) => {
    memoryStore.delete(key);
  },
}));

const {
  loadPresets,
  savePreset,
  removePreset,
  encodePresetClaims,
  decodePresetClaims,
  buildPresetShareUrl,
  PRESETS_STORAGE_KEY,
} = await import("../presets");
type PresetClaim = import("../presets").PresetClaim;

beforeEach(() => {
  memoryStore.delete(PRESETS_STORAGE_KEY);
});

describe("preset CRUD", () => {
  it("returns an empty list before anything is saved", () => {
    expect(loadPresets()).toEqual([]);
  });

  it("saves a new preset and lists it newest-first", () => {
    savePreset({ name: "Investor onboarding", claims: [{ type: "kyc" }] });
    savePreset({ name: "Age gate", claims: [{ type: "age", minThreshold: 21 }] });

    const all = loadPresets();
    expect(all).toHaveLength(2);
    expect(all[0]!.name).toBe("Age gate");
    expect(all[1]!.name).toBe("Investor onboarding");
    expect(all[0]!.id).toBeTruthy();
    expect(all[0]!.createdAt).toBeGreaterThan(0);
  });

  it("overwrites in place when saving with an existing id, preserving createdAt", () => {
    const [first] = savePreset({ name: "Original", claims: [{ type: "kyc" }] });
    const originalCreatedAt = first!.createdAt;

    const updated = savePreset({
      id: first!.id,
      name: "Renamed",
      claims: [{ type: "kyc" }, { type: "age", minThreshold: 18 }],
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]!.name).toBe("Renamed");
    expect(updated[0]!.claims).toHaveLength(2);
    expect(updated[0]!.createdAt).toBe(originalCreatedAt);
  });

  it("removes a preset by id, leaving the others untouched", () => {
    const [b] = savePreset({ name: "B", claims: [{ type: "age" }] });
    savePreset({ name: "A", claims: [{ type: "kyc" }] });

    const remaining = removePreset(b!.id);
    expect(remaining.map((p) => p.name)).toEqual(["A"]);
  });
});

describe("preset claim encode/decode", () => {
  it("round-trips binary and thresholded claims", () => {
    const claims: PresetClaim[] = [
      { type: "kyc" },
      { type: "age", minThreshold: 21 },
      { type: "funds", minThreshold: 50000 },
    ];
    const encoded = encodePresetClaims(claims);
    expect(encoded).toBe("kyc,age:21,funds:50000");
    expect(decodePresetClaims(encoded)).toEqual(claims);
  });

  it("drops unrecognised credential types from untrusted input", () => {
    expect(decodePresetClaims("kyc,not-a-real-type,age:21")).toEqual([
      { type: "kyc" },
      { type: "age", minThreshold: 21 },
    ]);
  });

  it("drops a non-finite threshold but keeps the claim type as binary", () => {
    expect(decodePresetClaims("age:not-a-number")).toEqual([{ type: "age" }]);
  });

  it("ignores empty segments (trailing/duplicate commas)", () => {
    expect(decodePresetClaims("kyc,,age:21,")).toEqual([
      { type: "kyc" },
      { type: "age", minThreshold: 21 },
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(decodePresetClaims("")).toEqual([]);
  });
});

describe("buildPresetShareUrl", () => {
  it("encodes the name and claim list as query params on /verify-preset", () => {
    const url = buildPresetShareUrl("https://stellarcred.xyz", "Investor onboarding", [
      { type: "kyc" },
      { type: "accreditation", minThreshold: 1000000 },
    ]);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/verify-preset");
    expect(parsed.searchParams.get("name")).toBe("Investor onboarding");
    expect(parsed.searchParams.get("c")).toBe("kyc,accreditation:1000000");
  });
});

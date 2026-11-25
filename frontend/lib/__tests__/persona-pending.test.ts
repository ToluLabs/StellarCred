import { describe, it, expect, beforeEach, vi } from "vitest";
// lib/wallet pulls in @stellar/freighter-api, a CJS module vitest can't load
// as ESM; these tests never reach a signing path.
vi.mock("../wallet", () => ({ signTx: vi.fn() }));

import {
  PERSONA_PENDING_KEY,
  PII_KEYS,
  savePersonaPending,
  loadPersonaPending,
  clearPersonaPending,
  clearStalePersonaPending,
  type PersonaPendingPayload,
} from "../persona-pending";

const basePayload: PersonaPendingPayload = {
  credential_types: ["kyc"],
  holder: "GHOLDER123",
  issuerId: "GISSUER456",
  issuerName: "StellarCred Authority",
  expiry: "2026-12-31T00:00:00Z",
  claimParams: { thresholdYears: "18", mode: "any" },
};

/** Recursively collect every object key present anywhere in parsed JSON. */
function allKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)]);
}

function storedBlob(): Record<string, unknown> {
  const raw = sessionStorage.getItem(PERSONA_PENDING_KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as Record<string, unknown>;
}

describe("savePersonaPending", () => {
  beforeEach(() => sessionStorage.clear());

  it("stores only resume-relevant fields", () => {
    savePersonaPending(basePayload);
    const blob = storedBlob();
    expect(Object.keys(blob).sort()).toEqual(
      ["claimParams", "credential_types", "expiry", "holder", "issuerId", "issuerName"].sort(),
    );
  });

  it("strips PII keys at any depth, even nested inside claimParams", () => {
    // Simulate a caller accidentally passing identity data alongside the
    // resume fields — the sanitizer must strip it, not store or throw.
    const maliciousPayload = {
      ...basePayload,
      claimParams: { ...basePayload.claimParams, nested: { first_name: "Ada", ok: 1 } },
      attributes: { date_of_birth: "1990-01-01", country_code: "US" },
    } as unknown as PersonaPendingPayload;
    savePersonaPending(maliciousPayload);

    const blob = storedBlob();
    const serialized = JSON.stringify(blob);
    for (const key of PII_KEYS) {
      expect(allKeys(blob)).not.toContain(key);
      // Belt-and-braces: not even as a string value anywhere in the blob.
      expect(serialized).not.toContain(`"${key}"`);
    }
    // Legitimate sibling keys survive the strip.
    expect(blob.claimParams).toMatchObject({ thresholdYears: "18", nested: { ok: 1 } });
  });

  it("drops unknown extra keys instead of persisting them", () => {
    // Simulate a caller smuggling an extra key past the type system.
    const leakedPayload = {
      ...basePayload,
      id_number: "X1234567",
    } as unknown as PersonaPendingPayload;
    savePersonaPending(leakedPayload);
    // id_number was passed but is not in the whitelist, so it should not appear.
    expect(JSON.stringify(storedBlob())).not.toContain("id_number");
  });

  it("strips a PII key that would reach claimParams directly instead of storing it", () => {
    savePersonaPending({
      ...basePayload,
      claimParams: { country_code: "US", mode: "all" },
    });
    const blob = storedBlob();
    expect(JSON.stringify(blob)).not.toContain("country_code");
    expect(blob.claimParams).toEqual({ mode: "all" });
  });
});

describe("loadPersonaPending / cleanup", () => {
  beforeEach(() => sessionStorage.clear());

  it("clears the blob on read, so nothing lingers after success or failure", () => {
    savePersonaPending(basePayload);
    expect(loadPersonaPending()).toEqual(basePayload);
    expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).toBeNull();
    // Second read sees nothing — the blob cannot be replayed.
    expect(loadPersonaPending()).toBeNull();
  });

  it("drops a corrupted blob instead of throwing", () => {
    sessionStorage.setItem(PERSONA_PENDING_KEY, "{not json");
    expect(loadPersonaPending()).toBeNull();
    expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).toBeNull();
  });

  it("re-strips a legacy blob that somehow contains PII (defensive)", () => {
    sessionStorage.setItem(
      PERSONA_PENDING_KEY,
      JSON.stringify({ ...basePayload, attributes: { income: 5 } }),
    );
    const loaded = loadPersonaPending();
    expect(loaded).not.toBeNull();
    expect(loaded).not.toHaveProperty("attributes");
    expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).toBeNull();
  });

  it("clearPersonaPending removes any lingering blob", () => {
    savePersonaPending(basePayload);
    clearPersonaPending();
    expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).toBeNull();
  });

  it("clearStalePersonaPending wipes abandonment (no inquiry id) but keeps an active flow's blob", () => {
    savePersonaPending(basePayload);
    clearStalePersonaPending(false);
    expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).toBeNull();

    savePersonaPending(basePayload);
    clearStalePersonaPending(true);
    expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).not.toBeNull();
  });
});

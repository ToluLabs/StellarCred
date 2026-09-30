import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Circuit version identity (#633) has three moving parts that must never
// disagree: circuits/circuit-versions.json (the source of truth), the compiled
// artifacts served to the browser (stamped by the build), and the app-side
// registry in lib/circuit-versions.ts (used to stamp and check credentials).
// The first group of tests pins that agreement; the rest cover the behaviour.

import {
  CIRCUIT_VERSIONS,
  CircuitVersionMismatchError,
  assertCredentialCircuitCompatible,
  circuitVersionFor,
  circuitVersionMismatchMessage,
  circuitVersionStampFor,
  witnessCircuitVersionMismatch,
} from "../circuit-versions";
import { CREDENTIAL_TYPES } from "../stellar";
import { parseCredential } from "../credential";
import { computeWitness } from "../proof";
import kycArtifact from "../../public/circuits/kyc.json";
import ageArtifact from "../../public/circuits/age.json";
import incomeArtifact from "../../public/circuits/income.json";
import jurisdictionArtifact from "../../public/circuits/jurisdiction.json";
import fundsArtifact from "../../public/circuits/funds.json";
import accreditationArtifact from "../../public/circuits/accreditation.json";
import employmentArtifact from "../../public/circuits/employment.json";
import aggregateArtifact from "../../public/circuits/aggregate.json";

// The manifest lives above the frontend package (circuits/circuit-versions.json).
// Vitest runs with the frontend package as its root, so the repo is one level up.
const REPO_ROOT = path.resolve(process.cwd(), "..");
const manifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "circuits/circuit-versions.json"), "utf8"),
) as { circuits: Record<string, { version: string; vkVersion: number }> };

/** The compiled artifacts the app actually serves, imported as the app does. */
const ARTIFACTS: Record<string, StampedArtifact> = {
  kyc: kycArtifact,
  age: ageArtifact,
  income: incomeArtifact,
  jurisdiction: jurisdictionArtifact,
  funds: fundsArtifact,
  accreditation: accreditationArtifact,
  employment: employmentArtifact,
  aggregate: aggregateArtifact,
};

interface StampedArtifact {
  bytecode: string;
  circuit_version?: string;
  circuit_vk_version?: number;
}

describe("circuit version registry", () => {
  it("has a declared circuit for every credential type", () => {
    for (const type of CREDENTIAL_TYPES) {
      expect(circuitVersionFor(type), type).not.toBeNull();
    }
  });

  it("covers the aggregate circuit, which is not a credential type", () => {
    expect(circuitVersionFor("aggregate")).not.toBeNull();
  });

  it("returns null for a type this build cannot prove", () => {
    expect(circuitVersionFor("nonsense")).toBeNull();
    // Prototype keys must not resolve to a version.
    expect(circuitVersionFor("toString")).toBeNull();
    expect(circuitVersionFor("constructor")).toBeNull();
  });

  it("uses semantic versions and VK counters of at least 1", () => {
    // 0 is the on-chain "version not stored" sentinel and can never be
    // registered, so it must never appear here.
    for (const [type, { version, vkVersion }] of Object.entries(CIRCUIT_VERSIONS)) {
      expect(version, type).toMatch(/^\d+\.\d+\.\d+$/);
      expect(vkVersion, type).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(vkVersion), type).toBe(true);
    }
  });

  it("agrees with circuits/circuit-versions.json", () => {
    // The manifest is authoritative; this table is its mirror. A bump applied
    // to only one of them would let a credential claim compatibility with a
    // circuit that is not the one being served.
    const byType: Record<string, { version: string; vkVersion: number }> = {};
    for (const [name, entry] of Object.entries(manifest.circuits)) {
      byType[name.replace(/_proof$/, "")] = entry;
    }
    // Only the circuits the app actually serves are mirrored here — the
    // manifest also tracks helper circuits (range, set_membership) that are
    // built but not wired into the holder flow.
    for (const type of Object.keys(ARTIFACTS)) {
      expect(byType[type], `manifest entry for ${type}`).toBeDefined();
      expect(CIRCUIT_VERSIONS[type as keyof typeof CIRCUIT_VERSIONS], type).toEqual(byType[type]);
    }
  });

  it("agrees with the version stamped into every compiled artifact", () => {
    for (const [type, artifact] of Object.entries(ARTIFACTS)) {
      const declared = CIRCUIT_VERSIONS[type as keyof typeof CIRCUIT_VERSIONS];
      expect(artifact.bytecode, `${type} bytecode`).toBeTruthy();
      expect(artifact.circuit_version, `${type} artifact circuit_version`).toBe(
        declared.version,
      );
      expect(artifact.circuit_vk_version, `${type} artifact circuit_vk_version`).toBe(
        declared.vkVersion,
      );
    }
  });

  it("stamps the declared version onto a newly issued credential", () => {
    expect(circuitVersionStampFor("kyc")).toEqual({ circuitVersion: "1.0.0", circuitVkVersion: 1 });
    // An unknown type gets no stamp rather than a wrong one.
    expect(circuitVersionStampFor("nonsense")).toEqual({});
  });
});

describe("circuitVersionMismatchMessage", () => {
  it("returns null when the recorded version is the one we serve", () => {
    expect(circuitVersionMismatchMessage("kyc", "1.0.0")).toBeNull();
  });

  it("returns null for a credential that predates circuit versioning", () => {
    // These must keep proving: the version field was introduced after
    // credentials were already in holders' wallets, and absence is not a
    // mismatch.
    expect(circuitVersionMismatchMessage("kyc", undefined)).toBeNull();
    expect(circuitVersionMismatchMessage("age", "")).toBeNull();
    expect(circuitVersionMismatchMessage("funds", 42)).toBeNull();
    expect(circuitVersionMismatchMessage("income", {})).toBeNull();
  });

  it("names both versions and the remedy on a mismatch", () => {
    const msg = circuitVersionMismatchMessage("kyc", "0.9.0");
    expect(msg).toContain("0.9.0");
    expect(msg).toContain(CIRCUIT_VERSIONS.kyc.version);
    expect(msg).toMatch(/KYC/);
    // The holder needs to know what to do, not just that something is wrong.
    expect(msg).toMatch(/re-issue/i);
  });

  it("explains that the circuit is gone when the type is no longer served", () => {
    const msg = circuitVersionMismatchMessage("retired-type", "1.0.0");
    expect(msg).toContain("retired-type");
    expect(msg).toMatch(/no longer available/i);
  });
});

describe("witnessCircuitVersionMismatch", () => {
  it("reads the version off a single-proof payload", () => {
    expect(witnessCircuitVersionMismatch("kyc", { circuitVersion: "1.0.0" })).toBeNull();
    expect(witnessCircuitVersionMismatch("kyc", { circuitVersion: "0.9.0" })).toContain("0.9.0");
    // No recorded version anywhere: allowed through.
    expect(witnessCircuitVersionMismatch("kyc", {})).toBeNull();
  });

  it("checks both inner credentials of an aggregate payload", () => {
    // The aggregate circuit re-verifies the KYC and age claims itself, so both
    // carry their own version, prefixed.
    const ok = { kyc_circuitVersion: "1.0.0", age_circuitVersion: "1.0.0" };
    expect(witnessCircuitVersionMismatch("aggregate", ok)).toBeNull();

    const staleKyc = { ...ok, kyc_circuitVersion: "0.9.0" };
    expect(witnessCircuitVersionMismatch("aggregate", staleKyc)).toMatch(/KYC/);

    const staleAge = { ...ok, age_circuitVersion: "0.9.0" };
    expect(witnessCircuitVersionMismatch("aggregate", staleAge)).toMatch(/Age/);
  });
});

describe("assertCredentialCircuitCompatible", () => {
  it("passes a matching or unversioned credential", () => {
    expect(() =>
      assertCredentialCircuitCompatible({ type: "kyc", circuitVersion: "1.0.0" }),
    ).not.toThrow();
    expect(() => assertCredentialCircuitCompatible({ type: "kyc" })).not.toThrow();
  });

  it("throws a typed error naming the version before any proving work", () => {
    let thrown: unknown;
    try {
      assertCredentialCircuitCompatible({ type: "kyc", circuitVersion: "0.9.0" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CircuitVersionMismatchError);
    expect((thrown as CircuitVersionMismatchError).code).toBe("circuit_version_mismatch");
    expect((thrown as Error).message).toContain("0.9.0");
  });

  it("uses an explicit type over the payload's own when given one", () => {
    // The aggregate path passes the inner type, since the merged payload is
    // keyed kyc_*/age_* and carries no `type`.
    expect(() =>
      assertCredentialCircuitCompatible({ circuitVersion: "0.9.0" }, "kyc"),
    ).toThrow(CircuitVersionMismatchError);
  });
});

// --------------------------------------------------------------------------- //
// The import boundary rejects a credential it can never prove, so the holder
// finds out at import rather than mid-proof.
// --------------------------------------------------------------------------- //

function credentialJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "kyc",
    value: "0x1234",
    salt: "0xabcd",
    commitment: "0xdeadbeef",
    issuerId: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY234",
    sig: Array(64).fill(7),
    issuerPubX: Array(32).fill(1),
    issuerPubY: Array(32).fill(2),
    expiry: "90 days",
    ...overrides,
  });
}

describe("parseCredential circuit-version guard", () => {
  it("accepts a credential stamped with the served version", () => {
    const cred = parseCredential(credentialJson({ circuitVersion: "1.0.0", circuitVkVersion: 1 }));
    expect(cred.circuitVersion).toBe("1.0.0");
    expect(cred.circuitVkVersion).toBe(1);
  });

  it("accepts a credential minted before circuit versioning existed", () => {
    expect(parseCredential(credentialJson()).circuitVersion).toBeUndefined();
  });

  it("rejects a credential issued against a superseded circuit", () => {
    expect(() => parseCredential(credentialJson({ circuitVersion: "0.9.0" }))).toThrow(
      /0\.9\.0/,
    );
  });

  it("rejects a corrupted VK version", () => {
    expect(() => parseCredential(credentialJson({ circuitVkVersion: 0 }))).toThrow(
      /circuitVkVersion/,
    );
    expect(() => parseCredential(credentialJson({ circuitVkVersion: "1" }))).toThrow(
      /circuitVkVersion/,
    );
  });
});

// --------------------------------------------------------------------------- //
// The prove path itself: the guard must fire *before* the witness request, so
// no prover time is spent and the holder gets the explanation rather than a
// Noir failure. This is the check that runs in the prover worker too, since
// both the worker and the main-thread fallback go through computeWitness.
// --------------------------------------------------------------------------- //

describe("computeWitness circuit-version gate", () => {
  it("does not ask the server for a witness it cannot use", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      computeWitness("kyc", { type: "kyc", circuitVersion: "0.9.0" }),
    ).rejects.toBeInstanceOf(CircuitVersionMismatchError);

    // The whole point is failing *early* — nothing should have hit the network.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("proceeds for a matching or unversioned credential", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ witness: "00ff" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(computeWitness("kyc", { type: "kyc", circuitVersion: "1.0.0" })).resolves.toEqual(
      new Uint8Array([0x00, 0xff]),
    );
    await expect(computeWitness("kyc", { type: "kyc" })).resolves.toEqual(
      new Uint8Array([0x00, 0xff]),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it("surfaces the server's verdict when it disagrees with this build", async () => {
    // A deploy skewed between app and server, or a client too old to carry the
    // check: the server owns the compiled circuits, so its answer wins — and it
    // must arrive as a CircuitVersionMismatchError, not a generic failure.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: "Conflict",
        text: async () =>
          JSON.stringify({
            error: "This KYC credential was issued against circuit version 0.9.0, but this app proves with circuit version 2.0.0.",
            code: "circuit_version_mismatch",
          }),
      }),
    );

    await expect(
      computeWitness("kyc", { type: "kyc", circuitVersion: "1.0.0" }),
    ).rejects.toMatchObject({
      name: "CircuitVersionMismatchError",
      code: "circuit_version_mismatch",
      message: expect.stringContaining("0.9.0"),
    });

    vi.unstubAllGlobals();
  });
});

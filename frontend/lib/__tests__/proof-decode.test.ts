import { describe, it, expect, vi, afterEach } from "vitest";
import { computeWitness, decodeWitnessHex, backendOptions } from "../proof";
import { CircuitVersionMismatchError } from "../circuit-versions";

describe("mobile WASM memory policy", () => {
  it("caps mobile and resource-constrained realms to a one-thread backend", () => {
    vi.stubGlobal("navigator", {
      hardwareConcurrency: 8,
      deviceMemory: 4,
      userAgent: "Mozilla/5.0 (Linux; Android 14)",
    });
    vi.stubGlobal("crossOriginIsolated", true);
    expect(backendOptions()).toEqual({ threads: 1 });
    vi.unstubAllGlobals();
  });
});

// #803 — decodeWitnessHex replaced a per-byte `hex.slice(...)` + `parseInt`
// loop that allocated two temporary strings per byte. For large witnesses
// (aggregate / set-membership circuits) that GC pressure landed inside the
// confined prover-worker heap. These tests pin the decoder's correctness and
// its fail-loud behaviour on malformed responses.
describe("decodeWitnessHex", () => {
  it("decodes a known vector", () => {
    expect(Array.from(decodeWitnessHex("00ff10ab"))).toEqual([0, 255, 16, 171]);
  });

  it("accepts uppercase hex", () => {
    expect(Array.from(decodeWitnessHex("DEADBEef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("decodes the empty string to an empty buffer", () => {
    expect(decodeWitnessHex("")).toHaveLength(0);
  });

  it("round-trips a large witness (128 KiB) with the last byte intact", () => {
    const size = 128 * 1024;
    let hex = "";
    for (let i = 0; i < size; i++) {
      hex += (i & 0xff).toString(16).padStart(2, "0");
    }
    const bytes = decodeWitnessHex(hex);
    expect(bytes).toHaveLength(size);
    expect(bytes[0]).toBe(0);
    expect(bytes[255]).toBe(255);
    expect(bytes[size - 1]).toBe((size - 1) & 0xff);
  });

  it("rejects an odd-length hex string", () => {
    expect(() => decodeWitnessHex("abc")).toThrow(/odd-length hex/);
  });

  it("rejects non-hex characters instead of decoding garbage", () => {
    expect(() => decodeWitnessHex("zz")).toThrow(/invalid hex/);
    expect(() => decodeWitnessHex("0x12")).toThrow(/invalid hex/);
  });
});

describe("computeWitness safe API failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the API code without displaying credential data from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ code: "invalid_credential", error: "salt=private signature=abc" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const error = await computeWitness("age", { value: "1995-06-15" }).catch((err) => err);
    expect(error).toMatchObject({ category: "invalid_input", code: "invalid_credential" });
    expect(error.message).not.toContain("private");
    expect(error.message).not.toContain("signature");
  });

  it("restores the typed circuit mismatch without exposing raw API text", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ code: "circuit_version_mismatch", error: "credential=private" }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const error = await computeWitness("age", {}).catch((err) => err);
    expect(error).toBeInstanceOf(CircuitVersionMismatchError);
    expect(error.message).not.toContain("private");
  });

  it.each(["KYC", "Age"])(
    "reconstructs a safe aggregate %s circuit mismatch from the response",
    async (label) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              code: "circuit_version_mismatch",
              error: `This ${label} credential was issued against circuit version 0.9.0; credential=private`,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      const error = await computeWitness("aggregate", {}).catch((err) => err);
      expect(error).toBeInstanceOf(CircuitVersionMismatchError);
      expect(error.message).toContain(label);
      expect(error.message).toContain("0.9.0");
      expect(error.message).not.toContain("private");
    },
  );

  it("classifies a failed request as a safe retryable network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("credential=private salt=secret")),
    );

    const error = await computeWitness("age", {}).catch((err) => err);
    expect(error).toMatchObject({
      category: "network_error",
      code: "witness_request_failed",
      retryable: true,
    });
    expect(error.message).not.toContain("private");
  });
});

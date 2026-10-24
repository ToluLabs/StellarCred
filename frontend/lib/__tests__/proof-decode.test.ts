import { describe, it, expect } from "vitest";
import { decodeWitnessHex } from "../proof";

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

import { describe, it, expect } from "vitest";
import { equals } from "./crypto";

describe("crypto equals", () => {
  it("returns true for identical 64-byte keys", () => {
    const keyA = new Uint8Array(64);
    const keyB = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      keyA[i] = (i * 7 + 13) & 0xff;
      keyB[i] = (i * 7 + 13) & 0xff;
    }

    expect(equals(keyA, keyB)).toBe(true);
  });

  it("returns false for same length keys differing in the first byte, the last byte, and a middle byte", () => {
    const base = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      base[i] = (i + 1) & 0xff;
    }

    const diffFirst = new Uint8Array(base);
    diffFirst[0] = diffFirst[0] ^ 0xff;
    expect(equals(base, diffFirst)).toBe(false);
    expect(equals(diffFirst, base)).toBe(false);

    const diffLast = new Uint8Array(base);
    diffLast[63] = diffLast[63] ^ 0xff;
    expect(equals(base, diffLast)).toBe(false);
    expect(equals(diffLast, base)).toBe(false);

    const diffMiddle = new Uint8Array(base);
    diffMiddle[32] = diffMiddle[32] ^ 0xff;
    expect(equals(base, diffMiddle)).toBe(false);
    expect(equals(diffMiddle, base)).toBe(false);
  });

  it("returns false and does not throw for different lengths in both argument orders", () => {
    const key64 = new Uint8Array(64).fill(0xaa);
    const key63 = new Uint8Array(63).fill(0xaa);
    const key65 = new Uint8Array(65).fill(0xaa);
    const key0 = new Uint8Array(0);

    // 64 vs 63
    expect(() => equals(key64, key63)).not.toThrow();
    expect(equals(key64, key63)).toBe(false);
    expect(() => equals(key63, key64)).not.toThrow();
    expect(equals(key63, key64)).toBe(false);

    // 64 vs 65
    expect(() => equals(key64, key65)).not.toThrow();
    expect(equals(key64, key65)).toBe(false);
    expect(() => equals(key65, key64)).not.toThrow();
    expect(equals(key65, key64)).toBe(false);

    // 64 vs 0
    expect(() => equals(key64, key0)).not.toThrow();
    expect(equals(key64, key0)).toBe(false);
    expect(() => equals(key0, key64)).not.toThrow();
    expect(equals(key0, key64)).toBe(false);
  });

  it("returns true when both inputs are empty", () => {
    const emptyA = new Uint8Array(0);
    const emptyB = new Uint8Array(0);
    expect(() => equals(emptyA, emptyB)).not.toThrow();
    expect(equals(emptyA, emptyB)).toBe(true);
  });

  it("returns true for Buffer vs plain Uint8Array with the same bytes", () => {
    const rawBytes = [10, 20, 30, 40, 50];
    const u8 = new Uint8Array(rawBytes);
    const buf = Buffer.from(rawBytes);

    expect(equals(u8, buf)).toBe(true);
    expect(equals(buf, u8)).toBe(true);
  });

  it("handles subarray views with non-zero byteOffset correctly", () => {
    // Backing buffer with extra prefix/suffix
    const backingA = new Uint8Array([0xde, 0xad, 1, 2, 3, 4, 5, 0xbe, 0xef]);
    const viewSame = backingA.subarray(2, 7); // [1, 2, 3, 4, 5], byteOffset = 2
    const standaloneSame = new Uint8Array([1, 2, 3, 4, 5]);

    // Same content as a standalone array -> true
    expect(viewSame.byteOffset).toBe(2);
    expect(equals(viewSame, standaloneSame)).toBe(true);
    expect(equals(standaloneSame, viewSame)).toBe(true);

    // Different content -> false
    const standaloneDiff = new Uint8Array([1, 2, 3, 4, 6]);
    expect(equals(viewSame, standaloneDiff)).toBe(false);
    expect(equals(standaloneDiff, viewSame)).toBe(false);

    // Compare two subarray views with different offsets and different content
    const backingB = new Uint8Array([0x00, 0x00, 0x00, 1, 2, 9, 4, 5]);
    const viewDiff = backingB.subarray(3, 8); // [1, 2, 9, 4, 5], byteOffset = 3
    expect(equals(viewSame, viewDiff)).toBe(false);
    expect(equals(viewDiff, viewSame)).toBe(false);
  });

  it("does not mutate arguments", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 6]);
    const aCopy = new Uint8Array(a);
    const bCopy = new Uint8Array(b);

    equals(a, b);

    expect(Array.from(a)).toEqual(Array.from(aCopy));
    expect(Array.from(b)).toEqual(Array.from(bCopy));
  });
});

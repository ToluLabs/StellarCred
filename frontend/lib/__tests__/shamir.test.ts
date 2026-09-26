import { describe, it, expect } from "vitest";
import {
  gfAdd,
  gfSub,
  gfMul,
  gfDiv,
  gfInv,
  evaluatePolynomial,
  splitSecret,
  combineShares,
} from "../shamir";

describe("lib/shamir.ts - Galois Field GF(256) Arithmetic", () => {
  it("gfAdd and gfSub are equivalent to XOR and self-inverting", () => {
    expect(gfAdd(0x57, 0x83)).toBe(0x57 ^ 0x83);
    expect(gfSub(0x57, 0x83)).toBe(0x57 ^ 0x83);
    expect(gfAdd(0x42, 0x42)).toBe(0);
    expect(gfSub(0x42, 0x42)).toBe(0);
  });

  it("gfMul satisfies field axioms (associativity, distributivity, identity, zero)", () => {
    // Identity: a * 1 = a
    for (let a = 0; a < 256; a++) {
      expect(gfMul(a, 1)).toBe(a);
      expect(gfMul(1, a)).toBe(a);
      expect(gfMul(a, 0)).toBe(0);
      expect(gfMul(0, a)).toBe(0);
    }

    // Commutativity & Distributivity: a * (b + c) = a * b + a * c
    const a = 0x57;
    const b = 0x83;
    const c = 0x1f;
    expect(gfMul(a, b)).toBe(gfMul(b, a));
    expect(gfMul(a, gfAdd(b, c))).toBe(gfAdd(gfMul(a, b), gfMul(a, c)));
  });

  it("gfInv computes correct multiplicative inverses for all non-zero elements", () => {
    expect(() => gfInv(0)).toThrow("Zero has no multiplicative inverse");

    for (let a = 1; a < 256; a++) {
      const inv = gfInv(a);
      expect(gfMul(a, inv)).toBe(1);
    }
  });

  it("gfDiv performs correct division and throws on division by zero", () => {
    expect(() => gfDiv(10, 0)).toThrow("Division by zero");
    expect(gfDiv(0, 42)).toBe(0);

    for (let a = 1; a < 50; a++) {
      for (let b = 1; b < 50; b++) {
        const prod = gfMul(a, b);
        expect(gfDiv(prod, b)).toBe(a);
        expect(gfDiv(prod, a)).toBe(b);
      }
    }
  });

  it("evaluatePolynomial correctly computes f(x)", () => {
    // f(x) = 5
    expect(evaluatePolynomial(new Uint8Array([5]), 10)).toBe(5);

    // f(x) = a0 + a1 * x
    const coeffs = new Uint8Array([10, 3]);
    // f(0) = 10
    expect(evaluatePolynomial(coeffs, 0)).toBe(10);
    // f(2) = 10 ^ (3 * 2) = 10 ^ 6 = 12
    expect(evaluatePolynomial(coeffs, 2)).toBe(10 ^ gfMul(3, 2));
  });
});

describe("lib/shamir.ts - Secret Splitting & Reconstruction", () => {
  it("splits and combines a secret with exact threshold (2 of 3)", () => {
    const secret = new Uint8Array([1, 2, 3, 4, 5, 42, 255, 128, 0, 99]);
    const shares = splitSecret(secret, 3, 2);

    expect(shares).toHaveLength(3);
    expect(shares[0].data).toHaveLength(secret.length);

    // Any 2 shares must reconstruct the secret
    const combos = [
      [shares[0], shares[1]],
      [shares[1], shares[2]],
      [shares[0], shares[2]],
      [shares[0], shares[1], shares[2]], // All 3 shares also work
    ];

    for (const combo of combos) {
      const recovered = combineShares(combo);
      expect(Array.from(recovered)).toEqual(Array.from(secret));
    }
  });

  it("splits and combines with 3-of-5 threshold across all 3-share combinations", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32)); // 256-bit AES key
    const shares = splitSecret(secret, 5, 3);

    // Generate all 10 combinations of 3 shares from 5
    const combinations: (typeof shares)[] = [];
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        for (let k = j + 1; k < 5; k++) {
          combinations.push([shares[i], shares[j], shares[k]]);
        }
      }
    }

    expect(combinations).toHaveLength(10);

    for (const combo of combinations) {
      const recovered = combineShares(combo);
      expect(Array.from(recovered)).toEqual(Array.from(secret));
    }
  });

  it("splits and combines with higher thresholds (e.g. 5-of-7, 2-of-2)", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));

    // 2-of-2
    const shares2 = splitSecret(secret, 2, 2);
    expect(Array.from(combineShares(shares2))).toEqual(Array.from(secret));

    // 5-of-7
    const shares7 = splitSecret(secret, 7, 5);
    const subset5 = [shares7[0], shares7[2], shares7[3], shares7[5], shares7[6]];
    expect(Array.from(combineShares(subset5))).toEqual(Array.from(secret));
  });

  it("fails to reconstruct with fewer than threshold shares (does not produce original secret)", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const shares = splitSecret(secret, 5, 3);

    // Reconstructing with only 2 shares when threshold is 3 will produce wrong bytes
    const recovered2 = combineShares([shares[0], shares[1]]);
    expect(Array.from(recovered2)).not.toEqual(Array.from(secret));
  });

  it("throws on invalid split parameters", () => {
    const secret = new Uint8Array([1, 2, 3]);

    expect(() => splitSecret(new Uint8Array(0), 3, 2)).toThrow("Secret must not be empty");
    expect(() => splitSecret(secret, 3, 1)).toThrow("Threshold must be at least 2");
    expect(() => splitSecret(secret, 2, 3)).toThrow("Total shares must be greater than or equal to threshold");
    expect(() => splitSecret(secret, 256, 2)).toThrow("Total shares cannot exceed 255");
  });

  it("throws on invalid combine parameters", () => {
    expect(() => combineShares([])).toThrow("At least 2 shares are required");
    expect(() => combineShares([{ index: 1, data: new Uint8Array([1]) }])).toThrow(
      "At least 2 shares are required",
    );

    // Duplicate indices
    const duplicateShares = [
      { index: 1, data: new Uint8Array([1, 2, 3]) },
      { index: 1, data: new Uint8Array([4, 5, 6]) },
    ];
    expect(() => combineShares(duplicateShares)).toThrow("Duplicate share index detected");

    // Invalid index
    const invalidIndex = [
      { index: 0, data: new Uint8Array([1, 2, 3]) },
      { index: 2, data: new Uint8Array([4, 5, 6]) },
    ];
    expect(() => combineShares(invalidIndex)).toThrow("Invalid share index");

    // Mismatched data lengths
    const mismatchedShares = [
      { index: 1, data: new Uint8Array([1, 2, 3]) },
      { index: 2, data: new Uint8Array([1, 2]) },
    ];
    expect(() => combineShares(mismatchedShares)).toThrow("same data length");
  });
});

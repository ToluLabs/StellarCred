"use client";

// Shamir's Secret Sharing (SSS) over Galois Field GF(256).
// Uses the standard Rijndael irreducible polynomial: P(x) = x^8 + x^4 + x^3 + x + 1 (0x11b)
// with generator g = 0x03.
//
// This enables splitting a sensitive secret (such as a 256-bit AES encryption key)
// into N shares such that any K (threshold) shares can restore the secret, while any
// K-1 or fewer shares reveal zero information about the secret.

const FIELD_SIZE = 256;
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(FIELD_SIZE);

// Precompute exponentiation and logarithm lookup tables for GF(256) multiplication & division
(function initGFTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    EXP[i + 255] = x;
    LOG[x] = i;

    let x2 = x << 1;
    if (x2 & 0x100) x2 ^= 0x11b;
    x = x2 ^ x;
  }
  EXP[255] = EXP[0];
  LOG[0] = 0; // log(0) is undefined, but set to 0 for table safety
})();

/** Addition in GF(256) is bitwise XOR. */
export function gfAdd(a: number, b: number): number {
  return a ^ b;
}

/** Subtraction in GF(256) is identical to addition (bitwise XOR). */
export function gfSub(a: number, b: number): number {
  return a ^ b;
}

/** Multiplication in GF(256) using log/exp tables. */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Division in GF(256) using log/exp tables. Throws on division by zero. */
export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero in GF(256)");
  if (a === 0) return 0;
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

/** Multiplicative inverse in GF(256). */
export function gfInv(a: number): number {
  if (a === 0) throw new Error("Zero has no multiplicative inverse in GF(256)");
  return EXP[255 - LOG[a]];
}

/** Evaluates a polynomial with given coefficients at point x in GF(256). */
export function evaluatePolynomial(coeffs: Uint8Array, x: number): number {
  if (x === 0) return coeffs[0];
  let result = 0;
  let xPow = 1;
  for (let i = 0; i < coeffs.length; i++) {
    result ^= gfMul(coeffs[i], xPow);
    xPow = gfMul(xPow, x);
  }
  return result;
}

export interface RawShare {
  /** 1-based index (x coordinate) in range [1, 255]. */
  index: number;
  /** Share data (y coordinates), same length as original secret. */
  data: Uint8Array;
}

/**
 * Splits a byte secret into `totalShares` shares with a reconstruction `threshold`.
 *
 * @param secret The secret bytes to split (e.g. 32-byte AES key).
 * @param totalShares Number of shares to generate (2 <= totalShares <= 255).
 * @param threshold Minimum number of shares required to reconstruct (2 <= threshold <= totalShares).
 */
export function splitSecret(
  secret: Uint8Array,
  totalShares: number,
  threshold: number,
): RawShare[] {
  if (secret.length === 0) {
    throw new Error("Secret must not be empty");
  }
  if (threshold < 2) {
    throw new Error("Threshold must be at least 2");
  }
  if (totalShares < threshold) {
    throw new Error("Total shares must be greater than or equal to threshold");
  }
  if (totalShares > 255) {
    throw new Error("Total shares cannot exceed 255 in GF(256)");
  }

  const shares: RawShare[] = Array.from({ length: totalShares }, (_, i) => ({
    index: i + 1,
    data: new Uint8Array(secret.length),
  }));

  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    const coeffs = new Uint8Array(threshold);
    coeffs[0] = secret[byteIdx];

    // Generate random coefficients for degree 1 to threshold-1 using WebCrypto
    const randomBytes = crypto.getRandomValues(new Uint8Array(threshold - 1));
    for (let c = 1; c < threshold; c++) {
      coeffs[c] = randomBytes[c - 1];
    }

    for (let s = 0; s < totalShares; s++) {
      const x = shares[s].index;
      shares[s].data[byteIdx] = evaluatePolynomial(coeffs, x);
    }
  }

  return shares;
}

/**
 * Combines any K or more shares to reconstruct the original secret using Lagrange interpolation at x = 0.
 *
 * @param shares Array of at least K raw shares.
 */
export function combineShares(shares: RawShare[]): Uint8Array {
  if (!shares || shares.length < 2) {
    throw new Error("At least 2 shares are required to reconstruct secret");
  }

  const k = shares.length;
  const secretLen = shares[0].data.length;

  if (secretLen === 0) {
    throw new Error("Share data must not be empty");
  }

  // Validate shares
  const indicesSeen = new Set<number>();
  for (const s of shares) {
    if (!s || typeof s.index !== "number" || s.index < 1 || s.index > 255) {
      throw new Error(`Invalid share index: ${s?.index}. Must be between 1 and 255.`);
    }
    if (indicesSeen.has(s.index)) {
      throw new Error(`Duplicate share index detected: ${s.index}`);
    }
    indicesSeen.add(s.index);

    if (!s.data || s.data.length !== secretLen) {
      throw new Error("All shares must have the same data length");
    }
  }

  // Precompute Lagrange basis coefficients for each share at x = 0:
  // l_j(0) = Prod_{m != j} (0 - x_m) / (x_j - x_m)
  // In GF(256): (0 - x_m) = x_m and (x_j - x_m) = (x_j ^ x_m)
  const lagrangeCoeffs = new Uint8Array(k);
  for (let j = 0; j < k; j++) {
    const xj = shares[j].index;
    let l_j = 1;
    for (let m = 0; m < k; m++) {
      if (m === j) continue;
      const xm = shares[m].index;
      const num = xm;
      const den = xj ^ xm;
      l_j = gfMul(l_j, gfDiv(num, den));
    }
    lagrangeCoeffs[j] = l_j;
  }

  const secret = new Uint8Array(secretLen);
  for (let byteIdx = 0; byteIdx < secretLen; byteIdx++) {
    let acc = 0;
    for (let j = 0; j < k; j++) {
      const yj = shares[j].data[byteIdx];
      acc ^= gfMul(yj, lagrangeCoeffs[j]);
    }
    secret[byteIdx] = acc;
  }

  return secret;
}

import { timingSafeEqual } from "node:crypto";

/**
 * Compares two byte arrays for equality using a constant-time algorithm
 * (`timingSafeEqual`) for equal-length inputs to mitigate timing-oracle attacks.
 *
 * Input length is not treated as secret: when the lengths differ the function returns `false`.
 * In that case a dummy `timingSafeEqual` is still run first so the call never throws
 * (Node's `timingSafeEqual` throws on mismatched lengths).
 *
 * This function MUST be used instead of `Buffer.equals` or `===` when comparing
 * sensitive cryptographic values such as keys, signatures, or MACs.
 *
 * NOTE: This function is server-only (`node:crypto`) and must not be imported
 * from client components.
 *
 * @param a - First byte array to compare.
 * @param b - Second byte array to compare.
 * @returns `true` if the byte sequences are identical, `false` otherwise.
 */
export function equals(a: Uint8Array, b: Uint8Array): boolean {
  const bufA = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const bufB = Buffer.from(b.buffer, b.byteOffset, b.byteLength);

  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

import { describe, it, expect } from 'vitest';
import {
  verifyProof,
  validateClaimPayload,
  isClaimTypeSupported,
  isCredentialStale,
} from './verifier';

import {
  validProofPayload,
  invalidProofPayload,
  malformedClaimPayload,
  missingProofPayload,
  unsupportedClaimTypePayload,
  staleCredentialPayload,
  makePayload,
} from './__fixtures__/fixtures';

describe('verifier', () => {
  describe('verifyProof', () => {
    it('accepts a valid proof payload', () => {
      const result = verifyProof(validProofPayload);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects an invalid proof with an actionable error', () => {
      const result = verifyProof(invalidProofPayload);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/proof verification failed/i);
    });

    it('rejects a payload with a missing proof', () => {
      const result = verifyProof(missingProofPayload);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/missing proof/i);
    });

    it('accepts a proof payload built with makePayload', () => {
      const result = verifyProof(makePayload(validProofPayload));
      expect(result.ok).toBe(true);
    });

    it('rejects a malformed claim payload', () => {
      const result = verifyProof(malformedClaimPayload);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/invalid claim payload/i);
    });
  });

  describe('validateClaimPayload', () => {
    it('accepts a well-formed claim payload', () => {
      const result = validateClaimPayload(validProofPayload.claim);
      expect(result.ok).toBe(true);
    });

    it('rejects a claim payload missing required fields', () => {
      const result = validateClaimPayload(malformedClaimPayload.claim);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/invalid claim payload/i);
    });

    it('rejects an unsupported claim type', () => {
      const result = validateClaimPayload(unsupportedClaimTypePayload.claim);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/unsupported claim type/i);
    });
  });

  describe('isClaimTypeSupported', () => {
    it('returns true for a known claim type', () => {
      expect(isClaimTypeSupported('kyc')).toBe(true);
    });

    it('returns false for an unknown claim type', () => {
      expect(isClaimTypeSupported('not-a-real-claim')).toBe(false);
    });
  });

  describe('isCredentialStale', () => {
    it('returns false for a fresh credential', () => {
      const now = Date.now();
      expect(isCredentialStale(new Date(now + 60 * 60 * 1000).toISOString(), now)).toBe(false);
    });

    it('returns true for an expired credential', () => {
      const now = Date.now();
      expect(isCredentialStale(new Date(now - 60 * 60 * 1000).toISOString(), now)).toBe(true);
    });

    it('rejects a stale credential payload', () => {
      const result = verifyProof(staleCredentialPayload);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/stale credential/i);
    });
  });

  describe('determinism', () => {
    it('produces identical results across repeated runs', () => {
      const a = verifyProof(validProofPayload);
      const b = verifyProof(validProofPayload);
      expect(a).toEqual(b);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  verifyProof,
  validateClaimPayload,
  isClaimTypeSupported,
  isCredentialStale,
} from '../../frontend/lib/verifier/verifier';

import {
  validProofPayload,
  invalidProofPayload,
  malformedClaimPayload,
  missingProofPayload,
  unsupportedClaimTypePayload,
  staleCredentialPayload,
} from '../../frontend/lib/verifier/__fixtures__/fixtures';

describe('verifier (cross-package): proof and claim validation', () => {
  it('accepts a valid proof', () => {
    const result = verifyProof(validProofPayload);
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid proof', () => {
    const result = verifyProof(invalidProofPayload);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/proof verification failed/i);
  });

  it('rejects a missing proof', () => {
    const result = verifyProof(missingProofPayload);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing proof/i);
  });

  it('rejects a malformed claim payload', () => {
    const result = verifyProof(malformedClaimPayload);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid claim payload/i);
  });

  it('rejects an unsupported claim type', () => {
    const result = verifyProof(unsupportedClaimTypePayload);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unsupported claim type/i);
  });

  it('rejects a stale credential', () => {
    const result = verifyProof(staleCredentialPayload);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stale credential/i);
  });

  it('validates a well-formed claim payload', () => {
    const result = validateClaimPayload(validProofPayload.claim);
    expect(result.ok).toBe(true);
  });

  it('detects supported vs unsupported claim types', () => {
    expect(isClaimTypeSupported('kyc')).toBe(true);
    expect(isClaimTypeSupported('not-a-real-claim')).toBe(false);
  });

  it('detects stale credentials deterministically', () => {
    const now = Date.now();
    expect(isCredentialStale(new Date(now + 60 * 60 * 1000).toISOString(), now)).toBe(false);
    expect(isCredentialStale(new Date(now - 60 * 60 * 1000).toISOString(), now)).toBe(true);
  });
});

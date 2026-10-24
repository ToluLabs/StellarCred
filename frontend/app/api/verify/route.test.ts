import { describe, it, expect } from 'vitest';
import { POST } from './route';

import {
  validProofPayload,
  invalidProofPayload,
  malformedClaimPayload,
  missingProofPayload,
  unsupportedClaimTypePayload,
  staleCredentialPayload,
} from '../../../lib/verifier/__fixtures__/fixtures';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/verify', () => {
  it('returns 200 for a valid proof payload', async () => {
    const res = await POST(makeRequest(validProofPayload));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('returns 400 for an invalid proof with an actionable error', async () => {
    const res = await POST(makeRequest(invalidProofPayload));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/proof verification failed/i);
  });

  it('returns 400 for a malformed claim payload', async () => {
    const res = await POST(makeRequest(malformedClaimPayload));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/invalid claim payload/i);
  });

  it('returns 400 when the proof is missing', async () => {
    const res = await POST(makeRequest(missingProofPayload));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/missing proof/i);
  });

  it('returns 400 for an unsupported claim type', async () => {
    const res = await POST(makeRequest(unsupportedClaimTypePayload));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/unsupported claim type/i);
  });

  it('returns 400 for a stale credential', async () => {
    const res = await POST(makeRequest(staleCredentialPayload));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/stale credential/i);
  });

  it('returns 400 for an invalid JSON body', async () => {
    const req = new Request('http://localhost/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json ',
    });
    const res = await POST(req);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/invalid request body/i);
  });
});

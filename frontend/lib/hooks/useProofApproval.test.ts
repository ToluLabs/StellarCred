import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Credential } from "../credential";
import { useProofApproval, type ProofRequest } from "./useProofApproval";

function cred(commitment: string): Credential {
  return {
    type: "kyc",
    title: "KYC Complete",
    claim: "identity verified",
    issuer: "StellarCred Authority",
    issuerId: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2",
    holder: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    value: "1",
    salt: "2",
    commitment,
    sig: [],
    issuerPubX: [],
    issuerPubY: [],
    issuedAt: 0,
    expiry: "90 days",
  };
}

describe("useProofApproval", () => {
  it("parks a request without starting the proof", () => {
    const start = vi.fn();
    const { result } = renderHook(() => useProofApproval(start));

    expect(result.current.creds).toBeNull();

    const one = cred("0xa");
    act(() => result.current.request({ kind: "single", cred: one }));

    expect(start).not.toHaveBeenCalled();
    expect(result.current.creds).toEqual([one]);
  });

  it("starts exactly the parked request on approve, then closes", () => {
    const start = vi.fn<(request: ProofRequest) => void>();
    const { result } = renderHook(() => useProofApproval(start));
    const batch: ProofRequest = { kind: "batch", creds: [cred("0xa"), cred("0xb")] };

    act(() => result.current.request(batch));
    expect(result.current.creds).toHaveLength(2);

    act(() => result.current.approve());

    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(batch);
    expect(result.current.creds).toBeNull();
  });

  it("discards the request on cancel", () => {
    const start = vi.fn();
    const { result } = renderHook(() => useProofApproval(start));

    act(() => result.current.request({ kind: "single", cred: cred("0xa") }));
    act(() => result.current.cancel());

    expect(start).not.toHaveBeenCalled();
    expect(result.current.creds).toBeNull();
  });

  it("does nothing when approve is called with no request", () => {
    const start = vi.fn();
    const { result } = renderHook(() => useProofApproval(start));

    act(() => result.current.approve());

    expect(start).not.toHaveBeenCalled();
    expect(result.current.creds).toBeNull();
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "../credential";
import * as credentialModule from "../credential";
import { useCredentialStore } from "./useCredentialStore";

const credential: Credential = {
  type: "kyc",
  title: "KYC Complete",
  claim: "identity verified",
  issuer: "GISSUER",
  issuerId: "GISSUER",
  holder: "GHOLDER",
  value: "verified",
  salt: "salt",
  commitment: "commitment-1",
  sig: [1],
  issuerPubX: [2],
  issuerPubY: [3],
  issuedAt: 1,
  expiry: "90 days",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCredentialStore request sequencing", () => {
  it("does not let an older initial load overwrite a newer reload", async () => {
    let resolveInitial!: (value: Credential[]) => void;
    const initialLoad = new Promise<Credential[]>((resolve) => {
      resolveInitial = resolve;
    });

    const loadSpy = vi
      .spyOn(credentialModule, "loadCredentials")
      .mockReturnValueOnce(initialLoad)
      .mockResolvedValueOnce([credential]);

    const { result } = renderHook(() => useCredentialStore());

    await act(async () => {
      await result.current.reload();
    });

    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(result.current.creds).toEqual([credential]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveInitial([]);
      await initialLoad;
    });

    expect(result.current.creds).toEqual([credential]);
  });

  it("keeps the latest result when multiple reloads finish out of order", async () => {
    let resolveFirst!: (value: Credential[]) => void;
    let resolveSecond!: (value: Credential[]) => void;
    const first = new Promise<Credential[]>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Credential[]>((resolve) => {
      resolveSecond = resolve;
    });

    vi.spyOn(credentialModule, "loadCredentials")
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const { result } = renderHook(() => useCredentialStore());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstReload!: Promise<Credential[]>;
    let secondReload!: Promise<Credential[]>;
    act(() => {
      firstReload = result.current.reload();
      secondReload = result.current.reload();
    });

    await act(async () => {
      resolveSecond([credential]);
      await secondReload;
    });
    await act(async () => {
      resolveFirst([]);
      await firstReload;
    });

    expect(result.current.creds).toEqual([credential]);
  });
});

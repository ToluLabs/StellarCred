import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useCredentialStore } from "./useCredentialStore";
import type { Credential } from "../credential";
import * as credentialModule from "../credential";

describe("useCredentialStore - Stale data prevention and functional state updates", () => {
  const KEY = "stellarcred:credentials";

  const sampleCred1: Credential = {
    type: "kyc",
    title: "KYC Complete",
    claim: "identity verified",
    issuer: "GABC...",
    issuerId: "GABC...",
    holder: "GXYZ...",
    value: "0x123",
    salt: "0x456",
    commitment: "0x789",
    sig: [1, 2, 3],
    issuerPubX: [4, 5, 6],
    issuerPubY: [7, 8, 9],
    issuedAt: 1000,
    expiry: "90 days",
  };

  const sampleCred2: Credential = {
    type: "age",
    title: "Age Verified",
    claim: "age ≥ 18",
    issuer: "GABC...",
    issuerId: "GABC...",
    holder: "GXYZ...",
    value: "0x123",
    salt: "0x456",
    commitment: "0xabc",
    sig: [1, 2, 3],
    issuerPubX: [4, 5, 6],
    issuerPubY: [7, 8, 9],
    issuedAt: 1000,
    expiry: "90 days",
  };

  beforeEach(() => {
    if (typeof window !== "undefined") {
      localStorage.clear();
    }
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (typeof window !== "undefined") {
      localStorage.clear();
    }
  });

  it("loads initial credentials and sets isLoaded to true", async () => {
    localStorage.setItem(KEY, JSON.stringify([sampleCred1]));
    const { result } = renderHook(() => useCredentialStore());

    expect(result.current.isLoaded).toBe(false);

    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
      expect(result.current.creds).toHaveLength(1);
      expect(result.current.creds[0].commitment).toBe(sampleCred1.commitment);
    });
  });

  it("optimistically and synchronously saves a credential with functional updates", async () => {
    const { result } = renderHook(() => useCredentialStore());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => {
      result.current.save(sampleCred1);
    });

    // State updates immediately without waiting for storage persistence
    expect(result.current.creds).toHaveLength(1);
    expect(result.current.creds[0].commitment).toBe(sampleCred1.commitment);

    // Verify persisted in storage
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(KEY) || "[]");
      expect(stored).toHaveLength(1);
      expect(stored[0].commitment).toBe(sampleCred1.commitment);
    });
  });

  it("optimistically and synchronously removes a credential", async () => {
    localStorage.setItem(KEY, JSON.stringify([sampleCred1, sampleCred2]));
    const { result } = renderHook(() => useCredentialStore());

    await waitFor(() => expect(result.current.creds).toHaveLength(2));

    act(() => {
      result.current.remove(sampleCred1.commitment);
    });

    // State removes item immediately
    expect(result.current.creds).toHaveLength(1);
    expect(result.current.creds[0].commitment).toBe(sampleCred2.commitment);

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(KEY) || "[]");
      expect(stored).toHaveLength(1);
      expect(stored[0].commitment).toBe(sampleCred2.commitment);
    });
  });

  it("optimistically and synchronously removes multiple credentials", async () => {
    localStorage.setItem(KEY, JSON.stringify([sampleCred1, sampleCred2]));
    const { result } = renderHook(() => useCredentialStore());

    await waitFor(() => expect(result.current.creds).toHaveLength(2));

    act(() => {
      result.current.removeMultiple([sampleCred1.commitment, sampleCred2.commitment]);
    });

    // State is immediately empty
    expect(result.current.creds).toHaveLength(0);

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(KEY) || "[]");
      expect(stored).toHaveLength(0);
    });
  });

  it("optimistically marks a credential as proved immediately", async () => {
    localStorage.setItem(KEY, JSON.stringify([sampleCred1]));
    const { result } = renderHook(() => useCredentialStore());

    await waitFor(() => expect(result.current.creds).toHaveLength(1));

    act(() => {
      result.current.markCredentialProved(sampleCred1.commitment, "tx_12345");
    });

    // State immediately reflects proved status and txHash
    expect(result.current.creds[0].provedTxHash).toBe("tx_12345");
    expect(result.current.creds[0].provedAt).toBeGreaterThan(0);
  });

  it("optimistically marks multiple credentials as proved immediately", async () => {
    localStorage.setItem(KEY, JSON.stringify([sampleCred1, sampleCred2]));
    const { result } = renderHook(() => useCredentialStore());

    await waitFor(() => expect(result.current.creds).toHaveLength(2));

    act(() => {
      result.current.markCredentialsProved(
        [sampleCred1.commitment, sampleCred2.commitment],
        "tx_batch_999",
      );
    });

    expect(result.current.creds[0].provedTxHash).toBe("tx_batch_999");
    expect(result.current.creds[1].provedTxHash).toBe("tx_batch_999");
  });

  it("prevents stale data race conditions when network responses return after cache updates", async () => {
    localStorage.setItem(KEY, JSON.stringify([sampleCred1]));
    const { result } = renderHook(() => useCredentialStore());

    await waitFor(() => expect(result.current.creds).toHaveLength(1));

    // Simulate an in-flight reload that takes some time to resolve with an older payload
    let resolveStaleReload!: (creds: Credential[]) => void;
    const staleReloadPromise = new Promise<Credential[]>((resolve) => {
      resolveStaleReload = resolve;
    });

    vi.spyOn(credentialModule, "loadCredentials").mockImplementationOnce(() => staleReloadPromise);

    // Trigger reload (simulating refresh / query re-fetch)
    act(() => {
      result.current.reload();
    });

    // While the reload is in-flight, a state/cache update happens (e.g., proving or adding credential)
    act(() => {
      result.current.save(sampleCred2);
    });

    // Dashboard now has both credentials
    expect(result.current.creds).toHaveLength(2);

    // Now the delayed stale network/storage reload finally returns with only sampleCred1
    await act(async () => {
      resolveStaleReload([sampleCred1]);
    });

    // CRITICAL: The stale reload response MUST be ignored and NOT overwrite newer cache state
    expect(result.current.creds).toHaveLength(2);
    expect(result.current.creds.map((c) => c.commitment)).toContain(sampleCred2.commitment);
  });
});

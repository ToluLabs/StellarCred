import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCredentialSync, type Credential } from "../credential";
import { isStorageAvailable } from "../safe-storage";

// Mock safe-storage
vi.mock("../safe-storage", () => ({
  isStorageAvailable: vi.fn(() => true),
}));

describe("useCredentialSync - Cross-tab storage sync", () => {
  const KEY = "stellarcred:credentials";

  beforeEach(() => {
    // Clear localStorage before each test
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

  it("loads initial credentials from localStorage", async () => {
    const mockCred: Credential = {
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
      issuedAt: Date.now() / 1000,
      expiry: "90 days",
    };

    localStorage.setItem(KEY, JSON.stringify([mockCred]));

    const { result } = renderHook(() => useCredentialSync());

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0].type).toBe("kyc");
  });

  it("syncs credentials when storage event fires from another tab", async () => {
    const { result } = renderHook(() => useCredentialSync());

    // Initially empty
    expect(result.current).toHaveLength(0);

    // Simulate a storage event from another tab
    const newCred: Credential = {
      type: "age",
      title: "Age Verified",
      claim: "age ≥ 18",
      issuer: "GABC...",
      issuerId: "GABC...",
      holder: "GXYZ...",
      value: "0x123",
      salt: "0x456",
      commitment: "0x789",
      sig: [1, 2, 3],
      issuerPubX: [4, 5, 6],
      issuerPubY: [7, 8, 9],
      issuedAt: Date.now() / 1000,
      expiry: "90 days",
    };

    // Write to localStorage (simulating another tab)
    localStorage.setItem(KEY, JSON.stringify([newCred]));

    // Dispatch storage event
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: KEY,
        newValue: JSON.stringify([newCred]),
        oldValue: "[]",
        url: window.location.href,
      }),
    );

    // Wait for debounce (100ms)
    await waitFor(
      () => {
        expect(result.current).toHaveLength(1);
        expect(result.current[0].type).toBe("age");
      },
      { timeout: 200 },
    );
  });

  it("ignores storage events for unrelated keys", async () => {
    const { result } = renderHook(() => useCredentialSync());

    expect(result.current).toHaveLength(0);

    // Dispatch storage event for a different key
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "unrelated_key",
        newValue: "some_value",
        oldValue: null,
        url: window.location.href,
      }),
    );

    // Credentials should remain empty
    expect(result.current).toHaveLength(0);
  });

  it("debounces rapid storage events", async () => {
    const { result } = renderHook(() => useCredentialSync());

    const cred1: Credential = {
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
      issuedAt: Date.now() / 1000,
      expiry: "90 days",
    };

    const cred2: Credential = {
      ...cred1,
      type: "age",
      title: "Age Verified",
      claim: "age ≥ 18",
    };

    // Rapidly fire multiple storage events
    localStorage.setItem(KEY, JSON.stringify([cred1]));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: KEY,
        newValue: JSON.stringify([cred1]),
        oldValue: "[]",
        url: window.location.href,
      }),
    );

    setTimeout(() => {
      localStorage.setItem(KEY, JSON.stringify([cred2]));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: KEY,
          newValue: JSON.stringify([cred2]),
          oldValue: JSON.stringify([cred1]),
          url: window.location.href,
        }),
      );
    }, 50);

    // Should only reload once after debounce
    await waitFor(
      () => {
        expect(result.current).toHaveLength(1);
        // Should have the latest value (cred2)
        expect(result.current[0].type).toBe("age");
      },
      { timeout: 300 },
    );
  });

  it("does not sync when storage is unavailable", () => {
    vi.mocked(isStorageAvailable).mockReturnValue(false);

    const { result } = renderHook(() => useCredentialSync());

    // Add a credential to localStorage
    const mockCred: Credential = {
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
      issuedAt: Date.now() / 1000,
      expiry: "90 days",
    };

    localStorage.setItem(KEY, JSON.stringify([mockCred]));

    // Dispatch storage event
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: KEY,
        newValue: JSON.stringify([mockCred]),
        oldValue: "[]",
        url: window.location.href,
      }),
    );

    // Should not sync (storage unavailable)
    expect(result.current).toHaveLength(0);
  });
});

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, renderHook, waitFor } from "@testing-library/react";
import { useHydrated } from "../hooks/useHydrated";
import { WalletProvider, useWallet, usePreviewMode } from "../wallet-context";
import { useCredentialStore } from "../hooks/useCredentialStore";
import * as credentialModule from "../credential";

describe("hydration mismatch and flash-of-incorrect-state prevention (#947)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("useHydrated returns false on initial render and true after mount", () => {
    const { result } = renderHook(() => useHydrated());
    expect(result.current).toBe(true);
  });

  it("WalletProvider reports restoring: false and hydrated: true after mount", async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(WalletProvider, null, children);

    const { result } = renderHook(() => useWallet(), { wrapper });

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true);
      expect(result.current.restoring).toBe(false);
    });
  });

  it("usePreviewMode returns false while unhydrated or restoring to prevent flash of preview data", () => {
    function Consumer() {
      const isPreview = usePreviewMode();
      return React.createElement("div", { "data-testid": "preview-mode" }, String(isPreview));
    }

    const { getByTestId } = render(
      React.createElement(WalletProvider, null, React.createElement(Consumer)),
    );

    expect(getByTestId("preview-mode").textContent).toBe("true");
  });

  it("useCredentialStore provides loading: true initially to prevent flashing empty state", async () => {
    vi.spyOn(credentialModule, "loadCredentials").mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve([
              {
                type: "kyc",
                commitment: "0xcommit123",
                issuer: "GABC",
                value: "val",
                salt: "salt",
                signature: "sig",
              },
            ]);
          }, 50);
        }),
    );

    const { result } = renderHook(() => useCredentialStore());
    expect(result.current.loading).toBe(true);
    expect(result.current.creds).toEqual([]);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.creds.length).toBe(1);
    });
  });
});

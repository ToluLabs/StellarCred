import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import HolderPageClient from "./HolderPageClient";

// Avoid importing the real wallet kit (ESM/CJS resolution issues under vitest).
vi.mock("@/lib/wallet", () => ({
  signTx: vi.fn(),
  getAddress: vi.fn(),
  isConnected: vi.fn(),
  getWalletErrorInfo: vi.fn(),
  getWalletReportUrl: vi.fn(),
}));

// Credential hydration is the behaviour under test: control when the async
// localStorage load resolves, so we can observe the page mid-hydration.
const loadCredentials = vi.fn();
vi.mock("@/lib/credential", () => ({
  loadCredentials: (...args: unknown[]) => loadCredentials(...args),
  saveCredential: vi.fn(),
  removeCredential: vi.fn(),
  markProved: vi.fn(),
  markAllProved: vi.fn(),
}));

// A connected wallet: the skeleton only replaces the empty state for a real
// (non-preview) holder session.
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    restoring: false,
    connecting: false,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
  usePreviewMode: () => false,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/use-warm-prover", () => ({ useWarmProver: () => {} }));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

// Keep the test focused on the list area; unrelated chrome and child widgets
// are stubbed out.
vi.mock("@/components/WalletButton", () => ({ WalletButton: () => null }));
vi.mock("@/components/ConfigBanner", () => ({ ConfigBanner: () => null }));
vi.mock("@/components/DataWipePanel", () => ({ DataWipePanel: () => null }));
vi.mock("@/components/CredentialDetailModal", () => ({ default: () => null }));
vi.mock("@/components/holder/CredCard", () => ({ CredCard: () => null }));

describe("HolderPageClient loading state", () => {
  beforeEach(() => {
    loadCredentials.mockReset();
  });

  it("shows credential skeletons instead of the empty state while credentials hydrate", async () => {
    let resolveLoad!: (creds: never[]) => void;
    loadCredentials.mockReturnValue(
      new Promise<never[]>((resolve) => {
        resolveLoad = resolve;
      }),
    );

    render(<HolderPageClient />);

    // Mid-hydration: skeleton placeholders, no "No credentials yet" flash.
    expect(
      screen.getByRole("status", { name: /loading credentials/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no credentials yet/i)).not.toBeInTheDocument();

    // Once hydration settles with an empty store, the empty state appears and
    // the skeleton is gone.
    await act(async () => {
      resolveLoad([]);
    });

    expect(await screen.findByText(/no credentials yet/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: /loading credentials/i }),
    ).not.toBeInTheDocument();
  });
});

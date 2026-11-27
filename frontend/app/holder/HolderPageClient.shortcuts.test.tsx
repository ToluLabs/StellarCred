import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/lib/test-utils";
import type { Credential } from "@/lib/credential";
import HolderPageClient from "./HolderPageClient";

vi.mock("@/lib/wallet", () => ({
  signTx: vi.fn(),
  getAddress: vi.fn(),
  isConnected: vi.fn(),
  getWalletErrorInfo: vi.fn(),
  getWalletReportUrl: vi.fn(),
}));

const sampleCreds: Credential[] = [
  {
    type: "age",
    title: "Age 21+ Verification",
    claim: "age >= 21",
    issuer: "Civic ID",
    issuerId: "civic-id",
    holder: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    value: "25",
    salt: "0x11",
    sig: [1, 2, 3],
    issuerPubX: [1, 2, 3, 4],
    issuerPubY: [5, 6, 7, 8],
    commitment: "0xaaaa1111bbbb2222",
    issuedAt: Math.floor(Date.now() / 1000) - 86_400,
    expiry: "90 days",
    claimParams: {},
  },
  {
    type: "accreditation",
    title: "Accredited Investor",
    claim: "net_worth >= 1M",
    issuer: "Stellar Trust",
    issuerId: "stellar-trust",
    holder: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    value: "1",
    salt: "0x22",
    sig: [4, 5, 6],
    issuerPubX: [9, 10, 11, 12],
    issuerPubY: [13, 14, 15, 16],
    commitment: "0xcccc3333dddd4444",
    issuedAt: Math.floor(Date.now() / 1000) - 86_400,
    expiry: "90 days",
    claimParams: {},
  },
];

const loadCredentials = vi.fn();
vi.mock("@/lib/credential", () => ({
  loadCredentials: (...args: unknown[]) => loadCredentials(...args),
  saveCredential: vi.fn(),
  removeCredential: vi.fn(),
  markProved: vi.fn(),
  markAllProved: vi.fn(),
}));

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
vi.mock("@/lib/useProofTimeline", () => ({
  useProofTimeline: () => ({ events: [], loading: false }),
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/components/WalletButton", () => ({ WalletButton: () => null }));
vi.mock("@/components/WalletOnboarding", () => ({ WalletOnboarding: () => null }));
vi.mock("@/components/OnboardingNudge", () => ({ OnboardingNudge: () => null }));
vi.mock("@/components/ConfigBanner", () => ({ ConfigBanner: () => null }));
vi.mock("@/components/DataWipePanel", () => ({ DataWipePanel: () => null }));
vi.mock("@/components/ExportVisibilitySettings", () => ({
  ExportVisibilitySettings: () => null,
}));
vi.mock("@/components/holder/CredentialExportPanel", () => ({
  CredentialExportPanel: () => null,
}));
vi.mock("@/components/holder/GuardianRecoveryControl", () => ({
  GuardianRecoveryControl: () => null,
}));

describe("HolderPageClient keyboard navigation shortcuts", () => {
  beforeEach(() => {
    loadCredentials.mockReset();
    loadCredentials.mockResolvedValue(sampleCreds);
  });

  it("navigates with j/k, opens detail modal with v, and closes with Escape", async () => {
    renderWithIntl(<HolderPageClient />);

    const firstHeading = await screen.findByText("Age 21+ Verification");
    expect(firstHeading).toBeInTheDocument();

    // Traverse down to first card, then second card, then back to first
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => {
      expect(screen.getAllByRole("article")[0]).toHaveAttribute("data-active", "true");
    });

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => {
      expect(screen.getAllByRole("article")[1]).toHaveAttribute("data-active", "true");
    });

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => {
      expect(screen.getAllByRole("article")[0]).toHaveAttribute("data-active", "true");
    });

    // 'v' opens CredentialDetailModal for the active credential
    fireEvent.keyDown(window, { key: "v" });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // Escape closes the modal
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("focuses search on '/' and filters credentials", async () => {
    renderWithIntl(<HolderPageClient />);
    await screen.findByText("Age 21+ Verification");

    const searchInput = screen.getByRole("searchbox", { name: /filter credentials/i });
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(searchInput);

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "Stellar Trust" } });
    });

    expect(screen.queryByText("Age 21+ Verification")).not.toBeInTheDocument();
    expect(screen.getByText("Accredited Investor")).toBeInTheDocument();
  });

  it("opens the shortcut cheat sheet with '?' and closes it with Escape", async () => {
    renderWithIntl(<HolderPageClient />);
    await screen.findByText("Age 21+ Verification");

    fireEvent.keyDown(window, { key: "?" });
    expect(await screen.findByRole("dialog", { name: /keyboard shortcuts/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /keyboard shortcuts/i })).not.toBeInTheDocument();
    });
  });

  it("toggles batch selection with 'x'", async () => {
    renderWithIntl(<HolderPageClient />);
    await screen.findByText("Age 21+ Verification");

    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "x" });

    const checkbox = screen.getByRole("checkbox", {
      name: /select age 21\+ verification for batch/i,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });
});

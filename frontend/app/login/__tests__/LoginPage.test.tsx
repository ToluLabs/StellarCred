import { screen, fireEvent } from "@testing-library/react";
import { renderWithIntl } from "@/lib/test-utils";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LoginPageClient } from "../LoginPageClient";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock wallet
vi.mock("@/lib/wallet", () => ({
  signTx: vi.fn(),
  getAddress: vi.fn(),
  isConnected: vi.fn(),
}));

let mockWalletState = {
  address: null as string | null,
  connecting: false,
  error: null as string | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  networkMismatch: false,
};

vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => mockWalletState,
}));

describe("LoginPage Accessibility & Functionality (Issue #756)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWalletState = {
      address: null,
      connecting: false,
      error: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      networkMismatch: false,
    };
  });

  it("renders the main page heading and landmark structure", () => {
    renderWithIntl(<LoginPageClient />);
    const heading = screen.getByRole("heading", { level: 1, name: /sign in to stellarcred/i });
    expect(heading).toBeInTheDocument();
  });

  it("exposes accessible tablist and tab controls with correct ARIA attributes", () => {
    renderWithIntl(<LoginPageClient />);
    const tablist = screen.getByRole("tablist", { name: /login methods/i });
    expect(tablist).toBeInTheDocument();

    const walletTab = screen.getByRole("tab", { name: /stellar wallet/i });
    const passphraseTab = screen.getByRole("tab", { name: /passphrase login/i });

    expect(walletTab).toHaveAttribute("aria-selected", "true");
    expect(passphraseTab).toHaveAttribute("aria-selected", "false");

    // Switch to passphrase tab
    fireEvent.click(passphraseTab);
    expect(walletTab).toHaveAttribute("aria-selected", "false");
    expect(passphraseTab).toHaveAttribute("aria-selected", "true");
  });

  it("provides accessible labels and hint descriptions for all form inputs", () => {
    renderWithIntl(<LoginPageClient />);
    const passphraseTab = screen.getByRole("tab", { name: /passphrase login/i });
    fireEvent.click(passphraseTab);

    // Form inputs must be queryable by their associated accessible labels
    const identifierInput = screen.getByLabelText(/email or public key/i);
    expect(identifierInput).toBeInTheDocument();
    expect(identifierInput).toHaveAttribute("aria-required", "true");
    expect(identifierInput).toHaveAttribute("aria-describedby", "login-identifier-hint");

    const passphraseInput = screen.getByLabelText(/passphrase or backup secret/i);
    expect(passphraseInput).toBeInTheDocument();
    expect(passphraseInput).toHaveAttribute("aria-required", "true");
    expect(passphraseInput).toHaveAttribute("aria-describedby", "login-passphrase-hint");

    const rememberCheckbox = screen.getByLabelText(/remember this device/i);
    expect(rememberCheckbox).toBeInTheDocument();
  });

  it("announces validation errors in an accessible role='alert' live region", async () => {
    renderWithIntl(<LoginPageClient />);
    const passphraseTab = screen.getByRole("tab", { name: /passphrase login/i });
    fireEvent.click(passphraseTab);

    const submitBtn = screen.getByRole("button", { name: /sign in to your account/i });
    fireEvent.click(submitBtn);

    // Error alert should appear with role="alert" and aria-live="assertive"
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent(/please enter your email or stellar public key/i);

    // Fill identifier and submit again
    const identifierInput = screen.getByLabelText(/email or public key/i);
    fireEvent.change(identifierInput, { target: { value: "test@domain.com" } });
    fireEvent.click(submitBtn);

    const alertPassphrase = await screen.findByRole("alert");
    expect(alertPassphrase).toHaveTextContent(/please enter your credential passphrase/i);
  });

  it("shows connected wallet status when wallet is connected", () => {
    mockWalletState = {
      address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      connecting: false,
      error: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      networkMismatch: false,
    };

    renderWithIntl(<LoginPageClient />);
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent(/connected as GBBB...BBBB/i);
    expect(screen.getByRole("link", { name: /proceed to holder dashboard/i })).toBeInTheDocument();
  });
});

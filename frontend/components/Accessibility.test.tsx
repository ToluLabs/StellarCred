import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletButton } from "./WalletButton";
import { ThemeToggle } from "./ThemeToggle";
import CopyButton from "./CopyButton";
import { ProofProgress } from "./ProofProgress";
import { Timeline } from "./Timeline";
import { Modal } from "./Modal";
import { ToastProvider, useToast } from "./Toast";
import { TransferExportModal } from "./TransferExportModal";
import { TransferImportModal } from "./TransferImportModal";

// Mock wallet to prevent freighter-api ESM/CJS resolution issues in vitest
vi.mock("@/lib/wallet", () => ({
  signTx: vi.fn(),
  getAddress: vi.fn(),
  isConnected: vi.fn(),
}));

// Mock wallet context
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    address: null,
    connecting: false,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

describe("Accessibility Pass - Components ARIA Semantics", () => {
  it("WalletButton renders with accessible label", () => {
    render(<WalletButton />);
    const button = screen.getByRole("button", { name: /connect wallet/i });
    expect(button).toBeInTheDocument();
  });

  it("ThemeToggle renders with button role and aria-label", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /switch to/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed");
  });

  it("CopyButton renders with accessible label", () => {
    render(<CopyButton value="test-copy" />);
    const button = screen.getByRole("button", { name: /copy/i });
    expect(button).toBeInTheDocument();
  });

  it("ProofProgress exposes list semantics and active step indicator", () => {
    render(
      <ProofProgress
        steps={[
          { label: "Step 1", status: "done" },
          { label: "Step 2", status: "active" },
          { label: "Step 3", status: "pending" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: /proof progress/i });
    expect(list).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveAttribute("aria-current", "step");
  });

  it("Timeline exposes list semantics and link labels", () => {
    render(
      <Timeline
        events={[
          { stage: "issued", timestamp: 1700000000 },
          { stage: "submitted", timestamp: 1700000100, txHash: "0123456789abcdef0123456789abcdef" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: /proof event history/i });
    expect(list).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /view transaction/i });
    expect(link).toBeInTheDocument();
  });

  it("Modal exposes role='dialog', aria-modal='true', labels by title, and closes on Escape", () => {
    const handleClose = vi.fn();
    render(
      <Modal title="Test Modal" onClose={handleClose}>
        <div>Modal Content</div>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: /test modal/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it("TransferExportModal exposes dialog role and labelled form fields", () => {
    const handleClose = vi.fn();
    render(
      <TransferExportModal
        cred={{
          type: "age",
          title: "Age Over 18",
          claim: "18+",
          issuer: "StellarCred Demo Issuer",
          issuerId: "GBBB",
          holder: "GAAA",
          value: "20",
          salt: "0x123",
          commitment: "0x123",
          sig: [1, 2, 3],
          issuerPubX: [1, 2, 3],
          issuerPubY: [1, 2, 3],
          issuedAt: 1700000000,
          expiry: "30 days",
        }}
        onClose={handleClose}
      />
    );
    const dialog = screen.getByRole("dialog", { name: /transfer credential/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText(/^passphrase$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm passphrase/i)).toBeInTheDocument();
  });

  it("TransferImportModal exposes dialog role and labelled form fields", () => {
    const handleClose = vi.fn();
    const handleImported = vi.fn();
    render(
      <TransferImportModal
        payload="v1.testpayload"
        onImported={handleImported}
        onClose={handleClose}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: /import credential/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText(/^passphrase$/i)).toBeInTheDocument();
  });

  it("ToastProvider announces status messages with role='status' and aria-live", () => {
    function TestConsumer() {
      const toast = useToast();
      return (
        <button onClick={() => toast.success("Proof generated successfully")}>
          Trigger Toast
        </button>
      );
    }

    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /trigger toast/i }));
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toBeInTheDocument();
    expect(statusRegion).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Proof generated successfully")).toBeInTheDocument();
  });
});


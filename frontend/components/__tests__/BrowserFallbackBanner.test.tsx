import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrowserFallbackBanner } from "../BrowserFallbackBanner";
import * as hookModule from "@/lib/hooks/useBrowserCompatibility";
import type { CapabilityIssue } from "@/lib/browser-compatibility";

describe("BrowserFallbackBanner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when there are no active issues", () => {
    vi.spyOn(hookModule, "useBrowserCompatibility").mockReturnValue({
      report: {
        isCompatible: true,
        hasBlockingIssues: false,
        hasDegradedIssues: false,
        capabilities: {
          crypto: true,
          subtleCrypto: true,
          webAssembly: true,
          webWorker: true,
          storage: true,
          secureContext: true,
          walletExtension: true,
          webUsb: true,
        },
        issues: [],
        summary: "All required browser capabilities are supported.",
      },
      activeIssues: [],
      dismissedKeys: [],
      dismissIssue: vi.fn(),
      dismissAll: vi.fn(),
      resetDismissals: vi.fn(),
      recheck: vi.fn(),
      isFallbackActive: false,
    });

    const { container } = render(<BrowserFallbackBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders friendly fallback warning when blocking issues are detected", () => {
    const mockIssue: CapabilityIssue = {
      id: "webAssembly",
      name: "WebAssembly",
      severity: "error",
      title: "WebAssembly not supported",
      description: "Zero-knowledge proof verification requires WebAssembly.",
      impact: "Client-side ZK proof generation cannot run.",
      actionableSteps: [
        "Switch to a browser that supports WebAssembly (Chrome, Firefox, Safari, Edge).",
        "Use Preview Mode to explore credential schemas safely.",
      ],
      fallbackAvailable: true,
      fallbackModeDescription: "ZK Prover Fallback: Preview Mode is active.",
      actions: [{ label: "Use Preview Mode", type: "preview-mode" }],
    };

    const mockDismissAll = vi.fn();
    const mockDismissIssue = vi.fn();
    const mockRecheck = vi.fn();

    vi.spyOn(hookModule, "useBrowserCompatibility").mockReturnValue({
      report: {
        isCompatible: false,
        hasBlockingIssues: true,
        hasDegradedIssues: false,
        capabilities: {
          crypto: true,
          subtleCrypto: true,
          webAssembly: false,
          webWorker: true,
          storage: true,
          secureContext: true,
          walletExtension: false,
          webUsb: false,
        },
        issues: [mockIssue],
        summary: "Critical browser capabilities missing.",
      },
      activeIssues: [mockIssue],
      dismissedKeys: [],
      dismissIssue: mockDismissIssue,
      dismissAll: mockDismissAll,
      resetDismissals: vi.fn(),
      recheck: mockRecheck,
      isFallbackActive: true,
    });

    render(<BrowserFallbackBanner />);

    // Check accessible alert container
    const alert = screen.getByRole("alert");
    expect(alert).toBeDefined();

    // Check title and reassuring guidance
    expect(screen.getByText("Unsupported Browser Capabilities Detected")).toBeDefined();
    expect(screen.getByText(/continue safely in Preview Mode/i)).toBeDefined();

    // Check preview mode action link
    const previewLink = screen.getByRole("link", { name: /Preview Mode/i });
    expect(previewLink).toBeDefined();
    expect(previewLink.getAttribute("href")).toBe("/holder");

    // Check expandable details
    const detailsBtn = screen.getByRole("button", { name: /View details/i });
    expect(detailsBtn).toBeDefined();
    fireEvent.click(detailsBtn);

    // Verify detailed issue explanation and actionable steps are now visible
    expect(screen.getByText("WebAssembly not supported")).toBeDefined();
    expect(screen.getByText("Client-side ZK proof generation cannot run.")).toBeDefined();
    expect(screen.getByText(/Switch to a browser that supports WebAssembly/i)).toBeDefined();
    expect(screen.getByText(/ZK Prover Fallback: Preview Mode is active/i)).toBeDefined();

    // Test dismiss issue
    const dismissItemBtn = screen.getByRole("button", { name: /Dismiss this item/i });
    fireEvent.click(dismissItemBtn);
    expect(mockDismissIssue).toHaveBeenCalledWith("webAssembly");

    // Test retry
    const retryBtn = screen.getByRole("button", { name: /Retry/i });
    fireEvent.click(retryBtn);
    expect(mockRecheck).toHaveBeenCalled();

    // Test dismiss all
    const dismissAllBtn = screen.getByRole("button", {
      name: /Dismiss compatibility warning/i,
    });
    fireEvent.click(dismissAllBtn);
    expect(mockDismissAll).toHaveBeenCalled();
  });
});

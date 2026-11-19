import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BrowserCapabilityBanner } from "./BrowserCapabilityBanner";
import * as capabilities from "@/lib/browser-capabilities";

function mockCapabilities(overrides: Partial<capabilities.BrowserCapabilities>) {
  vi.spyOn(capabilities, "checkBrowserCapabilities").mockReturnValue({
    checks: [],
    isFullySupported: true,
    hasBasicSupport: true,
    unsupportedCritical: [],
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BrowserCapabilityBanner", () => {
  it("renders nothing when everything is supported", () => {
    mockCapabilities({
      checks: [{ name: "WebAssembly", supported: true, critical: true, hasFallback: false }],
    });
    render(<BrowserCapabilityBanner />);

    expect(screen.queryByTestId("browser-capability-banner")).toBeNull();
  });

  it("shows a critical alert listing the unsupported critical features", () => {
    const wasm: capabilities.CapabilityCheck = {
      name: "WebAssembly",
      supported: false,
      error: "WebAssembly is not available in this browser",
      critical: true,
      hasFallback: false,
    };
    mockCapabilities({
      checks: [wasm],
      isFullySupported: false,
      hasBasicSupport: false,
      unsupportedCritical: [wasm],
    });
    render(<BrowserCapabilityBanner />);

    const banner = screen.getByRole("alert");
    expect(banner).toHaveAttribute("data-severity", "critical");
    expect(banner).toHaveTextContent("Browser not supported");
    expect(banner).toHaveTextContent("WebAssembly is not available in this browser");
  });

  it("shows a non-blocking warning with fallback details for non-critical gaps", () => {
    mockCapabilities({
      checks: [
        {
          name: "Web Workers",
          supported: false,
          error: "Web Workers are not available in this browser",
          critical: false,
          hasFallback: true,
          fallbackDescription: "Proof generation will run on the main thread",
        },
        { name: "WebAssembly", supported: true, critical: true, hasFallback: false },
      ],
    });
    render(<BrowserCapabilityBanner />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("data-severity", "warning");
    expect(banner).toHaveTextContent("Limited browser support");
    expect(banner).toHaveTextContent("Proof generation will run on the main thread");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("can be dismissed and notifies the caller", () => {
    mockCapabilities({
      checks: [{ name: "Web Workers", supported: false, critical: false, hasFallback: true }],
    });
    const onDismiss = vi.fn();
    render(<BrowserCapabilityBanner onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("browser-capability-banner")).toBeNull();
  });
});

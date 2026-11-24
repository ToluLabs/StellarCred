import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/lib/test-utils";
import { WalletReconnectBanner } from "@/components/WalletReconnectBanner";
import { WalletProvider, useWallet, WALLET_SESSION_HEARTBEAT_MS } from "@/lib/wallet-context";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    connect: vi.fn(),
    restore: vi.fn(),
    hasLiveWalletSession: vi.fn(),
    getNetworkOk: vi.fn(),
    getLedger: vi.fn(),
  },
}));

vi.mock("@/lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wallet")>();
  return {
    ...actual,
    connect: mocks.connect,
    restore: mocks.restore,
    hasLiveWalletSession: mocks.hasLiveWalletSession,
    getNetworkOk: mocks.getNetworkOk,
    getLedger: mocks.getLedger,
  };
});

const TEST_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function InProgressPresentationForm() {
  const { address, connect } = useWallet();
  const [value, setValue] = React.useState("");

  return (
    <section>
      <label>
        Presentation note
        <input value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <span aria-label="Current wallet address">{address}</span>
      <button type="button" onClick={() => void connect()}>
        Connect for test
      </button>
    </section>
  );
}

function renderWalletApp() {
  return renderWithIntl(
    <WalletProvider>
      <WalletReconnectBanner />
      <InProgressPresentationForm />
    </WalletProvider>,
  );
}

async function connectWallet() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Connect for test" }));
  });
}

describe("wallet session heartbeat and reconnect banner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T00:00:00.000Z"));
    window.localStorage.clear();
    mocks.connect.mockReset().mockResolvedValue({
      address: TEST_ADDRESS,
      walletId: "freighter",
    });
    mocks.restore.mockReset();
    mocks.hasLiveWalletSession.mockReset().mockResolvedValue(true);
    mocks.getNetworkOk.mockReset().mockResolvedValue(true);
    mocks.getLedger.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("warns after a failed heartbeat, counts down, and preserves the active form when the wallet recovers", async () => {
    renderWalletApp();
    const input = screen.getByRole("textbox", { name: "Presentation note" });
    fireEvent.change(input, { target: { value: "Keep this disclosure selection" } });
    await connectWallet();

    expect(screen.getByLabelText("Current wallet address").textContent).toBe(TEST_ADDRESS);
    mocks.hasLiveWalletSession.mockResolvedValue(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WALLET_SESSION_HEARTBEAT_MS);
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Wallet connection lost. Your current form is still open.",
    );
    expect(screen.getByText("Reconnect within 60 seconds.")).toBeTruthy();
    expect(input).toHaveValue("Keep this disclosure selection");
    expect(screen.getByLabelText("Current wallet address").textContent).toBe(TEST_ADDRESS);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText("Reconnect within 30 seconds.")).toBeTruthy();

    mocks.hasLiveWalletSession.mockResolvedValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WALLET_SESSION_HEARTBEAT_MS);
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(input).toHaveValue("Keep this disclosure selection");
    expect(screen.getByLabelText("Current wallet address").textContent).toBe(TEST_ADDRESS);
  });

  it("keeps the form mounted after the grace period and reconnects in place", async () => {
    renderWalletApp();
    const input = screen.getByRole("textbox", { name: "Presentation note" });
    fireEvent.change(input, { target: { value: "Preserve my presentation" } });
    await connectWallet();
    mocks.hasLiveWalletSession.mockResolvedValue(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WALLET_SESSION_HEARTBEAT_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Wallet session timed out. Your current form is still open.",
    );
    expect(input).toHaveValue("Preserve my presentation");

    mocks.hasLiveWalletSession.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reconnect wallet" }));
    });

    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).toBeNull();
    expect(input).toHaveValue("Preserve my presentation");
    expect(screen.getByLabelText("Current wallet address").textContent).toBe(TEST_ADDRESS);
  });
});

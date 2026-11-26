import { act, screen } from "@testing-library/react";
import { renderWithIntl } from "@/lib/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./Toast";

function ToastControls() {
  const toast = useToast();
  return (
    <div>
      <button onClick={() => toast.info("Repeated message")}>info</button>
      <button onClick={() => toast.success("Success")}>success</button>
      <button onClick={() => toast.error("Failure")}>error</button>
    </div>
  );
}

function renderToasts() {
  return renderWithIntl(
    <ToastProvider>
      <ToastControls />
    </ToastProvider>,
  );
}

describe("ToastProvider", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("caps the visible stack and coalesces consecutive duplicates", () => {
    renderToasts();
    const info = screen.getByRole("button", { name: "info" });
    const success = screen.getByRole("button", { name: "success" });
    const error = screen.getByRole("button", { name: "error" });

    act(() => {
      info.click();
      info.click();
      success.click();
      error.click();
    });

    expect(screen.getAllByRole("button", { name: "Dismiss notification" })).toHaveLength(3);
    expect(screen.getByText("Repeated message").closest(".toast-message")).toHaveTextContent(
      "Repeated message (2)",
    );
  });

  it("refreshes the timer when a duplicate arrives", () => {
    renderToasts();
    const info = screen.getByRole("button", { name: "info" });

    act(() => info.click());
    act(() => vi.advanceTimersByTime(4000));
    act(() => info.click());
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByText("Repeated message")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3500));
    expect(screen.queryByText("Repeated message")).not.toBeInTheDocument();
  });

  it("announces normal toasts politely and errors assertively", () => {
    renderToasts();
    const info = screen.getByRole("button", { name: "info" });
    const error = screen.getByRole("button", { name: "error" });

    act(() => info.click());
    expect(screen.getByRole("status", { name: "Notifications" })).toHaveAttribute(
      "aria-live",
      "polite",
    );

    act(() => error.click());
    expect(screen.getByRole("status", { name: "Notifications" })).toHaveAttribute(
      "aria-live",
      "assertive",
    );
  });
});

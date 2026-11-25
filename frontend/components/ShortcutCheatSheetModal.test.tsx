import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/lib/test-utils";
import { ShortcutCheatSheetModal } from "./ShortcutCheatSheetModal";

describe("ShortcutCheatSheetModal", () => {
  it("renders navigation, triage, and general shortcuts and closes on Escape", () => {
    const onClose = vi.fn();
    renderWithIntl(<ShortcutCheatSheetModal onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeInTheDocument();
    expect(screen.getByText(/focus credential search/i)).toBeInTheDocument();
    expect(screen.getByText(/next credential/i)).toBeInTheDocument();
    expect(screen.getByText(/view details for active credential/i)).toBeInTheDocument();
    expect(screen.getByText(/show keyboard shortcuts/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

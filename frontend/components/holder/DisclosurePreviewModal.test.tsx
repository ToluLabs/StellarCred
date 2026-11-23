import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Credential } from "@/lib/credential";
import { DisclosurePreviewModal } from "./DisclosurePreviewModal";

const HOLDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const NOW = new Date("2026-11-22T12:00:00Z");

function cred(overrides: Partial<Credential> = {}): Credential {
  return {
    type: "age",
    title: "Age Verified",
    claim: "age ≥ 18",
    issuer: "StellarCred Authority",
    issuerId: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2",
    holder: HOLDER,
    // A date of birth stored as days since the epoch; must never render.
    value: "9301",
    salt: "0x5a17c0ffee",
    commitment: "0xaaaa1111bbbb2222",
    sig: [1, 2, 3],
    issuerPubX: [4],
    issuerPubY: [5],
    issuedAt: 1_700_000_000,
    expiry: "90 days",
    claimParams: { threshold_years: "18" },
    ...overrides,
  };
}

function renderModal(creds: Credential[]) {
  const onApprove = vi.fn();
  const onCancel = vi.fn();
  render(
    <DisclosurePreviewModal
      creds={creds}
      holder={HOLDER}
      onApprove={onApprove}
      onCancel={onCancel}
      now={NOW}
    />,
  );
  return { onApprove, onCancel };
}

describe("DisclosurePreviewModal", () => {
  it("opens as a labelled dialog with the shared and private columns side by side", () => {
    renderModal([cred()]);

    expect(screen.getByRole("dialog", { name: "Review what you'll share" })).toBeInTheDocument();

    const shared = screen.getByRole("region", { name: "Shared publicly: Age Verified" });
    const kept = screen.getByRole("region", { name: "Kept private: Age Verified" });

    expect(within(shared).getByText("Shared Publicly")).toBeInTheDocument();
    expect(within(kept).getByText("Kept Private")).toBeInTheDocument();

    // The disclosed claim, proof date and wallet are in the shared column.
    expect(within(shared).getByText("age ≥ 18")).toBeInTheDocument();
    expect(within(shared).getByText("2026-11-22")).toBeInTheDocument();
    expect(within(shared).getByText("GAAA…AWHF")).toBeInTheDocument();

    // The attribute and secrets are in the private column, not the shared one.
    expect(within(kept).getByText("Date of birth")).toBeInTheDocument();
    expect(within(kept).getByText("Commitment salt")).toBeInTheDocument();
    expect(within(kept).getByText("Issuer signature")).toBeInTheDocument();
    expect(within(shared).queryByText("Date of birth")).not.toBeInTheDocument();
  });

  it("marks shared rows as shared and gives every private row a lock icon", () => {
    renderModal([cred()]);

    const shared = screen.getByRole("region", { name: "Shared publicly: Age Verified" });
    const kept = screen.getByRole("region", { name: "Kept private: Age Verified" });
    const sharedRows = within(shared).getAllByRole("listitem");
    const privateRows = within(kept).getAllByRole("listitem");

    expect(sharedRows.length).toBeGreaterThan(0);
    for (const row of sharedRows) {
      expect(row).toHaveAttribute("data-visibility", "shared");
    }
    expect(privateRows).toHaveLength(3);
    for (const row of privateRows) {
      expect(row).toHaveAttribute("data-visibility", "private");
      expect(within(row).getByTestId("private-lock").querySelector("svg")).not.toBeNull();
    }
  });

  it("never renders the private attribute value or salt", () => {
    renderModal([cred()]);

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("9301");
    expect(text).not.toContain("0x5a17c0ffee");
  });

  it("starts nothing until the holder approves", () => {
    const { onApprove, onCancel } = renderModal([cred()]);

    expect(onApprove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Approve & generate proof" }));

    expect(onApprove).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels from the Cancel button, the close button and Escape", () => {
    const { onApprove, onCancel } = renderModal([cred()]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("shows one diff per credential in a batch", () => {
    const { onApprove } = renderModal([
      cred(),
      cred({
        type: "income",
        title: "Accredited (Income)",
        commitment: "0xcccc3333dddd4444",
        claimParams: undefined,
      }),
    ]);

    expect(
      screen.getByRole("region", { name: "Shared publicly: Age Verified" }),
    ).toBeInTheDocument();
    const income = screen.getByRole("region", { name: "Kept private: Accredited (Income)" });
    expect(within(income).getByText("Annual income (USD)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve & generate 2 proofs" }));
    expect(onApprove).toHaveBeenCalledOnce();
  });
});

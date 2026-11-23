/**
 * Regression tests for the WCAG 2.1 AA audit of credential cards, modals and
 * verification status animations (#1045).
 *
 * Covers: focus trapping / Escape / focus restore in dialogs (SC 2.1.2,
 * 2.4.3), dialog names and roles (SC 4.1.2), accessible names for icon-only
 * controls (SC 1.1.1, 2.4.6, 4.1.2), card/field semantics (SC 1.3.1), and
 * status announcements plus reduced-motion handling for progress animations
 * (SC 4.1.3, 2.3.3).
 */
import { useRef, useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/lib/test-utils";
import { getFocusableElements, useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { Modal } from "./Modal";
import { CredentialCard } from "./CredentialCard";
import CredentialDetailModal from "./CredentialDetailModal";
import { ConfirmRemoveModal } from "./holder/ConfirmRemoveModal";
import { CredCard } from "./holder/CredCard";
import { AnimatedDots, ProofProgress, ProvingBar } from "./holder/ProgressWidgets";
import { VerifyDoneView } from "./verify/VerifyDoneView";
import type { Credential } from "@/lib/credential";

vi.mock("@/lib/useProofTimeline", () => ({
  useProofTimeline: () => ({ events: [] }),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, proofSubmissionConfigured: () => true };
});

function tab(shift = false) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey: shift });
}

// ── useFocusTrap ──────────────────────────────────────────────────────────────

function TrapHarness({ onEscape }: { onEscape: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape });
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-label="Harness">
      <button>First</button>
      <button disabled>Disabled</button>
      <button tabIndex={-1}>Programmatic only</button>
      <div hidden>
        <button>Hidden</button>
      </div>
      <button>Last</button>
    </div>
  );
}

function TrapToggle() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && <TrapHarness onEscape={() => setOpen(false)} />}
    </>
  );
}

describe("useFocusTrap", () => {
  it("skips disabled, tabindex=-1 and hidden elements", () => {
    render(<TrapHarness onEscape={() => {}} />);
    const names = getFocusableElements(screen.getByRole("dialog")).map((el) => el.textContent);
    expect(names).toEqual(["First", "Last"]);
  });

  it("focuses the first control on open and wraps Tab in both directions", () => {
    render(<TrapHarness onEscape={() => {}} />);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(first).toHaveFocus();

    tab(true);
    expect(last).toHaveFocus();
    tab();
    expect(first).toHaveFocus();
  });

  it("pulls focus back inside when it has escaped the container", () => {
    render(
      <>
        <button>Outside</button>
        <TrapHarness onEscape={() => {}} />
      </>,
    );
    screen.getByRole("button", { name: "Outside" }).focus();
    tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger", () => {
    render(<TrapToggle />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

// ── Modals ────────────────────────────────────────────────────────────────────

describe("Modal (shared dialog)", () => {
  it("is a named modal dialog that traps focus and closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Share credential" onClose={onClose}>
        <button>Inner action</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Share credential" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();

    const close = within(dialog).getByRole("button", { name: "Close" });
    const inner = within(dialog).getByRole("button", { name: "Inner action" });
    inner.focus();
    tab();
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

const detailCredential = {
  type: "age",
  title: "Age over 18",
  claim: "age >= 18",
  issuer: "Demo Issuer",
  issuerId: "GISSUER",
  commitment: "0xabc123",
  issuedAt: 1_700_000_000,
  expiry: "30 days",
};

describe("CredentialDetailModal", () => {
  it("is labelled by its heading and exposes fields as a description list", () => {
    renderWithIntl(<CredentialDetailModal credential={detailCredential} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const heading = within(dialog).getByRole("heading", { level: 2 });
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    expect(dialog).toHaveAccessibleName(heading.textContent!);

    const terms = dialog.querySelectorAll("dl dt");
    const defs = dialog.querySelectorAll("dl dd");
    expect(terms.length).toBeGreaterThanOrEqual(7);
    expect(defs.length).toBe(terms.length);
  });

  it("traps focus, closes on Escape and restores focus", () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = renderWithIntl(
      <CredentialDetailModal credential={detailCredential} onClose={onClose} />,
    );
    const dialog = screen.getByRole("dialog");
    const focusable = getFocusableElements(dialog);
    expect(focusable[0]).toHaveFocus();

    tab(true);
    expect(focusable[focusable.length - 1]).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});

describe("ConfirmRemoveModal", () => {
  it("is an alertdialog named and described by its text, focused on Cancel", () => {
    render(
      <ConfirmRemoveModal
        count={2}
        label="Remove credentials?"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Remove credentials?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/permanently remove 2 credentials/i);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("keeps Tab inside and cancels on Escape", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmRemoveModal
        count={1}
        label="Remove credential?"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Confirm Delete" });
    // Shift+Tab from the first stop wraps to the last, Tab from the last wraps back.
    tab(true);
    expect(confirm).toHaveFocus();
    tab();
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ── Credential cards ──────────────────────────────────────────────────────────

describe("CredentialCard", () => {
  it("is a named article whose fields are a description list", () => {
    render(
      <CredentialCard
        issuer="Demo Bank"
        type="Proof of balance"
        holder="GABC…XYZ"
        fields={[
          { label: "Balance", value: null },
          { label: "Country", value: "NG" },
        ]}
        proofHash="0x1234567890abcdef1234567890abcdef"
      />,
    );
    const card = screen.getByRole("article", {
      name: "Proof of balance credential issued by Demo Bank",
    });
    expect(card.querySelectorAll("dl dt")).toHaveLength(2);
    expect(card.querySelectorAll("dl dd")).toHaveLength(2);
    // Hidden field explains itself to screen readers instead of a lock glyph.
    expect(within(card).getByText(/not disclosed by the proof/i)).toHaveClass("sr-only");
    expect(within(card).getByText(/proof hash/i)).toHaveClass("sr-only");
  });
});

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    type: "age",
    title: "Age over 18",
    claim: "age >= 18",
    issuer: "Demo Issuer",
    issuerId: "GISSUER",
    commitment: "0xabc1234567890",
    issuedAt: Math.floor(Date.now() / 1000),
    expiry: "30 days",
    ...overrides,
  } as Credential;
}

describe("CredCard (holder)", () => {
  it("is an article labelled by its title heading", () => {
    render(
      <CredCard c={makeCredential()} address="GADDR" onProve={() => {}} onRemove={() => {}} />,
    );
    const heading = screen.getByRole("heading", { level: 3, name: "Age over 18" });
    const card = screen.getByRole("article", { name: "Age over 18" });
    expect(card).toContainElement(heading);
  });

  it("gives every icon-only control an accessible name that includes the credential", () => {
    const onInspect = vi.fn();
    const onRemove = vi.fn();
    render(
      <CredCard
        c={makeCredential()}
        address="GADDR"
        onProve={() => {}}
        onRemove={onRemove}
        onInspect={onInspect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View details for Age over 18" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Age over 18" }));
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });

  it("exposes the history toggle's expanded state and controlled region", () => {
    render(
      <CredCard c={makeCredential()} address="GADDR" onProve={() => {}} onRemove={() => {}} />,
    );
    const toggle = screen.getByRole("button", { name: /show proof history for age over 18/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("hidden");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName(/hide proof history/i);
    expect(region).not.toHaveAttribute("hidden");
  });
});

// ── Status animations ─────────────────────────────────────────────────────────

describe("Verification status animations", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ProofProgress (holder) exposes list semantics, the current step and step state", () => {
    render(
      <ProofProgress
        steps={[
          { label: "Witness", status: "done" },
          { label: "Prove", status: "active" },
          { label: "Submit", status: "error", error: "RPC unavailable" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Proof progress" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[0]).toHaveTextContent("(done)");
    expect(screen.getByRole("alert")).toHaveTextContent("RPC unavailable");
  });

  it("ProvingBar is a progressbar with a clamped value", () => {
    const { rerender } = render(<ProvingBar progress={42.4} />);
    const bar = screen.getByRole("progressbar", { name: "Proof generation progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    rerender(<ProvingBar progress={180} />);
    expect(bar).toHaveAttribute("aria-valuenow", "100");
  });

  it("AnimatedDots hides the cycling dots from assistive tech", () => {
    vi.useFakeTimers();
    render(<AnimatedDots text="Generating proof" />);
    const dots = screen.getByText(".");
    expect(dots).toHaveAttribute("aria-hidden", "true");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(dots).toHaveTextContent("..");
  });

  it("AnimatedDots stops animating when reduced motion is requested", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(<AnimatedDots text="Generating proof" />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    const dots = screen.getByText("...");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(dots).toHaveTextContent("...");
  });

  it("VerifyDoneView announces the outcome through a polite status region", () => {
    render(<VerifyDoneView requestingDomain="example.org" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Verified");
    expect(status).toHaveTextContent("Returning to example.org");
  });
});

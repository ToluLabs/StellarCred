// Presentation coverage for components/LedgerGuide.tsx (issue #1040): the
// guide must show the derivation path the device uses, every field that goes
// into a signature, the hash-signed (blind signing) warning with its reason,
// and the reconnect steps when the USB session drops.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LedgerGuide } from "./LedgerGuide";
import type { LedgerReview } from "@/lib/ledger-review";

const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function review(overrides: Partial<LedgerReview> = {}): LedgerReview {
  return {
    networkPassphrase: "Test SDF Network ; September 2015",
    envelopeHash: "a".repeat(64),
    fee: "12500",
    sequence: "4294967296",
    operationCount: 1,
    operationTypes: ["invokeHostFunction"],
    memo: null,
    timeBounds: { minTime: "0", maxTime: "0" },
    blindSigning: true,
    blindSigningReasons: [
      "The Ledger Stellar app can't fully render invokeHostFunction operations, so it asks you to confirm a hash instead of the operation details.",
    ],
    ...overrides,
  };
}

describe("LedgerGuide", () => {
  it("shows the default SEP-0005 derivation path and the connected address", () => {
    render(<LedgerGuide address={ADDRESS} />);

    expect(screen.getByText(/Ledger hardware wallet guide/i)).toBeInTheDocument();
    expect(screen.getAllByText(/44'\/148'\/0'/).length).toBeGreaterThan(0);
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByText(/ed25519 public key/i)).toBeInTheDocument();
  });

  it("explains each signature field when no envelope is being reviewed", () => {
    render(<LedgerGuide />);

    expect(screen.getByText("Envelope hash (SHA-256)")).toBeInTheDocument();
    expect(screen.getByText(/Derivation path/)).toBeInTheDocument();
    expect(screen.getByText(/Fee and sequence number/)).toBeInTheDocument();
    expect(screen.getByText(/Only the public key leaves the device/i)).toBeInTheDocument();
  });

  it("renders the live envelope review and warns when the device will hash-sign", () => {
    render(<LedgerGuide address={ADDRESS} review={review()} />);

    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("Test SDF Network ; September 2015")).toBeInTheDocument();
    expect(screen.getByText(/1 — invokeHostFunction/)).toBeInTheDocument();
    expect(screen.getByText(/Hash signing \(blind signing\)/i)).toBeInTheDocument();
    expect(screen.getByText(/can't fully render invokeHostFunction/i)).toBeInTheDocument();
    expect(screen.getByText(/matches the envelope hash above/i)).toBeInTheDocument();
  });

  it("says the operations are renderable when nothing is hash-signed", () => {
    render(
      <LedgerGuide
        review={review({
          operationTypes: ["payment"],
          blindSigning: false,
          blindSigningReasons: [],
        })}
      />,
    );

    expect(screen.queryByText(/Hash signing \(blind signing\)/i)).not.toBeInTheDocument();
    expect(screen.getByText(/can render every operation in this envelope/i)).toBeInTheDocument();
  });

  it("lists reconnect steps and never asks for the recovery phrase", () => {
    render(<LedgerGuide />);

    expect(screen.getByText(/Reopen the Stellar app/i)).toBeInTheDocument();
    expect(screen.getByText(/never asks for your recovery phrase/i)).toBeInTheDocument();
  });
});

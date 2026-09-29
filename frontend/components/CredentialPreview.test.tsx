import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialPreview } from "./CredentialPreview";

const holder = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const data = {
  issuerName: "StellarCred Authority",
  issuerId: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2",
  type: "income" as const,
  title: "Accredited (Income)",
  claimLabel: "income > $200,000",
  attributeLabel: "Annual income (USD)",
  attributeValue: "250000",
  holder,
  expiry: "90 days",
};

describe("CredentialPreview", () => {
  it("shows the exact attestation before signing", () => {
    render(<CredentialPreview data={data} onConfirm={vi.fn()} onBack={vi.fn()} busy={false} />);

    expect(screen.getByText("Credential type")).toBeInTheDocument();
    expect(screen.getByText("Accredited (Income)")).toBeInTheDocument();
    expect(screen.getByText("Claim / threshold")).toBeInTheDocument();
    expect(screen.getByText("income > $200,000")).toBeInTheDocument();
    expect(screen.getByText("$250,000")).toBeInTheDocument();
    expect(screen.getByText(holder)).toBeInTheDocument();
    expect(screen.getByText("90 days")).toBeInTheDocument();
    expect(screen.getByText(/hashed into a Poseidon2 commitment/i)).toBeInTheDocument();
    expect(screen.getByText(/stores only that commitment in its audit log/i)).toBeInTheDocument();
  });

  it("allows the issuer to go back or confirm signing", () => {
    const onBack = vi.fn();
    const onConfirm = vi.fn();
    render(<CredentialPreview data={data} onConfirm={onConfirm} onBack={onBack} busy={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByTestId("confirm-sign-btn"));

    expect(onBack).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

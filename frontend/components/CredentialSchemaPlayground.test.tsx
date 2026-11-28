import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CredentialSchemaPlayground from "./CredentialSchemaPlayground";

describe("CredentialSchemaPlayground", () => {
  it("renders with default preset and valid JSON-LD preview", () => {
    render(<CredentialSchemaPlayground />);

    expect(
      screen.getByRole("heading", { name: "Credential Schema Playground" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("schema-validation-badge")).toHaveTextContent("Valid JSON-LD");

    const preview = screen.getByTestId("jsonld-preview-code");
    expect(preview.textContent).toContain("ProofOfFundsCredential");
    expect(preview.textContent).toContain("balanceUsd");
    expect(preview.textContent).toContain("minThreshold");
  });

  it("loads another preset and updates live JSON-LD output", () => {
    render(<CredentialSchemaPlayground />);

    fireEvent.click(screen.getByRole("button", { name: "Jurisdiction Compliance" }));

    const preview = screen.getByTestId("jsonld-preview-code");
    expect(preview.textContent).toContain("JurisdictionCredential");
    expect(preview.textContent).toContain("countryCode");
    expect(preview.textContent).toContain("denylist");
  });

  it("adds and removes attributes and reflects validation errors immediately", () => {
    render(<CredentialSchemaPlayground />);

    fireEvent.click(screen.getByRole("button", { name: "+ Add Attribute" }));
    expect(screen.getByTestId("attribute-row-2")).toBeInTheDocument();

    const symbolInput = screen.getByLabelText("Claim Symbol");
    fireEvent.change(symbolInput, { target: { value: "invalid_too_long_sym" } });
    expect(screen.getByTestId("schema-validation-badge")).toHaveTextContent("1 error");

    fireEvent.click(screen.getByRole("button", { name: "Remove attribute attribute3" }));
    expect(screen.queryByTestId("attribute-row-2")).not.toBeInTheDocument();
  });

  it("validates live JSON-LD parsing and loads valid parsed schema into builder", () => {
    render(<CredentialSchemaPlayground />);

    fireEvent.click(screen.getByRole("tab", { name: "Live JSON-LD Parser" }));
    const textarea = screen.getByLabelText("Raw JSON-LD Input");

    fireEvent.change(textarea, { target: { value: "{ invalid json" } });
    expect(screen.getByTestId("parser-result")).toHaveTextContent("Invalid JSON syntax");
    expect(screen.getByRole("button", { name: "Load into Builder" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Age Gate (18+)" }));
    expect(screen.getByTestId("parser-result")).toHaveTextContent(
      "Parsed cleanly: AgeVerificationCredential",
    );
    expect(screen.getByRole("button", { name: "Load into Builder" })).not.toBeDisabled();
  });

  it("tests sample payloads live against StellarCred ZK constraints", () => {
    render(<CredentialSchemaPlayground />);

    fireEvent.click(screen.getByRole("tab", { name: "Test Sample Payload" }));
    expect(screen.getByTestId("payload-test-result")).toHaveTextContent("PASS");

    const payloadBox = screen.getByLabelText("Sample Credential Payload JSON");
    fireEvent.change(payloadBox, {
      target: {
        value: JSON.stringify({ balanceUsd: 100, accountVerified: true }),
      },
    });
    expect(screen.getByTestId("payload-test-result")).toHaveTextContent("FAIL");
  });
});

import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HumanDropPanel } from "./HumanDropPanel";
import { getProtocol, PROTOCOLS } from "@/lib/protocols";

const campaign = {
  campaignId: "drop1",
  scope: "stellarcred:airdrop:humandrop-2026",
  amountLabel: "250 XLM",
  credentialType: "kyc",
};

describe("apps gallery — HumanDrop airdrop demo", () => {
  it("is listed in the gallery with a nullifier-gated campaign", () => {
    const humandrop = getProtocol("humandrop");
    expect(PROTOCOLS.map((p) => p.id)).toContain("humandrop");
    expect(humandrop?.airdrop).toMatchObject({
      campaignId: "drop1",
      scope: "stellarcred:airdrop:humandrop-2026",
      credentialType: "kyc",
    });
  });

  it("derives the same nullifier for two wallets of the same human", async () => {
    render(<HumanDropPanel campaign={campaign} />);
    await waitFor(() => expect(screen.queryByText(/deriving…/)).not.toBeInTheDocument());

    const rendered = screen
      .getAllByText(/^nullifier /)
      .map((el) => el.textContent?.replace("nullifier ", "").trim());

    expect(rendered).toHaveLength(3);
    // Wallet 1 and wallet 2 are the same human → identical nullifier.
    expect(rendered[0]).toBe(rendered[1]);
    // A different human → a different nullifier.
    expect(rendered[2]).not.toBe(rendered[0]);
    // Matches the vector asserted by the contract test.
    expect(rendered[0]).toBe("ac90ac63…93a091");
  });

  it("rejects a second claim from another wallet of the same human", async () => {
    render(<HumanDropPanel campaign={campaign} />);
    await waitFor(() => expect(screen.queryByText(/deriving…/)).not.toBeInTheDocument());

    const claimButtons = () => screen.getAllByRole("button", { name: /Claim 250 XLM/ });

    // First wallet claims successfully.
    fireEvent.click(claimButtons()[0]);
    expect(await screen.findByText(/250 XLM sent/)).toBeInTheDocument();
    expect(screen.getByText(/Unique humans paid:/).textContent).toContain("1");

    // Second wallet — same human, different address — is refused.
    fireEvent.click(claimButtons()[1]);
    expect(await screen.findByText(/AlreadyClaimed/)).toBeInTheDocument();
    expect(screen.getByText(/Unique humans paid:/).textContent).toContain("1");

    // A different human can still claim.
    fireEvent.click(claimButtons()[2]);
    await waitFor(() =>
      expect(screen.getByText(/Unique humans paid:/).textContent).toContain("2"),
    );
  });
});

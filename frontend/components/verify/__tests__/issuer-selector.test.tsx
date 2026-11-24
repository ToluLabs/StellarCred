import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import type { CSSProperties } from "react";
import { renderWithIntl } from "@/lib/test-utils";
import { IssuerSelector } from "@/components/verify/IssuerSelector";
import type { RegisteredIssuer } from "@/lib/issuer-registry";

interface MockImageProps {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  sizes?: string;
  placeholder?: string;
  blurDataURL?: string;
  onError?: () => void;
  style?: CSSProperties;
}

// See components/__tests__/issuer-avatar.test.tsx for why next/image is stubbed.
vi.mock("next/image", () => ({
  default: (props: MockImageProps) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={props.src}
      alt={props.alt}
      width={props.width}
      height={props.height}
      data-sizes={props.sizes}
      data-placeholder={props.placeholder}
      data-blur={props.blurDataURL}
      onError={props.onError}
      style={props.style}
    />
  ),
}));

const ISSUERS: RegisteredIssuer[] = [
  {
    id: `G${"B".repeat(55)}`,
    name: "Globule Registry",
    pubkeyHex: "aa".repeat(64),
    credentialTypes: ["age", "kyc"],
    revoked: false,
    metadata: {
      name: "Globule Registry",
      url: "https://globule.example",
      logo: "https://logos.example/globule.png",
    },
  },
  {
    id: `G${"C".repeat(55)}`,
    name: "Third Trust",
    pubkeyHex: "bb".repeat(64),
    credentialTypes: ["age"],
    revoked: false,
    metadata: { name: "Third Trust", url: "https://third.example" },
  },
];

describe("IssuerSelector avatars (#1052)", () => {
  it("shows the logo for issuers that have one and a fallback avatar for the rest", () => {
    renderWithIntl(
      <IssuerSelector
        issuersForType={ISSUERS}
        selectedIssuerId={ISSUERS[0].id}
        setSelectedIssuerId={vi.fn()}
        anyAccepted
      />,
    );

    const logo = screen.getByRole("img", { name: "Globule Registry logo" });
    expect(logo.getAttribute("src")).toBe("https://logos.example/globule.png");
    expect(logo.getAttribute("data-placeholder")).toBe("blur");
    expect(logo.getAttribute("data-blur")).toMatch(/^data:image\/svg\+xml,/);

    const fallback = screen.getByRole("img", { name: "Third Trust avatar" });
    expect(fallback.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
  });

  it("still selects an issuer on click", () => {
    const setSelected = vi.fn();
    renderWithIntl(
      <IssuerSelector
        issuersForType={ISSUERS}
        selectedIssuerId={ISSUERS[0].id}
        setSelectedIssuerId={setSelected}
        anyAccepted
      />,
    );
    fireEvent.click(screen.getByText("Third Trust"));
    expect(setSelected).toHaveBeenCalledWith(ISSUERS[1].id);
    // The picked row renders its avatar too.
    expect(within(screen.getByRole("radiogroup")).getAllByRole("img")).toHaveLength(2);
  });
});

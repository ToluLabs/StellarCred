import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CSSProperties } from "react";
import { IssuerAvatar } from "@/components/IssuerAvatar";

interface MockImageProps {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  sizes?: string;
  placeholder?: string;
  blurDataURL?: string;
  priority?: boolean;
  onError?: () => void;
  style?: CSSProperties;
}

// next/image does real optimization work that jsdom cannot exercise; the
// stub keeps the props visible so the test can assert what IssuerAvatar
// asked for (blur placeholder, sizes, fixed dimensions, error fallback).
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

const PUBKEY_A = "aa".repeat(64);
const PUBKEY_B = "bb".repeat(64);
const LOGO = "https://logos.example/issuer.png";

describe("IssuerAvatar (#1052)", () => {
  it("renders the deterministic fallback avatar when there is no logo", () => {
    render(<IssuerAvatar publicKey={PUBKEY_A} name="Globule Registry" size={36} />);
    const img = screen.getByRole("img", { name: "Globule Registry avatar" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
    expect(img.getAttribute("width")).toBe("36");
    expect(img.getAttribute("height")).toBe("36");
    expect(img.getAttribute("data-sizes")).toBe("36px");
  });

  it("renders the same fallback for the same key and a different one for another key", () => {
    const { rerender } = render(<IssuerAvatar publicKey={PUBKEY_A} name="A" />);
    const first = screen.getByRole("img").getAttribute("src");
    rerender(<IssuerAvatar publicKey={PUBKEY_A} name="A" />);
    expect(screen.getByRole("img").getAttribute("src")).toBe(first);
    rerender(<IssuerAvatar publicKey={PUBKEY_B} name="B" />);
    expect(screen.getByRole("img").getAttribute("src")).not.toBe(first);
  });

  it("renders the remote logo with blur-up placeholder and fixed dimensions", () => {
    render(<IssuerAvatar logoUrl={LOGO} publicKey={PUBKEY_A} name="Globule Registry" size={36} />);
    const img = screen.getByRole("img", { name: "Globule Registry logo" });
    expect(img.getAttribute("src")).toBe(LOGO);
    expect(img.getAttribute("data-placeholder")).toBe("blur");
    expect(img.getAttribute("data-blur")).toMatch(/^data:image\/svg\+xml,/);
    expect(img.getAttribute("width")).toBe("36");
    expect(img.getAttribute("height")).toBe("36");
    expect(img.getAttribute("data-sizes")).toBe("36px");
  });

  it("falls back to the identicon when the logo fails to load", () => {
    render(<IssuerAvatar logoUrl={LOGO} publicKey={PUBKEY_A} name="Globule Registry" size={36} />);
    const img = screen.getByRole("img", { name: "Globule Registry logo" });
    fireEvent.error(img);
    const fallback = screen.getByRole("img", {
      name: "Globule Registry avatar",
    });
    expect(fallback.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
  });
});

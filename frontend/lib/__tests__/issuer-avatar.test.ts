import { describe, it, expect } from "vitest";
import {
  hashSeed,
  issuerAvatarColors,
  issuerIdenticonCells,
  identiconCellAt,
  issuerAvatarSvg,
  issuerAvatarDataUri,
  issuerBlurDataUri,
  pubkeyHexFromParts,
} from "@/lib/issuer-avatar";

const PUBKEY_A = "aa".repeat(64);
const PUBKEY_B = "bb".repeat(64);

describe("issuer avatars (#1052)", () => {
  it("hashes deterministically", () => {
    expect(hashSeed(PUBKEY_A)).toBe(hashSeed(PUBKEY_A));
    expect(hashSeed(PUBKEY_A)).not.toBe(hashSeed(PUBKEY_B));
    expect(hashSeed("")).toBe(hashSeed(""));
  });

  it("derives the same colors for the same key", () => {
    expect(issuerAvatarColors(PUBKEY_A)).toEqual(issuerAvatarColors(PUBKEY_A));
    expect(issuerAvatarColors(PUBKEY_A)).not.toEqual(issuerAvatarColors(PUBKEY_B));
    const { background, foreground } = issuerAvatarColors(PUBKEY_A);
    expect(background).toMatch(/^hsl\(\d+, 55%, 88%\)$/);
    expect(foreground).toMatch(/^hsl\(\d+, 65%, 42%\)$/);
  });

  it("derives the same identicon cells for the same key", () => {
    expect(issuerIdenticonCells(PUBKEY_A)).toEqual(issuerIdenticonCells(PUBKEY_A));
    expect(issuerIdenticonCells(PUBKEY_A)).not.toEqual(issuerIdenticonCells(PUBKEY_B));
    expect(issuerIdenticonCells(PUBKEY_A)).toHaveLength(15);
  });

  it("mirrors the identicon grid horizontally", () => {
    const cells = issuerIdenticonCells(PUBKEY_A);
    for (let row = 0; row < 5; row++) {
      expect(identiconCellAt(cells, row, 0)).toBe(identiconCellAt(cells, row, 4));
      expect(identiconCellAt(cells, row, 1)).toBe(identiconCellAt(cells, row, 3));
      expect(identiconCellAt(cells, row, 2)).toBe(identiconCellAt(cells, row, 2));
    }
  });

  it("renders a valid 5x5 SVG for a key", () => {
    const svg = issuerAvatarSvg(PUBKEY_A, 64);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 5 5"');
    expect(svg).toContain('width="64"');
    const rects = svg.match(/<rect x="[0-4]" y="[0-4]"/g) ?? [];
    expect(rects.length).toBeGreaterThan(0);
    expect(rects.length).toBeLessThanOrEqual(25);
    // Same key, same SVG; different key, different SVG.
    expect(issuerAvatarSvg(PUBKEY_A, 64)).toBe(svg);
    expect(issuerAvatarSvg(PUBKEY_B, 64)).not.toBe(svg);
  });

  it("produces a decodable SVG data URI", () => {
    const uri = issuerAvatarDataUri(PUBKEY_A, 64);
    expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(uri.slice("data:image/svg+xml,".length))).toBe(
      issuerAvatarSvg(PUBKEY_A, 64),
    );
  });

  it("produces a decodable blur placeholder data URI", () => {
    const uri = issuerBlurDataUri(PUBKEY_A);
    expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
    const svg = decodeURIComponent(uri.slice("data:image/svg+xml,".length));
    expect(svg).toContain("<linearGradient");
    expect(issuerBlurDataUri(PUBKEY_A)).toBe(uri);
    expect(issuerBlurDataUri(PUBKEY_B)).not.toBe(uri);
  });

  it("handles empty and non-hex seeds without throwing", () => {
    expect(() => issuerAvatarSvg("")).not.toThrow();
    expect(issuerAvatarSvg("")).toBe(issuerAvatarSvg(""));
    expect(issuerAvatarSvg("not-a-hex-key")).toBe(issuerAvatarSvg("not-a-hex-key"));
  });

  it("encodes a 64-byte pubkey (X || Y) as lowercase hex", () => {
    expect(pubkeyHexFromParts([0, 255, 16], [1])).toBe("00ff1001");
    expect(pubkeyHexFromParts(new Array(32).fill(0xaa), [])).toBe("aa".repeat(32));
    expect(pubkeyHexFromParts([], [])).toBe("");
    // Out-of-range bytes are masked, never throw.
    expect(pubkeyHexFromParts([256, -1], [])).toBe("00ff");
  });
});

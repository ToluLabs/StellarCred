/**
 * Deterministic issuer avatars (#1052).
 *
 * Issuer logos are remote URLs from on-chain metadata and may be missing or
 * fail to load, so every issuer also gets a deterministic SVG identicon
 * derived from its secp256k1 public key: the same key always renders the
 * same avatar, and different keys render different ones. The identicon is
 * pure data — no network, no layout shift — so it also doubles as the
 * blur-up placeholder while a remote logo loads.
 */

const GRID = 5; // 5x5 identicon, mirrored horizontally
const COLS = 3; // only the left 3 columns are random; the right 2 mirror them

/** FNV-1a 32-bit hash — small, deterministic, no dependencies. */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** xorshift32 PRNG seeded from the hash, for the identicon cells. */
function prng(seed: number): () => number {
  let s = seed === 0 ? 0x9e3779b9 : seed;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

/** Deterministic hue + colors for a seed string. */
export function issuerAvatarColors(seed: string): {
  background: string;
  foreground: string;
} {
  const hue = hashSeed(seed) % 360;
  return {
    background: `hsl(${hue}, 55%, 88%)`,
    foreground: `hsl(${hue}, 65%, 42%)`,
  };
}

/** 15 booleans (5 rows x 3 cols) for the left half of the identicon. */
export function issuerIdenticonCells(seed: string): boolean[] {
  const rand = prng(hashSeed(seed));
  const cells: boolean[] = [];
  for (let i = 0; i < GRID * COLS; i++) {
    cells.push(rand() > 0.5);
  }
  return cells;
}

/** Resolve a cell of the full 5-wide grid (right half mirrors the left). */
export function identiconCellAt(cells: boolean[], row: number, col: number): boolean {
  const mirrorCol = col < COLS ? col : GRID - 1 - col;
  return cells[row * COLS + mirrorCol];
}

/** Full SVG markup for the identicon. */
export function issuerAvatarSvg(seed: string, size = 64): string {
  const { background, foreground } = issuerAvatarColors(seed);
  const cells = issuerIdenticonCells(seed);
  let rects = "";
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      if (identiconCellAt(cells, row, col)) {
        rects += `<rect x="${col}" y="${row}" width="1" height="1" fill="${foreground}"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${GRID} ${GRID}"><rect width="${GRID}" height="${GRID}" fill="${background}"/>${rects}</svg>`;
}

/** Data URI for the identicon SVG (usable as an <img> src). */
export function issuerAvatarDataUri(seed: string, size = 64): string {
  return `data:image/svg+xml,${encodeURIComponent(issuerAvatarSvg(seed, size))}`;
}

/**
 * Tiny blurred colour-wash placeholder for next/image `blurDataURL`.
 * The remote logo's real pixels are unknown at render time, so the
 * placeholder is a soft gradient in the issuer's deterministic hue; the
 * blur filter on the <Image> smooths it into a blur-up effect while the
 * logo loads.
 */
export function issuerBlurDataUri(seed: string): string {
  const { background, foreground } = issuerAvatarColors(seed);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${background}"/><stop offset="1" stop-color="${foreground}"/></linearGradient></defs><rect width="8" height="8" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * 64-byte issuer pubkey (X || Y, each 32 bytes) as a lowercase hex string.
 * Non-byte values are masked to a byte so a malformed credential still
 * yields a stable seed instead of throwing.
 */
export function pubkeyHexFromParts(x: number[], y: number[]): string {
  return [...x, ...y].map((b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
}

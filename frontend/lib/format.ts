// Display formatting. Per the design system: wallet addresses are always
// truncated (first 4 + last 4), proof hashes (first 6 + last 4). Full values
// are only exposed on copy, never in a label.

export function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function truncateHash(hash: string): string {
  if (!hash) return hash;
  const h = hash.startsWith("0x") ? hash.slice(2) : hash;
  return `0x${h.slice(0, 6)}…${h.slice(-4)}`;
}

export function truncatePubkey(hex: string): string {
  if (!hex || hex.length <= 16) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

/**
 * Generic middle-truncation used when a shared helper's cut points don't fit:
 * keeps `head` leading + `tail` trailing characters separated by `separator`
 * ("…" by default). Values that fit whole are returned unchanged.
 */
export function truncateMiddle(
  value: string,
  head: number,
  tail: number,
  separator = "…",
): string {
  if (!value || value.length <= head + tail + separator.length) return value;
  return `${value.slice(0, head)}${separator}${value.slice(-tail)}`;
}

/**
 * Truncated transaction-hash label used for explorer links
 * ("ABCDEF12...XYZWXY", first 8 + last 6, ASCII "..."). One canonical
 * rendering instead of the per-component `slice` formulas it replaced.
 */
export function truncateTxHash(hash: string): string {
  if (!hash) return hash;
  return truncateMiddle(hash, 8, 6, "...");
}

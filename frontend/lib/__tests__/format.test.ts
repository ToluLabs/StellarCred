// Coverage for the shared display helpers in lib/format.ts that components
// previously re-implemented inline (per-component `slice` truncation
// formulas), consolidated as part of the duplicate-helper cleanup.

import { describe, it, expect } from "vitest";
import {
  truncateAddress,
  truncateHash,
  truncatePubkey,
  truncateMiddle,
  truncateTxHash,
} from "../format";

const ADDR = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // 56-char Stellar address

describe("pre-existing truncation helpers (unchanged contract)", () => {
  it("truncateAddress keeps 4+4", () => {
    expect(truncateAddress(ADDR)).toBe("GABC…4567");
    expect(truncateAddress("short")).toBe("short");
  });

  it("truncateHash keeps 6+4 with the 0x prefix", () => {
    expect(truncateHash("0xdeadbeefcafe1234")).toBe("0xdeadbe…1234");
    expect(truncateHash("")).toBe("");
  });

  it("truncatePubkey keeps 8+8", () => {
    expect(truncatePubkey("0011223344556677889900aabbccddeeff")).toBe(
      "00112233…ccddeeff",
    );
    expect(truncatePubkey("short")).toBe("short");
  });
});

describe("truncateMiddle", () => {
  it("keeps head leading and tail trailing chars joined by the separator", () => {
    expect(truncateMiddle("abcdefghij", 4, 3)).toBe("abcd…hij");
    expect(truncateMiddle("abcdefghij", 4, 3, "…")).toBe("abcd…hij");
  });

  it("returns short values unchanged", () => {
    // head(4) + tail(4) + separator(1) = 9  — length 9 fits exactly
    expect(truncateMiddle("123456789", 4, 4)).toBe("123456789");
    expect(truncateMiddle("1234567890", 4, 4)).toBe("1234…7890");
    expect(truncateMiddle("", 4, 4)).toBe("");
  });
});

describe("truncateTxHash", () => {
  it("renders explored tx hashes 8+6 with ASCII dots", () => {
    expect(truncateTxHash("abcdefghijklmnopqrstuvwxyz012345")).toBe(
      "abcdefgh...012345",
    );
  });

  it("returns empty/short hashes unchanged", () => {
    expect(truncateTxHash("")).toBe("");
    expect(truncateTxHash("ab")).toBe("ab");
  });
});

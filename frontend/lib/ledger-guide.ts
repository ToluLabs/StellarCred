/**
 * Device-independent Ledger facts shared by the hardware-wallet module, the
 * signing-review helper and the in-app guide (issue #1040).
 *
 * Kept free of any `@ledgerhq/*` or `@stellar/stellar-sdk` import so the guide
 * component can render on a page without pulling the device stack into that
 * route's bundle.
 */

/**
 * Stellar's BIP-44 coin type (SEP-0005). Ledger's Stellar app only derives
 * keys below `m/44'/148'/…'`; all three components are hardened.
 */
export const LEDGER_COIN_TYPE = 148;

/** SEP-0005's default account index for the first Stellar account. */
export const LEDGER_DEFAULT_ACCOUNT_INDEX = 0;

/** The derivation path Ledger's Stellar app uses when no SEP-43 path is given. */
export const LEDGER_DEFAULT_PATH = "44'/148'/0'";

/** Upper bound for a hardened BIP-32 index (2^31 - 1). */
const MAX_HARDENED_INDEX = 0x7fffffff;

export interface ParsedLedgerPath {
  purpose: number;
  coinType: number;
  accountIndex: number;
}

/**
 * Build the SEP-0005 derivation path for a Stellar account index, e.g.
 * `deriveLedgerPath(2) === "44'/148'/2'"`. Every component is hardened, which
 * is what the Ledger Stellar app expects.
 */
export function deriveLedgerPath(accountIndex: number = LEDGER_DEFAULT_ACCOUNT_INDEX): string {
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > MAX_HARDENED_INDEX) {
    throw new RangeError(
      `Ledger account index must be an integer between 0 and ${MAX_HARDENED_INDEX}, got ${String(accountIndex)}`,
    );
  }
  return `44'/${LEDGER_COIN_TYPE}'/${accountIndex}'`;
}

/**
 * Parse a hardened three-level Ledger path. Returns null for anything the
 * Stellar app would reject (wrong component count, unhardened indices,
 * non-numeric values) instead of silently coercing it.
 */
export function parseLedgerPath(path: string): ParsedLedgerPath | null {
  const match = /^(\d+)'\/(\d+)'\/(\d+)'$/.exec(path.trim());
  if (!match) return null;
  const [purpose, coinType, accountIndex] = match.slice(1).map(Number);
  if (
    !Number.isInteger(purpose) ||
    !Number.isInteger(coinType) ||
    !Number.isInteger(accountIndex) ||
    purpose > MAX_HARDENED_INDEX ||
    coinType > MAX_HARDENED_INDEX ||
    accountIndex > MAX_HARDENED_INDEX
  ) {
    return null;
  }
  return { purpose, coinType, accountIndex };
}

/** True when `path` is a path Ledger's Stellar app can derive from. */
export function isValidLedgerPath(path: string): boolean {
  return parseLedgerPath(path) !== null;
}

/**
 * The steps a Ledger shows in its own UI for the derivation, in order. Used by
 * the guide so the copy and the numbers come from one place.
 */
export function derivationSteps(accountIndex: number = LEDGER_DEFAULT_ACCOUNT_INDEX): string[] {
  return [
    `44' — BIP-44 purpose (hardened)`,
    `148' — Stellar coin type (hardened, SEP-0005)`,
    `${accountIndex}' — account index (hardened, default is 0)`,
  ];
}

/** What the user must do on the device before StellarCred can talk to it. */
export const LEDGER_SETUP_STEPS: readonly string[] = [
  "Connect the Ledger over USB (WebUSB needs a desktop browser: Chrome, Edge or Brave).",
  "Unlock the device with your PIN.",
  "Open the Stellar app on the device and leave it on screen for the whole session.",
  "If the device prompts for it, allow the browser's USB device permission for this site.",
];

/**
 * Recovery steps for the disconnect/reconnect path. The wallet layer retries a
 * dropped transport once on its own; these are the user-visible actions when
 * that is not enough.
 */
export const LEDGER_DISCONNECT_STEPS: readonly string[] = [
  "Reconnect the USB cable and unlock the device.",
  "Reopen the Stellar app — the device closes it when the transport drops.",
  "Click Retry. StellarCred re-opens the transport instead of reusing the dead session.",
  "If the browser no longer sees the device, unplug it, plug it back in, and reload this page.",
];

/**
 * Fields that make up a Stellar signature request. When the Ledger Stellar app
 * can decode the transaction it renders these itself; for operations it cannot
 * decode (Soroban host functions) it falls back to hash signing and shows only
 * the envelope hash, which is why the app surfaces the same values for review.
 */
export const BLIND_SIGNING_FIELDS: readonly { label: string; detail: string }[] = [
  {
    label: "Network passphrase",
    detail:
      "The passphrase the envelope is signed for. A signature for testnet is invalid on mainnet, and vice versa.",
  },
  {
    label: "Envelope hash (SHA-256)",
    detail:
      "The 32-byte hash of the transaction's signature base. This is the value the device signs and, for Soroban operations, the only value it can display.",
  },
  {
    label: "Derivation path",
    detail:
      "The account the key is derived from. StellarCred always signs with 44'/148'/0' unless the SEP-43 request names another path.",
  },
  {
    label: "Fee and sequence number",
    detail:
      "Both are part of the signed envelope. A changed fee or sequence produces a different hash, so the hash on the device would change too.",
  },
  {
    label: "Operations",
    detail:
      "Decodable operations (payments, contract invocations the app understands) are rendered on the device; anything else is shown as a hash to confirm.",
  },
];

/**
 * Human-readable review of the exact bytes a Ledger is asked to sign
 * (issue #1040).
 *
 * Ledger's Stellar app decodes the operations it understands and shows them on
 * the device. For everything else — principally Soroban host functions, which
 * is what every StellarCred proof submission is — it falls back to hash
 * signing and displays only a 32-byte hash. That screen is uninformative on
 * its own, so the app computes the same values locally and shows them next to
 * the device: the network passphrase, the SHA-256 envelope hash, fee, sequence,
 * operation list and time bounds. A user can then confirm that the hash on the
 * device matches the hash of the transaction they intended to submit.
 */

import { Transaction } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

/**
 * Operation types the Ledger Stellar app cannot render in full and therefore
 * presents as a hash to confirm. Keep this list in sync with the app's
 * supported-operation table; adding an operation type here only makes the
 * review *stricter*, never weaker.
 */
export const BLIND_SIGNED_OPERATION_TYPES: readonly string[] = [
  "invokeHostFunction",
  "extendFootprintTtl",
  "restoreFootprint",
  "createCustomContract",
];

/** True when the device can only show this operation as a hash. */
export function isBlindSignedOperation(type: string): boolean {
  return BLIND_SIGNED_OPERATION_TYPES.includes(type);
}

export interface LedgerTimeBounds {
  minTime: string;
  maxTime: string;
}

export interface LedgerReview {
  /** Network passphrase the envelope is signed for. */
  networkPassphrase: string;
  /** SHA-256 of the transaction's signature base, hex — what the device signs. */
  envelopeHash: string;
  /** Fee in stroops, as it appears in the signed envelope. */
  fee: string;
  /** Account sequence number, as it appears in the signed envelope. */
  sequence: string;
  operationCount: number;
  /** Operation type per operation, in envelope order. */
  operationTypes: string[];
  /** `null` when the envelope carries no memo. */
  memo: string | null;
  /** `null` when the envelope sets no time bounds. */
  timeBounds: LedgerTimeBounds | null;
  /** True when the device can only show a hash for at least one operation. */
  blindSigning: boolean;
  /** Why blind signing is required; empty when every operation is renderable. */
  blindSigningReasons: string[];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Render a memo the way the device/user would read it: text memos decode as
 *  UTF-8, hash/return memos stay hex, id memos stay numeric. */
function describeMemo(type: string, value: string | Buffer | null | undefined): string | null {
  if (type === "none") return null;
  if (value === null || value === undefined) return type;
  if (typeof value === "string") return `${type}: ${value}`;
  const bytes = Buffer.from(value);
  return type === "text"
    ? `${type}: ${bytes.toString("utf8")}`
    : `${type}: ${bytes.toString("hex")}`;
}

/**
 * Decode a transaction envelope and describe everything that goes into the
 * signature. Throws when the XDR cannot be parsed for the given network — a
 * review of the wrong envelope would be worse than no review at all.
 */
export function buildLedgerReview(xdrString: string, networkPassphrase: string): LedgerReview {
  let tx: Transaction;
  try {
    tx = new Transaction(xdrString, networkPassphrase);
  } catch (e) {
    throw new Error(`Unable to decode transaction for Ledger review: ${errorText(e)}`);
  }

  const operationTypes = tx.operations.map((op) => String(op.type));
  const blindTypes = Array.from(new Set(operationTypes.filter(isBlindSignedOperation)));

  const reasons: string[] = [];
  if (blindTypes.length > 0) {
    reasons.push(
      `The Ledger Stellar app can't fully render ${blindTypes.join(", ")} operation${
        blindTypes.length === 1 ? "" : "s"
      }, so it asks you to confirm a hash instead of the operation details.`,
    );
  }

  const memo = describeMemo(tx.memo.type, tx.memo.value);

  const bounds = tx.timeBounds;

  return {
    networkPassphrase,
    envelopeHash: tx.hash().toString("hex"),
    fee: String(tx.fee),
    sequence: String(tx.sequence),
    operationCount: operationTypes.length,
    operationTypes,
    memo,
    timeBounds: bounds
      ? { minTime: String(bounds.minTime), maxTime: String(bounds.maxTime) }
      : null,
    blindSigning: reasons.length > 0,
    blindSigningReasons: reasons,
  };
}

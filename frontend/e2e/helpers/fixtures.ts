/**
 * Deterministic E2E test fixtures.
 *
 * These credentials are injected into localStorage so tests can exercise
 * the Holder page, Apps page, and verify-redirect flow without hitting any
 * real APIs or the Stellar network.
 *
 * The three credentials intentionally cover all three status buckets:
 *   - "age"    → active proof (issued 5 days ago, expiry 90 days)
 *   - "funds"  → expiring soon (issued 85 days ago, expiry 90 days)
 *   - "income" → expired proof (proved 35 days ago, expiry 30 days)
 */

import { TEST_WALLET, TEST_ISSUER } from "./mock-wallet";

const nowSec = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** Three seeded credentials spanning active / expiring-soon / expired. */
export const SEEDED_CREDENTIALS = [
  {
    type: "age",
    title: "Age Verified",
    claim: "age ≥ 18",
    issuer: "StellarCred Authority",
    issuerId: TEST_ISSUER,
    holder: TEST_WALLET,
    value: "1995-06-15",
    salt: "0x111",
    commitment: "0x222",
    sig: [1, 2, 3],
    issuerPubX: [4, 5, 6],
    issuerPubY: [7, 8, 9],
    issuedAt: nowSec - 5 * DAY,
    expiry: "90 days",
    provedAt: nowSec - 5 * DAY,
    provedTxHash:
      "0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
  },
  {
    type: "funds",
    title: "Proof of Funds",
    claim: "balance > $10,000",
    issuer: "StellarCred Authority",
    issuerId: TEST_ISSUER,
    holder: TEST_WALLET,
    value: "50000",
    salt: "0x333",
    commitment: "0x444",
    sig: [1, 2, 3],
    issuerPubX: [4, 5, 6],
    issuerPubY: [7, 8, 9],
    issuedAt: nowSec - 85 * DAY,
    expiry: "90 days",
    provedAt: nowSec - 85 * DAY,
    provedTxHash:
      "0xbeef1234beef1234beef1234beef1234beef1234beef1234beef1234beef1234",
  },
  {
    type: "income",
    title: "Accredited (Income)",
    claim: "income > $200,000",
    issuer: "StellarCred Authority",
    issuerId: TEST_ISSUER,
    holder: TEST_WALLET,
    value: "250000",
    salt: "0x555",
    commitment: "0x666",
    sig: [1, 2, 3],
    issuerPubX: [4, 5, 6],
    issuerPubY: [7, 8, 9],
    issuedAt: nowSec - 10 * DAY,
    expiry: "30 days",
    provedAt: nowSec - 35 * DAY,
    provedTxHash:
      "0xdead1234dead1234dead1234dead1234dead1234dead1234dead1234dead1234",
  },
];

/** A single KYC credential (used in SDK / apps-gating tests). */
export const KYC_CREDENTIAL = {
  type: "kyc",
  title: "KYC Verified",
  claim: "Identity verified",
  issuer: "StellarCred Authority",
  issuerId: TEST_ISSUER,
  holder: TEST_WALLET,
  value: "1",
  salt: "0x999",
  commitment: "0xaaa",
  sig: [1, 2, 3],
  issuerPubX: [4, 5, 6],
  issuerPubY: [7, 8, 9],
  issuedAt: nowSec - 2 * DAY,
  expiry: "90 days",
  provedAt: nowSec - 2 * DAY,
  provedTxHash:
    "0xcafe1234cafe1234cafe1234cafe1234cafe1234cafe1234cafe1234cafe1234",
};

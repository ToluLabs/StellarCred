const { describe, it } = require('node:test');
const assert = require('node:assert');

// Keyset cursor encoding and decoding matching services/indexer/src/api.ts
function encodeCursor(cursor) {
  return Buffer.from(`${cursor.ledgerSequence}:${cursor.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('invalid cursor');
  }
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error('invalid cursor');
  }
  let decoded;
  try {
    decoded = Buffer.from(trimmed, 'base64url').toString('utf8');
  } catch {
    throw new Error('invalid cursor');
  }
  const parts = decoded.split(':');
  if (parts.length !== 2) {
    throw new Error('invalid cursor');
  }
  const [ledgerRaw, idRaw] = parts;
  if (!/^\d+$/.test(ledgerRaw) || !/^\d+$/.test(idRaw)) {
    throw new Error('invalid cursor');
  }
  const ledgerSequence = Number(ledgerRaw);
  const id = Number(idRaw);
  if (
    !Number.isSafeInteger(ledgerSequence) ||
    !Number.isSafeInteger(id) ||
    ledgerSequence < 0 ||
    id < 1
  ) {
    throw new Error('invalid cursor');
  }
  return { ledgerSequence, id };
}

// Keyset pagination evaluator matching services/indexer/src/db-shared.ts
function paginateRecent(records, limit, cursor) {
  let filtered = records.filter((r) => r.revoked === 0);

  if (cursor) {
    filtered = filtered.filter((r) =>
      r.ledger_sequence < cursor.ledgerSequence ||
      (r.ledger_sequence === cursor.ledgerSequence && r.id < cursor.id)
    );
  }

  // Primary: ledger_sequence DESC, Secondary tie-breaker: id DESC
  filtered.sort((a, b) => {
    if (b.ledger_sequence !== a.ledger_sequence) {
      return b.ledger_sequence - a.ledger_sequence;
    }
    return b.id - a.id;
  });

  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;
  const nextCursor = hasMore && page.length > 0
    ? { ledgerSequence: page[page.length - 1].ledger_sequence, id: page[page.length - 1].id }
    : null;

  return {
    claims: page,
    nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
  };
}

describe('Indexer Keyset Pagination and Cursor Semantics (#981)', () => {
  describe('Cursor Encoding and Validation', () => {
    it('encodes and decodes valid cursors round-trip', () => {
      const original = { ledgerSequence: 54100200, id: 42 };
      const encoded = encodeCursor(original);
      const decoded = decodeCursor(encoded);
      assert.deepStrictEqual(decoded, original);
    });

    it('rejects malformed or non-canonical cursor strings', () => {
      const invalidInputs = [
        '',
        '   ',
        'not-base64!',
        Buffer.from('invalid').toString('base64url'),
        Buffer.from('100:').toString('base64url'),
        Buffer.from(':5').toString('base64url'),
        Buffer.from('100:5:extra').toString('base64url'),
        Buffer.from('-1:5').toString('base64url'),
        Buffer.from('100:0').toString('base64url'),
        Buffer.from('1.5:2').toString('base64url'),
        Buffer.from('100:2.5').toString('base64url'),
        Buffer.from('1e6:2').toString('base64url'),
      ];

      for (const input of invalidInputs) {
        assert.throws(
          () => decodeCursor(input),
          /invalid cursor/,
          `Expected input "${input}" to be rejected`
        );
      }
    });
  });

  describe('Keyset Ordering and Stability', () => {
    const mockClaims = [
      { id: 1, ledger_sequence: 100, revoked: 0, wallet: 'G1' },
      { id: 2, ledger_sequence: 100, revoked: 0, wallet: 'G2' },
      { id: 3, ledger_sequence: 101, revoked: 0, wallet: 'G3' },
      { id: 4, ledger_sequence: 101, revoked: 0, wallet: 'G4' },
      { id: 5, ledger_sequence: 102, revoked: 0, wallet: 'G5' },
    ];

    it('orders by ledger_sequence DESC then id DESC', () => {
      const result = paginateRecent(mockClaims, 10, null);
      const ids = result.claims.map((c) => c.id);
      assert.deepStrictEqual(ids, [5, 4, 3, 2, 1]);
      assert.strictEqual(result.nextCursor, null);
    });

    it('enforces exclusive boundary without duplicate or skipped claims', () => {
      const page1 = paginateRecent(mockClaims, 2, null);
      assert.strictEqual(page1.claims.length, 2);
      assert.deepStrictEqual(page1.claims.map((c) => c.id), [5, 4]);
      assert.ok(page1.nextCursor);

      const cursor1 = decodeCursor(page1.nextCursor);
      const page2 = paginateRecent(mockClaims, 2, cursor1);
      assert.strictEqual(page2.claims.length, 2);
      assert.deepStrictEqual(page2.claims.map((c) => c.id), [3, 2]);
      assert.ok(page2.nextCursor);

      const cursor2 = decodeCursor(page2.nextCursor);
      const page3 = paginateRecent(mockClaims, 2, cursor2);
      assert.strictEqual(page3.claims.length, 1);
      assert.deepStrictEqual(page3.claims.map((c) => c.id), [1]);
      assert.strictEqual(page3.nextCursor, null);

      // Verify no duplicates across all pages
      const allRetrievedIds = [
        ...page1.claims.map((c) => c.id),
        ...page2.claims.map((c) => c.id),
        ...page3.claims.map((c) => c.id),
      ];
      assert.deepStrictEqual(allRetrievedIds, [5, 4, 3, 2, 1]);
    });

    it('maintains stability when new claims are inserted between page fetches', () => {
      const initialClaims = [
        { id: 1, ledger_sequence: 100, revoked: 0 },
        { id: 2, ledger_sequence: 100, revoked: 0 },
        { id: 3, ledger_sequence: 101, revoked: 0 },
      ];

      const page1 = paginateRecent(initialClaims, 2, null);
      assert.deepStrictEqual(page1.claims.map((c) => c.id), [3, 2]);
      const cursor = decodeCursor(page1.nextCursor);

      // Ingest a brand new event at a newer ledger sequence (102)
      const updatedClaims = [
        ...initialClaims,
        { id: 4, ledger_sequence: 102, revoked: 0 },
      ];

      // Fetching next page with the existing cursor should still yield record id: 1
      const page2 = paginateRecent(updatedClaims, 2, cursor);
      assert.deepStrictEqual(page2.claims.map((c) => c.id), [1]);
      assert.strictEqual(page2.nextCursor, null);
    });

    it('returns empty claims and null cursor for stale coordinates past the end', () => {
      const cursor = { ledgerSequence: 50, id: 1 };
      const result = paginateRecent(mockClaims, 5, cursor);
      assert.deepStrictEqual(result.claims, []);
      assert.strictEqual(result.nextCursor, null);
    });
  });
});

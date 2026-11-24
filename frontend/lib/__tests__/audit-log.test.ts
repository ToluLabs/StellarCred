import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appendAuditEntry,
  GENESIS_PREV_HASH,
  HASH_HEX_LENGTH,
  hashAuditEntry,
  verifyAuditChain,
  auditLogAppend,
  auditLogEntries,
  auditLogVerify,
  auditLogClear,
  auditLogSeed,
  auditLogSize,
  auditLogToJSONLines,
  parseAuditLogLines,
  assertPiiFreeEntry,
  type AuditLogFields,
  type AuditLogEntry,
} from "../audit-log";

function fields(overrides: Partial<AuditLogFields> = {}): AuditLogFields {
  return {
    timestamp: 1_700_000_000,
    requestId: "req-1",
    issuer: "GISS",
    commitment: "0xabc123",
    ...overrides,
  };
}

function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

describe("hashAuditEntry", () => {
  it("produces a 64-char lowercase-hex SHA-256 digest", () => {
    const digest = hashAuditEntry(fields(), GENESIS_PREV_HASH);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs", () => {
    const a = hashAuditEntry(fields(), GENESIS_PREV_HASH);
    const b = hashAuditEntry(fields(), GENESIS_PREV_HASH);
    expect(a).toBe(b);
  });

  it("changes when any field changes", () => {
    const base = hashAuditEntry(fields(), GENESIS_PREV_HASH);
    expect(hashAuditEntry(fields({ commitment: "0xother" }), GENESIS_PREV_HASH)).not.toBe(base);
    expect(hashAuditEntry(fields({ issuer: "GOTHER" }), GENESIS_PREV_HASH)).not.toBe(base);
    expect(hashAuditEntry(fields({ timestamp: 1_700_000_001 }), GENESIS_PREV_HASH)).not.toBe(base);
    expect(hashAuditEntry(fields({ requestId: "req-2" }), GENESIS_PREV_HASH)).not.toBe(base);
  });

  it("chains: changing prevHash changes the digest", () => {
    const base = hashAuditEntry(fields(), GENESIS_PREV_HASH);
    expect(hashAuditEntry(fields(), "ab".repeat(32))).not.toBe(base);
  });
});

describe("appendAuditEntry", () => {
  it("first entry chains from the genesis prev-hash", () => {
    const chain: AuditLogEntry[] = [];
    const entry = appendAuditEntry(chain, fields());
    expect(entry.index).toBe(0);
    expect(entry.prevHash).toBe(GENESIS_PREV_HASH);
    expect(isHex64(entry.prevHash)).toBe(true);
    expect(entry.hash).toBe(hashAuditEntry(fields(), GENESIS_PREV_HASH));
  });

  it("later entries chain from the previous entry's hash", () => {
    const chain: AuditLogEntry[] = [];
    const first = appendAuditEntry(chain, fields({ requestId: "req-1" }));
    const second = appendAuditEntry(chain, fields({ requestId: "req-2" }));
    expect(second.index).toBe(1);
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).toBe(hashAuditEntry(fields({ requestId: "req-2" }), first.hash));
    expect(first.hash).not.toBe(second.hash);
  });
});

describe("verifyAuditChain", () => {
  let chain: AuditLogEntry[];

  beforeEach(() => {
    chain = [];
    for (let i = 0; i < 5; i++) {
      appendAuditEntry(chain, fields({ requestId: `req-${i}` }));
    }
  });

  it("accepts an unmodified chain", () => {
    const result = verifyAuditChain(chain);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a single-entry chain", () => {
    const single: AuditLogEntry[] = [];
    appendAuditEntry(single, fields());
    expect(verifyAuditChain(single).valid).toBe(true);
  });

  it("accepts an empty chain", () => {
    expect(verifyAuditChain([]).valid).toBe(true);
  });

  it("detects a tampered commitment", () => {
    chain[2] = { ...chain[2], commitment: "0xtampered" };
    const result = verifyAuditChain(chain);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.join("\n")).toMatch(/entry 2: stored hash/);
  });

  it("detects a rewritten hash (adversary covers their tracks on one entry)", () => {
    const tampered = { ...chain[2], commitment: "0xtampered" };
    tampered.hash = hashAuditEntry(
      { timestamp: tampered.timestamp, requestId: tampered.requestId, issuer: tampered.issuer, commitment: tampered.commitment },
      tampered.prevHash,
    );
    chain[2] = tampered;
    const result = verifyAuditChain(chain);
    expect(result.valid).toBe(false);
    // The chain link to entry 3 is broken even though entry 2's own hash is self-consistent.
    expect(result.errors.join("\n")).toMatch(/entry 3: prevHash/);
  });

  it("detects a broken prevHash link", () => {
    chain[3] = { ...chain[3], prevHash: "0".repeat(HASH_HEX_LENGTH) };
    const result = verifyAuditChain(chain);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/entry 3: prevHash/);
  });

  it("detects a deleted entry (index discontinuity)", () => {
    chain.splice(2, 1); // remove entry 2; entry 3 is now at index 2
    const result = verifyAuditChain(chain);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/expected index 2, found 3/);
  });

  it("detects a re-ordered chain", () => {
    const reordered = [chain[0], chain[2], chain[1], ...chain.slice(3)];
    const result = verifyAuditChain(reordered);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/entry 2: prevHash/);
  });
});

describe("in-memory store", () => {
  beforeEach(() => {
    auditLogClear();
  });

  afterEach(() => {
    auditLogClear();
  });

  it("appends entries and links them", () => {
    const first = auditLogAppend(fields({ requestId: "req-1" }));
    const second = auditLogAppend(fields({ requestId: "req-2" }));
    expect(auditLogSize()).toBe(2);
    expect(second.prevHash).toBe(first.hash);
  });

  it("exposes a defensive copy of the chain", () => {
    auditLogAppend(fields());
    const snapshot = auditLogEntries();
    snapshot.push({ ...snapshot[0] });
    expect(auditLogSize()).toBe(1);
  });

  it("verifies the current chain", () => {
    auditLogAppend(fields());
    expect(auditLogVerify().valid).toBe(true);
  });

  it("seed replaces the chain", () => {
    const seeded: AuditLogEntry[] = [];
    appendAuditEntry(seeded, fields({ requestId: "seeded" }));
    auditLogSeed(seeded);
    expect(auditLogSize()).toBe(1);
    expect(auditLogEntries()[0].requestId).toBe("seeded");
  });

  it("clear empties the chain", () => {
    auditLogAppend(fields());
    auditLogClear();
    expect(auditLogSize()).toBe(0);
  });
});

describe("serialization (JSON-lines)", () => {
  it("round-trips a chain without changing hashes", () => {
    const chain: AuditLogEntry[] = [];
    for (let i = 0; i < 4; i++) appendAuditEntry(chain, fields({ requestId: `req-${i}` }));
    const parsed = parseAuditLogLines(auditLogToJSONLines(chain));
    expect(parsed).toEqual(chain);
    expect(verifyAuditChain(parsed).valid).toBe(true);
  });

  it("writes one JSON object per line", () => {
    const chain: AuditLogEntry[] = [];
    appendAuditEntry(chain, fields());
    const lines = auditLogToJSONLines(chain).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it("rejects invalid JSON lines", () => {
    expect(() => parseAuditLogLines("{not json\n")).toThrow(/invalid JSON/);
  });

  it("rejects blank lines gracefully (ignores them)", () => {
    const chain: AuditLogEntry[] = [];
    appendAuditEntry(chain, fields());
    const parsed = parseAuditLogLines(auditLogToJSONLines(chain) + "\n\n");
    expect(parsed).toEqual(chain);
  });
});

describe("PII protection", () => {
  it("assertPiiFreeEntry accepts only the allowlisted fields", () => {
    expect(() => assertPiiFreeEntry({ index: 0, timestamp: 1, requestId: "r", issuer: "i", commitment: "c", prevHash: "p", hash: "h" })).not.toThrow();
  });

  it("assertPiiFreeEntry rejects identity fields", () => {
    for (const key of ["first_name", "last_name", "id_number", "walletAddress", "holder", "value", "salt"]) {
      expect(() => assertPiiFreeEntry({ index: 0, [key]: "secret" })).toThrow(
        new RegExp(`disallowed field "${key}"`),
      );
    }
  });

  it("the parser refuses a file that smuggles identity data in", () => {
    const chain: AuditLogEntry[] = [];
    appendAuditEntry(chain, fields());
    const [goodLine] = auditLogToJSONLines(chain).trim().split("\n");
    const line = JSON.parse(goodLine);
    line.first_name = "Notreel";
    const tampered = JSON.stringify(line) + "\n";
    expect(() => parseAuditLogLines(tampered)).toThrow(/disallowed field "first_name"/);
  });

  it("the parser rejects entries missing required fields", () => {
    const chain: AuditLogEntry[] = [];
    appendAuditEntry(chain, fields());
    const [goodLine] = auditLogToJSONLines(chain).trim().split("\n");
    const line = JSON.parse(goodLine);
    delete line.commitment;
    expect(() => parseAuditLogLines(JSON.stringify(line) + "\n")).toThrow(/missing or mistyped field/);
  });

  it("entries produced by append contain no identity fields", () => {
    const chain: AuditLogEntry[] = [];
    const entry = appendAuditEntry(chain, fields());
    expect(entry).not.toHaveProperty("first_name");
    expect(entry).not.toHaveProperty("last_name");
    expect(entry).not.toHaveProperty("id_number");
    expect(entry).not.toHaveProperty("holder");
    expect(entry).not.toHaveProperty("value");
    expect(entry).not.toHaveProperty("salt");
    expect(Object.keys(entry).sort()).toEqual(
      ["commitment", "hash", "index", "issuer", "prevHash", "requestId", "timestamp"].sort(),
    );
  });
});

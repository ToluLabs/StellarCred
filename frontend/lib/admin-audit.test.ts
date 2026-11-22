// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assertPiiFreeEntry,
  auditLogAppend,
  auditLogEntries,
  auditLogClear,
  auditLogToJSONLines,
  parseAuditLogLines,
  verifyAuditChain,
  appendAuditEntry,
  hashAuditEntry,
  GENESIS_PREV_HASH,
  type AuditLogEntry,
} from "./audit-log";

function coreFields(overrides: Partial<{ timestamp: number; requestId: string; issuer: string; commitment: string }> = {}) {
  return {
    timestamp: 1_700_000_000,
    requestId: "req-admin-1",
    issuer: "GADMIN",
    commitment: "0xdeadbeef",
    ...overrides,
  };
}

describe("admin-audit — adminAction support", () => {
  beforeEach(() => {
    auditLogClear();
  });

  afterEach(() => {
    auditLogClear();
  });

  it("assertPiiFreeEntry does NOT throw for an entry containing adminAction key", () => {
    expect(() =>
      assertPiiFreeEntry({
        index: 0,
        timestamp: 1,
        requestId: "r",
        issuer: "i",
        commitment: "c",
        prevHash: "p",
        hash: "h",
        adminAction: "revoke:alice",
      }),
    ).not.toThrow();
  });

  it("assertPiiFreeEntry DOES throw for an entry with a disallowed key like 'email'", () => {
    expect(() =>
      assertPiiFreeEntry({
        index: 0,
        timestamp: 1,
        requestId: "r",
        issuer: "i",
        commitment: "c",
        prevHash: "p",
        hash: "h",
        email: "user@example.com",
      }),
    ).toThrow(/disallowed field "email"/);
  });

  it("auditLogAppend with adminAction: 'revoke' stores the field on the returned entry", () => {
    const entry = auditLogAppend({ ...coreFields(), adminAction: "revoke" });
    expect(entry.adminAction).toBe("revoke");
  });

  it("auditLogEntries returns the entry with adminAction field preserved", () => {
    auditLogAppend({ ...coreFields(), adminAction: "revoke" });
    const entries = auditLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].adminAction).toBe("revoke");
  });

  it("adminAction does not affect the hash — two entries with same core fields but different adminAction have the same hash", () => {
    const fields = coreFields();
    const withAction = auditLogAppend({ ...fields, adminAction: "revoke:alice" });
    auditLogClear();
    const withoutAction = auditLogAppend({ ...fields });
    expect(withAction.hash).toBe(withoutAction.hash);
  });

  it("adminAction round-trips through JSON-lines serialization", () => {
    const entry = auditLogAppend({ ...coreFields(), adminAction: "revoke:alice" });
    const lines = auditLogToJSONLines([entry]);
    const parsed = parseAuditLogLines(lines);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].adminAction).toBe("revoke:alice");
  });

  it("verifyAuditChain is valid on a chain containing adminAction entries", () => {
    const chain: AuditLogEntry[] = [];
    appendAuditEntry(chain, coreFields({ requestId: "req-0" }));
    appendAuditEntry(chain, { ...coreFields({ requestId: "req-1" }), adminAction: "revoke:bob" });
    appendAuditEntry(chain, coreFields({ requestId: "req-2" }));

    const result = verifyAuditChain(chain);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("adminAction does not break tamper detection — mutating commitment on an adminAction entry fails verification", () => {
    const chain: AuditLogEntry[] = [];
    appendAuditEntry(chain, coreFields({ requestId: "req-0" }));
    appendAuditEntry(chain, { ...coreFields({ requestId: "req-1" }), adminAction: "revoke:bob" });
    appendAuditEntry(chain, coreFields({ requestId: "req-2" }));

    // Mutate commitment on the adminAction entry
    chain[1] = { ...chain[1], commitment: "0xtampered" };

    const result = verifyAuditChain(chain);
    expect(result.valid).toBe(false);
  });

  it("existing entries without adminAction remain valid after parsing", () => {
    // Build an old-style chain (no adminAction anywhere)
    const chain: AuditLogEntry[] = [];
    appendAuditEntry(chain, coreFields({ requestId: "old-req-0" }));
    appendAuditEntry(chain, coreFields({ requestId: "old-req-1" }));

    const lines = auditLogToJSONLines(chain);
    const parsed = parseAuditLogLines(lines);

    const result = verifyAuditChain(parsed);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(parsed[0].adminAction).toBeUndefined();
    expect(parsed[1].adminAction).toBeUndefined();
  });

  it("hashAuditEntry produces the same hash regardless of adminAction field in fields", () => {
    // hashAuditEntry only accepts AuditLogFields which now has optional adminAction
    // but the canonical form only includes [timestamp, requestId, issuer, commitment, prevHash]
    const f = coreFields();
    const hashWithout = hashAuditEntry(f, GENESIS_PREV_HASH);
    const hashWith = hashAuditEntry({ ...f, adminAction: "revoke:carol" }, GENESIS_PREV_HASH);
    expect(hashWith).toBe(hashWithout);
  });
});

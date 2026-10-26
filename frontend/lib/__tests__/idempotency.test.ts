import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  completedIdempotencyRecord,
  decryptEncryptedResponseIdempotencyRecord,
  encryptedResponseIdempotencyRecord,
  idempotencyGet,
  idempotencyGetAsync,
  idempotencySet,
  idempotencyCleanup,
  idempotencyClear,
  idempotencySize,
  idempotencyInFlightBegin,
  idempotencyInFlightSettle,
  idempotencyInFlightFail,
  idempotencyInFlightSize,
  isValidIdempotencyKey,
  MAX_KEY_LENGTH_BYTES,
  personaPendingIdempotencyRecord,
  type CompletedIdempotencyRecord,
} from "../idempotency";
import { MemoryStore, setSharedStoreForTesting } from "../shared-store";

const originalReplayEncryptionKey = process.env.IDEMPOTENCY_REPLAY_ENCRYPTION_KEY;

function makeRecord(
  overrides: Partial<CompletedIdempotencyRecord> = {},
): CompletedIdempotencyRecord {
  return {
    version: 1,
    kind: "completed",
    responseHash: "a".repeat(64),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("idempotency store", () => {
  beforeEach(() => {
    setSharedStoreForTesting(new MemoryStore());
    idempotencyClear();
  });

  afterEach(() => {
    idempotencyClear();
    setSharedStoreForTesting(null);
    if (originalReplayEncryptionKey === undefined) {
      delete process.env.IDEMPOTENCY_REPLAY_ENCRYPTION_KEY;
    } else {
      process.env.IDEMPOTENCY_REPLAY_ENCRYPTION_KEY = originalReplayEncryptionKey;
    }
  });

  describe("completedIdempotencyRecord", () => {
    it("stores only a non-reversible response hash and completion marker", () => {
      const body = JSON.stringify({
        credentials: [
          {
            value: "1995-06-15",
            salt: "0xabc",
            commitment: "123",
            sig: [1, 2, 3],
          },
        ],
      });

      const record = completedIdempotencyRecord(200, body);
      const serialized = JSON.stringify(record);

      expect(record).toMatchObject({ version: 1, kind: "completed" });
      expect(record.responseHash).toMatch(/^[0-9a-f]{64}$/);
      expect(serialized).not.toContain("1995-06-15");
      expect(serialized).not.toContain("credentials");
      expect(serialized).not.toContain("value");
      expect(serialized).not.toContain("salt");
      expect(serialized).not.toContain("commitment");
      expect(serialized).not.toContain("sig");
    });
  });

  describe("encrypted batch replay records", () => {
    it("round-trips successful responses without exposing their contents", () => {
      process.env.IDEMPOTENCY_REPLAY_ENCRYPTION_KEY = "b".repeat(64);
      const body = JSON.stringify({ credentials: [{ commitment: "private-credential" }] });
      const record = encryptedResponseIdempotencyRecord(200, body);

      expect(record.kind).toBe("encrypted_response");
      expect(JSON.stringify(record)).not.toContain("private-credential");
      expect(decryptEncryptedResponseIdempotencyRecord(record)).toBe(body);
    });

    it("rejects tampered encrypted responses", () => {
      process.env.IDEMPOTENCY_REPLAY_ENCRYPTION_KEY = "b".repeat(64);
      const record = encryptedResponseIdempotencyRecord(200, '{"ok":true}');
      expect(() =>
        decryptEncryptedResponseIdempotencyRecord({
          ...record,
          ciphertext: Buffer.from("tampered").toString("base64url"),
        }),
      ).toThrow();
    });
  });

  describe("idempotencyGet", () => {
    it("returns null on cache miss", () => {
      expect(idempotencyGet("key-1")).toBeNull();
    });

    it("returns the cached minimal record", () => {
      const record = makeRecord();
      idempotencySet("key-1", record);

      expect(idempotencyGet("key-1")).toEqual(record);
    });

    it("returns null for a different key", () => {
      idempotencySet("key-a", makeRecord());
      expect(idempotencyGet("key-b")).toBeNull();
    });

    it("returns null after TTL expiry", () => {
      const now = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      idempotencySet("key-1", makeRecord({ createdAt: now }));

      nowSpy.mockReturnValue(now + 61_000);
      expect(idempotencyGet("key-1")).toBeNull();

      vi.restoreAllMocks();
    });

    it("still hits just before TTL expires", () => {
      const now = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      idempotencySet("key-1", makeRecord({ createdAt: now }));

      nowSpy.mockReturnValue(now + 59_000);
      expect(idempotencyGet("key-1")).not.toBeNull();

      vi.restoreAllMocks();
    });

    it("returns null for an empty key", () => {
      expect(idempotencyGet("")).toBeNull();
    });
  });

  describe("shared-store records", () => {
    it("rewrites legacy full-response data to a redacted completion marker", async () => {
      const sharedStore = new MemoryStore();
      setSharedStoreForTesting(sharedStore);
      const body = JSON.stringify({
        credentials: [{ value: "1995-06-15", salt: "0xabc" }],
      });
      await sharedStore.set(
        "idem:legacy-key",
        JSON.stringify({
          status: 200,
          body,
          headers: { "content-type": "application/json" },
          createdAt: Date.now(),
        }),
        60,
      );

      const record = await idempotencyGetAsync("legacy-key");
      const stored = await sharedStore.get("idem:legacy-key");

      expect(record).toMatchObject({ version: 1, kind: "completed" });
      expect(stored).not.toContain("1995-06-15");
      expect(stored).not.toContain("credentials");
      expect(stored).not.toContain("value");
      expect(stored).not.toContain("salt");
    });

    it("keeps the Persona redirect without any request attributes", async () => {
      const sharedStore = new MemoryStore();
      setSharedStoreForTesting(sharedStore);
      const record = personaPendingIdempotencyRecord(
        "inq_test",
        "https://withpersona.com/verify?inquiry=inq_test",
      );

      idempotencySet("persona-key", record);
      await Promise.resolve();
      const stored = await sharedStore.get("idem:persona-key");

      expect(stored).toContain("inq_test");
      expect(stored).not.toContain("date_of_birth");
      expect(stored).not.toContain("1995-06-15");
    });
  });

  describe("idempotencySet", () => {
    it("stores a record and increments size", () => {
      expect(idempotencySize()).toBe(0);
      idempotencySet("key-1", makeRecord());
      expect(idempotencySize()).toBe(1);
    });

    it("overwrites an existing record with the same key", () => {
      idempotencySet("key-1", makeRecord({ responseHash: "a".repeat(64) }));
      idempotencySet("key-1", makeRecord({ responseHash: "b".repeat(64) }));
      expect(idempotencySize()).toBe(1);
      expect(idempotencyGet("key-1")).toMatchObject({
        kind: "completed",
        responseHash: "b".repeat(64),
      });
    });
  });

  describe("idempotencyCleanup", () => {
    it("removes expired entries but keeps fresh ones", () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);

      idempotencySet("fresh", makeRecord({ createdAt: now }));
      idempotencySet("stale", makeRecord({ createdAt: now - 61_000 }));

      idempotencyCleanup();

      expect(idempotencyGet("fresh")).not.toBeNull();
      expect(idempotencyGet("stale")).toBeNull();
      expect(idempotencySize()).toBe(1);

      vi.restoreAllMocks();
    });
  });

  describe("idempotencyClear", () => {
    it("removes all entries", () => {
      idempotencySet("key-1", makeRecord());
      idempotencySet("key-2", makeRecord());
      expect(idempotencySize()).toBe(2);
      idempotencyClear();
      expect(idempotencySize()).toBe(0);
    });
  });

  describe("isValidIdempotencyKey", () => {
    it("accepts a normal key", () => {
      expect(isValidIdempotencyKey("key-1")).toBe(true);
    });

    it("rejects empty and whitespace-only keys", () => {
      expect(isValidIdempotencyKey("")).toBe(false);
      expect(isValidIdempotencyKey("   ")).toBe(false);
    });

    it("accepts a key exactly at the byte limit", () => {
      expect(isValidIdempotencyKey("a".repeat(MAX_KEY_LENGTH_BYTES))).toBe(true);
    });

    it("rejects keys longer than the byte limit", () => {
      expect(isValidIdempotencyKey("a".repeat(MAX_KEY_LENGTH_BYTES + 1))).toBe(false);
    });

    it("rejects control characters", () => {
      expect(isValidIdempotencyKey("bad\u0000key")).toBe(false);
      expect(isValidIdempotencyKey("bad\nkey")).toBe(false);
    });
  });

  describe("store guards for invalid keys", () => {
    it("idempotencyGet returns null for invalid keys", () => {
      expect(idempotencyGet("a".repeat(MAX_KEY_LENGTH_BYTES + 1))).toBeNull();
      expect(idempotencyGet("\u0000")).toBeNull();
    });

    it("idempotencySet ignores invalid keys", () => {
      idempotencySet("a".repeat(MAX_KEY_LENGTH_BYTES + 1), makeRecord());
      idempotencySet("\u0000", makeRecord());
      expect(idempotencySize()).toBe(0);
    });
  });

  describe("in-flight sentinel", () => {
    it("first caller becomes the leader", () => {
      expect(idempotencyInFlightBegin("key-1")).toBeNull();
      expect(idempotencyInFlightSize()).toBe(1);
    });

    it("a duplicate caller joins the same in-flight slot", () => {
      expect(idempotencyInFlightBegin("key-1")).toBeNull();
      expect(idempotencyInFlightBegin("key-1")).not.toBeNull();
      expect(idempotencyInFlightSize()).toBe(1);
    });

    it("settling shares only the produced minimal record", async () => {
      idempotencyInFlightBegin("key-1");
      const joined = idempotencyInFlightBegin("key-1")!;
      const record = makeRecord();
      idempotencyInFlightSettle("key-1", record);
      await expect(joined).resolves.toEqual(record);
      expect(idempotencyInFlightSize()).toBe(0);
    });

    it("a settled slot allows the next caller to become a new leader", async () => {
      idempotencyInFlightBegin("key-1");
      const joined = idempotencyInFlightBegin("key-1")!;
      idempotencyInFlightSettle("key-1", makeRecord());
      await joined;
      expect(idempotencyInFlightBegin("key-1")).toBeNull();
    });

    it("failing rejects waiting duplicates", async () => {
      idempotencyInFlightBegin("key-1");
      const joined = idempotencyInFlightBegin("key-1")!;
      idempotencyInFlightFail("key-1", new Error("boom"));
      await expect(joined).rejects.toThrow("boom");
      expect(idempotencyInFlightSize()).toBe(0);
    });

    it("clear resets in-flight slots", () => {
      idempotencyInFlightBegin("key-1");
      expect(idempotencyInFlightSize()).toBe(1);
      idempotencyClear();
      expect(idempotencyInFlightSize()).toBe(0);
    });

    it("begin ignores invalid keys", () => {
      expect(idempotencyInFlightBegin("")).toBeNull();
      expect(idempotencyInFlightBegin("a".repeat(MAX_KEY_LENGTH_BYTES + 1))).toBeNull();
      expect(idempotencyInFlightSize()).toBe(0);
    });

    it("prunes stale in-flight slots after the TTL", async () => {
      const now = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

      idempotencyInFlightBegin("key-1");
      const joined = idempotencyInFlightBegin("key-1")!;

      nowSpy.mockReturnValue(now + 61_000);
      idempotencyInFlightBegin("key-2");

      await expect(joined).rejects.toThrow("idempotency in-flight slot expired");
      expect(idempotencyInFlightSize()).toBe(1);

      vi.restoreAllMocks();
    });
  });
});

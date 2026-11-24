import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MemoryStore,
  UpstashRedisStore,
  isMultiInstanceOrServerless,
  isSharedStoreConfigured,
  checkMultiInstanceStoreWarning,
  __resetStoreWarningForTesting,
  setSharedStoreForTesting,
} from "../shared-store";
import { checkLimitAsync } from "../rate-limit";
import {
  completedIdempotencyRecord,
  idempotencyGetAsync,
  idempotencySetAsync,
  idempotencyClear,
} from "../idempotency";

describe("Shared Store (#523)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    __resetStoreWarningForTesting();
    setSharedStoreForTesting(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    setSharedStoreForTesting(null);
    vi.restoreAllMocks();
  });

  describe("MemoryStore", () => {
    it("sets, gets, and deletes values", async () => {
      const store = new MemoryStore();
      expect(await store.get("test-key")).toBeNull();

      await store.set("test-key", "hello");
      expect(await store.get("test-key")).toBe("hello");

      await store.del("test-key");
      expect(await store.get("test-key")).toBeNull();
    });

    it("respects TTL expiration", async () => {
      const store = new MemoryStore();
      vi.useFakeTimers();
      try {
        await store.set("ttl-key", "val", 1); // 1 second
        expect(await store.get("ttl-key")).toBe("val");

        vi.advanceTimersByTime(1100);
        expect(await store.get("ttl-key")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("atomically increments keys and calculates remaining TTL", async () => {
      const store = new MemoryStore();
      const r1 = await store.incr("counter", 10);
      expect(r1.count).toBe(1);
      expect(r1.ttlRemainingMs).toBeGreaterThan(0);

      const r2 = await store.incr("counter", 10);
      expect(r2.count).toBe(2);

      const r3 = await store.incr("counter", 10);
      expect(r3.count).toBe(3);
    });

    it("clears all keys", async () => {
      const store = new MemoryStore();
      await store.set("a", "1");
      await store.set("b", "2");
      expect(store.size).toBe(2);

      await store.clear();
      expect(store.size).toBe(0);
      expect(await store.get("a")).toBeNull();
    });
  });

  describe("UpstashRedisStore", () => {
    it("executes get, set, and del via fetch", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (body[0] === "GET") {
          return { ok: true, json: async () => ({ result: "mock-value" }) };
        }
        if (body[0] === "SET") {
          return { ok: true, json: async () => ({ result: "OK" }) };
        }
        if (body[0] === "DEL") {
          return { ok: true, json: async () => ({ result: 1 }) };
        }
        return { ok: true, json: async () => ({ result: null }) };
      });

      global.fetch = fetchMock;

      const store = new UpstashRedisStore({
        url: "https://mock-upstash.com",
        token: "mock-token",
      });

      const val = await store.get("my-key");
      expect(val).toBe("mock-value");
      expect(fetchMock).toHaveBeenCalledWith("https://mock-upstash.com", expect.objectContaining({
        headers: {
          Authorization: "Bearer mock-token",
          "Content-Type": "application/json",
        },
      }));

      await store.set("my-key", "my-val", 60);
      expect(fetchMock).toHaveBeenCalledWith("https://mock-upstash.com", expect.objectContaining({
        body: JSON.stringify(["SET", "my-key", "my-val", "EX", 60]),
      }));

      await store.del("my-key");
      expect(fetchMock).toHaveBeenCalledWith("https://mock-upstash.com", expect.objectContaining({
        body: JSON.stringify(["DEL", "my-key"]),
      }));
    });

    it("executes incr via pipeline", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string, _init: RequestInit) => {
        if (url.endsWith("/pipeline")) {
          return {
            ok: true,
            json: async () => [
              { result: 4 },
              { result: 45000 },
            ],
          };
        }
        return { ok: true, json: async () => ({ result: "OK" }) };
      });

      global.fetch = fetchMock;

      const store = new UpstashRedisStore({
        url: "https://mock-upstash.com",
        token: "mock-token",
      });

      const res = await store.incr("rl:key", 60);
      expect(res.count).toBe(4);
      expect(res.ttlRemainingMs).toBe(45000);
      expect(fetchMock).toHaveBeenCalledWith("https://mock-upstash.com/pipeline", expect.anything());
    });
  });

  describe("Environment detection and multi-instance warning", () => {
    it("detects serverless/multi-instance environments", () => {
      expect(isMultiInstanceOrServerless()).toBe(false);

      process.env.VERCEL = "1";
      expect(isMultiInstanceOrServerless()).toBe(true);

      delete process.env.VERCEL;
      process.env.AWS_LAMBDA_FUNCTION_NAME = "my-fn";
      expect(isMultiInstanceOrServerless()).toBe(true);
    });

    it("detects shared store configuration", () => {
      expect(isSharedStoreConfigured()).toBe(false);

      process.env.UPSTASH_REDIS_REST_URL = "https://upstash";
      expect(isSharedStoreConfigured()).toBe(false); // missing token

      process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
      expect(isSharedStoreConfigured()).toBe(true);

      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      process.env.KV_REST_API_URL = "https://kv";
      process.env.KV_REST_API_TOKEN = "tok";
      expect(isSharedStoreConfigured()).toBe(true);
    });

    it("emits loud warning when running in serverless without shared store", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.VERCEL = "1";

      checkMultiInstanceStoreWarning();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("WARNING: Running in a multi-instance or serverless environment");

      // Warns at most once
      checkMultiInstanceStoreWarning();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("does NOT warn when shared store is configured", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.VERCEL = "1";
      process.env.UPSTASH_REDIS_REST_URL = "https://upstash";
      process.env.UPSTASH_REDIS_REST_TOKEN = "tok";

      checkMultiInstanceStoreWarning();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("Pluggable integration with rate-limit and idempotency", () => {
    it("checkLimitAsync respects pluggable store", async () => {
      const mockStore = new MemoryStore();
      setSharedStoreForTesting(mockStore);

      const r1 = await checkLimitAsync("client-ip", 2, 60_000);
      expect(r1.throttled).toBe(false);

      const r2 = await checkLimitAsync("client-ip", 2, 60_000);
      expect(r2.throttled).toBe(false);

      const r3 = await checkLimitAsync("client-ip", 2, 60_000);
      expect(r3.throttled).toBe(true);
      if (r3.throttled) {
        expect(r3.retryAfterMs).toBeGreaterThan(0);
      }
    });

    it("idempotencyGetAsync and idempotencySetAsync sync across shared store", async () => {
      const mockStore = new MemoryStore();
      setSharedStoreForTesting(mockStore);
      idempotencyClear();

      const sampleRecord = completedIdempotencyRecord(
        200,
        JSON.stringify({ credentials: [{ value: "1995-06-15" }] }),
      );

      await idempotencySetAsync("idem-req-1", sampleRecord);

      // Verify it was stored in the shared store without response contents.
      const stored = await mockStore.get("idem:idem-req-1");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toMatchObject({
        version: 1,
        kind: "completed",
      });
      expect(stored).not.toContain("credentials");
      expect(stored).not.toContain("1995-06-15");

      // Verify retrieval via async getter.
      const fetched = await idempotencyGetAsync("idem-req-1");
      expect(fetched).toEqual(sampleRecord);
    });
  });
});

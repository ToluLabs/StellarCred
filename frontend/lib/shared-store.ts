/**
 * Shared pluggable Key-Value store for distributed rate-limiting and idempotency.
 *
 * ## Architecture
 *
 * Provides a clean `KeyValueStore` abstraction supporting:
 * 1. `MemoryStore` — In-process Map fallback (default for local dev and single-instance).
 * 2. `UpstashRedisStore` — Serverless / multi-instance distributed backend using
 *    native fetch against the Upstash Redis / Vercel KV REST API.
 *
 * Environment variables:
 * - `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN`
 * - or Vercel KV aliases: `KV_REST_API_URL` & `KV_REST_API_TOKEN`
 *
 * ## Multi-instance / Serverless Warning
 *
 * If a multi-instance or serverless platform is detected (Vercel, AWS Lambda,
 * Google Cloud Run, Railway, etc.) and no shared store is configured, a loud
 * warning is emitted once to alert operators that rate limits and idempotency
 * are only effective per instance/container.
 */

export interface KeyValueStore {
  readonly name: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(
    key: string,
    ttlSeconds?: number,
  ): Promise<{ count: number; ttlRemainingMs: number }>;
  clear?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// MemoryStore (In-process Map)
// ---------------------------------------------------------------------------

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

export class MemoryStore implements KeyValueStore {
  readonly name = "memory";
  private store = new Map<string, MemoryEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt =
      ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(
    key: string,
    ttlSeconds?: number,
  ): Promise<{ count: number; ttlRemainingMs: number }> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || (entry.expiresAt !== null && now > entry.expiresAt)) {
      const expiresAt =
        ttlSeconds && ttlSeconds > 0 ? now + ttlSeconds * 1000 : null;
      this.store.set(key, { value: "1", expiresAt });
      return {
        count: 1,
        ttlRemainingMs: ttlSeconds ? ttlSeconds * 1000 : 0,
      };
    }

    const currentCount = parseInt(entry.value, 10) || 0;
    const newCount = currentCount + 1;
    entry.value = String(newCount);

    const ttlRemainingMs = entry.expiresAt ? Math.max(0, entry.expiresAt - now) : 0;
    return {
      count: newCount,
      ttlRemainingMs,
    };
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// UpstashRedisStore (REST API via native fetch)
// ---------------------------------------------------------------------------

export interface UpstashConfig {
  url: string;
  token: string;
}

export class UpstashRedisStore implements KeyValueStore {
  readonly name = "upstash-redis";
  private baseUrl: string;
  private token: string;

  constructor(config: UpstashConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.token = config.token;
  }

  private async execute<T = unknown>(command: (string | number)[]): Promise<T> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash REST API error (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`Upstash Redis error: ${data.error}`);
    }
    return data.result;
  }

  private async pipeline<T = unknown[]>(commands: (string | number)[][]): Promise<T> {
    const res = await fetch(`${this.baseUrl}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash pipeline error (${res.status}): ${text}`);
    }

    const data = await res.json();
    return data as T;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.execute<string | null>(["GET", key]);
    return result !== null && result !== undefined ? String(result) : null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.execute(["SET", key, value, "EX", Math.ceil(ttlSeconds)]);
    } else {
      await this.execute(["SET", key, value]);
    }
  }

  async del(key: string): Promise<void> {
    await this.execute(["DEL", key]);
  }

  async incr(
    key: string,
    ttlSeconds?: number,
  ): Promise<{ count: number; ttlRemainingMs: number }> {
    const results = await this.pipeline<Array<{ result?: unknown; error?: string }>>([
      ["INCR", key],
      ["PTTL", key],
    ]);

    const count = Number(results[0]?.result ?? 1);
    let pttl = Number(results[1]?.result ?? -1);

    if (pttl < 0 && ttlSeconds && ttlSeconds > 0) {
      const ttlMs = Math.ceil(ttlSeconds * 1000);
      await this.execute(["PEXPIRE", key, ttlMs]).catch(() => null);
      pttl = ttlMs;
    }

    return {
      count,
      ttlRemainingMs: Math.max(0, pttl),
    };
  }

  async clear(): Promise<void> {
    await this.execute(["FLUSHDB"]).catch(() => null);
  }
}

// ---------------------------------------------------------------------------
// Environment detection and singleton factory
// ---------------------------------------------------------------------------

/**
 * Detects whether the current process is running in a serverless or multi-instance
 * environment where in-memory stores are subject to cold-start isolation or replica drift.
 */
export function isMultiInstanceOrServerless(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  const env = process.env;
  return !!(
    env.VERCEL ||
    env.AWS_LAMBDA_FUNCTION_NAME ||
    env.AWS_EXECUTION_ENV ||
    env.K_SERVICE || // Google Cloud Run / Knative
    env.FUNCTIONS_WORKER_RUNTIME || // Azure Functions
    env.RAILWAY_ENVIRONMENT ||
    env.HEROKU_APP_NAME ||
    env.FLY_APP_NAME ||
    env.CONTAINER_APP_NAME ||
    (env.NODE_ENV === "production" && env.CLUSTER_MODE === "true")
  );
}

/**
 * Returns true if Upstash Redis or Vercel KV environment variables are present.
 */
export function isSharedStoreConfigured(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return !!(url && token);
}

let _warnedMultiInstance = false;

/**
 * Reset warning flag between test cases.
 */
export function __resetStoreWarningForTesting(): void {
  _warnedMultiInstance = false;
}

/**
 * Emits a prominent console warning when running in a multi-instance/serverless
 * deployment without a configured shared store.
 */
export function checkMultiInstanceStoreWarning(): void {
  if (_warnedMultiInstance) return;
  if (isMultiInstanceOrServerless() && !isSharedStoreConfigured()) {
    _warnedMultiInstance = true;
    // eslint-disable-next-line no-console
    console.warn(
      "\n================================================================================\n" +
        "[StellarCred] ⚠️ WARNING: Running in a multi-instance or serverless environment\n" +
        "without a shared store (UPSTASH_REDIS_REST_URL / KV_REST_API_URL).\n" +
        "In-process Map fallback is active. Rate-limiting and idempotency guarantees will\n" +
        "only be effective per instance and can be bypassed across concurrent cold starts\n" +
        "or horizontally scaled replicas.\n\n" +
        "To enable shared distributed protection across all instances, configure:\n" +
        "  UPSTASH_REDIS_REST_URL=https://...\n" +
        "  UPSTASH_REDIS_REST_TOKEN=...\n" +
        "(or Vercel KV aliases: KV_REST_API_URL and KV_REST_API_TOKEN)\n" +
        "See docs/DEPLOYMENTS.md and .env.example for details.\n" +
        "================================================================================\n",
    );
  }
}

let _sharedStoreInstance: KeyValueStore | null = null;

/**
 * Get the active shared store singleton.
 */
export function getSharedStore(): KeyValueStore {
  checkMultiInstanceStoreWarning();

  if (_sharedStoreInstance) {
    return _sharedStoreInstance;
  }

  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (url && token) {
    _sharedStoreInstance = new UpstashRedisStore({ url, token });
  } else {
    _sharedStoreInstance = new MemoryStore();
  }

  return _sharedStoreInstance;
}

/**
 * Override the shared store instance (useful for unit tests or custom stores).
 */
export function setSharedStoreForTesting(store: KeyValueStore | null): void {
  _sharedStoreInstance = store;
}

import type { SdkConfig, SdkRequestOptions, SdkResponse, SdkErrorBody } from './types';
import { SdkError } from './types';

export { SdkError };

export const DEFAULT_TIMEOUT_MS = 30_000;

function isAssertionError(value: unknown): value is SdkErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === 'string' ||
    typeof candidate.message === 'string' ||
    'details' in candidate
  );
}

export class SdkClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SdkConfig) {
    if (!config.baseUrl) {
      throw new Error('SdkClient requires a baseUrl');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.defaultHeaders = { ...config.headers };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('SdkClient requires a fetch implementation');
    }
    this.fetchImpl = fetchImpl;
  }

  buildUrl(path: string, query?: SdkRequestOptions['query']): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T>(path: string, options: SdkRequestOptions = {}): Promise<SdkResponse<T>> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options.headers,
    };
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['content-type'] = 'application/json';
      }
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options.signal ?? controller.signal;

    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal,
      });

      const text = await response.text();
      const parsed = text ? (safeParseJson(text) as T) : (undefined as unknown as T);

      if (!response.ok) {
        const errorBody = isAssertionError(parsed) ? parsed : undefined;
        throw new SdkError(errorBody?.message ?? `SGK request failed with status ${response.status}`, {
          status: response.status,
          code: errorBody?.code,
          details: errorBody?.details,
        });
      }

      return {
        status: response.status,
        headers: response.headers,
        data: parsed,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  get<T>(path: string, options: Omit<SdkRequestOptions, 'method' | 'body'> = {}): Promise<SdkResponse<T>> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<SdkRequestOptions, 'method' | 'body'> = {}): Promise<SdkResponse<T>> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  /**
   * Derives a deterministic per-app nullifier for cross-app unlinkable Sybil resistance (#395).
   */
  deriveNullifier(secret: string | bigint, appContext: string | bigint): string {
    const payload = `${secret.toString()}::${appContext.toString()}`;
    let h1 = 0xdeadbeef ^ 42;
    let h2 = 0x41c6ce57 ^ 42;
    for (let i = 0; i < payload.length; i++) {
      const ch = payload.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const p1 = (h1 >>> 0).toString(16).padStart(8, '0');
    const p2 = (h2 >>> 0).toString(16).padStart(8, '0');
    const p3 = (Math.imul(h1, 31) >>> 0).toString(16).padStart(8, '0');
    const p4 = (Math.imul(h2, 37) >>> 0).toString(16).padStart(8, '0');
    return `${p1}${p2}${p3}${p4}`.padEnd(64, '0');
  }

  /**
   * Checks whether a nullifier has already been recorded in a given application context.
   */
  async checkNullifier(appContext: string, nullifier: string, options: SdkRequestOptions = {}): Promise<boolean> {
    const res = await this.get<{ isUsed: boolean }>(`/api/nullifier/check`, {
      ...options,
      query: { ...options.query, appContext, nullifier },
    });
    return Boolean(res.data?.isUsed);
  }

  /**
   * Records a nullifier in a given application context for Sybil resistance.
   */
  async recordNullifier(
    appContext: string,
    nullifier: string,
    options: SdkRequestOptions = {}
  ): Promise<SdkResponse<{ recorded: boolean }>> {
    return this.post<{ recorded: boolean }>(`/api/nullifier/record`, { appContext, nullifier }, options);
  }

  /**
   * High-level verification of unique personhood in an application context (#395).
   */
  async verifyUniquePersonhood(params: {
    appContext: string;
    nullifier?: string;
    secret?: string | bigint;
  }): Promise<{ unique: boolean; nullifier: string }> {
    const nullifier = params.nullifier ?? (params.secret ? this.deriveNullifier(params.secret, params.appContext) : '');
    if (!nullifier) {
      throw new Error('Either nullifier or secret must be provided to verifyUniquePersonhood');
    }
    const isUsed = await this.checkNullifier(params.appContext, nullifier);
    return { unique: !isUsed, nullifier };
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createSdkClient(config: SdkConfig): SdkClient {
  return new SdkClient(config);
}

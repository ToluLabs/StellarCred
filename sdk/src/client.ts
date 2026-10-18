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

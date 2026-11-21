export interface SdkConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface SdkRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface SdkResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export interface SdkErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

export class SdkError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, options: { status: number; code?: string; details?: unknown }) {
    super(message);
    this.name = 'SdkError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type SdkFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface NullifierCheckOptions extends SdkRequestOptions {
  appContext: string;
  nullifier: string;
}

export interface NullifierRecordOptions extends SdkRequestOptions {
  appContext: string;
  nullifier: string;
}

export interface UniquePersonhoodOptions extends SdkRequestOptions {
  appContext: string;
  nullifier?: string;
  secret?: string | bigint;
  wallet?: string;
}

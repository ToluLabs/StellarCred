/**
 * Supported JavaScript execution runtimes for WebAssembly loading.
 */
export type WasmRuntime = "browser" | "node" | "bun" | "edge" | "unknown";

/**
 * Error codes emitted by {@link WasmLoadError}.
 */
export type WasmErrorCode =
  | "UNSUPPORTED_RUNTIME"
  | "INVALID_SOURCE"
  | "FETCH_FAILED"
  | "FS_READ_FAILED"
  | "COMPILE_FAILED"
  | "INSTANTIATE_FAILED";

/**
 * Accepted input sources for isomorphic WebAssembly compilation and instantiation.
 */
export type WasmSource =
  | BufferSource
  | URL
  | string
  | Response
  | Promise<Response>
  | WebAssembly.Module;

/**
 * Options for {@link initWasm} and {@link compileWasm}.
 */
export interface WasmInitOptions {
  /** Import object passed to `WebAssembly.instantiate`. */
  imports?: WebAssembly.Imports;
  /** Custom `fetch` implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
  /**
   * Cache compiled `WebAssembly.Module` instances by URL or `cacheKey`.
   * Defaults to `true`.
   */
  cache?: boolean;
  /** Explicit cache key when supplying raw bytes (`BufferSource`). */
  cacheKey?: string;
  /**
   * Custom file reader used when loading `file://` URLs or local paths.
   * Useful in Node.js, Bun, or custom test environments.
   */
  readFile?: (path: string | URL) => Promise<Uint8Array | ArrayBuffer>;
}

/**
 * Result returned by {@link initWasm}.
 */
export interface WasmInstanceResult<
  T extends WebAssembly.Exports = WebAssembly.Exports,
> {
  instance: WebAssembly.Instance;
  module: WebAssembly.Module;
  exports: T;
  runtime: WasmRuntime;
}

/**
 * Typed error thrown when WebAssembly loading, compilation, or instantiation fails.
 */
export class WasmLoadError extends Error {
  readonly code: WasmErrorCode;
  readonly runtime: WasmRuntime;
  readonly cause?: unknown;

  constructor(
    code: WasmErrorCode,
    message: string,
    runtime: WasmRuntime,
    cause?: unknown,
  ) {
    super(message);
    this.name = "WasmLoadError";
    this.code = code;
    this.runtime = runtime;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

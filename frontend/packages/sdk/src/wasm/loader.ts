import {
  detectWasmRuntime,
  isStreamingSupported,
  isWasmSupported,
} from "./runtime";
import {
  WasmLoadError,
  type WasmInitOptions,
  type WasmInstanceResult,
  type WasmRuntime,
  type WasmSource,
} from "./types";

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;

const moduleCache = new Map<string, WebAssembly.Module>();

/**
 * Clears all cached compiled `WebAssembly.Module` instances.
 */
export function clearWasmCache(): void {
  moduleCache.clear();
}

/**
 * Returns the number of currently cached `WebAssembly.Module` instances.
 */
export function getWasmCacheSize(): number {
  return moduleCache.size;
}

/**
 * Checks whether the given bytes start with the standard WebAssembly binary
 * magic header (`\0asm`).
 */
export function hasWasmMagicHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < WASM_MAGIC.length) {
    return false;
  }
  return (
    bytes[0] === WASM_MAGIC[0] &&
    bytes[1] === WASM_MAGIC[1] &&
    bytes[2] === WASM_MAGIC[2] &&
    bytes[3] === WASM_MAGIC[3]
  );
}

/**
 * Decodes a base64 string into a `Uint8Array` across Browser, Node.js, Bun,
 * and Edge runtimes without relying on Node-only imports.
 */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, "");
  if (typeof atob === "function") {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  const nodeBuffer = (
    globalThis as unknown as {
      Buffer?: { from(input: string, encoding: string): Uint8Array };
    }
  ).Buffer;

  if (nodeBuffer && typeof nodeBuffer.from === "function") {
    const buf = nodeBuffer.from(normalized, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  throw new WasmLoadError(
    "UNSUPPORTED_RUNTIME",
    "No base64 decoder (atob or Buffer) is available in this runtime.",
    detectWasmRuntime(),
  );
}

function toUint8Array(source: BufferSource): Uint8Array {
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function isBufferSource(value: unknown): value is BufferSource {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function isResponse(value: unknown): value is Response {
  return (
    typeof Response !== "undefined" &&
    value instanceof Response
  );
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isDataUrl(value: string): boolean {
  return /^data:[^,]*;base64,/i.test(value);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isFileUrl(value: string): boolean {
  return /^file:\/\//i.test(value);
}

function isLocalPath(value: string): boolean {
  return (
    isFileUrl(value) ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /^[a-zA-Z]:[\\/]/.test(value)
  );
}

async function readLocalWasmFile(
  pathOrUrl: string | URL,
  runtime: WasmRuntime,
  customReader?: WasmInitOptions["readFile"],
): Promise<Uint8Array> {
  if (customReader) {
    try {
      const data = await customReader(pathOrUrl);
      return toUint8Array(data);
    } catch (err) {
      throw new WasmLoadError(
        "FS_READ_FAILED",
        `Failed to read WASM file via custom readFile: ${String(pathOrUrl)}`,
        runtime,
        err,
      );
    }
  }

  if (runtime !== "node" && runtime !== "bun") {
    throw new WasmLoadError(
      "UNSUPPORTED_RUNTIME",
      `Filesystem WASM loading is only supported in Node.js and Bun (current runtime: ${runtime}).`,
      runtime,
    );
  }

  try {
    // Dynamic specifier prevents browser/edge bundlers from statically resolving node:* built-ins.
    const fsModuleName = "node:fs/promises";
    const urlModuleName = "node:url";
    const fsMod = (await import(/* @vite-ignore */ fsModuleName)) as {
      readFile: (path: string) => Promise<Uint8Array>;
    };

    let filePath: string;
    if (pathOrUrl instanceof URL) {
      const urlMod = (await import(/* @vite-ignore */ urlModuleName)) as {
        fileURLToPath: (url: URL) => string;
      };
      filePath = urlMod.fileURLToPath(pathOrUrl);
    } else if (isFileUrl(pathOrUrl)) {
      const urlMod = (await import(/* @vite-ignore */ urlModuleName)) as {
        fileURLToPath: (url: string) => string;
      };
      filePath = urlMod.fileURLToPath(pathOrUrl);
    } else {
      filePath = pathOrUrl;
    }

    const bytes = await fsMod.readFile(filePath);
    return toUint8Array(bytes);
  } catch (err) {
    throw new WasmLoadError(
      "FS_READ_FAILED",
      `Failed to read WASM file from filesystem: ${String(pathOrUrl)}`,
      runtime,
      err,
    );
  }
}

async function compileBytes(
  bytes: Uint8Array,
  runtime: WasmRuntime,
): Promise<WebAssembly.Module> {
  if (!hasWasmMagicHeader(bytes)) {
    throw new WasmLoadError(
      "INVALID_SOURCE",
      "Invalid WebAssembly binary: missing \\0asm magic header.",
      runtime,
    );
  }

  try {
    const bufferSource = new Uint8Array(bytes);
    return await WebAssembly.compile(bufferSource);
  } catch (err) {
    throw new WasmLoadError(
      "COMPILE_FAILED",
      "Failed to compile WebAssembly binary.",
      runtime,
      err,
    );
  }
}

async function compileFromResponse(
  responseOrPromise: Response | Promise<Response>,
  runtime: WasmRuntime,
): Promise<WebAssembly.Module> {
  let response: Response;
  try {
    response = await responseOrPromise;
  } catch (err) {
    throw new WasmLoadError(
      "FETCH_FAILED",
      "Failed to fetch WebAssembly response.",
      runtime,
      err,
    );
  }

  if (!response.ok) {
    throw new WasmLoadError(
      "FETCH_FAILED",
      `Failed to fetch WebAssembly binary: HTTP ${response.status} ${response.statusText}`.trim(),
      runtime,
    );
  }

  const contentType = response.headers?.get("content-type") ?? "";
  if (
    isStreamingSupported() &&
    contentType.toLowerCase().includes("application/wasm")
  ) {
    try {
      // Clone if available so we can fall back to arrayBuffer() if streaming fails.
      const fallbackClone =
        typeof response.clone === "function" ? response.clone() : null;
      try {
        return await WebAssembly.compileStreaming(response);
      } catch (streamErr) {
        if (!fallbackClone) {
          throw streamErr;
        }
        const buf = await fallbackClone.arrayBuffer();
        return await compileBytes(new Uint8Array(buf), runtime);
      }
    } catch (err) {
      if (err instanceof WasmLoadError) {
        throw err;
      }
      throw new WasmLoadError(
        "COMPILE_FAILED",
        "Failed to stream-compile WebAssembly response.",
        runtime,
        err,
      );
    }
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (err) {
    throw new WasmLoadError(
      "FETCH_FAILED",
      "Failed to read ArrayBuffer from WebAssembly response.",
      runtime,
      err,
    );
  }

  return compileBytes(new Uint8Array(buffer), runtime);
}

function resolveCacheKey(
  source: WasmSource,
  options: WasmInitOptions,
): string | undefined {
  if (options.cache === false) {
    return undefined;
  }
  if (options.cacheKey) {
    return options.cacheKey;
  }
  if (typeof source === "string") {
    return source;
  }
  if (source instanceof URL) {
    return source.href;
  }
  return undefined;
}

/**
 * Compiles a WebAssembly module isomorphically across Node.js (CJS & ESM),
 * Bun, browsers, and edge runtimes.
 */
export async function compileWasm(
  source: WasmSource,
  options: WasmInitOptions = {},
): Promise<WebAssembly.Module> {
  const runtime = detectWasmRuntime();

  if (!isWasmSupported()) {
    throw new WasmLoadError(
      "UNSUPPORTED_RUNTIME",
      "WebAssembly is not supported in this runtime.",
      runtime,
    );
  }

  if (source instanceof WebAssembly.Module) {
    return source;
  }

  const cacheKey = resolveCacheKey(source, options);
  if (cacheKey && moduleCache.has(cacheKey)) {
    return moduleCache.get(cacheKey)!;
  }

  let compiled: WebAssembly.Module;

  if (isBufferSource(source)) {
    compiled = await compileBytes(toUint8Array(source), runtime);
  } else if (isResponse(source) || isPromiseLike<Response>(source)) {
    compiled = await compileFromResponse(source, runtime);
  } else if (source instanceof URL || typeof source === "string") {
    const str = source instanceof URL ? source.href : source;

    if (isDataUrl(str)) {
      const commaIdx = str.indexOf(",");
      const bytes = decodeBase64ToBytes(str.slice(commaIdx + 1));
      compiled = await compileBytes(bytes, runtime);
    } else if (
      (source instanceof URL && source.protocol === "file:") ||
      (!isHttpUrl(str) &&
        isLocalPath(str) &&
        (runtime === "node" || runtime === "bun" || Boolean(options.readFile)))
    ) {
      const bytes = await readLocalWasmFile(source, runtime, options.readFile);
      compiled = await compileBytes(bytes, runtime);
    } else {
      const fetchFn = options.fetch ?? globalThis.fetch;
      if (typeof fetchFn !== "function") {
        throw new WasmLoadError(
          "FETCH_FAILED",
          `No fetch implementation available to load WASM URL: ${str}`,
          runtime,
        );
      }
      compiled = await compileFromResponse(fetchFn(str), runtime);
    }
  } else {
    throw new WasmLoadError(
      "INVALID_SOURCE",
      "Unsupported WebAssembly source type.",
      runtime,
    );
  }

  if (cacheKey) {
    moduleCache.set(cacheKey, compiled);
  }

  return compiled;
}

/**
 * Compiles and instantiates a WebAssembly module isomorphically across
 * Node.js (CJS & ESM), Bun, browsers, and edge runtimes.
 */
export async function initWasm<
  T extends WebAssembly.Exports = WebAssembly.Exports,
>(
  source: WasmSource,
  options: WasmInitOptions = {},
): Promise<WasmInstanceResult<T>> {
  const runtime = detectWasmRuntime();
  const module = await compileWasm(source, options);

  try {
    const instance = await WebAssembly.instantiate(module, options.imports);
    return {
      instance,
      module,
      exports: instance.exports as T,
      runtime,
    };
  } catch (err) {
    throw new WasmLoadError(
      "INSTANTIATE_FAILED",
      "Failed to instantiate WebAssembly module.",
      runtime,
      err,
    );
  }
}

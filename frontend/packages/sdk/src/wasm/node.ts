/**
 * @stellarcred/sdk/wasm (Node.js & Bun entry point)
 *
 * Selected automatically via package.json conditional exports (`node`, `bun`).
 * Provides direct filesystem WASM loading via `node:fs/promises` in addition
 * to the universal isomorphic loader API.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { initWasm, compileWasm } from "./loader";
import type { WasmInitOptions, WasmInstanceResult } from "./types";

export {
  WasmLoadError,
  type WasmErrorCode,
  type WasmInitOptions,
  type WasmInstanceResult,
  type WasmRuntime,
  type WasmSource,
} from "./types";
export {
  detectWasmRuntime,
  isStreamingSupported,
  isWasmSupported,
} from "./runtime";
export {
  clearWasmCache,
  compileWasm,
  decodeBase64ToBytes,
  getWasmCacheSize,
  hasWasmMagicHeader,
  initWasm,
} from "./loader";

async function nodeReadFile(pathOrUrl: string | URL): Promise<Uint8Array> {
  const isUrlObj =
    pathOrUrl instanceof URL ||
    (typeof pathOrUrl === "object" &&
      pathOrUrl !== null &&
      typeof (pathOrUrl as { href?: unknown }).href === "string");

  const filePath = isUrlObj
    ? fileURLToPath((pathOrUrl as { href: string }).href)
    : typeof pathOrUrl === "string" && pathOrUrl.startsWith("file://")
      ? fileURLToPath(pathOrUrl)
      : (pathOrUrl as string);
  const buf = await readFile(filePath);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Compiles a WebAssembly module directly from a local file path or `file://`
 * URL in Node.js and Bun environments.
 */
export function compileWasmFromFile(
  pathOrUrl: string | URL,
  options: Omit<WasmInitOptions, "readFile"> = {},
): Promise<WebAssembly.Module> {
  return compileWasm(pathOrUrl, {
    ...options,
    readFile: nodeReadFile,
  });
}

/**
 * Compiles and instantiates a WebAssembly module directly from a local file
 * path or `file://` URL in Node.js and Bun environments.
 */
export function initWasmFromFile<
  T extends WebAssembly.Exports = WebAssembly.Exports,
>(
  pathOrUrl: string | URL,
  options: Omit<WasmInitOptions, "readFile"> = {},
): Promise<WasmInstanceResult<T>> {
  return initWasm<T>(pathOrUrl, {
    ...options,
    readFile: nodeReadFile,
  });
}

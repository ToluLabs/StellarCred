/**
 * @stellarcred/sdk/wasm
 *
 * Universal isomorphic WebAssembly initialization supporting Node.js
 * (CommonJS & ESM), Bun, browsers, and edge runtimes.
 */
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

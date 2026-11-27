/**
 * @stellarcred/sdk/wasm (browser & edge entry point)
 *
 * Zero Node.js built-in imports. Selected automatically via package.json
 * conditional exports (`browser`, `edge-light`, `workerd`).
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

import type { WasmRuntime } from "./types";

interface RuntimeGlobals {
  Bun?: unknown;
  Deno?: unknown;
  EdgeRuntime?: unknown;
  WebSocketPair?: unknown;
  window?: unknown;
  document?: unknown;
  self?: unknown;
  importScripts?: unknown;
  navigator?: { userAgent?: string };
  process?: { versions?: { node?: string } };
}

/**
 * Detects the active JavaScript runtime so WASM loading can select the
 * optimal strategy (streaming fetch, filesystem read, or buffer compilation).
 */
export function detectWasmRuntime(
  env: RuntimeGlobals = globalThis as unknown as RuntimeGlobals,
): WasmRuntime {
  if (typeof env.Bun !== "undefined") {
    return "bun";
  }

  if (
    typeof env.EdgeRuntime !== "undefined" ||
    typeof env.Deno !== "undefined" ||
    (typeof env.WebSocketPair !== "undefined" &&
      typeof env.window === "undefined") ||
    env.navigator?.userAgent === "Cloudflare-Workers"
  ) {
    return "edge";
  }

  if (
    (typeof env.window !== "undefined" &&
      typeof env.document !== "undefined") ||
    (typeof env.self !== "undefined" && typeof env.importScripts === "function")
  ) {
    return "browser";
  }

  if (typeof env.process !== "undefined" && Boolean(env.process?.versions?.node)) {
    return "node";
  }

  return "unknown";
}

/**
 * Returns `true` if the current runtime exposes the standard `WebAssembly` API.
 */
export function isWasmSupported(): boolean {
  return (
    typeof WebAssembly === "object" &&
    WebAssembly !== null &&
    typeof WebAssembly.compile === "function" &&
    typeof WebAssembly.instantiate === "function"
  );
}

/**
 * Returns `true` if streaming WebAssembly compilation is available.
 */
export function isStreamingSupported(): boolean {
  return (
    isWasmSupported() &&
    typeof WebAssembly.compileStreaming === "function" &&
    typeof WebAssembly.instantiateStreaming === "function"
  );
}

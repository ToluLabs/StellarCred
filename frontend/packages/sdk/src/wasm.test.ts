// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  clearWasmCache,
  compileWasm,
  decodeBase64ToBytes,
  detectWasmRuntime,
  getWasmCacheSize,
  hasWasmMagicHeader,
  initWasm,
  isStreamingSupported,
  isWasmSupported,
  WasmLoadError,
} from "./wasm";
import * as browserWasm from "./wasm/browser";
import * as nodeWasm from "./wasm/node";
import * as sdkIndex from "./index";

/**
 * Minimal valid WebAssembly module exporting `add(i32, i32) -> i32`.
 * Equivalent WAT:
 *   (module
 *     (func (export "add") (param i32 i32) (result i32)
 *       local.get 0
 *       local.get 1
 *       i32.add))
 */
const ADD_WASM_BYTES = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d, // \0asm
  0x01,
  0x00,
  0x00,
  0x00, // version 1
  0x01,
  0x07,
  0x01,
  0x60,
  0x02,
  0x7f,
  0x7f,
  0x01,
  0x7f, // type section: (i32, i32) -> i32
  0x03,
  0x02,
  0x01,
  0x00, // function section: func 0 has type 0
  0x07,
  0x07,
  0x01,
  0x03,
  0x61,
  0x64,
  0x64,
  0x00,
  0x00, // export section: "add" -> func 0
  0x0a,
  0x09,
  0x01,
  0x07,
  0x00,
  0x20,
  0x00,
  0x20,
  0x01,
  0x6a,
  0x0b, // code section
]);

const ADD_WASM_BASE64 = Buffer.from(ADD_WASM_BYTES).toString("base64");
const ADD_WASM_DATA_URL = `data:application/wasm;base64,${ADD_WASM_BASE64}`;

interface AddExports extends WebAssembly.Exports {
  add: (a: number, b: number) => number;
}

describe("Universal WASM runtime detection", () => {
  it("detects Node.js in the current test environment", () => {
    expect(detectWasmRuntime()).toBe("node");
    expect(isWasmSupported()).toBe(true);
    expect(typeof isStreamingSupported()).toBe("boolean");
  });

  it("detects Bun runtime", () => {
    expect(detectWasmRuntime({ Bun: { version: "1.1.0" } })).toBe("bun");
  });

  it("detects Edge runtimes (EdgeRuntime, Cloudflare Workers, Deno)", () => {
    expect(detectWasmRuntime({ EdgeRuntime: "edge-runtime" })).toBe("edge");
    expect(detectWasmRuntime({ Deno: { version: {} } })).toBe("edge");
    expect(detectWasmRuntime({ WebSocketPair: function () {} })).toBe("edge");
    expect(detectWasmRuntime({ navigator: { userAgent: "Cloudflare-Workers" } })).toBe("edge");
  });

  it("detects Browser and WebWorker runtimes", () => {
    expect(detectWasmRuntime({ window: {}, document: {} })).toBe("browser");
    expect(detectWasmRuntime({ self: {}, importScripts: () => {} })).toBe("browser");
  });

  it("returns unknown when no runtime markers exist", () => {
    expect(detectWasmRuntime({})).toBe("unknown");
  });
});

describe("Universal WASM loader (initWasm / compileWasm)", () => {
  let tempDir: string;

  beforeEach(async () => {
    clearWasmCache();
    tempDir = await mkdtemp(join(tmpdir(), "stellarcred-wasm-test-"));
  });

  afterEach(async () => {
    clearWasmCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("validates WASM magic header and decodes base64 isomorphically", () => {
    expect(hasWasmMagicHeader(ADD_WASM_BYTES)).toBe(true);
    expect(hasWasmMagicHeader(new Uint8Array([0x01, 0x02, 0x03, 0x04]))).toBe(false);
    expect(hasWasmMagicHeader(new Uint8Array([0x00, 0x61]))).toBe(false);

    const decoded = decodeBase64ToBytes(ADD_WASM_BASE64);
    expect(decoded).toEqual(ADD_WASM_BYTES);
  });

  it("initializes from Uint8Array and ArrayBuffer", async () => {
    const res1 = await initWasm<AddExports>(ADD_WASM_BYTES);
    expect(res1.exports.add(2, 3)).toBe(5);
    expect(res1.runtime).toBe("node");

    const copy = ADD_WASM_BYTES.slice().buffer;
    const res2 = await initWasm<AddExports>(copy);
    expect(res2.exports.add(10, 25)).toBe(35);
  });

  it("initializes from a pre-compiled WebAssembly.Module", async () => {
    const mod = await compileWasm(ADD_WASM_BYTES);
    const res = await initWasm<AddExports>(mod);
    expect(res.module).toBe(mod);
    expect(res.exports.add(7, 8)).toBe(15);
  });

  it("initializes from a base64 data: URL", async () => {
    const res = await initWasm<AddExports>(ADD_WASM_DATA_URL);
    expect(res.exports.add(20, 22)).toBe(42);
    expect(getWasmCacheSize()).toBe(1);
  });

  it("initializes from a Response with application/wasm and octet-stream fallback", async () => {
    const wasmResponse = new Response(ADD_WASM_BYTES, {
      status: 200,
      headers: { "content-type": "application/wasm" },
    });
    const res1 = await initWasm<AddExports>(wasmResponse);
    expect(res1.exports.add(4, 5)).toBe(9);

    const fallbackResponse = new Response(ADD_WASM_BYTES, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    const res2 = await initWasm<AddExports>(Promise.resolve(fallbackResponse));
    expect(res2.exports.add(11, 13)).toBe(24);
  });

  it("initializes from an HTTPS URL via custom fetch and caches compiled module", async () => {
    let fetchCalls = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCalls++;
      return new Response(ADD_WASM_BYTES, {
        status: 200,
        headers: { "content-type": "application/wasm" },
      });
    };

    const url = "https://cdn.stellarcred.test/circuit.wasm";
    const first = await initWasm<AddExports>(url, { fetch: mockFetch });
    const second = await initWasm<AddExports>(url, { fetch: mockFetch });

    expect(fetchCalls).toBe(1);
    expect(first.module).toBe(second.module);
    expect(first.exports.add(1, 2)).toBe(3);
    expect(second.exports.add(3, 4)).toBe(7);

    // Bypassing cache triggers a second fetch
    await initWasm<AddExports>(url, { fetch: mockFetch, cache: false });
    expect(fetchCalls).toBe(2);
  });

  it("initializes from local file path and file:// URL in Node.js", async () => {
    const wasmPath = join(tempDir, "add.wasm");
    await writeFile(wasmPath, ADD_WASM_BYTES);

    const fromPath = await initWasm<AddExports>(wasmPath);
    expect(fromPath.exports.add(6, 7)).toBe(13);

    clearWasmCache();

    const fromFileUrl = await initWasm<AddExports>(pathToFileURL(wasmPath));
    expect(fromFileUrl.exports.add(8, 9)).toBe(17);
  });

  it("supports node-specific initWasmFromFile and compileWasmFromFile", async () => {
    const wasmPath = join(tempDir, "node-add.wasm");
    await writeFile(wasmPath, ADD_WASM_BYTES);

    const mod = await nodeWasm.compileWasmFromFile(wasmPath);
    expect(mod).toBeInstanceOf(WebAssembly.Module);

    const res = await nodeWasm.initWasmFromFile<AddExports>(pathToFileURL(wasmPath));
    expect(res.exports.add(100, 23)).toBe(123);
  });

  it("throws typed WasmLoadError for invalid bytes, HTTP errors, and missing files", async () => {
    await expect(initWasm(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).rejects.toMatchObject({
      name: "WasmLoadError",
      code: "INVALID_SOURCE",
    });

    await expect(
      initWasm("https://cdn.stellarcred.test/missing.wasm", {
        fetch: async () => new Response("Not Found", { status: 404 }),
      }),
    ).rejects.toMatchObject({
      name: "WasmLoadError",
      code: "FETCH_FAILED",
    });

    await expect(initWasm(join(tempDir, "does-not-exist.wasm"))).rejects.toMatchObject({
      name: "WasmLoadError",
      code: "FS_READ_FAILED",
    });

    // Valid magic header followed by invalid WASM payload -> COMPILE_FAILED
    await expect(
      initWasm(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff, 0xff])),
    ).rejects.toMatchObject({
      name: "WasmLoadError",
      code: "COMPILE_FAILED",
    });
  });

  it("re-exports identical WASM functions from index.ts, StellarCred, and browser entry", () => {
    expect(sdkIndex.initWasm).toBe(initWasm);
    expect(sdkIndex.compileWasm).toBe(compileWasm);
    expect(sdkIndex.detectWasmRuntime).toBe(detectWasmRuntime);
    expect(sdkIndex.WasmLoadError).toBe(WasmLoadError);

    expect(sdkIndex.StellarCred.initWasm).toBe(initWasm);
    expect(sdkIndex.StellarCred.compileWasm).toBe(compileWasm);
    expect(sdkIndex.StellarCred.detectWasmRuntime).toBe(detectWasmRuntime);

    expect(browserWasm.initWasm).toBe(initWasm);
    expect(browserWasm.compileWasm).toBe(compileWasm);
    expect(browserWasm.detectWasmRuntime).toBe(detectWasmRuntime);
  });
});

describe("Universal WASM package conditional exports", () => {
  it("declares conditional exports for CJS, ESM, Bun, Browser, Edge, and Node", async () => {
    const pkgPath = resolve(__dirname, "../package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      exports: Record<string, Record<string, unknown>>;
    };

    expect(pkg.exports["."]).toMatchObject({
      types: "./dist/index.d.ts",
      bun: "./dist/index.mjs",
      "edge-light": "./dist/index.mjs",
      workerd: "./dist/index.mjs",
      browser: "./dist/index.mjs",
      import: "./dist/index.mjs",
      require: "./dist/index.js",
      default: "./dist/index.mjs",
    });

    expect(pkg.exports["./server"]).toMatchObject({
      types: "./dist/server.d.ts",
      bun: "./dist/server.mjs",
      "edge-light": "./dist/server.mjs",
      workerd: "./dist/server.mjs",
      import: "./dist/server.mjs",
      require: "./dist/server.js",
    });

    expect(pkg.exports["./wasm"]).toMatchObject({
      types: "./dist/wasm/index.d.ts",
      browser: {
        import: "./dist/wasm/browser.mjs",
        require: "./dist/wasm/browser.js",
        default: "./dist/wasm/browser.mjs",
      },
      "edge-light": {
        import: "./dist/wasm/browser.mjs",
        default: "./dist/wasm/browser.mjs",
      },
      workerd: {
        import: "./dist/wasm/browser.mjs",
        default: "./dist/wasm/browser.mjs",
      },
      bun: {
        import: "./dist/wasm/node.mjs",
        require: "./dist/wasm/node.js",
        default: "./dist/wasm/node.mjs",
      },
      node: {
        import: "./dist/wasm/node.mjs",
        require: "./dist/wasm/node.js",
        default: "./dist/wasm/node.mjs",
      },
      import: "./dist/wasm/index.mjs",
      require: "./dist/wasm/index.js",
      default: "./dist/wasm/index.mjs",
    });
  });

  it("keeps browser WASM entry free of static node:* imports", async () => {
    const browserEntrySource = await readFile(resolve(__dirname, "./wasm/browser.ts"), "utf8");
    expect(browserEntrySource).not.toMatch(/from\s+["']node:/);
  });
});

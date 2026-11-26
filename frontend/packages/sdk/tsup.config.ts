import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    server: "src/server.ts",
    testing: "src/testing.ts",
    "wasm/index": "src/wasm/index.ts",
    "wasm/browser": "src/wasm/browser.ts",
    "wasm/node": "src/wasm/node.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  platform: "neutral",
  external: ["@stellar/stellar-sdk", "node:fs/promises", "node:url"],
});

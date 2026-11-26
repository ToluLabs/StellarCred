import type { Options } from "tsup";

// Type-only import: CI runs tsup through `npx`, so the config must not need to
// resolve the `tsup` package at runtime.
const config: Options = {
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
};

export default config;

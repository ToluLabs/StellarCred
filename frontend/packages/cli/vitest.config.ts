import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The CLI reuses the SDK from source; `npm run build` inlines it the same way.
    alias: { "@stellarcred/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    // The packaged-binary test spawns node three times; that alone exceeds
    // vitest's 5s default on Windows and cold runners.
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});

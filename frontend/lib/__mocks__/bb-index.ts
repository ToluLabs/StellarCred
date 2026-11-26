// Test-only stand-in for the runtime-only "/bb/index.js" import in
// lib/proof.ts's loadBb() (see the comments there — it's a native ES module
// copied to /public/bb by scripts/copy-bb.mjs, resolved by the *browser* at
// runtime, never part of any bundler's module graph).
//
// Vite (which vitest runs on) refuses to import files under /public as JS
// modules ("Cannot import non-asset file ... which is inside /public"), so
// vitest.config.ts aliases the "/bb/index.js" specifier to this file instead,
// purely so the import resolves during tests. lib/proof.test.ts then
// overrides UltraHonkBackend via vi.mock("/bb/index.js", ...) to control its
// behavior per test; this file's own export is never exercised.
export const UltraHonkBackend = class {
  generateProof(): never {
    throw new Error('bb-index.ts stub was not mocked — call vi.mock("/bb/index.js", ...)');
  }
  destroy(): never {
    throw new Error('bb-index.ts stub was not mocked — call vi.mock("/bb/index.js", ...)');
  }
};

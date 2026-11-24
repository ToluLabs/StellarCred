// Vitest global setup. Kept minimal — matchers and polyfills that are only
// needed by specific suites should be imported there, not here, so this stays
// fast for pure unit tests.

// jsdom does not implement matchMedia (used by some UI code under test is not
// needed for the current suites, but guarding it keeps future tests stable).
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
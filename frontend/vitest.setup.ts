import "@testing-library/jest-dom/vitest";

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

if (typeof window !== "undefined") {
  if (!window.localStorage || typeof window.localStorage.getItem !== "function") {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => store.set(key, String(val)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
    };
    Object.defineProperty(window, "localStorage", { value: mockStorage, writable: true });
    Object.defineProperty(globalThis, "localStorage", { value: mockStorage, writable: true });
  } else if (typeof localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", { value: window.localStorage, writable: true });
  }
}
class MemoryStorage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value));
  }
}

const mockLocalStorage = new MemoryStorage();
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: mockLocalStorage,
    writable: true,
    configurable: true,
  });
}
try {
  Object.defineProperty(globalThis, "localStorage", {
    value: mockLocalStorage,
    writable: true,
    configurable: true,
  });
} catch {
  // Ignore if non-configurable
}


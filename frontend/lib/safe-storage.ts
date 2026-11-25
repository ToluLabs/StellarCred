/**
 * Safe localStorage access helper.
 *
 * Handles private mode / blocked storage scenarios by catching errors
 * and providing safe no-op fallbacks. This is used to guard storage
 * operations that might fail in restricted browser environments.
 */

/**
 * Safely read from localStorage. Returns null if storage is unavailable.
 */
export function safeGetItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    // private mode / blocked storage
    return null;
  }
}

/**
 * Safely write to localStorage. Silently fails if storage is unavailable.
 */
export function safeSetItem(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    // private mode / blocked storage — silently fail
  }
}

/**
 * Safely remove from localStorage. Silently fails if storage is unavailable.
 */
export function safeRemoveItem(key: string): void {
  if (typeof window === "undefined") return;
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    // private mode / blocked storage — silently fail
  }
}

/**
 * Check if localStorage is available for writes.
 * Returns false in private mode or if storage is blocked.
 */
export function isStorageAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const testKey = "__storage_test__";
    globalThis.localStorage.setItem(testKey, "test");
    globalThis.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

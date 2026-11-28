"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/**
 * Returns true once the component has mounted on the client.
 * Uses useSyncExternalStore to guarantee server and initial client renders match exactly,
 * preventing hydration mismatch warnings and flash-of-incorrect-state (#947).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

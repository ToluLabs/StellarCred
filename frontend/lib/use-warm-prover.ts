"use client";

// Warms the UltraHonk prover for the holder page's unproved credential types
// in the background, so the backend is already constructed by the time the
// user clicks "Prove". Trigger and lifecycle live here rather than in the
// prover modules so those stay plain data/cache modules with no React
// dependency.
//
// Warming goes through lib/proof-client.ts, which owns the dedicated prover
// worker: the warm request is handled *in the worker*, so the bytecode fetch
// and wasm init happen off the UI thread too. When workers are unavailable the
// same calls fall back to the main-thread backend cache in lib/proof.ts.

import { useEffect } from "react";
import { warmProver, releaseProver } from "./proof-client";
import type { CredentialType } from "./stellar";

/**
 * Kicks off background warming for each of `types` once `enabled` is true
 * (the holder page passes the wallet's connected state — never warm before
 * that, and never before crossOriginIsolated is knowable, which the prover
 * reads live at construction time rather than assuming here).
 *
 * Warming is fire-and-forget: it doesn't block render and never throws (see
 * warmBackend in lib/proof.ts). Repeated calls for the same type — including
 * the effect re-running under React StrictMode's mount/unmount/mount, or a
 * real prove click racing an in-flight warm — share the single in-flight
 * construction via the prover's backend cache, so nothing is ever
 * double-constructed.
 *
 * This hook also owns teardown: the backend cache lives as long as the prover
 * worker does (module/worker scope, shared for the whole tab), so something
 * has to decide when to stop holding onto warmed backends. This hook is that
 * owner — the worker, and every backend and its wasm memory with it, is
 * released when the calling component unmounts (e.g. SPA navigation away from
 * the holder page) or the tab is closed/reloaded (`beforeunload`). Only mount
 * the holder page's warming from one place, or an earlier unmount will tear
 * down backends a later mount still expects to be warm.
 */
export function useWarmProver(types: CredentialType[], enabled: boolean): void {
  // Stable key so the warm effect only re-fires when the *set* of types
  // actually changes, not on every render that happens to pass a new array
  // instance with the same contents.
  const key = types.join(",");

  useEffect(() => {
    if (!enabled) return;
    for (const type of types) {
      warmProver(type);
    }
    // `types` intentionally excluded: `key` is the derived, order/content-
    // stable dependency that should actually re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  // Separate, mount/unmount-only effect: registers the tab-close cleanup
  // once and tears the prover down when this hook's owner unmounts,
  // regardless of how many times the warm effect above re-ran.
  useEffect(() => {
    const handleUnload = () => {
      releaseProver();
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      releaseProver();
    };
  }, []);
}

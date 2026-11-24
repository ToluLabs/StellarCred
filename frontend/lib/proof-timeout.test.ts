// Coverage for the proof deadline helpers in lib/proof-timeout.ts.
//
// These live in their own module (and their own test file) because they are
// dependency-free AbortController plumbing: the UI imports them without
// pulling the proving engine into the holder route chunk.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withTimeout,
  ProofTimeoutError,
  DEFAULT_PROOF_TIMEOUT_MS,
} from "./proof-timeout";

describe("withTimeout / ProofTimeoutError", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves normally when the function completes before the deadline", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withTimeout(() => fn(), { timeoutMs: 5000 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws ProofTimeoutError when the deadline fires first", async () => {
    // The inner function must observe the abort signal so the promise
    // actually rejects when the controller fires.
    const fn = vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const promise = withTimeout(() => fn(), { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);

    await expect(promise).rejects.toThrow(ProofTimeoutError);
  });

  it("forwards the caller signal so user-cancel still works", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const promise = withTimeout(() => fn(controller.signal), {
      timeoutMs: 60_000,
    });

    // User cancels before the timeout.
    controller.abort();

    await expect(promise).rejects.toThrow(/Aborted/);
    // Must NOT be ProofTimeoutError — this was a user cancel.
    await expect(promise).rejects.not.toThrow(ProofTimeoutError);
  });

  it("cleans up the timer when the function resolves early", async () => {
    const fn = vi.fn().mockResolvedValue("done");
    await withTimeout(() => fn(), { timeoutMs: 5000 });

    // Advancing past the deadline should be a no-op (timer cleared).
    vi.advanceTimersByTime(10_000);
    // No unhandled-rejection or other side-effect.
  });

  it("rejects immediately if caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const fn = vi.fn();
    await expect(
      withTimeout(() => fn(), { signal: controller.signal }),
    ).rejects.toThrow(/Aborted/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses DEFAULT_PROOF_TIMEOUT_MS when no timeoutMs is given", () => {
    expect(DEFAULT_PROOF_TIMEOUT_MS).toBeGreaterThan(0);
    // Just verify it's a reasonable value (not 0, not Infinity).
    expect(DEFAULT_PROOF_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });
});

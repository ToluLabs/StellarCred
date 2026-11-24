// Coverage for the trigger/lifecycle wiring in use-warm-prover.ts. The prover
// internals (backend-cache reuse, double-init guard, graceful failure) are
// covered in proof.test.ts against the real cache, and the worker transport in
// __tests__/proof-worker.test.ts; here we only verify the hook calls into the
// prover client correctly and at the right times.

import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialType } from "./stellar";

const { warmProver, releaseProver } = vi.hoisted(() => ({
  warmProver: vi.fn(),
  releaseProver: vi.fn(),
}));

// The hook talks to the prover *client* (which owns the dedicated worker and
// falls back to lib/proof.ts's main-thread cache), not to lib/proof.ts
// directly -- so that is the seam this suite mocks.
vi.mock("./proof-client", () => ({ warmProver, releaseProver }));

import { useWarmProver } from "./use-warm-prover";

interface Props {
  types: CredentialType[];
  enabled: boolean;
}

describe("useWarmProver", () => {
  beforeEach(() => {
    warmProver.mockClear();
    releaseProver.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not warm when disabled (wallet not connected)", () => {
    renderHook(() => useWarmProver(["age", "kyc"], false));
    expect(warmProver).not.toHaveBeenCalled();
  });

  it("warms every given type once enabled", () => {
    renderHook(() => useWarmProver(["age", "kyc"], true));
    expect(warmProver).toHaveBeenCalledTimes(2);
    expect(warmProver).toHaveBeenCalledWith("age");
    expect(warmProver).toHaveBeenCalledWith("kyc");
  });

  it("does not re-warm on a re-render with the same types", () => {
    const { rerender } = renderHook(
      ({ types, enabled }: Props) => useWarmProver(types, enabled),
      { initialProps: { types: ["age"], enabled: true } },
    );
    expect(warmProver).toHaveBeenCalledTimes(1);

    // A fresh array instance with identical contents should not re-trigger
    // warming -- the hook keys its effect off the joined type list, not
    // array identity.
    rerender({ types: ["age"], enabled: true });
    expect(warmProver).toHaveBeenCalledTimes(1);
  });

  it("re-warms when the set of unproved types changes", () => {
    const { rerender } = renderHook(
      ({ types, enabled }: Props) => useWarmProver(types, enabled),
      { initialProps: { types: ["age"], enabled: true } },
    );
    expect(warmProver).toHaveBeenCalledTimes(1);

    // The effect re-fires for the whole new list (warmProver/getBackend is
    // cheap to call again for an already-warm type -- see proof.test.ts's
    // cache-reuse coverage), so "age" is called again alongside the new
    // "kyc" rather than only the newly-added type.
    rerender({ types: ["age", "kyc"], enabled: true });
    expect(warmProver).toHaveBeenCalledTimes(3);
    expect(warmProver).toHaveBeenLastCalledWith("kyc");
  });

  it("starts warming once the wallet transitions from disconnected to connected", () => {
    const { rerender } = renderHook(
      ({ types, enabled }: Props) => useWarmProver(types, enabled),
      { initialProps: { types: ["age"], enabled: false } },
    );
    expect(warmProver).not.toHaveBeenCalled();

    rerender({ types: ["age"], enabled: true });
    expect(warmProver).toHaveBeenCalledTimes(1);
  });

  it("releases the prover on unmount", () => {
    const { unmount } = renderHook(() => useWarmProver(["age"], true));
    expect(releaseProver).not.toHaveBeenCalled();

    unmount();
    expect(releaseProver).toHaveBeenCalledTimes(1);
  });

  it("releases the prover on beforeunload", () => {
    renderHook(() => useWarmProver(["age"], true));
    window.dispatchEvent(new Event("beforeunload"));
    expect(releaseProver).toHaveBeenCalledTimes(1);
  });

  it("removes its beforeunload listener on unmount (no leak, no double-release)", () => {
    const { unmount } = renderHook(() => useWarmProver(["age"], true));
    unmount();
    releaseProver.mockClear();

    window.dispatchEvent(new Event("beforeunload"));
    expect(releaseProver).not.toHaveBeenCalled();
  });
});

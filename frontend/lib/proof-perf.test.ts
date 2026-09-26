// @vitest-environment jsdom
//
// Unit tests for the slim proving-performance tracker (GitHub #432):
// budgets, per-stage timings, time-to-first-proof, storage, and budget flags.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PROOF_PERF_TARGETS,
  createProofRun,
  getProofRuns,
  clearProofRuns,
  getDeviceClass,
  type ProofRunTracker,
} from "./proof-perf";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `perf.measure(stage, sleep(ms))` while advancing the faked clock by `ms`
 * so the timer actually fires and the recorded duration is exactly `ms`.
 */
async function timed(
  perf: ProofRunTracker,
  stage: "witness" | "prove",
  ms: number,
  warm?: boolean,
): Promise<void> {
  const p = perf.measure(stage, () => sleep(ms), warm);
  await vi.advanceTimersByTimeAsync(ms);
  await p;
}

beforeEach(() => {
  localStorage.clear();
  // Fake performance.now + setTimeout so stage durations are deterministic.
  vi.useFakeTimers({ toFake: ["performance", "Date", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  clearProofRuns();
});

describe("ProofRunTracker", () => {
  it("measures witness + prove into timeToFirstProof and records the run", async () => {
    const perf = createProofRun("kyc");
    const id = perf.id;

    await timed(perf, "witness", 2000);
    await timed(perf, "prove", 8000);

    const run = perf.finishProof({ status: "ok" });

    expect(run.id).toBe(id);
    expect(run.credentialType).toBe("kyc");
    expect(run.status).toBe("ok");
    expect(run.timeToFirstProofMs).toBe(10_000);
    expect(run.totalMs).toBe(run.timeToFirstProofMs);
    expect(run.stages.map((s) => s.stage)).toEqual(["witness", "prove"]);
    expect(run.stages.find((s) => s.stage === "witness")!.durationMs).toBe(2000);
    expect(run.stages.find((s) => s.stage === "prove")!.durationMs).toBe(8000);

    // The run is persisted.
    const stored = getProofRuns();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(id);
    expect(stored[0].timeToFirstProofMs).toBe(10_000);
  });

  it("records the warm flag for a reused backend", async () => {
    const perf = createProofRun("age");
    await timed(perf, "witness", 100);
    await timed(perf, "prove", 100, true);
    const run = perf.finishProof();
    expect(run.warm).toBe(true);
    expect(run.stages.find((s) => s.stage === "prove")!.warm).toBe(true);
  });

  it("flags exceededBudget via an individual stage under/over target", async () => {
    const perf = createProofRun("kyc");
    await timed(perf, "witness", 5_000); // under witness budget
    await timed(perf, "prove", 1_000);
    const ok = perf.finishProof();
    expect(ok.exceededBudget).toBe(false);

    const bad = createProofRun("kyc");
    await timed(bad, "witness", PROOF_PERF_TARGETS.witnessMs + 1_000);
    await timed(bad, "prove", 100);
    const over = bad.finishProof();
    expect(over.exceededBudget).toBe(true);
    expect(over.stages.find((s) => s.stage === "witness")!.overBudget).toBe(true);
  });

  it("records an errored run with the failing stage attributed", async () => {
    const perf = createProofRun("income");
    await timed(perf, "witness", 100);
    await expect(
      perf.measure("prove", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    perf.failAt("prove");
    const run = perf.finishProof({ status: "errored", errorStage: "prove" });
    expect(run.status).toBe("errored");
    expect(run.errorStage).toBe("prove");
    // Even a failed run persists, for debugging.
    expect(getProofRuns().some((r) => r.id === run.id)).toBe(true);
  });

  it("attaches submission timing via recordSubmit", async () => {
    const perf = createProofRun("age");
    await timed(perf, "witness", 100);
    await timed(perf, "prove", 100);
    const before = perf.finishProof({ status: "ok" });
    expect(before.stages).toHaveLength(2);

    perf.recordSubmit(1200);

    const updated = getProofRuns().find((r) => r.id === perf.id)!;
    expect(updated.stages).toHaveLength(3);
    expect(updated.stages[2].stage).toBe("submit");
    expect(updated.stages[2].durationMs).toBe(1200);
    expect(updated.totalMs).toBe(before.timeToFirstProofMs + 1200);
  });

  it("storage helpers round-trip and clear", () => {
    const perf = createProofRun("funds");
    perf.finishProof();
    expect(getProofRuns()).toHaveLength(1);
    clearProofRuns();
    expect(getProofRuns()).toHaveLength(0);
  });
});

describe("getDeviceClass", () => {
  it("returns a coarse, anonymous class", () => {
    const d = getDeviceClass();
    expect(typeof d.deviceClass).toBe("string");
    expect(typeof d.cores).toBe("number");
  });
});
/**
 * latency-regression.test.ts — the pgbench gate's decision rule.
 *
 * These tests pin the contract the CI job relies on: a regression fails the
 * run, while ordinary CI jitter on a fast query does not. A baseline that has
 * never been recorded (version < 2) is skipped rather than failed.
 */

import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_LATENCY_GATE,
  evaluateLatencyGate,
  type LatencyBaseline,
} from "./latency-regression";

const committedBaseline: LatencyBaseline = {
  version: 2,
  workload: "indexer mixed read/write",
  averageLatencyMs: 4,
  tps: 900,
};

const placeholderBaseline: LatencyBaseline = {
  version: 1,
  workload: "placeholder",
  averageLatencyMs: 6,
};

describe("evaluateLatencyGate", () => {
  it("skips, with a message, when no committed baseline has been recorded yet", () => {
    const result = evaluateLatencyGate({ averageLatencyMs: 3.2 }, placeholderBaseline);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "gate-skipped: no committed baseline recorded yet — run pgbench and update perf/pgbench/baseline.json",
    ]);
    expect(result.failures).not.toContain("gate-failed");
  });

  it("skips even when the placeholder value is small", () => {
    const result = evaluateLatencyGate(
      { averageLatencyMs: 4.5 },
      { version: 1, workload: "placeholder", averageLatencyMs: 0.05 },
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "gate-skipped: no committed baseline recorded yet — run pgbench and update perf/pgbench/baseline.json",
    ]);
    expect(result.failures).not.toContain("gate-failed");
  });

  it("honours a committed baseline with a small measured value (version >= 2)", () => {
    const result = evaluateLatencyGate(
      { averageLatencyMs: 0.12 },
      { version: 2, workload: "regenerated", averageLatencyMs: 0.1 },
      { toleranceFactor: 2.5, absoluteFloorMs: 0 },
    );
    expect(result.ok).toBe(true);
  });

  it("honours a committed baseline that regressed beyond the tolerance", () => {
    const result = evaluateLatencyGate(
      { averageLatencyMs: 10 },
      { version: 2, workload: "regenerated", averageLatencyMs: 1 },
      { toleranceFactor: 2.5, absoluteFloorMs: 0 },
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/exceeds the 2\.50 ms budget/);
  });

  it("passes a run at or below a committed baseline", () => {
    const result = evaluateLatencyGate({ averageLatencyMs: 3.2 }, committedBaseline);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    // max(4 ms × 2.5, 20 ms floor) — the floor wins for a fast baseline.
    expect(result.budgetMs).toBe(20);
  });

  it("passes mild CI noise within the tolerance", () => {
    expect(evaluateLatencyGate({ averageLatencyMs: 9.9 }, committedBaseline).ok).toBe(
      true,
    );
  });

  it("fails a run beyond the tolerance budget", () => {
    const result = evaluateLatencyGate({ averageLatencyMs: 12.5 }, committedBaseline, {
      toleranceFactor: 2.5,
      absoluteFloorMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/exceeds the 10\.00 ms budget/);
  });

  it("uses the absolute floor when the committed baseline is very fast", () => {
    const result = evaluateLatencyGate(
      { averageLatencyMs: 15 },
      { version: 2, workload: "regenerated", averageLatencyMs: 0.5 },
    );
    expect(result.budgetMs).toBe(DEFAULT_LATENCY_GATE.absoluteFloorMs);
    expect(result.ok).toBe(true);
    expect(
      evaluateLatencyGate({ averageLatencyMs: 21 }, {
        version: 2,
        workload: "regenerated",
        averageLatencyMs: 0.5,
      }).ok,
    ).toBe(false);
  });

  it("honours a looser or tighter tolerance", () => {
    const tenMs: LatencyBaseline = {
      version: 2,
      workload: "regenerated",
      averageLatencyMs: 10,
    };
    expect(
      evaluateLatencyGate({ averageLatencyMs: 30 }, tenMs, {
        toleranceFactor: 4,
        absoluteFloorMs: 0,
      }).ok,
    ).toBe(true);
    expect(
      evaluateLatencyGate({ averageLatencyMs: 15 }, tenMs, {
        toleranceFactor: 1,
        absoluteFloorMs: 0,
      }).ok,
    ).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid observed latency (%p)",
    (observed) => {
      const result = evaluateLatencyGate({ averageLatencyMs: observed }, committedBaseline);
      expect(result.ok).toBe(false);
      expect(result.failures[0]).toMatch(/invalid average latency/);
    },
  );

  it("rejects an invalid baseline rather than silently passing", () => {
    const result = evaluateLatencyGate(
      { averageLatencyMs: 1 },
      { version: 2, averageLatencyMs: 0 },
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/latency baseline is invalid/);
  });

  it("rejects an invalid gate configuration", () => {
    const result = evaluateLatencyGate({ averageLatencyMs: 1 }, committedBaseline, {
      toleranceFactor: 0.5,
      absoluteFloorMs: -1,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "toleranceFactor must be >= 1, got 0.5",
      "absoluteFloorMs must be >= 0, got -1",
    ]);
  });
});

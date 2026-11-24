"use client";

// Anonymized summary + opt-in reporting for proving-performance telemetry
// (GitHub #432). Imported by the debug panel (and potentially tooling) only —
// not by the holder page — so its weight stays out of the proving bundle.

import {
  getProofRuns,
  updateProofRun,
  type ProofRun,
  type ProofStageName,
  type StageTiming,
} from "./proof-perf";

// ---------------------------------------------------------------------------
// Aggregates (for the debug view and the reported payload)
// ---------------------------------------------------------------------------

export interface StageSummary {
  stage: ProofStageName;
  /** Mean duration in ms across runs. */
  avgMs: number;
  /** Median duration in ms. */
  p50Ms: number;
  minMs: number;
  maxMs: number;
  /** How many runs exceeded this stage's budget. */
  overCount: number;
}

export interface PerfSummary {
  totalRuns: number;
  timeToFirstProof: { avgMs: number; p50Ms: number; minMs: number; maxMs: number };
  byStage: StageSummary[];
  deviceClasses: string[];
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function forStage(runs: ProofRun[], stage: ProofStageName): StageTiming[] {
  return runs
    .map((r) => r.stages.find((s) => s.stage === stage))
    .filter(Boolean) as StageTiming[];
}

/** Summarize a set of runs for the debug view / reporting payload. */
export function summarizeProofs(runs: ProofRun[]): PerfSummary {
  const ttf = runs.map((r) => r.timeToFirstProofMs);
  const stages: StageSummary[] = (["witness", "prove", "submit"] as const).map((stage) => {
    const list = forStage(runs, stage);
    const nums = list.map((s) => s.durationMs);
    return {
      stage,
      avgMs: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0,
      p50Ms: median(nums),
      minMs: nums.length ? Math.min(...nums) : 0,
      maxMs: nums.length ? Math.max(...nums) : 0,
      overCount: list.filter((s) => s.overBudget).length,
    };
  });
  return {
    totalRuns: runs.length,
    timeToFirstProof: {
      avgMs: ttf.length ? ttf.reduce((a, b) => a + b, 0) / ttf.length : 0,
      p50Ms: median(ttf),
      minMs: ttf.length ? Math.min(...ttf) : 0,
      maxMs: ttf.length ? Math.max(...ttf) : 0,
    },
    byStage: stages,
    deviceClasses: Array.from(new Set(runs.map((r) => r.deviceClass))),
  };
}

// ---------------------------------------------------------------------------
// Opt-in anonymized reporting
// ---------------------------------------------------------------------------

const OPTIN_KEY = "stellarcred:proof-telemetry-optin";

export function isTelemetryOptIn(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(OPTIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setTelemetryOptIn(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (enabled) localStorage.setItem(OPTIN_KEY, "1");
    else localStorage.removeItem(OPTIN_KEY);
  } catch {
    // best-effort
  }
}

/**
 * If telemetry is opted in, POST this session's not-yet-reported anonymized runs
 * to /api/proof-telemetry and mark them sent on success. Returns the number of
 * runs reported (0 when not opted in / nothing pending / failure). Never throws —
 * reporting must never break proving.
 */
export async function reportOptedInRuns(): Promise<number> {
  if (!isTelemetryOptIn()) return 0;
  const pending = getProofRuns().filter((r) => r.reportedAt === undefined);
  if (pending.length === 0) return 0;

  // Build payload without `reportedAt` — it's local bookkeeping only.
  const payload = pending.map((r) => ({
    id: r.id,
    status: r.status,
    credentialType: r.credentialType,
    startedAt: r.startedAt,
    timeToFirstProofMs: r.timeToFirstProofMs,
    totalMs: r.totalMs,
    stages: r.stages,
    exceededBudget: r.exceededBudget,
    errorStage: r.errorStage,
    deviceClass: r.deviceClass,
    cores: r.cores,
    memoryGB: r.memoryGB,
    warm: r.warm,
  }));

  try {
    const res = await fetch("/api/proof-telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runs: payload }),
    });
    if (!res.ok) return 0;
    const now = Date.now();
    for (const r of pending) updateProofRun(r.id, { reportedAt: now });
    return pending.length;
  } catch {
    return 0;
  }
}
"use client";

// Slim core of proving-performance telemetry (GitHub #432).
//
// This module is intentionally kept small and dependency-light because the
// holder page imports it statically at the top level (its bytes land in the
// holder route's initial bundle, budgeted at 16 kB). The heavier pieces
// — run summaries, the anonymized opt-in reporter — live in
// lib/proof-telemetry.ts, which re-exports everything here and is only pulled
// in by lazily-loaded code, keeping this core from bloating the proving UI.
//
// Privacy: no identity data. Only the circuit kind, a coarse device class, and
// raw timing numbers.

// ---------------------------------------------------------------------------
// Browser-safe opaque id (avoids the node crypto import in the client bundle)
// ---------------------------------------------------------------------------

function cryptoId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // fall through to the non-crypto fallback
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface PerfBudget {
  /** Target for the witness stage (server-side Nitro / Noir execution). */
  witnessMs: number;
  /** Target for the browser UltraHonk proving stage. */
  proveMs: number;
  /** Target for the on-chain (ProofRegistry) submission stage. */
  submitMs: number;
  /** Target for the whole time-to-first-proof (witness + prove). */
  timeToFirstProofMs: number;
}

/**
 * Explicit performance budgets. A run that exceeds any of these is flagged
 * `overBudget` so the debug view can call it out. Picked relative to the
 * existing UX cues: the holder UI advertises "~10–20s" for proving and
 * enforces a 120s cap via DEFAULT_PROOF_TIMEOUT_MS.
 */
export const PROOF_PERF_TARGETS: PerfBudget = {
  witnessMs: 20_000,
  proveMs: 60_000,
  submitMs: 15_000,
  timeToFirstProofMs: 90_000,
};

export type ProofStageName = "witness" | "prove" | "submit";

export interface StageTiming {
  stage: ProofStageName;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Target budget for this stage (see PROOF_PERF_TARGETS). */
  budgetMs: number;
  /** True when this single stage exceeded its own budget. */
  overBudget: boolean;
  /** True when the prover was already warm (backend reused). Prove only. */
  warm?: boolean;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type ProofRunStatus = "ok" | "errored";

export interface ProofRun {
  /** Opaque id so a run can be updated when its submission completes later. */
  id: string;
  status: ProofRunStatus;
  /** Circuit kind, e.g. "kyc" / "age" / "aggregate". Not identity data. */
  credentialType: string;
  /** Epoch ms when witness generation began. */
  startedAt: number;
  /** Witness + prove, i.e. the core time-to-first-proof (ms). */
  timeToFirstProofMs: number;
  /** timeToFirstProofMs + submission (ms), relevant after submit. */
  totalMs: number;
  /** Individual stage timings (always witness + prove; submit if captured). */
  stages: StageTiming[];
  /** True if any stage (or the total) exceeded its budget. */
  exceededBudget: boolean;
  /** Which stage failed, when status is "errored". */
  errorStage?: ProofStageName;
  /** Coarse device signals (no PII). */
  deviceClass: string;
  cores: number;
  memoryGB: number;
  /** True when the prover backend was already constructed (second+ proof). */
  warm: boolean;
  /** Set when the run's anonymized numbers were sent to the server. */
  reportedAt?: number;
}

// ---------------------------------------------------------------------------
// Device class (anonymized)
// ---------------------------------------------------------------------------

function readNav(): { cores: number; memoryGB: number } | null {
  if (typeof navigator === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mem = (navigator as any).deviceMemory ?? 0;
  return { cores: navigator.hardwareConcurrency ?? 0, memoryGB: mem };
}

/** Coarse, stable device classification with no identifying detail. */
export function getDeviceClass(): {
  deviceClass: string;
  cores: number;
  memoryGB: number;
} {
  const nav = readNav();
  if (!nav) return { deviceClass: "unknown", cores: 0, memoryGB: 0 };
  const bucket =
    nav.cores >= 8 ? "high" : nav.cores >= 4 ? "mid" : nav.cores > 0 ? "low" : "unknown";
  return { deviceClass: bucket, cores: nav.cores, memoryGB: nav.memoryGB };
}

// ---------------------------------------------------------------------------
// Storage (bounded, in localStorage)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "stellarcred:proof-perf";
const MAX_RUNS = 50;

function readAll(): ProofRun[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ProofRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(runs: ProofRun[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs.slice(0, MAX_RUNS)));
  } catch {
    // Quota / private-mode — telemetry is best-effort, never fatal.
  }
}

/** Return the stored proof-run history (newest first). */
export function getProofRuns(): ProofRun[] {
  return readAll();
}

/** Wipe the stored history. */
export function clearProofRuns(): void {
  writeAll([]);
}

/** Upsert a run by id (used to attach submission timing after the fact). */
export function updateProofRun(id: string, patch: Partial<ProofRun>): void {
  const runs = readAll();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx === -1) return;
  runs[idx] = { ...runs[idx], ...patch };
  writeAll(runs);
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/**
 * Measures one proof end-to-end. Usage (from the holder page):
 *
 *   import { createProofRun } from "@/lib/proof-perf";
 *   const perf = createProofRun(cred.type);
 *   await perf.measure("witness", () => computeWitness(cred.type, cred));
 *   await perf.measure("prove", () => proveWithBackend(cred.type, witness), warm);
 *   const run = perf.finishProof();                 // records to storage
 *   ...later, on submit success...
 *   perf.recordSubmit(submitMs);                    // attaches submit timing
 *
 * `measure` times the promise and records the stage in `finally`, so a thrown
 * stage still produces a timing (surfaced as an errored run via finishProof).
 */
export class ProofRunTracker {
  readonly id: string;
  readonly credentialType: string;
  private started = Date.now();
  private stageMark = 0;
  private stageTimes: Partial<Record<ProofStageName, number>> = {};
  private warm = false;

  constructor(credentialType: string) {
    this.id = cryptoId();
    this.credentialType = credentialType;
  }

  private begin(): void {
    this.stageMark = performance.now();
  }

  private end(stage: ProofStageName): void {
    this.stageTimes[stage] = performance.now() - this.stageMark;
  }

  /** Time `fn`, recording `stage` in a finally block. Returns fn's result. */
  async measure<T>(
    stage: ProofStageName,
    fn: () => Promise<T>,
    warm?: boolean,
  ): Promise<T> {
    this.begin();
    try {
      return await fn();
    } finally {
      this.end(stage);
      if (warm !== undefined) this.warm = warm;
    }
  }

  /** Mark a failed stage so the run records which one errored. */
  failAt(stage: ProofStageName): void {
    this.stageTimes[stage] = performance.now() - this.stageMark;
  }

  /**
   * Finalize, record, and return the run covering witness + prove. Records to
   * storage automatically. `status`/`errorStage` describe an errored run.
   */
  finishProof(opts: { status?: ProofRunStatus; errorStage?: ProofStageName } = {}): ProofRun {
    const { status = "ok", errorStage } = opts;
    const witnessMs = this.stageTimes["witness"] ?? 0;
    const proveMs = this.stageTimes["prove"] ?? 0;
    const timeToFirstProofMs = witnessMs + proveMs;

    const stages: StageTiming[] = [];
    if (this.stageTimes["witness"] !== undefined) {
      stages.push({
        stage: "witness",
        durationMs: witnessMs,
        budgetMs: PROOF_PERF_TARGETS.witnessMs,
        overBudget: witnessMs > PROOF_PERF_TARGETS.witnessMs,
      });
    }
    if (this.stageTimes["prove"] !== undefined) {
      stages.push({
        stage: "prove",
        durationMs: proveMs,
        budgetMs: PROOF_PERF_TARGETS.proveMs,
        overBudget: proveMs > PROOF_PERF_TARGETS.proveMs,
        warm: this.warm,
      });
    }

    const device = getDeviceClass();
    const run: ProofRun = {
      id: this.id,
      status,
      credentialType: this.credentialType,
      startedAt: this.started,
      timeToFirstProofMs,
      totalMs: timeToFirstProofMs,
      stages,
      exceededBudget:
        timeToFirstProofMs > PROOF_PERF_TARGETS.timeToFirstProofMs ||
        stages.some((s) => s.overBudget),
      errorStage,
      deviceClass: device.deviceClass,
      cores: device.cores,
      memoryGB: device.memoryGB,
      warm: this.warm,
    };

    const runs = readAll();
    runs.unshift(run);
    writeAll(runs);
    return run;
  }

  /**
   * Attach the on-chain submission timing to this run. Must be called after
   * finishProof(); it updates the stored record to include the submit stage.
   */
  recordSubmit(submitMs: number): void {
    if (typeof submitMs !== "number" || !Number.isFinite(submitMs) || submitMs < 0) return;
    const run = readAll().find((r) => r.id === this.id);
    if (!run) return;
    const submitStage: StageTiming = {
      stage: "submit",
      durationMs: submitMs,
      budgetMs: PROOF_PERF_TARGETS.submitMs,
      overBudget: submitMs > PROOF_PERF_TARGETS.submitMs,
    };
    const stages = [...run.stages, submitStage];
    const totalMs = run.timeToFirstProofMs + submitMs;
    updateProofRun(this.id, {
      stages,
      totalMs,
      exceededBudget:
        totalMs > PROOF_PERF_TARGETS.timeToFirstProofMs ||
        stages.some((s) => s.overBudget),
    });
  }
}

/** Convenience factory matching `new ProofRunTracker(credentialType)`. */
export function createProofRun(credentialType: string): ProofRunTracker {
  return new ProofRunTracker(credentialType);
}
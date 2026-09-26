"use client";

// Proving-performance telemetry — aggregates & opt-in reporting (GitHub #432).
//
// This file layers the heavier analysis on top of the slim core in
// lib/proof-perf.ts (which holds the budgets, the ProofRunTracker, device
// classification, and localStorage history). It is intentionally NOT imported
// by the holder page itself — the debug panel and any tooling pull it in
// lazily so the core stays out of the proving UI's initial bundle.
//
// Privacy: everything here operates on the anonymized ProofRun records from
// proof-perf — circuit kind, coarse device class, and timing numbers. No
// identity data is ever generated or transmitted.

export * from "./proof-perf";
export {
  summarizeProofs,
  isTelemetryOptIn,
  setTelemetryOptIn,
  reportOptedInRuns,
  type PerfSummary,
  type StageSummary,
} from "./telemetry-reporter";
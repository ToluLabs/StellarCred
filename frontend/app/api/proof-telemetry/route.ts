// frontend/app/api/proof-telemetry/route.ts
//
// Lightweight, opt-in aggregator for proving-timing telemetry (GitHub #432).
//
// The client measures per-stage timings (witness / prove / submit) and
// time-to-first-proof locally, then — only when the user opts in — POSTs the
// anonymized numbers here so regressions across device classes can be spotted.
//
// Privacy: the payload is deliberately coarse (circuit kind, timing numbers, a
// device-class string + core/memory counts). It contains no wallet, no
// commitment, no identity data. Unrecognized fields are ignored and not
// stored. The subscription is in-memory only, consistent with the app's other
// lightweight in-process counters (see lib/rate-limit.ts) — a single long-lived
// server accumulate on this process.

import { NextRequest, NextResponse } from "next/server";

const STAGES = ["witness", "prove", "submit"] as const;
type StageName = (typeof STAGES)[number];
const MAX_RUNS_PER_POST = 200;
const MAX_STRING_LEN = 40;
const MAX_MS = 3_600_000; // 1 hour — anything larger is malformed.

interface StageAgg {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  overBudget: number;
}

export interface DeviceClassAggregate {
  count: number;
  timeToFirstProofAvgMs: number;
  timeToFirstProofMinMs: number;
  timeToFirstProofMaxMs: number;
  overBudget: number;
  warmCount: number;
  stages: Record<StageName, StageAgg>;
}

// In-memory aggregates keyed by device class. Module-scoped so it survives
// across requests for the lifetime of the process.
const AGG: Record<string, DeviceClassAggregate> = {};

interface RawRun {
  credentialType?: unknown;
  deviceClass?: unknown;
  cores?: unknown;
  memoryGB?: unknown;
  timeToFirstProofMs?: unknown;
  totalMs?: unknown;
  exceededBudget?: unknown;
  warm?: unknown;
  stages?: unknown;
}

function isStageName(v: unknown): v is StageName {
  return STAGES.includes(v as StageName);
}

function safeNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_MS
    ? v
    : undefined;
}

function safeStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_STRING_LEN
    ? v
    : undefined;
}

function freshStage(): StageAgg {
  return { count: 0, sumMs: 0, minMs: Infinity, maxMs: 0, overBudget: 0 };
}

function absorb(run: RawRun): number {
  const deviceClass = safeStr(run.deviceClass) ?? "unknown";
  const ttf = safeNum(run.timeToFirstProofMs);
  if (ttf === undefined) return 0;

  const bucket = (AGG[deviceClass] ??= {
    count: 0,
    timeToFirstProofAvgMs: 0,
    timeToFirstProofMinMs: Infinity,
    timeToFirstProofMaxMs: 0,
    overBudget: 0,
    warmCount: 0,
    stages: { witness: freshStage(), prove: freshStage(), submit: freshStage() },
  });

  bucket.count += 1;
  bucket.timeToFirstProofMinMs = Math.min(bucket.timeToFirstProofMinMs, ttf);
  bucket.timeToFirstProofMaxMs = Math.max(bucket.timeToFirstProofMaxMs, ttf);
  // Running average, stable against overflow.
  bucket.timeToFirstProofAvgMs +=
    (ttf - bucket.timeToFirstProofAvgMs) / bucket.count;
  if (run.exceededBudget === true) bucket.overBudget += 1;
  if (run.warm === true) bucket.warmCount += 1;

  if (Array.isArray(run.stages)) {
    for (const s of run.stages) {
      if (typeof s !== "object" || s === null) continue;
      const stage = isStageName((s as { stage?: unknown }).stage)
        ? (s as { stage: StageName }).stage
        : null;
      const dur = safeNum((s as { durationMs?: unknown }).durationMs);
      if (!stage || dur === undefined) continue;
      const agg = bucket.stages[stage];
      agg.count += 1;
      agg.sumMs += dur;
      agg.minMs = Math.min(agg.minMs, dur);
      agg.maxMs = Math.max(agg.maxMs, dur);
      if ((s as { overBudget?: unknown }).overBudget === true) agg.overBudget += 1;
    }
  }

  return 1;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const runs = (body as { runs?: unknown })?.runs;
  if (!Array.isArray(runs)) {
    return NextResponse.json({ error: "runs must be an array" }, { status: 400 });
  }
  if (runs.length > MAX_RUNS_PER_POST) {
    return NextResponse.json(
      { error: "too many runs in one batch" },
      { status: 413 },
    );
  }

  let received = 0;
  for (const run of runs) {
    received += absorb(run as RawRun);
  }

  return NextResponse.json({
    received,
    aggregates: AGG,
  });
}
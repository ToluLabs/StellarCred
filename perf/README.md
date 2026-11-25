# Proving performance gate

Implements the regression gate from issue #629 (pairs with the constraint
tracking from #534).

- `proving-baselines.json` — the committed baseline: median CPU ms per stage
  (witness / prove / submit-proxy), ACIR opcode counts per circuit, and the
  regression thresholds. This is the file a PR is compared against.
- `proving-perf-report.json` — generated per run by the workflow and uploaded
  as an artifact; never commit it.

The workflow (`.github/workflows/proving-perf.yml`) runs on PRs touching
circuits or the gate itself: it compiles `kyc_proof` with the pinned
Noir/Barretenberg stack, runs the pipeline 5 times, and compares the median
CPU times and gate counts against `proving-baselines.json`. A gated stage
regressing beyond `stageRatio` (1.75x) or gate count beyond `gateRatio`
(1.15x) fails the PR with annotations; softer drift warns. The summary table
also prints the attribution line (gate growth vs client-side change) so a
regression can be routed to the right owner.

## Payload-size tiers and size guardrails

Issue #943 pairs this gate with a second harness that answers a different
question: not "did this circuit regress vs its baseline?" but "is the largest
proof job the app allows still affordable?".

- `payloads-baselines.json` — per-tier time ceilings (witness/prove) for the
  representative payload sizes, plus the aggregate/small scaling ceiling and a
  warn-only peak-RSS indicator. These ceilings define what the client resource
  guard (`frontend/lib/proof-guard.ts`) permits.
- `scripts/perf/measure-payloads.mjs` — runs `measure-proving.mjs` once per tier
  (small `kyc_proof`, medium `jurisdiction_proof`, large `aggregate_proof`),
  medians 3 runs, and writes `proving-payloads-report.json`. A tier over its
  ceiling, or an aggregate/small prove ratio above the scaling ceiling, fails
  the PR with an annotation.
- `proving-payloads-report.json` — generated per run; never commit it.

Run it locally exactly as CI does:

```bash
node scripts/perf/measure-payloads.mjs --runs 3 \
  --compare perf/payloads-baselines.json
```

The workflow runs both harnesses; the payload tier step uses the same pinned
toolchain and committed `Prover.toml` inputs, so the numbers are reproducible.
The user-facing limits, error messages, and the guidance for large documents or
claim sets are documented in
[docs/PROOF_RESOURCE_LIMITS.md](../docs/PROOF_RESOURCE_LIMITS.md).

## Updating the baseline

Baseline refreshes are intentional commits: run the workflow on `main`
(workflow_dispatch), download the `proving-perf-report` artifact, copy the
`medians` and `gateCounts` into `proving-baselines.json` (plus the
`provenance.bytecodeSha256`), and add a `$history` entry with the reason.

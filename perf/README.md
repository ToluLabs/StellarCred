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

## Updating the baseline

Baseline refreshes are intentional commits: run the workflow on `main`
(workflow_dispatch), download the `proving-perf-report` artifact, copy the
`medians` and `gateCounts` into `proving-baselines.json` (plus the
`provenance.bytecodeSha256`), and add a `$history` entry with the reason.

# Proving performance gate

Implements the regression gate from issue #629 (pairs with the constraint
tracking from #534).

- `proving-baselines.json` â€” the committed baseline: median CPU ms per stage
  (witness / prove / submit-proxy), ACIR opcode counts per circuit, and the
  regression thresholds. This is the file a PR is compared against.
- `proving-perf-report.json` â€” generated per run by the workflow and uploaded
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

---

## Reproducible contract benchmarks (issue #996)

The files and scripts below make on-chain instruction-budget benchmarks
reproducible and comparable across releases.

### Files

| File | Description |
|------|-------------|
| `perf/provenance.schema.json` | JSON Schema for `benchmark_provenance.jsonl` records |
| `perf/circuit-constraint-baselines.json` | Committed circuit constraint baselines |
| `benchmark_provenance.jsonl` *(gitignored)* | Per-run provenance appended by `benchmark-with-provenance.sh` |
| `benchmark_results.txt` *(gitignored)* | Raw per-function metrics appended by `benchmark.sh` |

### Running a benchmark with provenance

```bash
# Full run â€” deploys fresh contracts, records provenance
SOURCE=benchmarker ./scripts/benchmark-with-provenance.sh

# Against existing contract IDs
SOURCE=benchmarker \
  ISSUER_REGISTRY_ID=C... \
  CREDENTIAL_VERIFIER_ID=C... \
  PROOF_REGISTRY_ID=C... \
  GATED_POOL_ID=C... \
  ./scripts/benchmark-with-provenance.sh

# Save provenance to a custom path
./scripts/benchmark-with-provenance.sh --provenance-file perf/run-v1.2.0.jsonl
```

Each invocation appends a JSON record to `benchmark_provenance.jsonl` capturing:

- **Git provenance**: commit hash, branch, tags, dirty flag
- **Toolchain versions**: rustc, cargo, stellar CLI, nargo, barretenberg
- **Rust channel**: pinned version from `rust-toolchain.toml`
- **Network context**: network name, RPC URL, ledger sequence, protocol version
- **Command parameters** passed to `benchmark.sh`

The schema for each record is documented in `perf/provenance.schema.json`.

### Comparing two benchmark runs

```bash
# Compare last week's baseline against today's candidate
./scripts/benchmark-compare.sh \
  benchmark_results_v1.1.0.txt \
  benchmark_results_v1.2.0.txt

# With provenance metadata included in the report
./scripts/benchmark-compare.sh \
  benchmark_results_v1.1.0.txt \
  benchmark_results_v1.2.0.txt \
  --provenance-baseline perf/run-v1.1.0.jsonl \
  --provenance-candidate perf/run-v1.2.0.jsonl

# JSON output for CI consumption
./scripts/benchmark-compare.sh baseline.txt candidate.txt --format json

# Fail if any function regresses by more than 5%
./scripts/benchmark-compare.sh baseline.txt candidate.txt \
  --threshold-cpu 5 --threshold-fee 5
```

The comparison script flags any function whose `cpu_insns` or `fee_stroops`
grows beyond the threshold (default 10%) while also surfacing improvements.

### Storing a named baseline

Before a release, copy your results file to a versioned name:

```bash
cp benchmark_results.txt perf/benchmark_results_v1.2.0.txt
cp benchmark_provenance.jsonl perf/run-v1.2.0.jsonl
git add perf/benchmark_results_v1.2.0.txt perf/run-v1.2.0.jsonl
git commit -m "perf: record v1.2.0 benchmark baseline"
```

Committed baselines are never overwritten â€” they serve as the permanent
reference point for every future `benchmark-compare.sh` run.

### Why provenance matters

Without provenance two benchmark files may look identical but be incomparable:
the same contract function can produce different instruction counts when the
Stellar CLI version, Rust toolchain, or ledger protocol version differ.
Recording provenance alongside results makes it possible to attribute a cost
change to a code change rather than a toolchain upgrade or ledger condition.

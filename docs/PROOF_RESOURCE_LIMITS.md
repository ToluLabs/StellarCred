# Proof resource limits and large documents

Proving cost grows with the size of the job, not with the size of the claim. This
document states the limits the app enforces before it starts proving, why each
one exists, what a holder sees when one is hit, and what to do instead for large
documents or claim sets. It pairs with the proving benchmarks
(`perf/payloads-baselines.json`, `scripts/perf/measure-payloads.mjs`) and the
existing regression gate (`perf/proving-baselines.json`).

The guard itself lives in [`frontend/lib/proof-guard.ts`](../frontend/lib/proof-guard.ts)
and is checked in `proveOffMainThread` — before a witness is requested, a
backend is constructed, or a worker job is posted.

## Limits

| Limit | Value | Where it comes from | Enforced |
| --- | --- | --- | --- |
| Aggregate credentials per proof | 2 | `circuits/aggregate_proof/src/main.nr` asserts `num_credentials == 2` (KYC + age PoC) | `checkProofRequest` |
| Proofs per batch | 5 | `MAX_BATCH_SIZE` in `frontend/lib/contract-transactions.ts`, mirroring `ProofRegistry` | `assertProofBatchWithinLimits` |
| Private input per proof | 16 kB | The JSON the browser POSTs to `/api/witness`; real credentials are ~1–2 kB | `checkProofRequest` |
| Private input per batch | 64 kB | Sum of the above across a batch | `assertProofBatchWithinLimits` |
| Witness request body | 64 kB | `MAX_BODY_BYTES` in `frontend/lib/request-limits.ts` (server side) | `/api/witness` |
| Proof deadline, single credential | 120 s | `perf/proving-baselines.json` stage medians with headroom | `withTimeout` in `useProofFlow` |
| Proof deadline, aggregate | 180 s | Two credentials ≈ 2× the single-credential workload | `withTimeout` in `useProofFlow` |
| Hard deadline ceiling | 300 s | Matches the harness stage guard (`--timeout-ms`) | `proofDeadlineMs` |
| Harness stage timeout | 300 s | `scripts/perf/measure-proving.mjs --timeout-ms` | benchmark |

Limits are counted structurally, never from client-declared metadata: the number
of credentials in an aggregate proof is counted from the credential objects, so
a request cannot talk the guard down by mis-declaring `num_credentials`.

## What a holder sees

Every rejection is a `ProofResourceError` with:

- `code` — `proof_request_too_large` (stable, safe to log or report as telemetry),
- `limitName` — `aggregate_credentials` | `batch_size` | `credential_bytes` | `batch_bytes`,
- `limit` / `actual` — the configured limit and what the request asked for,
- `friendly` — one actionable sentence shown in the UI and toast,
- `message` — the same detail with the limit name, for logs.

Examples of the user-facing text:

- *"An aggregate proof covers at most 2 credentials. Prove them separately, or in
  a batch."*
- *"A single proof accepts at most 16 kB of private input. Large documents should
  be represented by a derived claim (a threshold, a hash commitment) rather than
  embedded in the credential."*
- *"A batch proves at most 5 credentials at once. Split the selection into
  multiple batches."*

A proof that passes the guard but stalls past its deadline fails with
`ProofTimeoutError` instead ("Proof generation timed out…"), and the worker job
is aborted rather than left spinning. These are distinct states in the flow
(`errorPhase: "proving"` / `"timeout"`), so retrying a size rejection is never
suggested — nothing changes on retry.

No error message contains credential fields. The guard only reports sizes and
counts.

## Large documents and claim sets

The circuits prove *claims about* a value: a threshold, a membership bit, a
jurisdiction code. They do not carry documents.

- **Do not embed a document body in a credential.** A base64 PDF, a long
  transcript, or a raw attribute blob is guaranteed to hit the 16 kB per-proof
  cap, and even below it the witness grows linearly and proving time follows.
- **Prove a derived claim instead.** Income above a threshold, age at least 18,
  accreditation above a value, membership of an allowlist. The claim has a fixed
  circuit footprint regardless of the underlying paperwork; the paperwork stays
  with the issuer.
- **For set membership, raise the tree, not the payload.** `set_membership`
  uses a compile-time `DEPTH` (8 → 256 members). Supporting a bigger set is a
  circuit change plus VK regeneration, not a bigger witness — the path is
  always `DEPTH` siblings.
- **For many credentials, batch — up to 5.** Beyond that, submit multiple
  batches. A batch is proven sequentially in the prover worker, so its cost is
  the sum of its proofs (the deadline applies per proof).
- **For more than 2 credentials in one proof**, the aggregate circuit has to be
  extended. The guard's `maxAggregateCredentials` is not the constraint to relax
  on its own: raising it without extending the circuit produces an opaque Noir
  assertion failure instead of a clear guard message.

## Benchmarks and CI

`scripts/perf/measure-payloads.mjs` measures the largest jobs the guard allows,
one tier per representative payload size:

| Tier | Circuit | Shape |
| --- | --- | --- |
| small | `kyc_proof` | one credential, smallest full pipeline |
| medium | `jurisdiction_proof` | one credential plus a fixed 8-entry allowlist |
| large | `aggregate_proof` | two credentials in one proof |

It runs the pinned Noir/Barretenberg toolchain over the committed `Prover.toml`
inputs, medians several runs, and reports CPU time per stage, peak RSS where GNU
`time` is available (warn-only), and ACIR gate counts. It then compares each
tier against the ceilings in `perf/payloads-baselines.json` and the
aggregate/small scaling ratio, failing the PR when an *allowed* payload becomes
more expensive than expected. The result is written to
`perf/proving-payloads-report.json` and uploaded as a CI artifact.

Run it exactly as CI does:

```bash
node scripts/perf/measure-payloads.mjs --runs 3 \
  --compare perf/payloads-baselines.json
```

`perf/proving-baselines.json` remains the regression-vs-baseline gate for the
single representative circuit (issue #629); the payload tier file answers the
different question "is this payload size still affordable at all?".

## Changing a limit

A limit is only meaningful if the whole stack agrees with it:

1. If the limit comes from a circuit (aggregate credentials) or the contract
   (batch size), change it there first, then regenerate the VK / redeploy as
   that change requires.
2. Update `PROOF_RESOURCE_LIMITS` and the guard's tests
   (`frontend/lib/__tests__/proof-guard.test.ts`), which cross-check the
   behaviour the UI depends on.
3. Refresh `perf/payloads-baselines.json` so CI measures the newly allowed
   workload, with a `$history` entry explaining why.
4. Update the table above.

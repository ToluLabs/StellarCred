# Contributing to StellarCred

Thanks for your interest in contributing. StellarCred is a ZK credential layer for Stellar — contributions that improve correctness, security, or developer experience are especially welcome.

**First time in this repo?** Work through
[START_HERE.md](START_HERE.md) — one linear path from `git clone` to the same
checks CI runs on your PR. This file is the reference for everything after that:
project layout, workflow, review routing, trust-model invariants and PR rules.
The per-component commands, expected outputs and known failure modes are
collected in [docs/CONTRIBUTOR_CHECKLIST.md](docs/CONTRIBUTOR_CHECKLIST.md).

## Project layout

```
contracts/    Soroban workspace (Rust, soroban-sdk 26)
circuits/     Noir circuits (UltraHonk · Noir 1.0.0-beta.9 / bb 0.87.0)
frontend/     Next.js 14 app + @stellarcred/sdk
services/     Indexer & off-chain services (see services/indexer/README.md)
scripts/      deploy.sh — wires all contracts on testnet
fixtures/     real vk / proof / public_inputs used by contract tests
```

### Where a markdown file belongs

The repository tracks documentation in two places, and the split has one rule:

- **Repository root** — the entry points a person or a tool is expected to find
  without looking: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`,
  `ROADMAP.md`, `LICENSE`. A component directory keeps its own `README.md`
  (`services/indexer/README.md`, `frontend/packages/sdk/README.md`) as that
  component's entry point.
- **`docs/`** — everything else: specifications, integration guides, runbooks,
  operational references (`docs/EVENTS.md`, `docs/THREAT_MODEL.md`,
  `docs/ISSUER_ONBOARDING.md`, …), with decision records in `docs/adr/`.

Two rules follow. The first is the one whose absence produced the duplicated
`EVENTS.md` (issue #687):

1. **One topic, one file.** Never mirror a document into a second path for
   visibility. If it must stay reachable from the root `README.md`, link it from
   there — a contract such as the event schema read by indexers and integrators
   cannot exist in two copies, because one of them will go stale and its readers
   will decode events wrong with no error to show them.
2. **Link with a path that resolves from the file you are editing.** From the
   root, `docs/EVENTS.md`; from another file in `docs/`, the sibling `EVENTS.md`;
   from a component, the full walk up (`../../docs/EVENTS.md`).

### Export pipeline

The admin export system (issues [#783](https://github.com/ToluLabs/StellarCred/issues/783), [#784](https://github.com/ToluLabs/StellarCred/issues/784), and [#788](https://github.com/ToluLabs/StellarCred/issues/788)) lives under:

```
frontend/lib/export-store.ts          ExportRecord store (create/list/get/revoke)
frontend/lib/export-job-store.ts      Chunked ExportJob model and cursor handles
frontend/lib/export-cursor.ts         HMAC-signed resumable cursor tokens
frontend/lib/export-chunks.ts         serveExportChunk orchestrator
frontend/lib/export-throttle.ts       Per-tenant rate limiting
frontend/lib/export-concurrency.ts    Global concurrency cap
frontend/lib/export-scheduler.ts      Cost-aware priority queue
frontend/lib/export-metrics.ts        Backpressure metrics aggregator
frontend/app/api/admin/exports/       API routes (list, get, revoke, audit, chunks, queue)
frontend/app/admin/exports/           Admin web UI (Server Component + Server Action)
```

Full API reference, schema documentation, cURL and TypeScript examples, a contributor checklist, and testing guidance are in **[docs/exports.md](docs/exports.md)**.

### Writing a contract test

Contract suites share one harness, `contracts/test_support`, so a test body is
the scenario rather than the wiring. It owns:

- `Contracts::deploy` / `deploy_all_contracts` — deploy and wire IssuerRegistry,
  CredentialVerifier, and ProofRegistry.
- `Contracts::register_issuer` / `register_issuer_for` — register an issuer
  under the pubkey the real fixtures were signed with.
- `Contracts::set_vk` / `enable` — register a circuit's real verification key.
- `Contracts::valid_submission` / `submit` — build a `ProofSubmission` that
  verifies, or submit one directly.
- `Contracts::deploy_pool` — add a GatedPool wired to the stack.
- `test_support::{KYC, AGE, FUNDS, AGGREGATE, …}` — the checked-in real
  UltraHonk artifacts, with `vk_bytes`/`proof_bytes`/`public_inputs_bytes` and
  an `issuer_pubkey` read out of the public inputs.

```rust
let env = Env::default();
env.mock_all_auths();
let h = deploy(&env); // builds on Contracts::deploy + Contracts::enable

let holder = Address::generate(&env);
submit(&env, &h, &holder, 9_999);

assert!(h.registry.is_verified(&holder, &symbol_short!("kyc"), &None).0);
```

Do not re-declare `include_bytes!` constants for a circuit in a suite, and do
not stub the fixtures: the shared catalog still holds the real artifacts, so
tests keep exercising genuine on-chain BN254 verification. A one-off artifact
that has no catalog entry (e.g. `fixtures/negative/…`) can still be pulled in
with the exported `test_support::fixture!` macro.

The harness is host-only (it needs `soroban-sdk`'s `testutils`), so the four
deployable contracts are the workspace's `default-members` and a bare
`cargo build --release --target wasm32v1-none` never compiles it. It is still
covered by `cargo test` and by `cargo clippy --workspace`.

## Setting up your environment

[**START_HERE.md**](START_HERE.md) is the ordered path from a fresh clone to a
green local build. [**SETUP.md**](SETUP.md) is the install reference behind it —
exact commands per toolchain, PATH configuration, and the troubleshooting table.
[**docs/CONTRIBUTOR_CHECKLIST.md**](docs/CONTRIBUTOR_CHECKLIST.md) lists the
validation command for each component, what its output looks like when it passes,
and the failure modes contributors hit most often.

Install only what your change needs (contracts do not need `nargo`/`bb`; the
committed test fixtures already contain the real artifacts), then verify:

```bash
make doctor
```

`make doctor` checks every pinned toolchain version and tells you exactly what
is wrong before you hit a confusing CI failure. A passing run looks like:

```
[ok]   rustc                  1.93.1
[ok]   wasm32v1-none          installed
[ok]   nargo                  1.0.0-beta.9
[ok]   bb                     0.87.0
[ok]   node                   v20.x.x  (need 20.x)
[ok]   pnpm                   9.x.x    (need 9.x)
[ok]   npm                    10.x.x
All checks passed — environment is ready.
```

Fix any `[FAIL]` lines before running `make build` or `make test`. The Makefile
needs GNU Make **and** bash — on Windows run it from Git Bash or WSL, and if you
have no Make, run the per-component commands from
[docs/CONTRIBUTOR_CHECKLIST.md](docs/CONTRIBUTOR_CHECKLIST.md) instead.

### Pinned versions at a glance

| Tool | Pinned version | Why pinned |
|------|---------------|------------|
| Rust | **1.93.1** | Byte-identical WASM artifacts (`rust-toolchain.toml`) |
| wasm32v1-none | — | Required compile target for Soroban contracts |
| nargo | **1.0.0-beta.9** | VK determinism — must match `bb` exactly |
| bb | **0.87.0** | VK determinism — must match `nargo` exactly |
| Node | **20** | Frontend and indexer |
| pnpm | **9** | Frontend workspace manager |

`frontend/package.json` also declares its own `packageManager` pnpm version, which
corepack honours for commands run inside `frontend/`; SETUP.md § "Quick reference"
explains how the two interact and what to do if they disagree.

> **Circuit toolchain warning:** the `nargo` and `bb` versions are load-bearing.
> A mismatch produces a VK that differs from the committed fixture, and CI fails
> with `VK mismatch for <circuit>` — which looks like your change broke
> something but is actually a version problem. Run `make doctor` first.

## Docker

Two different things live in Docker here, and mixing them up is a common early
stumble.

**The pinned toolchain image** — [`docker/Dockerfile.dev`](docker/Dockerfile.dev)
— is what you use instead of installing Rust, Noir, Barretenberg, Node and pnpm
on your host. It has no `docker compose` service, so build and run it directly,
mounting the repo at `/workspace`:

```bash
docker build -f docker/Dockerfile.dev -t stellarcred-dev .

# Contract tests / WASM build
docker run --rm -v "$PWD":/workspace -w /workspace stellarcred-dev \
  bash -lc "cargo test --locked && cargo build --release --target wasm32v1-none --locked"

# Circuits
docker run --rm -v "$PWD":/workspace -w /workspace stellarcred-dev \
  bash -lc "bash ./circuits/scripts/build.sh"

# Frontend
docker run --rm -v "$PWD":/workspace -w /workspace stellarcred-dev \
  bash -lc "cd frontend && pnpm install && pnpm build"
```

The image pins nargo 1.0.0-beta.9, bb 0.87.0, Node 20, pnpm 9 and Stellar CLI
27; Rust itself comes from `rust:1-bookworm` and `rust-toolchain.toml` selects
the pinned compiler on the first `cargo` run inside the container, so that run
needs network access.

**`docker compose`** runs the *application*, not the toolchain: it defines only
the `indexer` and `frontend` containers, reads contract IDs and keys from `.env`
(see [`.env.example`](.env.example) and `services/indexer/.env.example`), and the
frontend waits for the indexer's `/health` check:

```bash
docker compose up            # indexer on 3001, frontend on 3000
docker compose up frontend   # also starts the indexer — it is a dependency
```

There is no `contracts` or `circuits` compose service; a `docker compose run
--rm contracts …` command fails with `no such service`.

## Getting started

```bash
# contracts — real BN254 verification against the committed fixtures/ artifacts
cargo test

# circuits (optional — pre-built artifacts are committed)
./circuits/scripts/build.sh       # compile all, stage to frontend/public/circuits

# frontend
cd frontend
cp .env.example .env.local        # fill in contract IDs + ISSUER_PRIVATE_KEY
pnpm install
pnpm dev

# indexer (optional — off-chain Soroban event indexing)
cd services/indexer
cp .env.example .env
npm ci
npm run dev
```

To validate rather than just run a component, use the checklist's per-component
tables ([§ 3–§ 6](docs/CONTRIBUTOR_CHECKLIST.md)) — they pair each command with
the output that means it passed. `make build && make test && make lint` (or
`make all`) mirrors the CI build/test/lint jobs across every workspace.

## Holder page architecture

`frontend/app/holder/HolderPageClient.tsx` is the shell for the `/holder` route.
It must stay thin: **only top-level view state and modal open/close logic belong
there**. Everything else has a designated home:

| What | Where |
|------|-------|
| Async state, effects, derived data | `frontend/lib/hooks/use*.ts` |
| UI primitives, cards, flows | `frontend/components/holder/*.tsx` |
| Shared credential helpers (TTL, expiry maths) | `frontend/lib/proof-helpers.ts` |

**Never add inline logic to HolderPageClient.tsx.** The pattern is:
1. Write the logic in `lib/hooks/` or the helper library.
2. Write the UI in `components/holder/`.
3. Import and wire them in HolderPageClient.

A CI guard (`scripts/check-page-client-size.sh`) enforces a hard line-count
ceiling on the page-client shells — `HolderPageClient.tsx`, `VerifyPageClient.tsx`
and `DocsPageClient.tsx`. Caps are pinned at their current sizes and only go down,
so adding inline feature code fails CI. The guard was added in
[#606](https://github.com/ToluLabs/StellarCred/issues/606) and extended in
[#685](https://github.com/ToluLabs/StellarCred/issues/685).

## Development workflow

1. **Pick and claim an issue** (see [Picking up an issue](#picking-up-an-issue) below), then **fork** the repo and create a branch from `main`.
2. Make your changes. Keep commits focused — one logical change per commit.
3. For contract changes: run `cargo test --locked`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo fmt --all` before committing (formatting the files you did not touch would bloat the diff — revert those).
4. For circuit changes: run `./circuits/scripts/build.sh` and update the relevant `fixtures/<type>/` artifacts, then regenerate the regression test vectors with `node circuits/scripts/testvectors.js update` (see `circuits/README.md` — "Test Vectors") and commit the result. CI runs `node circuits/scripts/testvectors.js check` and fails if a circuit or toolchain change silently altered proof output without the vectors being updated.
5. For frontend changes: run `pnpm lint`, `pnpm exec tsc --noEmit` (zero errors required), `pnpm test`, `pnpm format:check` and `pnpm build`. For the SDK, the examples and the indexer, use the matching table in [docs/CONTRIBUTOR_CHECKLIST.md](docs/CONTRIBUTOR_CHECKLIST.md).
6. Before pushing, walk [docs/CONTRIBUTOR_CHECKLIST.md § 9](docs/CONTRIBUTOR_CHECKLIST.md) — the CI job → command map there is how you reproduce anything red on the PR.
7. Open a pull request against `main` with a clear description of what changed and why.

### Process documents belong in the PR description

An implementation summary, review checklist, status report, test summary or
"final verification" write-up is a **PR artifact, not a repository file**. Put it
in the pull request description (or a PR comment), where it is read once, stays
attached to the diff it describes, and is searchable from the PR. Do not commit it.

- **Why:** such a document describes a change, and a change ends at merge. In the
  tree it is wrong within days — every later edit to the code it documents makes
  its claims stale while its file name still asserts authority — and it is never
  updated, only re-created by the next contributor. It also buries the documents
  that stay true: the root directory is where a newcomer looks for `README`,
  `CONTRIBUTING`, `SETUP`, `ROADMAP`, `SECURITY`.
- **What to do instead:** if something in your summary is worth keeping after the
  merge, it is documentation, so move that part into the doc that owns the topic
  (`circuits/README.md` for a circuit, `docs/` for a subsystem, the component's
  own `README.md`) and let the rest live in the PR.
- **Enforced:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) fails a PR
  that *adds* a file whose name matches a process-artifact pattern
  (`*IMPLEMENTATION_SUMMARY`, `*IMPLEMENTATION_DETAILS`, `*IMPLEMENTATION_NOTES`,
  `*REVIEW_SUMMARY`, `*STATUS_REPORT`, `PR_DESCRIPTION*`, `*_COMPLETE`,
  `START_HERE`, `FILES_MODIFIED`, `CRITICAL_FIX_NEEDED`, `READY_FOR_BUILD` — any
  extension). Only new files are checked; the legacy ones still in the tree are
  being removed separately. If you genuinely mean to add a durable document under
  one of those names, add it with a reason to the allowlist in
  [`.github/scripts/check-process-docs.mjs`](.github/scripts/check-process-docs.mjs)
  and justify it in the PR.

## Testing guide

Everything here runs locally, and CI (the **CI** workflow, on every PR against
`main`) runs the same commands — the bar is "CI green", not "green on my
machine". One command covers every unit suite: **`make test`** (contracts +
frontend + indexer + the canonical example). If you are not sure your toolchain
matches the pinned versions, run **`make doctor`** first; it checks every pinned
binary and exits non-zero on a mismatch.

### Contracts (Rust / Soroban)

```bash
make test-contracts      # cargo test --locked at the repo root
make lint-contracts      # cargo clippy --workspace --all-targets -- -D warnings
```

Keep `--locked`: the CI job runs `cargo test --locked`, and the wasm build is
pinned by `rust-toolchain.toml`. The host-only test-harness crate is a workspace
member — a bare `cargo build` skips it, the lint target does not.

### Circuits (Noir / Barretenberg)

`make compile-circuits` runs `circuits/scripts/build.sh`. If a circuit changes,
regenerate the regression vectors
(`node circuits/scripts/testvectors.js update`) and commit them — CI runs the
`check` variant and fails on silent proof-output changes. The property-based
circuit-fuzz job exercises the compiled circuits further.

### Frontend (Next.js, pnpm)

From `frontend/`:

```bash
pnpm test               # vitest unit suites
pnpm test:coverage      # same suites with coverage (CI uploads the report)
pnpm test:theme         # theme helpers via node:test
pnpm --filter @stellarcred/issuer test    # issuer package, incl. cross-boundary circuit test
pnpm exec tsc --noEmit  # zero errors required
pnpm lint
```

One command for the common set: `make test-frontend`.

### SDK

Two SDKs live in this repo, and both are tested:

- **`frontend/packages/sdk` (`@stellarcred/sdk`)** — the browser package.
  `make test-sdk` runs `pnpm typecheck && pnpm test:integration` there; CI also
  checks the barrel exports (`pnpm test:barrel`). The integration suite talks to
  testnet and skips gracefully when credentials are absent.
- **`sdk/` (root, standalone)** — `pnpm test` (vitest), `pnpm typecheck`, and
  `pnpm bundle-check` for the bundle-size guard.

### Indexer (Node.js, npm + jest)

```bash
make test-indexer        # cd services/indexer && npm test (jest)
cd services/indexer && npm run build   # tsc must be clean
```

The DB suite is a **SQLite + Postgres matrix** in CI (a `postgres:16` service
container). Locally the Postgres leg is gated on `TEST_POSTGRES_URL` (falling
back to `DATABASE_URL`) and is *skipped* when unset — so a local run that
reports fewer DB tests than CI is normal, not broken. Point `TEST_POSTGRES_URL`
at any Postgres 16 (e.g. `docker compose up indexer`'s database) to run both
legs.

### E2E locally (Playwright, testnet)

```bash
cd frontend
pnpm exec playwright install --with-deps chromium   # first time only
pnpm test:e2e
```

Playwright starts its own dev server unless `PLAYWRIGHT_BASE_URL` is set, in
which case it drives whatever is already running. The full happy-path flow
(deploy → issue → prove → verify) needs a live testnet deployment and funded
issuer keys: use [`scripts/e2e-testnet.sh`](scripts/e2e-testnet.sh) and the
variables in the relevant `.env.example` files. Note the distinction in CI:
the `Accessibility (axe-core)` job runs as part of every PR, while the
ephemeral-testnet happy path
([`.github/workflows/e2e.yml`](.github/workflows/e2e.yml)) is scheduled /
manually dispatched, not a PR gate.

### Docker

`docker-compose.yml` wires the two long-running services:

```bash
docker compose up indexer     # indexer API on :4100
docker compose up frontend    # web app on :3000
```

Use these for a quick smoke test when you would rather not install the full
toolchain; the dev-image commands for contract/circuit work are in the
[Docker quickstart](#docker-quickstart).

### What CI runs on your PR

The `CI` workflow contains these jobs — **all must pass before merge**:

| Job | What it does |
| --- | --- |
| Dependency review | advisories / license / maintenance checks on changed packages |
| Lint commit messages | commitlint — Conventional Commits are enforced |
| Contract API reference drift check | `docs/PROOF_REGISTRY_API.md` vs the contract source |
| Process artifact check | fails PRs that *add* process docs (see above) |
| Contract tests & build | `cargo test --locked` + pinned wasm build |
| Circuit compile / Property-based circuit fuzzing | pinned `nargo` + `bb`; test-vector check |
| Frontend typecheck & build | vitest, coverage, `tsc --noEmit`, issuer + SDK barrel tests, identity-leak gate |
| Indexer tests (SQLite + Postgres) | build + jest against both DB backends |
| SDK integration tests (testnet) | `frontend/packages/sdk` integration suite |
| Accessibility (axe-core) | Playwright + axe against the built app |
| Coverage gate | merges frontend + indexer coverage and enforces thresholds (`.github/scripts/check-coverage.mjs`) |

Two jobs are environment-dependent and may not run on your PR: the SDK
integration job only starts when the repository variables it needs
(`SC_TEST_WALLET`, `STELLARCRED_REGISTRY_ID`) are set — fork PRs cannot see
maintainer secrets, which is by design — and the ephemeral-testnet E2E lives in
its own scheduled workflow. Neither is a reason to skip local testing of the
code you changed.

### Debugging and common gotchas

- **Start with `make doctor`.** A `nargo`/`bb` version mismatch is the worst
  one: it silently produces wrong verification keys and the artifact-freshness
  check fails with a confusing diff. Install the pinned versions it prints.
- **Node 20 and pnpm 9** are the pinned JS toolchain (mirrored in
  `Makefile` and `ci.yml`); other majors produce lockfile churn.
- **`pnpm install` in `frontend/` runs a postinstall** that builds
  `packages/issuer`. If that fails, build the issuer package directly to see
  the real error.
- **Commit message fails CI?** commitlint wants Conventional Commits
  (`feat(scope): …`, `fix: …`, `docs: …`) — see
  [Commit messages](#commit-messages).
- **Playwright "browser not found"** → re-run
  `pnpm exec playwright install --with-deps chromium`.
- **Indexer Postgres leg "skipped"** in local output is the gating described
  above, not a failure; CI is the place both legs actually run.
- **Coverage gate failure** means your diff lowered coverage below the
  threshold — add tests for the code you changed rather than adjusting the
  gate.

## Picking up an issue

The repo carries dozens of open issues labelled by **area** (`contracts`, `circuits`,
`frontend`, `sdk`, `backend`, `infrastructure`) and **difficulty** (`easy`, `medium`,
`hard`). Difficulty alone is *not* a safety signal: a change labelled `easy` that touches
the signing path or a circuit can silently break a trust property, while a `hard` label
on an isolated SDK helper may be perfectly safe to attempt. Use the guidance below to
pick work that matches both your comfort level and the risk the area carries.

### Which issues are safe to pick up

Issues tagged [`good first issue`](https://github.com/ToluLabs/StellarCred/labels/good%20first%20issue)
are curated by maintainers to be **self-contained and unable to break a trust property**.
An issue only earns that label when every box below is true:

- It touches only a *Normal* review area (docs, UI copy, isolated frontend components,
  SDK helpers, additive tests, tooling that does not run with repo credentials).
- It does **not** modify `contracts/`, `circuits/`, `fixtures/`, the issuance/signing path
  (`frontend/app/api/issue`, `lib/issuer-signer.ts`, `lib/persona-webhook.ts`), or
  `.github/workflows/`.
- It has no unmet dependency — nothing else has to land first.
- Its correct behaviour is checkable by a test or a type check, not by reading a diff.

If an issue is not labelled `good first issue`, assume it needs the care described in
[Sensitive areas](#sensitive-areas-and-their-invariants) below, even when the difficulty
label says `easy`. When in doubt, ask in the issue before starting.

### Claiming an issue (avoid duplicate PRs)

Several issues have accumulated two or three competing PRs because nothing signalled a
claim. Follow this convention:

1. **Comment on the issue and ask to be assigned.** A maintainer assigns the issue to you;
   the assignment *is* the claim. Do not open a PR for an issue that is already assigned.
2. **One assignee per issue.** If someone is already assigned, do not start a parallel PR.
   Offer to help on theirs instead, or pick an unassigned issue.
3. **Use draft PRs early.** Opening a `draft` PR that references the issue announces the
   claim to everyone and lets reviewers course-correct before much code is written.
4. **Stale claims are released.** If an assignee is inactive for ~2 weeks, a maintainer may
   unassign the issue so someone else can take it. Say the word if you need more time.
5. **Reference, don't guess.** Link the PR with `Closes #<n>` / `Fixes #<n>` so the issue and
   the claim move together.
6. **One open PR per contributor per issue.** Do not open a second PR for the same issue —
   push follow-up commits to the existing one instead. When several people race competing PRs
   for one issue, effort is duplicated and reviewers re-read the same diff; a maintainer will
   pick one to land and close the rest with a pointer, so a single PR per issue keeps that
   resolution simple.

### Dependencies between issues

When one issue must land before another can be done, that relationship belongs on the
issues themselves, not in someone's head:

- The blocking issue gains a `blocked` note in its body: **“Blocked by #<n>”** near the top.
- The *dependent* issue is **not** labelled `good first issue` and should not be claimed
  until the blocker is merged.
- If you pick up an issue and discover a dependency that isn’t recorded, comment on it and
  ask a maintainer to add the “Blocked by” line before you write code — starting out of
  order is the usual cause of throwaway PRs.

## Sensitive areas and their invariants

The [Review routing](#review-routing) table says *who* reviews each area. This table says
*what must stay true* — the invariant a plausible-looking change can quietly break. If
your diff touches one of these areas, name the invariant you preserved in the PR
description. A change that passes the test suite but weakens any of these is a regression,
not a fix: the tests often encode the same mistaken assumption (see
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and the relevant [ADR](#architecture-decision-records)).

| Area | Invariants you must not break |
|------|-------------------------------|
| `contracts/` (IssuerRegistry, ProofRegistry, CredentialVerifier, GatedPool) | A proof is accepted only when it verifies on-chain against a registered VK with real BN254 verification — test-side auth mocking (`mock_all_auths`) never stands in for the verification itself; only `IssuerRegistry`-registered issuer keys are trusted (`is_valid_issuer_key`: current key, or a retired key still inside its validity window); `submit_proof` stays holder-authorized (ADR-003); `is_verified`/`check_claim` remain public reads (ADR-004); expiry stays bounded by `MAX_CREDENTIAL_TTL_SECS`; revocation only shortens validity, never extends it. |
| `circuits/` + `fixtures/` | A credential is only valid when the issuer's secp256k1 signature is verified **inside** the circuit over the committed value (ADR-001); the Poseidon2 commitment keeps its mandatory salt (ADR-002); never remove or loosen a constraint or range check — that is a soundness break that still compiles, proves, and verifies while asserting something untrue; committed fixtures and `testvectors.js` must be regenerated by the pinned `nargo 1.0.0-beta.9` / `bb 0.87.0` build, never hand-edited. |
| `frontend/app/api/issue/`, `lib/issuer-signer.ts`, `packages/issuer/`, `lib/persona-webhook.ts` | `prehash: false` is preserved on the secp256k1 signing call in `packages/issuer` (`signCommitment`) — Noir consumes the raw 32-byte digest, not a double-SHA256, so re-enabling prehash produces signatures the circuit rejects; the signature stays over the commitment digest that matches the circuit's public inputs; `lib/issuer-signer.ts` keeps its server-only guard and `ISSUER_PRIVATE_KEY` never gains a `NEXT_PUBLIC_` prefix or reaches client-bundled code; no identity field is persisted or logged after a KYC/provider call. |
| `.github/workflows/`, `Makefile`, `deny.toml` | These run with repo credentials and the release job publishes to npm — a workflow diff is treated like a signing-path diff; do not add `pull_request_target` handlers that check out untrusted PR code, and do not widen license/audit gates without a note. |

## Pull request lifecycle and staleness

A large, untriaged PR backlog costs everyone: contributors build on branches that can no
longer merge, reviewers re-read the same stale diffs, and genuinely ready work gets buried.
To keep the queue navigable we triage open PRs into four buckets and run a stale-PR bot so
the backlog can't silently rebuild.

### Triage buckets

When a maintainer sweeps the backlog, every open PR is sorted into one of these and acted on
accordingly. If your PR falls into the last two, the close comment names *why* and, where
relevant, *what replaced it* — you are never closed without a pointer.

| Bucket | Meaning | Action |
|--------|---------|--------|
| **Rebase-and-land** | Correct, wanted, just behind `main` | Author (or a maintainer, with credit) rebases, gets CI green, lands it. |
| **Needs-author-fix** | Mergeable in principle but conflicting, failing CI, or awaiting review changes | Left open with the specific fix requested; the stale clock applies while it waits. |
| **Superseded** | The same work already landed via another PR, or a better PR now owns the issue | Closed with a link to the PR/commit that replaced it. |
| **Abandoned** | Author inactive, no response to review or rebase requests | Closed as stale (see the bot below). |

**Duplicate races.** When two or more open PRs target the same issue, a maintainer keeps the
single best-positioned PR (most complete, closest to green) and closes the others with a
comment pointing at the chosen one, so the losing authors stop duplicating effort. Prevent
the race in the first place with [one open PR per contributor per
issue](#claiming-an-issue-avoid-duplicate-prs) above.

### Stale-PR bot

[`.github/workflows/stale.yml`](.github/workflows/stale.yml) runs daily and, for pull
requests:

- **Warns after 30 days** with no activity (a push, comment, or review reply counts as
  activity and resets the clock) — the PR is labelled `stale` and the author is pinged.
- **Closes 14 days later** (≈44 days total) if there is still no response, labelled
  `stale-closed`.
- **Exempts** PRs carrying any of `security`, `blocked`, `dependencies`, or
  `good first issue`.

Issues are only labelled when inactive, never auto-closed.

Closing is not permanent: a stale-closed PR can be reopened by anyone at any time, and the
branch and full history are preserved. If you return to work that was closed as stale, prefer
rebasing onto current `main` and reopening over starting a parallel PR.

## Branch Cleanup

- **After merging:** Head branches are deleted automatically when a pull request
  is merged, so you don't need to delete yours. If you need to keep working,
  create a new branch from the latest `main`.
- **Stale branches:** Maintainers periodically prune branches that are merged,
  reverted, or abandoned (including superseded Dependabot branches). To keep a
  branch, keep its PR open or ask a maintainer.
- **Local cleanup:** Run `git fetch --prune` to drop references to deleted
  remote branches.
- **Branch naming:** Use descriptive names so a branch's purpose is clear.

## Preview Deployments

Every Pull Request automatically triggers a live preview deployment via GitHub Actions.

- **URL Generation:** Once CI runs, the deployment URL will be automatically posted as a comment on your PR.
- **Environment Configuration:** Preview builds automatically ingest safe **testnet/dummy contract IDs**. No production secrets are exposed or required for PR previews.
- **Lifecycle:** The preview environment updates automatically with every new commit pushed to the PR and is torn down when the PR is closed or merged.

## Areas open for contribution

- Additional credential types (employment, accreditation, etc.)
- Multi-issuer trust: allow protocols to specify which issuers they accept
- Proof batching: submit multiple proofs in one transaction
- SDK: additional framework integrations (React hook, Vue composable)
- Circuit optimizations: reduce constraint count for faster browser proving
- Issuer integrations: additional KYC / attestation providers

## Architecture Decision Records

Before proposing changes that touch the trust model, read the relevant ADR. Several design choices look like they could be simplified or swapped out, but are load-bearing in ways that are not obvious from the code alone.

| Area | ADR | What it explains |
|------|-----|-----------------|
| In-circuit signature check | [ADR-001](docs/adr/ADR-001-in-circuit-signature-verification.md) | Why the issuer's secp256k1 signature is verified inside the Noir circuit rather than on-chain, and why the signature is a private witness |
| Commitment scheme and salt | [ADR-002](docs/adr/ADR-002-poseidon2-commitment-scheme.md) | Why Poseidon2 is used over SHA-256 or keccak, and why the salt is mandatory |
| Proof submission authorization | [ADR-003](docs/adr/ADR-003-holder-authorized-submission.md) | Why `submit_proof` requires the holder's wallet signature rather than the issuer's |
| Public verification reads | [ADR-004](docs/adr/ADR-004-public-read-default.md) | Why `is_verified` and `check_claim` have no access control |
| Proving system | [ADR-005](docs/adr/ADR-005-ultrahonk-proving-system.md) | Why UltraHonk / Barretenberg and why the toolchain version pair must be pinned exactly |

If you are proposing a change that touches any of the areas above, reference the relevant ADR in your PR description and explain how the change interacts with the decision recorded there.

## Review routing

Reviews are routed automatically by [`.github/CODEOWNERS`](.github/CODEOWNERS). Opening a PR requests review from the maintainers of every area the diff touches, so a change to `contracts/` never lands with the same scrutiny as a README typo.

**Note the rule order.** When several patterns match the same file, the *last* matching rule wins. CODEOWNERS is written general-to-specific — broad catch-alls first, narrow overrides after. If you add a rule, put it *below* the broad rule it is meant to refine, or it will be silently overridden.

| Area | What it decides | Review depth |
|------|-----------------|--------------|
| `contracts/`, `circuits/` | The trust anchor: which issuers are trusted, and what a proof can assert | **Highest.** Reasoned review against [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and the relevant ADR, not just the diff. |
| `Cargo.toml`, `Cargo.lock` | Pins `soroban-sdk` and the git-sourced UltraHonk verifier at exact revisions | Highest — a version bump can change verifier behaviour or invalidate existing proofs. |
| `fixtures/`, `circuits/scripts/` | The committed VKs, proofs, and public inputs the contract tests verify against | Highest — must be regenerated through the documented circuit build, never by hand. |
| `frontend/app/api/`, `frontend/lib/issuer-signer.ts`, `frontend/lib/persona-webhook.ts` | Issuance, signing, and the KYC webhook. Reads `ISSUER_PRIVATE_KEY` | **High.** Check for `NEXT_PUBLIC_` leaking server-only vars, that `prehash: false` is preserved, and that webhook payloads stay redacted. |
| `frontend/packages/issuer-registry/`, `frontend/packages/proof-registry/` | Client-facing view of the trust anchor | High, same as contracts. |
| `frontend/packages/sdk/` | The published integrators' surface | Normal, but breaking changes need a version/migration note. |
| `services/indexer/` | Reads chain state and republishes it to consumers | Normal, with extra attention to `auth.ts`, `cors.ts`, and `rate-limit.ts`. |
| `.github/workflows/`, `.github/dependabot.yml`, `Makefile`, `deny.toml` | Runs with repo credentials; the release job publishes to npm | **High** — treat a workflow diff like a signing-path diff. |
| `docs/adr/`, `SECURITY.md`, `docs/THREAT_MODEL.md`, `CONTRIBUTING.md`, `SUPPORT_POLICY.md` | Records the decisions and the review bar the rest of the routing relies on | High — reviewed alongside the CODEOWNERS rules themselves. |
| Everything else (docs, UI, Docker, scripts) | — | Normal. |

### Why the trust-anchor areas are treated differently

- **Contracts** are the on-chain trust root. A change to `IssuerRegistry` or `ProofRegistry` can make an unauthorized issuer trusted, or accept a proof that should have been rejected — while still passing every test, because the test encodes the same mistaken assumption.
- **Circuits** decide what a proof is *able* to assert. Removing a constraint or loosening a range check is a soundness break: the circuit still compiles, still proves, and still verifies on-chain while proving something untrue. See [ADR-001](docs/adr/ADR-001-in-circuit-signature-verification.md) and [ADR-005](docs/adr/ADR-005-ultrahonk-proving-system.md).
- **Issuance and signing** hold the issuer signing key. A credential is only as trustworthy as the signature over it, and that signature is produced in this path.
- **CI and supply-chain config** execute with repository credentials, and the release job can publish to npm.

CODEOWNERS routes the *request*; it does not change branch protection. To make a trust-anchor approval genuinely blocking, require a review from these owners under **Settings → Branches → Branch protection rules** — a code owner request is a suggestion unless the branch rule enforces it.

## Security

Please do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## Code style & Linting

- **Rust**: `cargo fmt` before committing. Follow the existing contract structure — cross-contract calls use `#[contractclient]` interface traits, not crate dependencies. No CI job runs `cargo fmt --check` today and parts of the tree are unformatted, so keep the reformat to the files your PR touches.
- **TypeScript & Web**: ESLint and Prettier are configured across the repository.
  - Run linting: `pnpm --dir frontend lint` (or `pnpm --dir frontend/packages/sdk lint` for SDK).
  - Check formatting: `pnpm --dir frontend format:check`.
  - Auto-format code: `pnpm --dir frontend format`.
- **Pre-commit hooks**: Husky and `lint-staged` run automatically on staged TypeScript, JavaScript, CSS, and JSON files on `git commit` to maintain format and lint standards.
- **Noir**: Keep circuits as simple as possible — constraint count directly affects browser proving time.
- **Comments**: Only when the *why* is non-obvious (a constraint, a workaround, a subtle invariant). Don't explain what the code does.

## Linting

Every TypeScript workspace carries its own ESLint 9 flat config next to the code
it lints, and `.github/workflows/lint.yml` runs all of them on push and pull
request. A lint job fails on any **error**; it prints **warnings** and carries on.

| Workspace | Config | Run locally |
|-----------|--------|-------------|
| Frontend app | [frontend/eslint.config.mjs](frontend/eslint.config.mjs) | `cd frontend && pnpm lint` (or `make lint-frontend`) |
| Indexer service | [services/indexer/eslint.config.mjs](services/indexer/eslint.config.mjs) | `cd services/indexer && npm run lint` (or `make lint-indexer`) |

`make lint` runs clippy plus both ESLint jobs.

**Documented exceptions.** These are deliberate, not leftovers — each one has its
rationale written into the config header:

- `react-hooks/set-state-in-effect` and `react-hooks/refs` are warnings in the
  frontend config: 34 pre-existing, working patterns from the Next.js 16 upgrade,
  tracked for a dedicated refactor.
- `@typescript-eslint/no-explicit-any` is a warning in both configs: the existing
  uses sit at untyped boundaries (XDR and SDK values), so tightening them is a
  typing task rather than a linting one. New code should avoid `any` anyway.
- `prefer-const` is a frontend warning.
- Inline `// eslint-disable-next-line` notes are used where a rule conflicts with
  a deliberate design, e.g. the lazy `require()` of the optional `pg` /
  `better-sqlite3` drivers in the indexer. Keep the suppression on the line, with
  the reason in the comment above it.

The indexer's lint toolchain (`eslint`, `@eslint/js`, `typescript-eslint`) is not
in its `package-lock.json`, because `npm ci` in the build and test jobs fails when
`package.json` and the lockfile disagree. On a fresh clone, install it once:

```bash
cd services/indexer && npm install --no-save --no-package-lock eslint@9 @eslint/js@9 typescript-eslint@8
```

Adding a rule is cheap; switching one to `error` is a repo-wide change, since the
lint job then fails on every existing violation. Prefer a warning plus a tracked
follow-up over a bulk reformat, and never silence a rule repo-wide to get green.

## Commit messages

StellarCred uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must have a structured prefix so the changelog and release notes are generated automatically.

| Prefix | When to use |
|--------|-------------|
| `feat:` | A new feature visible to users or integrators |
| `fix:` | A bug fix |
| `docs:` | Documentation only |
| `chore:` | Build process, tooling, dependency updates |
| `refactor:` | Code change that isn't a fix or feature |
| `test:` | Adding or updating tests |
| `ci:` | CI/CD pipeline changes |

Examples:

```
feat: add income_proof circuit
fix: correct check_claim threshold comparison off-by-one
docs: document NPM_TOKEN secret setup
chore: bump soroban-sdk to 26.0.1
```

Breaking changes: add `BREAKING CHANGE:` in the commit footer, or append `!` after the type (`feat!:`).

Commit messages are linted automatically on pull requests via `commitlint`.

## Automated Dependency Updates & Auto-Merge Policy

To keep dependencies secure and current without manual overhead, minor and patch dependency updates are automatically merged when all test suites pass.

### Auto-Merge Criteria
Pull requests are automatically evaluated and merged when:
1. The PR carries the configured auto-merge label (default: `deps` or `dependencies`).
2. All CI workflows and status checks pass (green build).
3. The PR only modifies dependency manifests and lockfiles (`package.json`, `pnpm-lock.yaml`, `Cargo.toml`, `Cargo.lock`, etc.).

### Safeguards & Threshold Rules
To prevent breaking changes and supply chain regressions, strict threshold rules are enforced:
- **Major Version Bumps Blocked:** Any update that increments the major semver version (e.g. `v1.2.0` → `v2.0.0`, or breaking `0.x` transitions such as `0.1.0` → `0.2.0`) is **strictly barred** from auto-merging. Major version upgrades require manual maintainer review, audit, and approval.
- **Pinned Core Dependencies:** Cryptographic and zero-knowledge toolchain dependencies (`@aztec/bb.js`, `@noir-lang/*`, `soroban-sdk`, `ultrahonk_soroban_verifier`) are explicitly pinned in `.github/dependabot.yml` and cannot be bumped automatically.
- **Source Code Protection:** If a dependency PR contains modifications to application source files (e.g. `src/`, `lib/`, `contracts/`, `circuits/`), auto-merge is immediately rejected.
- **Configurable Label:** The required label can be configured via repository variable `AUTOMERGE_DEPS_LABEL` (defaulting to `deps`).

## Releasing

Releases are tag-driven. The GitHub Actions release workflow fires on any tag matching `v*` and:

1. Regenerates `CHANGELOG.md` from the full conventional commit history.
2. Commits the updated changelog back to `main`.
3. Creates a GitHub Release with the changelog section for that version as the body.
4. Builds and publishes `@stellarcred/sdk` to npm.

### Cutting a release

```bash
# Bump the version in frontend/packages/sdk/package.json, then:
git add frontend/packages/sdk/package.json
git commit -m "chore: release v<version>"
git tag v<version>
git push origin main --tags
```

The workflow handles everything else.

### Required secret

The repository must have an `NPM_TOKEN` secret set under **Settings → Secrets and variables → Actions**.
Generate the token at [npmjs.com](https://www.npmjs.com) with **Automation** type and **Read and write** scope for the `@stellarcred` scope (or the package name).
Never commit the token value.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

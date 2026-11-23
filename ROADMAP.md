# StellarCred roadmap — v1.0 release plan

This roadmap coordinates the work needed to ship **StellarCred v1.0**: a tagged,
reproducible release of the Soroban contracts, Noir circuits, `@stellarcred/sdk`,
`@stellarcred/issuer`, the reference app, and the indexer, with stability promises
that integrators can rely on.

It is a plan, not a date commitment. Estimates are rough, and owners are roles
until a maintainer claims a task. GitHub issue state is authoritative; this file
was checked against open issues on 2026-10-22.

**Tracking:** #741. Each major task links an existing issue or is marked
**NEW** (to be filed; drafts are listed in the PR for this roadmap).

---

## 1. Where we are today

| Component | Location | State today |
|---|---|---|
| Contracts | `contracts/` (`issuer_registry`, `credential_verifier`, `proof_registry`, `gated_pool`; soroban-sdk 26.0.1) | `CONTRACT_VERSION = 1_000_000` already; real UltraHonk verifier via `rs-soroban-ultrahonk` pinned to a git rev (not published). Testnet only. |
| Circuits | `circuits/` (12 proven circuits in `circuit-versions.json`, Noir 1.0.0-beta.9 / bb 0.87.0) | All at circuit `1.0.0`, VK version 1. Constraint baseline in `circuits/AUDIT.md`. |
| SDK | `frontend/packages/sdk` (`@stellarcred/sdk` 0.1.1) | Read-only claim client. A second, private package `sdk/` (`@sdk/core` 0.0.0) still exists at the repo root. |
| Issuer package | `frontend/packages/issuer` (`@stellarcred/issuer` 0.1.0) | Server-only issuance. Not published by `release.yml`. |
| Generated clients | `frontend/packages/proof-registry`, `frontend/packages/issuer-registry` | Generated from contracts (`scripts/gen-bindings.sh`). |
| App + API | `frontend/` (Next.js; holder, verify, issuer, admin, apps, developers; `app/api/issue`) | Beta. Several open security and correctness issues. |
| Indexer | `services/indexer` | Event indexer (SQLite/Postgres). No tests running in CI yet. |
| Release tooling | `.github/workflows/release.yml`, `reproducible-build.yml`, `DEPLOYMENTS.md` | Release-on-tag workflow exists, but **the repo has no tags, releases, or milestones yet**. |
| Docs | `README.md`, `docs/`, `SUPPORT_POLICY.md`, `VERSION_COMPATIBILITY.md` | Comprehensive but partly stale (e.g. a "Q4 2024" roadmap, README badges pointing to a fork). Repo root holds ~20 legacy process-artifact files. |

Already done and counted as gates for v1.0 (verify regression coverage at RC):
#523 shared rate-limit/idempotency store, #522 single SDK claim reader,
#627 no identity data retained or logged, #284 safe credential storage at rest,
#342 contract admin rotation, #633 circuit versioning, #519 release workflow.

---

## 2. Scope

### In scope for v1.0

- **Contracts:** `IssuerRegistry`, `CredentialVerifier`, `ProofRegistry` with a
  frozen public ABI, event schema (`docs/EVENTS.md`), and error codes
  (`docs/contract-error-codes.md`). Covered by the contract-version and
  schema-version promises in `SUPPORT_POLICY.md`.
- **Circuits:** a declared v1.0 set of supported credential types, with frozen
  public-input layouts and registered VKs.
- **SDK:** `@stellarcred/sdk` 1.0.0 with a reviewed, documented public API under
  semver. `@stellarcred/issuer` 1.0.0 published alongside it.
- **App:** holder, verify, and issuer flows on testnet with security headers,
  validated APIs, and E2E coverage of verify → prove → submit.
- **Indexer:** tested in CI and able to backfill.
- **Release:** tagged, reproducible WASM with hashes in `DEPLOYMENTS.md`, a
  changelog, published npm packages, and a release checklist maintainers can rerun.

### Out of scope for v1.0 (post-v1 backlog)

- `GatedPool` stays a **demo** contract, deployed for examples only, with no ABI promise.
- New proof types and circuit features: #414 income band, #430 uniqueness
  leaderboard, #556 credential freshness.
- Integrator conveniences: #129 SDK cache, #400 middleware, #401 CLI,
  #557 dry-run, #858 local proof validator, #811/#843 export CLI.
- Indexer webhooks (#407), multi-tenant issuance (#849), trust scoring (#903),
  approval workflows (#901).
- UX extensions: #131 i18n, #399 theming, #899 onboarding, #902 inventory search,
  #909 export history, #938 skeleton states.
- **Mainnet deployment itself.** v1.0 ships mainnet-*deployable* artifacts and a
  rehearsed runbook. Deploying to mainnet is a separate maintainer go/no-go after
  v1.0, and depends on the security review result (see Risks).

---

## 3. Milestones

Durations are rough and assume 2–4 active contributors. Create a GitHub
milestone for each and assign the issues below to it.

### v1.0-alpha — "scope frozen" (≈ weeks 0–3)

Goal: decide what v1.0 *is* and stop the public surface from moving.

Exit criteria:
- [ ] v1.0 contract ABI, events, and error codes frozen and documented (NEW: contract freeze).
- [ ] v1.0 supported circuit set and public-input layouts frozen (NEW: circuit freeze).
- [ ] SDK public API review complete, and the fate of the root `sdk/` package decided (NEW: SDK API review).
- [ ] Backlog triaged: duplicates closed, milestones created, every v1.0 issue on a milestone (NEW: triage).
- [ ] Contract fmt/clippy gate in CI (#599).
- [ ] First pre-release tag `v1.0.0-alpha.1` cut through `release.yml` (NEW: release pipeline).

### v1.0-beta — "feature complete and hardened" (≈ weeks 3–7)

Goal: every in-scope task is merged. Only bug fixes after this point.

Exit criteria:
- [ ] All security tasks below merged (#69, #72, #531, #814, #945).
- [ ] Known correctness bugs fixed (#758, #764, #910, #905, #942, #947).
- [ ] E2E verify → prove → submit on testnet runs in CI (#43, merged with #743/#946).
- [ ] Indexer tests in CI (#820) and backfill (#611).
- [ ] Aggregate submission integration test (#308).
- [ ] Security review scheduled with a frozen commit handed over (NEW: security review).
- [ ] `v1.0.0-beta.1` tagged and deployed to testnet from the tag.

### v1.0-rc — "release candidate" (≈ weeks 7–9)

Goal: prove the release process end to end on the exact bits we will ship.

Exit criteria:
- [ ] Security review findings rated high or critical are fixed or explicitly accepted by maintainers in writing.
- [ ] Fresh testnet deploy from the RC tag using `scripts/deploy.sh`, verified with one command (#692). WASM hashes match the reproducible-build artifact (NEW: deploy rehearsal).
- [ ] Mainnet dry run of `scripts/deploy-mainnet.sh` (simulation / no-submit) completed (NEW: deploy rehearsal).
- [ ] Docs reconciled to v1.0: compat matrix, support policy, README, SDK reference (#402, NEW: docs reconcile).
- [ ] No open issue labelled `security` or `bug` on the v1.0 milestone.
- [ ] `v1.0.0-rc.1` tagged. Integrators invited to test for ≥ 1 week with no blocking regressions.

### v1.0 — "GA" (≈ week 10+)

Exit criteria:
- [ ] Release checklist (section 5) fully ticked by the release manager.
- [ ] `v1.0.0` tag; GitHub release with changelog; `@stellarcred/sdk@1.0.0` and `@stellarcred/issuer@1.0.0` on npm.
- [ ] `DEPLOYMENTS.md` updated with contract IDs, source commit, and WASM hashes for the v1.0 testnet deployment.
- [ ] Post-v1 backlog moved to a `v1.1` milestone.

---

## 4. Major tasks by component

Estimate scale: **S** = 1–2 days · **M** = 3–5 days · **L** = 6–10 days (one contributor).
Owners are roles; replace them with a GitHub handle when someone claims the task.

### 4.1 Contracts (`contracts/`)

| Task | Issue | Est. | Owner | Milestone |
|---|---|---|---|---|
| Freeze v1.0 contract ABI, events, and error codes; mark `GatedPool` demo-only | NEW | M (3–4d) | Contracts maintainer | alpha |
| fmt + clippy CI gate across all contracts | #599 | S (1d) | Contributor | alpha |
| Faster contracts CI (cache, quick PR build path) | #818 | S (2d) | Contributor | beta |
| Integration test for aggregate/recursive submission and layout validation | #308 | M (3d) | Contracts maintainer | beta |
| Pin critical ZK dependencies (`rs-soroban-ultrahonk` git rev, Noir/bb versions) with a documented upgrade policy | NEW | M (3d) | Contracts + circuits maintainers | beta |
| Independent security review of contracts and circuits | NEW | L (external; 2–4 weeks elapsed, ~5d maintainer time) | Lead maintainer | beta → rc |

### 4.2 Circuits (`circuits/`)

| Task | Issue | Est. | Owner | Milestone |
|---|---|---|---|---|
| Freeze v1.0 supported credential types, public-input layouts, and VKs | NEW | M (3d) | Circuits maintainer | alpha |
| Validate inputs and fail on malformed witness data in `gen_inputs.sh` | #163 | S (1d) | Contributor | beta |
| Fix race condition in circuit prover | #758 | M (3–5d) | Circuits maintainer | beta |
| Proving benchmarks and timeout guardrails | #943 | M (3d) | Contributor | beta |
| Verify `date_range` circuit (exists in `circuits/date_range`) against #390; close or scope the remaining work | #390 | S (0.5d) | Circuits maintainer | alpha |

### 4.3 SDK and packages (`frontend/packages/*`, `sdk/`)

| Task | Issue | Est. | Owner | Milestone |
|---|---|---|---|---|
| SDK v1.0 API review: public surface, naming, errors, deprecations; resolve the duplicate root `sdk/` package | NEW | M (4d) | SDK maintainer | alpha |
| Generate and publish SDK API reference from TSDoc in CI | #402 | S (2d) | Contributor | rc |
| Bundle-size budget and tree-shaking (merge with #737) | #403, #737 | S (2d) | Contributor | beta |
| Retry logic must not amplify load during an RPC outage | #555 | M (3d) | SDK maintainer | beta |
| Type-safe `buildVerifyUrl` options (duplicates; keep one, close the other) | #808 / #842 | S (1d) | Contributor | beta |
| SDK method to query deployment and circuit versions | #841 | M (3d) | Contributor | beta |
| SDK helper to parse and validate credential JSON | #852 | S (2d) | Contributor | beta |

### 4.4 App API and issuance (`frontend/app/api`, `frontend/packages/issuer`)

| Task | Issue | Est. | Owner | Milestone |
|---|---|---|---|---|
| Issuer signing key in KMS/HSM, not an env var (one design; fold in #851) | #69, #851 | L (6–8d) | Backend maintainer | beta |
| Request validation and schema enforcement on all API routes | #72 | S (2d) | Contributor | beta |
| Harden API auth checks and session validation | #945 | M (3d) | Backend maintainer | beta |
| Timing-safe compare utility instead of `Buffer.equals` | #814 | S (1d) | Contributor | beta |
| Handle rate-limiting from external APIs gracefully | #761 | M (3d) | Contributor | beta |
| Persona webhook receiver instead of redirect polling | #528 | M (4d) | Backend maintainer | beta |
| Health checks for app and worker services | #859 | S (1d) | Contributor | beta |

### 4.5 Frontend (`frontend/app`, `frontend/components`)

| Task | Issue | Est. | Owner | Milestone |
|---|---|---|---|---|
| Content-Security-Policy headers | #531 | M (3d) | Frontend maintainer | beta |
| Playwright E2E: verify → prove → submit on testnet (consolidate #743, #946) | #43, #743, #946 | L (6d) | Frontend maintainer | beta |
| Stale data, cache invalidation, and hydration bugs on the dashboard | #905, #942, #947 | M (4d total) | Contributor | beta |
| Graceful fallback for unsupported browser capabilities (duplicates; keep one) | #900 / #939 | M (3d) | Contributor | beta |
| Warn the holder before proving when the gate will not be satisfied | #618 | S (2d) | Contributor | beta |
| Split `HolderPageClient` (2,000+ lines) | #685 | L (6d) | Frontend maintainer | beta (not a release blocker if it slips) |

### 4.6 Indexer (`services/indexer`)

| Task | Issue | Est. | Owner | Milestone |
|---|---|---|---|---|
| Jest tests for the indexer, run in CI | #820 | M (3d) | Contributor | beta |
| Backfill from genesis or a given ledger | #611 | M (4d) | Backend maintainer | beta |

### 4.7 Deployment, CI, and release (`scripts/`, `.github/workflows/`)

| Task | Issue | Est. | Owner | Milestone |
|---|---|---|---|---|
| Release pipeline: align versions, publish `@stellarcred/issuer`, fix package metadata, support pre-release tags | NEW | M (3d) | Release manager (maintainer) | alpha |
| Fix deploy-script typo and non-idempotent deploys | #764, #910 | M (3d) | Contributor | beta |
| Better logging in deploy scripts | #754 | S (1d) | Contributor | beta |
| One command to verify a deployment end to end | #692 | S (2d) | Contributor | rc |
| Rehearse deploy + verify from the RC tag (fresh testnet; mainnet dry run) | NEW | M (3d) | Release manager (maintainer) | rc |
| Document CI workflow ownership; fix flaky Windows runner | #621, #874 | S (2d) | Contributor | beta |

### 4.8 Documentation and repo hygiene

| Task | Issue | Est. | Owner | Milestone |
|---|---|---|---|---|
| Triage backlog for v1.0: milestones, close duplicates and off-topic issues | NEW | S (2d) | Lead maintainer | alpha |
| Remove legacy process-artifact files and stray logs from the repo root | NEW | S (1d) | Contributor | alpha |
| Reconcile version and compatibility docs for v1.0 (`VERSION_COMPATIBILITY.md`, `SUPPORT_POLICY.md`, README badges/links) | NEW | S (2d) | Docs (maintainer review) | rc |
| Testing guide in CONTRIBUTING; local setup in README | #757, #875 | S (2d) | Contributor | rc |
| Backup and restore guide for credential data | #857 | S (1d) | Contributor | rc |
| Wallet and network compatibility matrix | #944 | S (1d) | Contributor | rc |
| Credential lifecycle and renewal policy (build on `docs/ISSUER_LIFECYCLE.md`) | #908 | S (2d) | Docs (maintainer review) | rc |

**Totals (rough):** 46 tasks (36 linked to existing issues, 10 NEW), about 95–120 contributor-days excluding the
external review. With 3 contributors in parallel, that fits the ~10-week outline
above, with the security review on the critical path.

---

## 5. Release checklist (per tag: alpha, beta, rc, GA)

Release manager runs this list and pastes it, ticked, into the release PR or issue.

**Before tagging**
- [ ] Milestone has no open issues, or each remaining one is moved with a reason.
- [ ] `main` CI is green: CI, Contracts CI, reproducible-build, e2e, lint.
- [ ] `cargo test` passes for all contracts. `nargo test` passes and constraint baselines match (`circuits/AUDIT.md`).
- [ ] `circuits/circuit-versions.json`, staged artifacts in `frontend/public/circuits/`, and on-chain VK versions agree (`scripts/verify-vks.sh`).
- [ ] Generated contract clients are regenerated and committed (`scripts/gen-bindings.sh`, `scripts/verify-client-freshness.sh`).
- [ ] Versions bumped together: `frontend/packages/sdk/package.json`, `frontend/packages/issuer/package.json`, contract `CONTRACT_VERSION` if the ABI changed.
- [ ] `docs/EVENTS.md`, `docs/contract-error-codes.md`, and `docs/PROOF_REGISTRY_API.md` match source (the CI API-reference drift check passes).
- [ ] `SUPPORT_POLICY.md` and `VERSION_COMPATIBILITY.md` list the new versions.
- [ ] `.env.example` and `.env.mainnet.example` are complete (`scripts/validate-deploy-env.sh`).

**Tag and publish**
- [ ] Tag `vX.Y.Z[-pre.N]` on the release commit. `release.yml` updates `CHANGELOG.md`, creates the GitHub release, and publishes npm packages.
- [ ] Download the `wasm-hashes-<commit>` artifact from the reproducible-build workflow and attach it to the GitHub release.

**Deploy and verify (testnet)**
- [ ] Deploy from the tag with `scripts/deploy.sh`. Register the issuer and install VKs.
- [ ] `scripts/verify-deployment.sh` and `scripts/verify-wasm.sh --network testnet` pass.
- [ ] `scripts/e2e-testnet.sh` passes against the new deployment.
- [ ] Record contract IDs, source commit, and WASM hashes in `DEPLOYMENTS.md`.
- [ ] App `/api/ready` reports the expected contract versions.

**After release**
- [ ] Smoke test: issue → prove → submit → `is_verified` from the deployed app and from a fresh `npm install @stellarcred/sdk`.
- [ ] Announce the release with upgrade notes. For breaking changes, follow the deprecation procedure in `SUPPORT_POLICY.md`.
- [ ] Open the next milestone. Move leftovers.

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| ZK toolchain is pre-1.0 (Noir 1.0.0-beta.9, bb 0.87.0) and the verifier is an unpublished git dependency | A toolchain bump changes VKs or breaks verification after v1.0 | Pin exact versions, record the upgrade policy, and treat any toolchain bump as a circuit MAJOR/VK bump per `SUPPORT_POLICY.md` (NEW: pin deps). |
| No independent security review of contracts or circuits yet | Mainnet funds or trust at risk | Review is a beta → rc gate. Mainnet go/no-go depends on its findings. |
| Security review lead time | Slips the RC | Freeze scope and request the review at alpha exit. Hand over a frozen commit at beta. |
| Freezing the ABI too early or too late | Breaking changes after GA, or alpha stalls | Freeze at alpha. After that, ABI changes need maintainer sign-off and a note in #741. |
| Noisy backlog (duplicates, issues unrelated to this codebase) | Contributors work on the wrong things | Triage at alpha. Only issues on the v1.0 milestone count toward release. |
| Two SDK packages (`sdk/` and `frontend/packages/sdk`) | Integrators import the wrong one; drift | Decide during the SDK API review. Delete or merge before beta. |
| Proving performance in browsers (ECDSA dominates constraints, per `circuits/AUDIT.md`) | Poor holder UX on low-end devices | Benchmarks and timeouts (#943). Unsupported-browser fallback (#900). |
| Few maintainers; many contributor tasks | Review bottleneck | Owners per component; contributor tasks sized S/M; release manager role named at alpha. |

---

## 7. Priority rules (still apply)

- **Security, privacy, correctness, and operational defects come before new
  features**, whatever their labels or difficulty. A feature does not displace an
  unresolved defect.
- Labels such as `easy`, `medium`, and `hard` describe effort, not priority.
- Pick work from the earliest open milestone that matches your skills. Before
  starting, check that the issue is still open and has no active pull request.
- Anything not on the v1.0 milestones belongs to the post-v1 backlog (section 2).

# CI Workflows & Merge-Gating Reference

This document defines the purpose, trigger schedule, ownership, and merge-gating status of every GitHub Actions workflow in `.github/workflows/`.

---

## 1. Workflow Consolidation & Design Principles

- **Main PR Gate (`ci.yml`)**: Fast static checks and core build/test suites run as parallel jobs inside `ci.yml` so contributors and branch protection rules have a single, predictable status surface.
  - **`env-check` consolidation (#621)**: The standalone `env-check.yml` workflow has been consolidated into the `env-check` job in `ci.yml`. It is a fast (<15s) Node-only static check (`check-env-sync.mjs` and `validate-deploy-env.mjs --smoke-test`) with no special secrets, so keeping it in a separate workflow file added redundant runner overhead without isolation benefit.
- **Why other workflows remain separate**:
  - **`reproducible-build.yml`**: Kept separate from `ci.yml`'s `contracts` job because it builds a `--no-cache` Docker image (`docker/Dockerfile.reproducible`), executes two isolated container builds plus a host build for cross-environment WASM byte-identity verification, and publishes the `wasm-hashes-<commit>` artifact. Path-filtering it to `contracts/**`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, and `docker/Dockerfile.reproducible` avoids adding 10+ minutes to unrelated frontend or docs PRs.
  - **`e2e.yml`**: Runs only on a nightly schedule and `workflow_dispatch`. It is intentionally detached from `pull_request` because it uses the `stellarcred-e2e` environment secret (`STELLARCRED_E2E_ISSUER_PRIVATE_KEY`) against Stellar Testnet, which must never be exposed to fork PRs.
  - **`preview-deployment.yml`**: Path-filtered to `frontend/**` and guarded by `head.repo.full_name == github.repository` so `VERCEL_TOKEN` is never accessed on fork PRs. It is purely informational (posts a preview URL comment).
  - **`release.yml`**: Triggered only on `v*` tag pushes with `contents: write` and `NPM_TOKEN` to update `CHANGELOG.md`, create a GitHub Release, and publish `@stellarcred/sdk`.
  - **`auto-label-deps.yml` / `auto-merge-deps.yml`**: Use `pull_request_target` / `workflow_run` for Dependabot automation with elevated write permissions; isolated from `ci.yml`'s `contents: read` least-privilege boundary.

---

## 2. Complete Workflow Inventory

| Workflow File | Purpose | Triggers (When it runs) | Merge-Gating Status | Owner |
|---|---|---|---|---|
| `ci.yml` | Core CI pipeline: dependency/license review, `commitlint`, `api-reference` drift check, `process-docs`, `ownership-docs`, `env-check`, `contracts`, `circuits`, `circuit-fuzz`, `frontend`, `windows-smoke`, `indexer`, `sdk-integration`, `coverage-gate` | Every PR to `main` and push to `main` | **Required for merge** (excluding `sdk-integration` on forks without repo vars, and `a11y` while `if: false`) | Protocol & Frontend maintainers |
| `reproducible-build.yml` | Two-layer deterministic WASM build (container vs container + host vs container) and `wasm-hashes-<commit>` artifact upload | PR and push to `main` touching `contracts/**`, `Cargo.*`, `rust-toolchain.toml`, `docker/Dockerfile.reproducible` | **Required when triggered** (path-filtered contract gate) | Protocol maintainers |
| `contracts-ci.yml` | Standalone Soroban contract build & unit test verification | PR to `main`, manual (`workflow_dispatch`) | **Required for merge** (mirrors contract verification) | Protocol maintainers |
| `lint.yml` | Frontend ESLint, Indexer ESLint, and Next.js page-client bundle size cap | PR and push to `main` | **Required for merge** | Frontend & Indexer maintainers |
| `dependency-review.yml` | GitHub Advisory DB & license check on PR dependency diffs | PR to `main` | **Required for merge** | All maintainers |
| `first-load.yml` | Lighthouse first-load budgets & proving-asset critical-path check | PR to `main` touching `frontend/**`, manual (`workflow_dispatch`) | **Required when triggered** (path-filtered frontend gate) | Frontend maintainers |
| `proving-perf.yml` | Noir/Barretenberg proving time & memory regression gate | PR to `main` touching `circuits/**`, `perf/**`, `frontend/lib/proof-perf.ts`, manual | **Required when triggered** (path-filtered circuit gate) | Circuits maintainers |
| `preview-deployment.yml` | Builds and deploys a Vercel preview for same-repo PRs | PR (`opened`, `synchronize`, `reopened`, `closed`) touching `frontend/**` | **Informational** (non-gating; skipped on fork PRs) | Frontend maintainers |
| `e2e.yml` | Full deploy → issue → prove → verify happy path on Stellar Testnet + browser prover Playwright spec | Nightly (`17 3 * * *` UTC) & manual (`workflow_dispatch`) | **Non-gating** (scheduled / manual) | Protocol & QA maintainers |
| `nightly.yml` | Runs `./scripts/verify-deployment.sh --network testnet` to catch live on-chain drift vs `DEPLOYMENTS.md` | Nightly (`0 2 * * *` UTC) & manual (`workflow_dispatch`) | **Non-gating** (scheduled / manual) | Protocol maintainers |
| `release.yml` | Verifies SDK version, updates `CHANGELOG.md`, creates GitHub Release, publishes npm package | Push of tags matching `v*` | **Release only** (tag push) | Release maintainers |
| `auto-label-deps.yml` | Labels dependency PRs by ecosystem and semver bump | `pull_request_target` on PR lifecycle events | **Automation** (non-gating) | Repo automation |
| `auto-merge-deps.yml` | Auto-merges eligible minor/patch dependency PRs after `CI` passes | `pull_request_target`, `workflow_run` (`CI`), manual | **Automation** (non-gating) | Repo automation |
| `stale.yml` | Marks and closes inactive issues and PRs | Daily (`30 2 * * *` UTC) & manual | **Housekeeping** (non-gating) | Repo automation |

---

## 3. Required Checks for Merge into `main`

Branch protection on `main` requires the following checks to pass before merging:

1. **Always-required PR checks (`ci.yml`, `lint.yml`, `contracts-ci.yml`, `dependency-review.yml`)**:
   - `ci.yml`: `Dependency review`, `Lint commit messages`, `Contract API reference drift check`, `Process artifact check`, `Component ownership check`, `Environment variable check`, `Contract tests & build`, `Circuit compile`, `Property-based circuit fuzzing`, `Frontend typecheck & build`, `Windows smoke (frontend)`, `Indexer tests (SQLite + Postgres)`, `Coverage gate`.
   - `lint.yml`: `Frontend`, `Indexer`, `Page client size`.
   - `contracts-ci.yml`: `contracts`.
   - `dependency-review.yml`: `dependency-review`.
2. **Path-filtered required checks** (must pass whenever the matching paths are modified):
   - `reproducible-build.yml`: `Build twice (container), compare hashes`
   - `first-load.yml`: `first-load`
   - `proving-perf.yml`: `proving-perf`
3. **Explicitly non-gating / informational checks**:
   - `preview-deployment.yml` (skipped on fork PRs)
   - `ci.yml / sdk-integration` (skipped on forks lacking `SC_TEST_WALLET` / `STELLARCRED_REGISTRY_ID`)
   - `ci.yml / a11y` (disabled with `if: false` pending pre-existing violation cleanup)
   - `e2e.yml`, `nightly.yml`, `release.yml`, `auto-label-deps.yml`, `auto-merge-deps.yml`, `stale.yml`

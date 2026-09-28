# GitHub Actions workflow ownership

This document is the repository map for GitHub Actions. It records what each workflow owns, when it runs, and whether it is part of the intended merge gate.

> **Merge policy:** `CI` is the primary required merge gate. Its jobs run on every pull request targeting `main` and on pushes to `main`. Path-scoped workflows are additional gates for the areas they cover; maintainers should require their check names in branch protection when those checks are intended to block a merge. Manual, scheduled, deployment, and release workflows are not merge gates.

The issue that introduced this inventory described six workflows. The repository now has seven because first-load and proving-performance checks were added later; this inventory covers the current set.

## Workflow inventory

| Workflow | File | Runs | Merge-gating status | Owner and responsibility |
| --- | --- | --- | --- | --- |
| **CI** | `.github/workflows/ci.yml` | Every PR to `main`; every push to `main` | **Primary required gate** | Repository-wide correctness: dependency/license checks, commit messages, API-doc drift, contracts, circuits, fuzzing, frontend, indexer, SDK integration when configured, and environment-variable documentation. |
| **Reproducible Build** | `.github/workflows/reproducible-build.yml` | PRs and pushes touching contracts, Cargo/toolchain files, the reproducible Dockerfile, or this workflow | **Required for contract/build changes** | Builds the contract WASM twice in independent containers and compares hashes. It remains separate because it validates the build environment's determinism rather than ordinary contract correctness. |
| **Proving perf gate** | `.github/workflows/proving-perf.yml` | PRs touching circuits, proving instrumentation, performance scripts/baselines, or this workflow; manual dispatch | **Required for proving-performance changes** | Measures representative witness/prove stages and gates regressions against the committed baseline. It is separate because it is a slow, specialized benchmark rather than a general correctness check. |
| **First-load budget** | `.github/workflows/first-load.yml` | PRs touching `frontend/**` or this workflow; manual dispatch | **Required for frontend performance changes** | Runs Lighthouse and proving-asset critical-path budgets. It is separate because it needs browser installation and measures user-perceived performance, not frontend correctness. |
| **StellarCred E2E** | `.github/workflows/e2e.yml` | Nightly at `03:17 UTC`; manual dispatch | **Informational; not a PR gate** | Exercises deploy → issue → prove → verify on an ephemeral testnet using protected environment secrets. It is intentionally not attached to PRs, especially fork PRs. |
| **Preview Deployment** | `.github/workflows/preview-deployment.yml` | Frontend PR open, synchronize, reopen, and close events | **Deployment status; not a merge gate** | Creates and tears down Vercel previews and comments the preview URL. It is restricted to same-repository PRs when secrets are needed. |
| **Release** | `.github/workflows/release.yml` | Pushes of tags matching `v*` | **Release-only; not a merge gate** | Updates the changelog, creates a GitHub release, and publishes the SDK to npm. It never runs for ordinary PRs. |

## Required CI checks

The `CI` workflow is the default merge contract. For a normal pull request, the relevant checks are:

- Dependency review and license/runtime-dependency checks.
- Conventional commit message validation.
- Contract API reference drift check.
- Contract tests, WASM build, and Clippy.
- Circuit compilation, VK freshness, syntax checks, and Noir tests.
- Circuit fuzzing after the circuit job.
- Frontend typecheck, lint, tests, build, privacy checks, SDK checks, and bundle budget.
- Indexer tests.
- Environment-variable documentation synchronization.

Some CI jobs are intentionally conditional:

- `sdk-integration` runs only when the test wallet and registry variables are configured.
- The accessibility job is currently disabled in the workflow until existing violations are fixed; it is not a required check today.
- Dependency review runs only for pull requests, while the build and test jobs also run on pushes to `main`.

Branch protection is configured in GitHub repository settings rather than in the repository files. When updating required checks, use the stable job names shown in the workflow and keep this document synchronized with that setting.

## Ownership rules

- Changes to `.github/workflows/ci.yml` require CI/infrastructure review because this file defines the primary merge gate.
- A new correctness check belongs in `ci.yml` unless it needs a distinct trigger, secrets boundary, runtime, or specialized resource profile.
- A separate workflow must document its reason in both its header comments and this inventory.
- Slow benchmarks, protected-environment E2E tests, previews, and tag-driven releases remain separate because combining them with the primary gate would either expose secrets, slow ordinary feedback, or change their trigger semantics.
- The environment-variable check is intentionally a CI job rather than a standalone workflow: it is a fast static check with no separate trigger or security boundary.
- The standalone dependency-review workflow was removed because its advisory, runtime-dependency, and license checks duplicated the `dependency-check` job already owned by `ci.yml`.

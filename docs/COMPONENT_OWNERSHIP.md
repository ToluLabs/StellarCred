# Component ownership and review paths

This document answers two questions for every part of the repository: **who is
responsible for reviewing a change here**, and **what a reviewer is expected to
check**. It is the per-component companion to two other documents:

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) § [Review
  routing](../CONTRIBUTING.md#review-routing) — review _depth_ and the trust-model
  invariants each area must preserve.
- [`RELEASE_RUNBOOK.md`](RELEASE_RUNBOOK.md) — release-time roles (Release
  Manager, Release Operator, Independent Approver, Component Owner). That
  document says who performs and approves a release; this one says who owns the
  code and reviews changes to it.

It deliberately does not repeat the contribution workflow, the CI command map
([`docs/CONTRIBUTOR_CHECKLIST.md`](CONTRIBUTOR_CHECKLIST.md)), or the release
procedure.

## 1. What is enforced, and what is only documented

Three different things are often confused in review discussions. They are not
interchangeable, and only the first is automated by this repository:

| Layer                    | Mechanism                                                                                   | What it actually does                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic review request | [`.github/CODEOWNERS`](../.github/CODEOWNERS)                                               | When a PR touches a path, GitHub requests a review from the owners of the **last** matching pattern. This is routing, not approval.                                               |
| Documented expectation   | this file and `CONTRIBUTING.md` § Review routing                                            | Says which owner must review which component, and what they must check. Reviewers and contributors are expected to follow it.                                                     |
| Merge blocking           | GitHub branch protection (repository settings)                                              | Not stored in this repository and therefore not verifiable from a clone. Whether a code-owner review is _required_ before merge depends on the branch rule configured for `main`. |
| Consistency check        | `node .github/scripts/check-component-ownership.mjs` (CI job **Component ownership check**) | Fails when this matrix, `CODEOWNERS`, and the documented paths disagree. It does not grant approvals and cannot inspect branch protection.                                        |

**Do not infer an approval count from this document.** Nothing here enforces
"two approvals", "one approval", or "code owner approval" at merge time.
`CONTRIBUTING.md` makes the same point: a code-owner request is a suggestion
unless the `main` branch rule requires it. Treat every "required review" below
as a documented expectation that reviewers must honour, not a guarantee the
platform blocks a merge without.

The owners are the two maintainers already named in `CODEOWNERS`:
`@nonchalanttee22-lgtm` and `@Psalmuel01`. No GitHub team slug is used anywhere
in the repository, and `CODEOWNERS` itself warns that a team without write
access is silently ignored. This document names individuals only because that
is the verified state of the repository, not because component ownership has
been delegated to separate people.

## 2. Ownership matrix

Scope cells list the paths a component owns. `CODEOWNERS` rules are the literal
patterns in `.github/CODEOWNERS`; the check script verifies that each rule still
exists, that every scope path exists, and that the owner cell matches what the
rule resolves to.

<!-- ownership-matrix:start -->

| Component                   | Scope / repository areas                                                                                                                                                                                                                                                                                                                                                                    | Owner                                 | CODEOWNERS rule                                                                                                                                              | Required review path                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contracts**               | `contracts/`, `contracts/issuer_registry/`, `contracts/credential_verifier/`, `contracts/proof_registry/`, `contracts/gated_pool/`, `contracts/test_support/`, `contracts/ProofRegistry.sol`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`                                                                                                                                             | `@nonchalanttee22-lgtm` `@Psalmuel01` | `/contracts/`, `/Cargo.toml`, `/Cargo.lock`                                                                                                                  | A contracts owner reviews every diff against [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) and the relevant ADR. Cross-component: add the SDK/bindings owner if the public ABI or events change, and the circuits owner if a VK or verifier dependency changes.                  |
| **Circuits and VKs**        | `circuits/`, `circuits/Nargo.toml`, `circuits/scripts/`, `circuits/testvectors/`, `circuits/circuit-versions.json`, `fixtures/`, `scripts/verify-vks.sh`                                                                                                                                                                                                                                    | `@nonchalanttee22-lgtm` `@Psalmuel01` | `/circuits/`, `/circuits/Nargo.toml`, `/circuits/scripts/`, `/fixtures/`                                                                                     | A circuits owner reviews every constraint, toolchain, fixture, or VK change. Cross-component: the contracts owner reviews anything that changes a registered VK or public-input layout.                                                                                      |
| **SDK and client bindings** | `frontend/packages/sdk/`, `sdk/` (private root package, fate undecided), `frontend/packages/proof-registry/`, `frontend/packages/issuer-registry/`, `frontend/packages/cli/`, `scripts/gen-bindings.sh`, `scripts/verify-client-freshness.sh`, `docs/contract-clients.md`                                                                                                                   | `@nonchalanttee22-lgtm` `@Psalmuel01` | `/frontend/packages/sdk/`, `/sdk/`, `/frontend/packages/proof-registry/`, `/frontend/packages/issuer-registry/`, `/frontend/packages/cli/`                   | An SDK owner reviews the published surface, signing and transaction construction, and generated bindings. Cross-component: the contracts owner reviews binding changes that follow an ABI change.                                                                            |
| **Frontend**                | `frontend/app/` (pages and non-issuance API routes), `frontend/components/`, `frontend/lib/`, `frontend/public/`, `frontend/e2e/`, `frontend/middleware.ts`, `frontend/package.json`                                                                                                                                                                                                        | `@nonchalanttee22-lgtm` `@Psalmuel01` | `/frontend/`, `/frontend/middleware.ts`                                                                                                                      | A frontend owner reviews UI, routing, and client-side behaviour. Cross-component: the issuer owner reviews any change under `frontend/app/api/` or the signing/KYC helpers; the SDK owner reviews changes to how the app calls the SDK.                                      |
| **Issuer**                  | `frontend/packages/issuer/`, `frontend/app/api/issue/`, `frontend/app/api/issuers/`, `frontend/app/api/persona/`, `frontend/app/api/witness/`, `frontend/app/api/plaid-balance/`, `frontend/app/api/admin/issuance/`, `frontend/lib/issuer-signer.ts`, `frontend/lib/persona-webhook.ts`, `frontend/lib/error-reporting.ts`, `frontend/lib/admin-page-auth.ts`, `docs/ISSUER_ONBOARDING.md` | `@nonchalanttee22-lgtm` `@Psalmuel01` | `/frontend/packages/issuer/`, `/frontend/app/api/`, `/frontend/lib/issuer-signer.ts`, `/frontend/lib/persona-webhook.ts`, `/frontend/lib/error-reporting.ts` | An issuer owner reviews every credential-producing, signing, KYC, and admin-issuance change. Cross-component: the circuits owner reviews commitment/signature changes that must match the circuit's public inputs; the frontend owner reviews UI that consumes these routes. |
| **Indexer**                 | `services/indexer/`, `services/indexer/src/auth.ts`, `services/indexer/src/cors.ts`, `services/indexer/src/rate-limit.ts`, `services/indexer/README.md`                                                                                                                                                                                                                                     | `@nonchalanttee22-lgtm` `@Psalmuel01` | `/services/indexer/`                                                                                                                                         | An indexer owner reviews event decoding, storage, auth/CORS/rate limiting, and backfill changes. Cross-component: the contracts owner reviews any change that depends on a new or renamed contract event.                                                                    |

<!-- ownership-matrix:end -->

Two boundaries need stating because the directory names hide them:

- `/frontend/app/api/` is one `CODEOWNERS` rule covering the whole API tree, but
  the **issuance surfaces** listed above are the issuer component's
  responsibility; non-issuance routes (`health`, `ready`, `metrics`, `export`,
  `proof-telemetry`, and the rest) default to the frontend owner. The rule routes
  the same maintainers either way — the split is about which invariant a reviewer
  checks, not about who is requested.
- `fixtures/` is routed to the circuits owners. The contracts test harness in
  `contracts/test_support/` consumes those artifacts, so a fixture change is
  reviewed as a circuit change _and_ re-run through `cargo test`.

`GatedPool` (`contracts/gated_pool/`) is in the contracts scope for review
purposes, but it is a demo contract with no v1.0 ABI promise (see `ROADMAP.md`).

## 3. What each component owns

### Contracts

- **In scope:** the four deployable Soroban contracts, their tests, the shared
  test harness, contract version constants, the workspace `Cargo.toml`/`Cargo.lock`,
  and the pinned Rust toolchain.
- **Belongs elsewhere:** circuit constraints (`circuits/`), committed proof
  artifacts (`fixtures/`), generated TypeScript clients
  (`frontend/packages/*-registry/`), and deployment execution (`scripts/deploy*.sh`).
- **Review must preserve:** a proof is accepted only when it verifies on-chain
  against a registered VK; only issuer keys registered in `IssuerRegistry` are
  trusted; expiry and revocation semantics. The full list is in
  `CONTRIBUTING.md` § [Sensitive areas](../CONTRIBUTING.md#sensitive-areas-and-their-invariants).

### Circuits and VKs

- **In scope:** Noir sources for all proven circuits, `Nargo.toml`, circuit build
  and test-vector scripts, `circuit-versions.json`, committed verification
  keys/proofs/public inputs in `fixtures/`, and VK verification tooling.
- **Belongs elsewhere:** on-chain verification code (`contracts/`), and the
  `set_vk` deployment step itself (`scripts/deploy*.sh`).
- **Review must preserve:** in-circuit secp256k1 verification over the committed
  digest, the mandatory Poseidon2 salt, and every existing constraint or range
  check. A loosened constraint still compiles, proves, and verifies, so this is
  a review-only defence. Fixtures and test vectors must come from the pinned
  `nargo 1.0.0-beta.9` / `bb 0.87.0` build, never hand edits.

### SDK and client bindings

- **In scope:** the published SDK package, the private root `sdk/` package, the
  generated proof-registry and issuer-registry clients, the `stellarcred` CLI,
  the binding generation/freshness scripts, and the integrator-facing docs.
- **Belongs elsewhere:** the contract ABI those bindings mirror, and app-side
  usage of the SDK (`frontend/`).
- **Review must preserve:** published signatures and semver promises, signing
  and transaction assembly, and generated output that matches the current
  contract source (`scripts/verify-client-freshness.sh`). The root `sdk/`
  package still exists; per `ROADMAP.md` its fate is undecided, so do not quietly
  grow it into a second public surface.

### Frontend

- **In scope:** pages, components, hooks, client helpers, styling, public
  assets (including the staged circuits under `frontend/public/circuits/`),
  middleware, and non-issuance API routes.
- **Belongs elsewhere:** the issuance/signing API routes and helpers (issuer
  component), the SDK itself, and circuit sources.
- **Review must preserve:** no server-only secret reaches client-bundled code;
  page-client shells stay within their size caps; auth and header handling in
  `frontend/middleware.ts` is not weakened.

### Issuer

- **In scope:** the issuer package and its `signCommitment` signing path, the
  credential-producing API routes, the Persona/KYC webhook, identity redaction,
  admin issuance, and issuer onboarding/lifecycle docs.
- **Belongs elsewhere:** the circuit that verifies the signature, and the
  contract registry that decides which issuer keys are trusted.
- **Review must preserve:** `prehash: false` on the secp256k1 call, the signature
  over the same commitment digest the circuit consumes, the server-only guard
  around `ISSUER_PRIVATE_KEY`, no `NEXT_PUBLIC_` prefix on server values, and no
  identity field stored or logged after the provider call. See
  `SECURITY.md` and `docs/THREAT_MODEL.md`.

### Indexer

- **In scope:** event ingestion and decoding, SQLite/Postgres storage, the HTTP
  API (`auth`, `cors`, `rate-limit`), backfill, and indexer-specific docs.
- **Belongs elsewhere:** the contract event schema (`docs/EVENTS.md` and the
  contracts themselves) and the app that reads indexed state.
- **Review must preserve:** event decoding matches the emitted schema, auth and
  CORS defaults stay closed, and backfill remains resumable.

## 4. Required review paths

### 4.1 A change isolated to one component

1. `CODEOWNERS` requests a review from the owner whose rule matches the touched
   paths (currently both maintainers for every rule).
2. The PR needs a review from **the owner of that component**, not merely any
   maintainer. The owner checks the invariants in §3 and the matching rows of
   `CONTRIBUTING.md` § Sensitive areas.
3. The contributor states in the PR description which component the change
   belongs to and names the invariant it preserves; a diff that crosses a
   boundary without saying so is the usual cause of a missed reviewer.

### 4.2 A change that crosses components

Add the owner of **each** touched component; a review from one area does not
cover another. The common combinations:

| Change                                            | Reviewers expected                                       |
| ------------------------------------------------- | -------------------------------------------------------- |
| Contract ABI/event change + regenerated clients   | contracts owner **and** SDK/bindings owner               |
| Circuit or fixture change + contract test updates | circuits owner **and** contracts owner                   |
| Commitment or signature change in the issuer path | issuer owner **and** circuits owner                      |
| New API route consumed by the app                 | issuer owner **and** frontend owner                      |
| New contract event consumed by the indexer        | contracts owner **and** indexer owner                    |
| Shared tooling / CI / release scripts             | the owner of every component the tooling builds or ships |

These reviewers are additive. Because every rule currently resolves to the same
two maintainers, a cross-component PR is not visibly different in GitHub's
reviewer list today — the rule still matters when ownership is split, and it
determines what must be re-checked, not just who is pinged.

### 4.3 Sensitive changes

These are the changes where a missing review is a security or release risk. The
"additional process" column names what the release runbook requires; none of it
is enforced by `CODEOWNERS` or CI.

| Change type                                 | Paths                                                                                                                      | Reviewers                                                                               | Additional process                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Contract logic, storage, or deployment      | `contracts/`, `scripts/deploy.sh`, `scripts/deploy-mainnet.sh`, `deployment/`                                              | contracts owner; circuits owner if verification changes                                 | Release runbook treats a contract deploy as a two-person action with an Independent Approver (documented procedure, not automation). |
| Circuit constraints or verification keys    | `circuits/`, `fixtures/`                                                                                                   | circuits owner; contracts owner for a VK/version change                                 | Required preflight: `scripts/verify-vks.sh check` and regenerated vectors; release approval per runbook.                             |
| Authentication or authorization             | `frontend/middleware.ts`, `frontend/app/api/admin/`, `frontend/lib/admin-page-auth.ts`, `services/indexer/src/auth.ts`     | issuer or frontend owner (app) / indexer owner (service)                                | No extra approval mechanism exists; the reviewer must check the authz decision directly.                                             |
| Issuer verification and credential handling | `frontend/packages/issuer/`, `frontend/app/api/issue/`, `frontend/lib/issuer-signer.ts`, `frontend/lib/persona-webhook.ts` | issuer owner; circuits owner if the signed digest changes                               | `SECURITY.md` reporting path for vulnerabilities; `prehash: false` and redaction checks in the PR template.                          |
| SDK signing or transaction behaviour        | `frontend/packages/sdk/src/`, `sdk/src/`, `frontend/packages/cli/src/`                                                     | SDK owner; contracts owner if the ABI or argument encoding changes                      | Version/migration note for breaking changes; release runbook package-release approvals.                                              |
| Production configuration and infrastructure | `.github/workflows/`, `Makefile`, `deny.toml`, `docker-compose.yml`, `.env.example`, `.env.mainnet.example`                | maintainers (CI/release paths in `CODEOWNERS`); component owner whose build is affected | A workflow change runs with repository credentials and is treated like a signing-path diff.                                          |

### 4.4 When the listed owner is unavailable

- Comment on the PR and mention both owners (`@nonchalanttee22-lgtm`,
  `@Psalmuel01`). There is no separate team or on-call rotation to escalate to.
- Do **not** self-approve a sensitive change because the owner is silent. If the
  change is blocking a release, raise it in the release issue so the Release
  Manager records the delay or reassignment.
- For a security vulnerability, do not wait on a review thread: follow
  [`SECURITY.md`](../SECURITY.md) (private advisory or email), not a public PR.
- If an owner is unavailable long term, the correct fix is to change
  `CODEOWNERS` in the same PR as this matrix, not to rely on informal review.

## 5. CI checks expected before review

The full command map lives in
[`docs/CONTRIBUTOR_CHECKLIST.md`](CONTRIBUTOR_CHECKLIST.md) § 7. The table below
lists only what a PR triggers, so contributors know which checks a reviewer will
expect to be green. Jobs listed as conditional are not gates on fork PRs.

| Workflow                 | Job (display name)                                     | Trigger                           | Covers                                          |
| ------------------------ | ------------------------------------------------------ | --------------------------------- | ----------------------------------------------- |
| `ci.yml`                 | Dependency review                                      | PR                                | advisories/licenses on changed packages         |
| `ci.yml`                 | Lint commit messages                                   | PR                                | Conventional Commits                            |
| `ci.yml`                 | Contract API reference drift check                     | PR                                | `docs/PROOF_REGISTRY_API.md` vs contract source |
| `ci.yml`                 | Process artifact check                                 | PR                                | no newly added process documents                |
| `ci.yml`                 | Contract tests & build                                 | PR                                | `cargo test --locked`, pinned WASM build        |
| `ci.yml`                 | Circuit compile                                        | PR                                | pinned `nargo`/`bb`, VK and test-vector checks  |
| `ci.yml`                 | Property-based circuit fuzzing                         | PR                                | compiled circuits under fuzzing                 |
| `ci.yml`                 | Frontend typecheck & build                             | PR                                | vitest, coverage, `tsc --noEmit`, barrel tests  |
| `ci.yml`                 | Windows smoke (frontend)                               | PR                                | install, lint, typecheck, unit tests on Windows |
| `ci.yml`                 | Indexer tests (SQLite + Postgres)                      | PR                                | build + jest against both databases             |
| `ci.yml`                 | SDK integration tests (testnet)                        | PR, conditional on repo variables | SDK integration suite                           |
| `ci.yml`                 | Accessibility (axe-core)                               | PR                                | Playwright + axe against the built app          |
| `ci.yml`                 | Coverage gate                                          | PR                                | merged frontend + indexer coverage thresholds   |
| `contracts-ci.yml`       | Soroban contract build & test                          | PR                                | independent contract build/test job             |
| `lint.yml`               | Frontend ESLint, Indexer ESLint, Page-client size cap  | PR                                | per-workspace lint and page-shell caps          |     | `env-check.yml` | `env-check` | PR  | env example/template consistency |
| `dependency-review.yml`  | Dependency review (advisories & licenses)              | PR                                | dependency policy                               |
| `first-load.yml`         | Lighthouse budgets + proving-asset critical-path check | PR on `frontend/**`               | first-load budget                               |
| `proving-perf.yml`       | Proving performance regression gate                    | PR on `circuits/**`, perf paths   | proving performance                             |
| `reproducible-build.yml` | Build twice (container), compare hashes                | PR on contract/toolchain paths    | reproducible WASM hashes                        |
| `preview-deployment.yml` | Preview deployment                                     | PR on `frontend/**`               | preview URL (not a merge gate)                  |

Not gates: `e2e.yml` (scheduled/manual), `nightly.yml`, `stale.yml`, and
`release.yml` (tag push only). The new **Component ownership check** job runs
the matrix/CODEOWNERS consistency script on every PR and push to `main`.

## 6. Unresolved ownership gaps

These are real gaps, not things this document can paper over:

1. **One pair of owners for every component.** No component has a distinct
   named owner, and no GitHub team exists. Until maintainers split ownership,
   every rule resolves to the same two people and "component owner" means
   "whichever maintainer reviews this area".
2. **Branch protection is not in the repository.** Whether a code-owner review
   is required before merge cannot be verified from a clone. A maintainer must
   confirm the `main` branch rule under **Settings → Branches**. Until then,
   every approval statement here is an expectation, not a guarantee.
3. **`CODEOWNERS` cannot express "two approvals" or "one of N owners".** Adding
   approval counts requires branch protection or a ruleset, not this file.
4. **The root `sdk/` package has no decided owner or future.** `ROADMAP.md`
   § 4.3 schedules a decision to merge or delete it. It is now explicitly routed
   so a change cannot land unrequested in the meantime.
5. **Per-workflow CI ownership is not assigned.** `ROADMAP.md` tracks this as
   #621. This document names the maintainers for `.github/workflows/` but not an
   owner for each workflow.
6. **`frontend/packages/cli/` was previously unrouted** (covered only by the
   baseline `/*` rule). It is now explicit under SDK and client bindings.

## 7. Keeping this file accurate

Change the matrix and `.github/CODEOWNERS` in the **same** PR. Then run:

```bash
node .github/scripts/check-component-ownership.mjs
node --test test/component-ownership.test.js
```

The check fails if the six component rows are missing, a scope path no longer
exists, a listed `CODEOWNERS` rule was removed or renamed, an owner handle is not
in `CODEOWNERS`, or a `CODEOWNERS` pattern matches no tracked file. It cannot
verify GitHub branch protection — that remains a manual check in §6.

`docs/RELEASE_RUNBOOK.md` (issue #992) uses the same maintainers for its
**Component Owner** role and the same component split at a coarser level
(`contracts/`, `circuits/`, `frontend/`, `services/indexer/`, SDK, CI). This
document refines it by separating the issuer surfaces from the rest of the
frontend; that is a finer scope, not a different owner. Release approvals
(two-person execution, Independent Approver) are defined there and are not
duplicated here.

# Release Manager Runbook

StellarCred ships several independently versioned artifacts: four Soroban
contracts, the Noir circuits and their verification keys, the Next.js app, the
indexer, and the npm packages. A release is complete only when every artifact in
scope is deployed, published, recorded and verified against the same commit.

This runbook defines **who** owns each step, **what evidence** must exist before
an irreversible action, and **how to recover** when a step fails. It does not
repeat component procedures — the authoritative documents are:

| Topic                                     | Authoritative document                                    |
| ----------------------------------------- | --------------------------------------------------------- |
| Deploying and upgrading contracts         | [MIGRATION_RUNBOOK.md](../MIGRATION_RUNBOOK.md)           |
| Reproducible builds and hash verification | [docs/REPRODUCIBLE_BUILDS.md](REPRODUCIBLE_BUILDS.md)     |
| Per-component validation commands         | [docs/CONTRIBUTOR_CHECKLIST.md](CONTRIBUTOR_CHECKLIST.md) |
| Version compatibility                     | [VERSION_COMPATIBILITY.md](../VERSION_COMPATIBILITY.md)   |
| Support windows and deprecation           | [SUPPORT_POLICY.md](../SUPPORT_POLICY.md)                 |
| Deployment registry                       | [DEPLOYMENTS.md](../DEPLOYMENTS.md)                       |
| Review routing and invariants             | [CONTRIBUTING.md](../CONTRIBUTING.md#review-routing)      |
| Security reports                          | [SECURITY.md](../SECURITY.md)                             |

> **Policy versus automation.** The two-person approval in §5 is a documented
> policy, not an enforced GitHub setting. `.github/workflows/release.yml` has no
> `environment` protection or required reviewer, and `CODEOWNERS` only _requests_
> a review — see [CONTRIBUTING.md § Review routing](../CONTRIBUTING.md#review-routing).
> Any account with write access that pushes a `v*` tag publishes to npm. The
> approval therefore has to be recorded in the release issue, and the person who
> executes an action must not be the only person who approves it.

---

## 1. What a release covers

| Artifact                                                                             | Version source                                                                    | How it ships                                                                         | Verify with                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| Contracts (`issuer_registry`, `credential_verifier`, `proof_registry`, `gated_pool`) | `CONTRACT_VERSION` in each `contracts/*/src/lib.rs` and `contracts/*/Cargo.toml`  | `scripts/deploy.sh` (testnet) or `scripts/deploy-mainnet.sh` (mainnet)               | `make verify-deployment`                      |
| Circuits and VKs                                                                     | `circuits/circuit-versions.json`; VK versions on-chain                            | `circuits/scripts/build.sh`, then `set_vk` during deployment                         | `scripts/verify-vks.sh check`                 |
| Frontend app                                                                         | `NEXT_PUBLIC_APP_VERSION`; `frontend/package.json`                                | Hosting provider (Vercel; this repo only has PR previews, not a production workflow) | `GET /api/health`, `GET /api/ready`           |
| `@stellarcred/sdk`                                                                   | `frontend/packages/sdk/package.json`                                              | `release.yml` on a `v*` tag                                                          | `npm view @stellarcred/sdk@<version> version` |
| `@stellarcred/issuer`                                                                | `frontend/packages/issuer/package.json`                                           | **Not automated** — see §10                                                          | package test + registry check                 |
| Indexer                                                                              | `INDEXER_VERSION`; `services/indexer/package.json`                                | Deployed by the operator alongside the app                                           | `GET /health`                                 |
| Records                                                                              | `DEPLOYMENTS.md`, `VERSION_COMPATIBILITY.md`, `SUPPORT_POLICY.md`, `CHANGELOG.md` | PR (except `CHANGELOG.md`, written by `release.yml`)                                 | §8                                            |

A release that changes a contract or a circuit must ship the matching app, SDK
and documentation versions. A package-only release must state which deployed
contract versions it supports.

---

## 2. Roles and responsibilities

Roles are assigned per release and named in the release issue. The maintainers
listed in [`.github/CODEOWNERS`](../.github/CODEOWNERS) fill them. Per-component
scope, owners and change-review paths are in
[`COMPONENT_OWNERSHIP.md`](COMPONENT_OWNERSHIP.md); the **Component Owner** role
below uses that split.

| Role                     | Owns                                                                                                                                | Final say                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Release Manager**      | Release scope, version numbers, the release issue, sequencing, go/no-go, records and announcement                                   | Release scope and whether the release proceeds |
| **Release Operator**     | Executes deployments, registers VKs, changes production configuration, rolls forward or back                                        | How a command is executed, once approved       |
| **Independent Approver** | Reviews the evidence bundle and approves irreversible actions; must not be the Release Operator for that action                     | Can block any §5 action                        |
| **Component Owner**      | Correctness of their area (`contracts/`, `circuits/`, `frontend/`, `services/indexer/`, SDK, CI) and the invariant it must preserve | Changes in their area                          |
| **Verification Owner**   | Runs post-deploy and post-publish checks and signs the verification record                                                          | Whether verification passed                    |

There is no separate QA team. The Release Manager assigns the Verification
Owner; on a small release the Release Manager may verify, but the Verification
Owner for a contract or mainnet deployment must be independent of the Release
Operator.

### Who does what

| Task                                       | Performs                       | Reviews                          | Approves                                |
| ------------------------------------------ | ------------------------------ | -------------------------------- | --------------------------------------- |
| Release plan, version bump, release issue  | Release Manager                | Component Owners                 | Release Manager                         |
| Release commit / PR                        | Contributor or Component Owner | CODEOWNERS for each touched area | Component Owner                         |
| Preflight evidence (§4)                    | Release Operator               | Release Manager                  | Independent Approver                    |
| Testnet contract deployment                | Release Operator               | Verification Owner               | Independent Approver                    |
| Mainnet contract deployment                | Release Operator               | Verification Owner               | Independent Approver + written go/no-go |
| Production configuration or secret change  | Release Operator               | Component Owner                  | Independent Approver                    |
| Tag push / npm publication                 | Release Manager                | Independent Approver             | Independent Approver                    |
| `DEPLOYMENTS.md` and compatibility records | Release Manager                | Independent Approver             | Release Manager                         |
| Post-release verification (§8)             | Verification Owner             | Release Manager                  | Independent Approver                    |

The Release Manager may hold any role except the Independent Approver for their
own execution.

---

## 3. Release classes

| Class                              | Examples                                        | Required approvals                                                                      |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Documentation / app-only patch** | Copy, UI, docs, non-sensitive frontend fix      | One Component Owner review; Release Manager sign-off                                    |
| **Package release**                | `@stellarcred/sdk` version bump                 | One Component Owner review + Independent Approver for the tag push                      |
| **Contract / circuit release**     | Contract change, VK change, new credential type | Component Owner (contracts/circuits) + Independent Approver; two-person execution       |
| **Mainnet release**                | Any first-time or upgraded mainnet deployment   | All of the above, plus a written go/no-go naming the commit, hashes and approver        |
| **Emergency fix**                  | Security or availability incident               | Release Manager + one maintainer; retroactive record and review within one business day |

---

## 4. Preflight checks

All checks run against the **exact commit to be released**, not a branch tip that
may move. Record the commit SHA in the release issue and attach the evidence in
§5. Any failed check blocks the release unless the Release Manager and
Independent Approver record a written waiver with a follow-up issue.

### 4.1 Repository and release commit

```bash
git fetch upstream --tags
git status --porcelain          # must print nothing
git rev-parse HEAD              # this SHA goes in every record
git log -1 --format='%H %s'
```

- [ ] The commit is on `main` in `ToluLabs/StellarCred`, not a fork branch.
- [ ] The tree is clean; no uncommitted version bumps, generated bindings or
      circuit artifacts.
- [ ] The release issue names the version, the networks in scope and every role
      from §2.

### 4.2 Toolchain

```bash
make doctor
```

Must report Rust `1.93.1`, `wasm32v1-none`, `nargo 1.0.0-beta.9`,
`bb 0.87.0`, Node 20 and pnpm 9. A mismatch produces different WASM/VKs and
invalidates every hash comparison later. See
[docs/REPRODUCIBLE_BUILDS.md](REPRODUCIBLE_BUILDS.md#toolchain-pins).

### 4.3 Tests and CI status

Local mirror of the gates:

```bash
make build
make test
make lint
make test-sdk
```

For a component-specific release, run the matching table in
[docs/CONTRIBUTOR_CHECKLIST.md](CONTRIBUTOR_CHECKLIST.md) instead of `make all`.
The SDK integration suite inside `make test-sdk` skips itself when
`SC_TEST_WALLET` / `STELLARCRED_REGISTRY_ID` are unset; a package release must
run it with testnet credentials before the tag is approved.

Confirm these workflows are green on the release SHA (open the run and copy its
URL into the release issue):

| Workflow                        | File                                       | Why it gates a release                                |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| CI                              | `.github/workflows/ci.yml`                 | Contracts, circuits, frontend, indexer, SDK, coverage |
| Contracts CI                    | `.github/workflows/contracts-ci.yml`       | Dedicated contract build/test gate                    |
| Lint                            | `.github/workflows/lint.yml`               | ESLint for every TypeScript workspace                 |
| Environment Variable Check      | `.github/workflows/env-check.yml`          | `.env.example` stays in sync with code                |
| Reproducible Build              | `.github/workflows/reproducible-build.yml` | Publishes `wasm-hashes-<sha>` for the commit          |
| First-load budget               | `.github/workflows/first-load.yml`         | Frontend bundle regression (frontend changes)         |
| Nightly Deployment Verification | `.github/workflows/nightly.yml`            | Baseline testnet deployment has not drifted           |

`StellarCred E2E` (`.github/workflows/e2e.yml`) is scheduled/manual, not a PR
gate; run it explicitly for a contract release (§4.4). A red or missing run on
the release SHA blocks publication.

### 4.4 Contracts, circuits and bindings

```bash
cargo test --locked
cargo build --release --target wasm32v1-none --locked
cargo clippy --workspace --all-targets -- -D warnings

bash ./circuits/scripts/build.sh
node circuits/scripts/testvectors.js check
bash scripts/verify-vks.sh check
node circuits/scripts/stamp-circuit-version.js check-all

./scripts/gen-bindings.sh
./scripts/verify-client-freshness.sh

make check-api-reference
node .github/scripts/check-process-docs.mjs
bash scripts/check-page-client-size.sh
```

- [ ] `target/wasm32v1-none/release/*.wasm` exists for all four contracts.
- [ ] The `wasm-hashes-<sha>` artifact from Reproducible Build is downloaded and
      its four hashes match a local reproducible rebuild
      ([docs/REPRODUCIBLE_BUILDS.md](REPRODUCIBLE_BUILDS.md)).
- [ ] Generated contract clients are committed and fresh.
- [ ] A contract or circuit change includes regenerated `fixtures/` and test
      vectors in the same commit ([CONTRIBUTING.md § Development workflow](../CONTRIBUTING.md#development-workflow)).

### 4.5 Deployment configuration

The deploy scripts must match the contracts they deploy. Check the constructor
signatures before scheduling a deployment:

```bash
grep -n -A 6 "pub fn __constructor" contracts/*/src/lib.rs
grep -n "WASM_DIR\|deploy()" scripts/deploy.sh scripts/deploy-mainnet.sh
```

- [ ] Every constructor argument is supplied by the script (for example
      `proof_registry` requires `--admin`, `--verifier`, `--issuer_registry`, and
      `gated_pool` requires `--registry`, `--required_type`, `--min_threshold`,
      `--token`).
- [ ] The script's `WASM_DIR` matches where the pinned build writes artifacts
      (`target/wasm32v1-none/release`).
- [ ] `scripts/deploy-mainnet.sh` targets the intended RPC URL and network
      passphrase; `RPC_URL`, `NETWORK_PASSPHRASE`, `SOURCE` and
      `ISSUER_PRIVATE_KEY` are set in the operator's environment, never in a
      committed file.
- [ ] `scripts/validate-deploy-env.sh --target=contracts` passes for the
      deployment environment and `--target=production` passes for the app
      environment.
- [ ] `node frontend/scripts/check-env-sync.mjs` passes (the `env-check` job).
- [ ] No secret, private key, token or connection string appears in
      `git status`, the diff, or the release issue.

Run a contract deployment against testnet before mainnet (§6, stage 5). There is
no `--dry-run`/no-submit mode in the deploy scripts as of this runbook; the
testnet rehearsal **is** the dry run.

### 4.6 Version and dependency alignment

```bash
node -p "require('./frontend/packages/sdk/package.json').version"
node -p "require('./frontend/packages/issuer/package.json').version"
grep -H "CONTRACT_VERSION: u32" contracts/*/src/lib.rs
grep -H '^version = ' contracts/*/Cargo.toml
node -p "require('./circuits/circuit-versions.json')"
```

- [ ] The tag to be pushed equals `frontend/packages/sdk/package.json` exactly
      (`release.yml` fails otherwise).
- [ ] `Cargo.toml` version and `CONTRACT_VERSION` agree for every contract, and
      both agree with the version recorded in `DEPLOYMENTS.md` and
      `VERSION_COMPATIBILITY.md`.
- [ ] `frontend/packages/issuer/package.json` is bumped if the issuer package
      changed.
- [ ] `circuits/circuit-versions.json` matches the staged circuit artifacts and
      the VK versions about to be registered.
- [ ] No dependency bump lands in the release commit unless it is part of the
      reviewed change; `Cargo.lock` and `pnpm-lock.yaml` are committed with it.

### 4.7 Documentation updates

- [ ] `docs/EVENTS.md`, `docs/contract-error-codes.md` and
      `docs/PROOF_REGISTRY_API.md` match the contract source (`make check-api-reference`).
- [ ] `VERSION_COMPATIBILITY.md` lists the released versions and the
      `App ↔ SDK ↔ Contracts` combination.
- [ ] `SUPPORT_POLICY.md` is updated if a support window, VK version or
      deprecation phase changed.
- [ ] `DEPLOYMENTS.md` has a section ready for the new deployment (contract IDs,
      source commit, hashes, date) — do not pre-fill unverified values.
- [ ] `CHANGELOG.md` will be regenerated by `release.yml`; do not hand-edit it in
      the release commit. Its current file also contains legacy content, so read
      the generated section rather than assuming the whole file is conventional.
- [ ] Upgrade notes for integrators (breaking changes, deprecations, minimum SDK)
      are drafted for the GitHub Release body.

### 4.8 Network, baseline and blockers

```bash
stellar keys address "$SOURCE"
curl -fsS https://<deployment-host>/api/ready
curl -fsS https://<deployment-host>/api/health
curl -fsS https://<indexer-host>/health
```

- [ ] The deployer account exists, is funded and is the intended admin; its
      address matches `NEXT_PUBLIC_ISSUER_ADDRESS` where applicable.
- [ ] The current deployment's contract IDs and versions are recorded, so a
      rollback target exists (§7).
- [ ] The last Nightly Deployment Verification run is green; a red baseline must
      be explained before adding a new deployment on top of it.
- [ ] The milestone has no open `security` or `bug` issue that the
      [ROADMAP.md § 3](../ROADMAP.md) exit criteria require to be closed.
- [ ] The security review gate for a mainnet release is satisfied
      ([ROADMAP.md § 3](../ROADMAP.md)).
- [ ] A change freeze is announced for the deployment window; no unrelated PR is
      merging into `main` during it.

---

## 5. Two-person review and approval

The following actions require an approval recorded by someone other than the
person who executes them.

| Action                                            | Executes         | Independent approval evidence                                                                                                           | Block if                                                                              |
| ------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Deploy or upgrade a contract (testnet or mainnet) | Release Operator | Commit SHA, green CI runs, `wasm-hashes-<sha>` artifact, constructor/wiring review, testnet rehearsal log for mainnet                   | Any hash, commit or constructor argument differs from the approved bundle             |
| Register, deprecate or prune a VK                 | Release Operator | Circuit version, VK hash, `scripts/verify-vks.sh check` output, target credential types                                                 | VK hash differs from the artifact or a prune is inside the 90-day delay               |
| Change production configuration or secrets        | Release Operator | Env-var diff with secret values redacted, `scripts/validate-deploy-env.sh --target=production` output                                   | A secret would be exposed, or a `NEXT_PUBLIC_` prefix is added to a server-only value |
| Publish a package (push a `v*` tag)               | Release Manager  | Tag equals package version, CI green on the tag commit, `npm view` shows the version does not already exist, SDK integration tests pass | Version already published, or the tag is not on the approved commit                   |
| Delete or move a tag / GitHub Release             | Release Manager  | Proof that no package or release was published from it                                                                                  | A published version depends on it                                                     |
| Record a deployment in `DEPLOYMENTS.md`           | Release Manager  | Manifest, verification output, source commit                                                                                            | Verification has not passed                                                           |

### Evidence bundle

The Release Operator hands the Independent Approver one bundle (linked from the
release issue):

1. Release commit SHA and the PR that produced it.
2. URLs of the green CI, Contracts CI, Lint, Environment Variable Check and
   Reproducible Build runs for that SHA.
3. `wasm-hashes-<sha>` artifact contents.
4. `make verify-deployment NETWORK=<network>` output from the testnet rehearsal.
5. The deployment manifest produced by the script
   (`deployment-manifests/deployment-<timestamp>.json`, gitignored — attach it to
   the release issue).
6. Version table: SDK, issuer package, each contract (`Cargo.toml` and
   `CONTRACT_VERSION`), circuit/VK versions, and the `DEPLOYMENTS.md` row that
   will be written.
7. Environment-variable diff for the app and indexer, with values redacted.

### Approval record

Record approval as a comment in the release issue:

```text
Approved by @<approver> for commit <sha>, version <vX.Y.Z>.
Scope: <testnet deploy | mainnet deploy | npm publish | config change>.
Evidence reviewed: <links to CI runs, artifact, verification output, env diff>.
Conditions: <none | list>.
```

Do not approve from a direct message, a reaction, or an earlier commit. If the
commit changes, approval is void and the bundle must be re-reviewed.

### When to block

Block the release if any of the following is true:

- CI is red, has not run on the release SHA, or a required workflow was skipped.
- The local reproducible rebuild does not match the recorded hashes or the
  `wasm-hashes-<sha>` artifact.
- The tag does not equal the SDK version, or the version already exists on npm.
- The deploy scripts do not match the current contract constructors.
- A required secret is missing, or a secret would be printed, committed or
  exposed to the client.
- The executor and approver are the same person for a §5 action.
- A security or correctness blocker in the milestone is open, or the mainnet
  security-review gate is unmet.
- The rollback target (previous IDs, versions and hashes) is unknown.

---

## 6. Release execution and handoffs

The order below is deliberate: **for a contract-bearing release the tag is
pushed last**, because `release.yml` publishes to npm immediately and a published
version cannot be taken back. This differs from the order in
[ROADMAP.md § 5](../ROADMAP.md), which lists "Tag and publish" before
"Deploy and verify"; tag-first is acceptable only for an SDK-only release with no
contract, circuit or app change.

| Stage                               | Owner                         | Output / handoff                                                |
| ----------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| 1. Open the release issue           | Release Manager               | Scope, version, roles, networks, target dates                   |
| 2. Cut the release commit           | Component Owner + contributor | Focused PR with version bumps, bindings, docs; merged to `main` |
| 3. Freeze and preflight             | Release Operator              | §4 evidence bundle handed to the approver                       |
| 4. Approval checkpoint              | Independent Approver          | Written approval in the release issue                           |
| 5. Testnet rehearsal / deployment   | Release Operator              | Manifest, IDs, hashes, verification log                         |
| 6. Mainnet deployment (if in scope) | Release Operator              | Manifest, go/no-go record, verification log                     |
| 7. Record the deployment            | Release Manager               | `DEPLOYMENTS.md` PR, reviewed and merged                        |
| 8. Tag and publish                  | Release Manager               | Green `Release` run, npm version, GitHub Release                |
| 9. Roll out app and indexer         | Release Operator              | Health/readiness output, version shown in `/api/ready`          |
| 10. Close out                       | Release Manager               | Completed checklist, release notes, milestone moved             |

### Stage details

**1 — Plan.** Create one release issue using the checklist in
[ROADMAP.md § 5](../ROADMAP.md). Name the five roles, the exact target networks
and what is explicitly out of scope.

**2 — Prepare.** Include in one PR: SDK and issuer version bumps, contract
`Cargo.toml`/`CONTRACT_VERSION` bumps, regenerated bindings and circuit artifacts,
and documentation updates. Do not mix unrelated changes in. Get Component Owner
approval for every area the diff touches
([CONTRIBUTING.md § Review routing](../CONTRIBUTING.md#review-routing)).

**3 — Freeze and verify.** Run §4 on the merge commit. Announce the freeze before
starting; if `main` moves, restart from the new commit.

**4 — Approve.** The Independent Approver reviews the evidence bundle against
§5 and records approval. The Release Operator does not proceed on verbal approval.

**5 — Testnet.** From the approved commit:

```bash
SOURCE=deployer ./scripts/deploy.sh
make verify-deployment NETWORK=testnet
./scripts/verify-wasm.sh --network testnet
./scripts/e2e-testnet.sh
```

`deploy.sh` writes `deployment-manifests/deployment-<timestamp>.json` and prints
the env vars for the app. Do not copy those values anywhere until
`verify-deployment` passes. `scripts/e2e-testnet.sh` deploys an ephemeral stack
with its own wallet; it is a functional smoke test, not the record of this
deployment.

**6 — Mainnet.** Only with a written go/no-go naming the commit and hashes. Run
`ISSUER_PRIVATE_KEY=... SOURCE=deployer ./scripts/deploy-mainnet.sh`, then
`make verify-deployment NETWORK=mainnet` and
`./scripts/verify-wasm.sh --network mainnet`. The approver watches the run and
can stop it between stages; a failed step follows §7.

**7 — Record.** Follow [DEPLOYMENTS.md § Recording a new deployment](../DEPLOYMENTS.md#recording-a-new-deployment).
Use `source_commit` and `sha256sums` from the manifest and the hashes from the
`wasm-hashes-<sha>` artifact, not from a local build. `deployment-manifests/` is
gitignored, so attach the manifest to the release issue instead of committing it.
The record PR needs the Independent Approver's review.

**8 — Tag and publish.** Only after the deployment is verified and recorded:

```bash
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
```

The tag must be pushed to `ToluLabs/StellarCred`; a tag pushed to a fork does not
run `.github/workflows/release.yml`. The workflow verifies tag == SDK version,
regenerates `CHANGELOG.md` and commits it to `main` with `[skip ci]`, creates the
GitHub Release, builds the SDK and publishes `@stellarcred/sdk`. Watch the run
to completion and verify the npm result (§8). Publish `@stellarcred/issuer`
separately if that package changed (§10).

**9 — Roll out the app and indexer.** Update production environment variables to
the new contract IDs (from the verified deployment record, not from a shell
transcript), deploy the app build for the release commit, deploy the indexer, and
confirm `/api/health`, `/api/ready` and the indexer `/health` report the expected
version and contract versions.

**10 — Close out.** Attach the artifact, manifest and verification outputs to the
release issue and the GitHub Release. State the released versions, contract IDs,
known issues and any deferred component. Move leftovers to the next milestone
([ROADMAP.md § 5](../ROADMAP.md)).

---

## 7. Failure recovery and rollback

**Rollback** means restoring a previous, known-good state. **Forward recovery**
means completing the release or shipping a new version because the bad state
cannot be undone. Know which one applies before acting.

| Action                                                               | Reversible?                                             | Recovery path                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `stellar contract deploy` (new instance/ID)                          | **No** — the ID and state persist                       | Redeploy a complete stack from the correct commit and repoint env/records; abandon the orphan IDs |
| `upgrade(new_wasm_hash)` on `credential_verifier` / `proof_registry` | Yes, if the previous WASM is already installed on-chain | Upgrade back to the previous hash                                                                 |
| Upgrade on `issuer_registry` / `gated_pool`                          | **No upgrade entry point exists**                       | Redeploy and repoint the app and dependants                                                       |
| `set_vk`                                                             | Yes                                                     | Register the corrected VK under a new version; deprecate the bad one                              |
| `deprecate_version` / `prune_version`                                | Deprecation is reversible in effect; pruning is not     | Keep the old VK for its support window; never prune inside 90 days                                |
| npm publish                                                          | **No** in practice                                      | Deprecate the bad version; publish a new patch; do not reuse the version                          |
| Git tag / GitHub Release                                             | Before publish: yes. After publish: no                  | Delete and re-tag before publish; edit the release afterwards                                     |
| App / indexer deployment                                             | Yes                                                     | Redeploy the previous build and environment                                                       |
| Docs and records                                                     | Yes                                                     | Forward-fix PR                                                                                    |

Useful containment on `proof_registry` only (it is the only contract with these
entry points):

```bash
stellar contract invoke --id "$PROOF_REGISTRY_ID" --source "$SOURCE" --network "$NETWORK" --send yes -- pause
# ... investigate ...
stellar contract invoke --id "$PROOF_REGISTRY_ID" --source "$SOURCE" --network "$NETWORK" --send yes -- unpause
```

Contract upgrades, data migrations and VK lifecycle rules are owned by
[MIGRATION_RUNBOOK.md](../MIGRATION_RUNBOOK.md) and
[SUPPORT_POLICY.md](../SUPPORT_POLICY.md#vk-versions-and-the-pruning-rule). Follow
them rather than improvising a repair.

### 7.1 Failed contract deployment

- **Identify:** the deploy script aborts (`set -euo pipefail`) with a build,
  constructor, hash or submission error, or `verify-deployment` fails against the
  new IDs. There may be no manifest, or a manifest with only some contracts.
- **Owner:** Release Operator executes; Release Manager decides whether to stop
  the release; Independent Approver is informed.
- **Stop?** Yes. Do not start the next stage or publish anything.
- **Recovery:** a partially deployed stack cannot be deleted or rewired.
  Redeploy the **complete** stack from the same approved commit and take the new
  IDs, because the scripts are not idempotent and constructor wiring is immutable.
  Only continue manually from a partial run if every deployed ID and constructor
  argument has been verified and the remaining steps are pure additions.
- **Resume when:** a full `make verify-deployment` passes against the new
  manifest, no environment variable or record points at an abandoned ID, and the
  approver accepts the recovery evidence.
- **Record:** the failed command, transaction hash/ledger where available, orphan
  IDs, the replacement manifest, and the decision in the release issue.

### 7.2 Incorrect deployment configuration

- **Identify:** `/api/ready` returns 503 or wrong IDs, `verify-deployment` reports
  a network/version mismatch, transactions land on the wrong network, or the
  constructor was given the wrong admin/issuer/RPC. A Soroban contract instance
  is immutable apart from an `upgrade` entry point, so a wrong constructor cannot
  be edited.
- **Owner:** Release Operator for the fix; Component Owner confirms the correct
  configuration; Independent Approver approves the corrected deployment.
- **Stop?** Yes. If proofs are being accepted under a wrong trust configuration,
  `pause` `proof_registry` (the only contract that supports it) as containment.
- **Recovery:** for app-only misconfiguration, correct the environment and
  redeploy the app. For a wrong contract ID or constructor argument, redeploy the
  affected contract and every contract that references it (`issuer_registry` and
  `credential_verifier` before `proof_registry`, then `gated_pool`), then repoint
  the app and records. No `set_admin` entry point exists in the current
  contracts (`grep -rn "fn set_admin" contracts/`), so a wrong admin means
  redeploy.
- **Resume when:** `/api/ready`, `/api/capabilities` and `verify-deployment` agree
  with the corrected record, and the old IDs are removed from configuration.
- **Record:** what was wrong, which IDs were abandoned, who approved the
  replacement, and whether any proof was accepted under the wrong configuration
  (if so, escalate under [SECURITY.md](../SECURITY.md)).

### 7.3 Failed package publication

- **Identify:** the `Release` run fails at "Publish to npm", or
  `npm view @stellarcred/sdk@<version> version` returns nothing/404 after the run.
  Remember that `release.yml` creates the GitHub Release and commits `CHANGELOG.md`
  **before** publishing, so the repository may show a successful-looking release
  while npm is empty.
- **Owner:** Release Manager; Independent Approver confirms the retry or new
  version.
- **Stop?** Yes. Do not announce completion or point integrators at the version.
- **Recovery:** if the version is not on npm, fix the cause (`NPM_TOKEN`,
  authentication, build) and re-run the failed job. If the version was published
  with bad content, do **not** reuse or move the tag: deprecate it with
  `npm deprecate @stellarcred/sdk@<version> "<reason>"`, bump the patch, and cut
  a new release. Edit the GitHub Release body to state the publication status.
- **Resume when:** the expected version resolves from the registry, a fresh
  `npm install @stellarcred/sdk@<version>` succeeds, and the release notes match
  what is published.
- **Record:** the failed run URL, npm state, retry/new version, and the exact
  commands used.

### 7.4 Version mismatches

- **Identify:** `release.yml` stops at "Verify package version"; `/api/ready`
  disagrees with `DEPLOYMENTS.md`; `Cargo.toml` disagrees with `CONTRACT_VERSION`
  or the on-chain `version()`; `VERSION_COMPATIBILITY.md` lists different
  versions.
- **Owner:** Release Manager owns the decision; Component Owner confirms which
  version is correct.
- **Stop?** Yes. A mismatch means at least one artifact is not the one that was
  reviewed.
- **Recovery:** if the tag was not pushed, fix the commit and re-run preflight. If
  the tag was pushed but nothing was published, delete the tag and re-tag the
  corrected commit. If a package or release already exists, never move the tag:
  publish the next patch and deprecate the wrong version. For contract/document
  drift, fix forward: redeploy if the contract is wrong, or correct the docs in a
  reviewed PR if the record is wrong.
- **Resume when:** all version locations in §4.6 agree on the release commit and
  `verify-deployment` passes.
- **Record:** the conflicting values, which one was authoritative, and the
  corrective commit/tag.

### 7.5 Incomplete documentation updates

- **Identify:** a §4.7 item is unticked, `DEPLOYMENTS.md` lacks a source commit or
  hash, compatibility/support docs omit the release, or the GitHub Release body
  lacks upgrade notes.
- **Owner:** Release Manager.
- **Stop?** The release is **not complete**, and it must not be announced as
  complete. Do not roll back working code for a documentation gap.
- **Recovery:** open a focused docs PR from the deployment manifest and artifact
  hashes; edit the GitHub Release body if it is already public; link the PR from
  the release issue. If the docs contain a security-sensitive error, treat it as
  an incident and correct it before wider announcement.
- **Resume when:** the docs PR is merged, every link resolves, and the approver
  confirms the record matches the deployed artifacts.
- **Record:** the missing item, PR link, and merge commit.

### 7.6 Partial release across components

- **Identify:** the release matrix (§1) has a component on the old version, for
  example contracts deployed but the app still points at the old IDs, or the SDK
  published but the app not deployed, or testnet complete but mainnet missing.
- **Owner:** Release Manager.
- **Stop?** Yes — the release is partial. Decide explicitly between completing
  forward and rolling the app back; do not leave the state unstated.
- **Recovery:** complete in dependency order: `issuer_registry` →
  `credential_verifier` → `proof_registry` → `gated_pool` → VKs → app environment
  → app/indexer build → SDK/docs. If the new app cannot run against the deployed
  contracts, redeploy the previous app build (reversible) rather than attempting
  to un-deploy contracts. Publish the component/version matrix in the release
  notes, marking anything deferred.
- **Resume when:** every component in scope is verified at the intended version,
  or the deferral is recorded with a support statement.
- **Record:** the matrix, the decision, and the follow-up issues for deferred
  work.

### 7.7 Failed post-release verification

- **Identify:** `make verify-deployment` fails, `verify-wasm.sh` finds a hash
  mismatch, the Nightly Deployment Verification run goes red, `/api/ready` shows
  unexpected versions, or `/api/capabilities` disagrees with the manifest.
- **Owner:** Verification Owner runs the check; Release Manager owns the
  response; suspected tampering goes to the security process in
  [SECURITY.md](../SECURITY.md) through a private report.
- **Stop?** Yes. Freeze further deployments and announcements until the cause is
  known. A bytecode or version mismatch is not a documentation bug until proven
  otherwise.
- **Recovery:** distinguish three cases. (a) The record is wrong: correct
  `DEPLOYMENTS.md` in a reviewed PR with the verification output as evidence.
  (b) The wrong build was deployed: redeploy from the verified commit, using
  `upgrade` where available. (c) On-chain state does not match any reviewed
  build: do not edit the record to match it; escalate, keep `proof_registry`
  paused if appropriate, and prepare a forward fix. Never "fix" verification by
  updating the expected hash without an explanation.
- **Resume when:** verification passes against the recorded source commit and
  hashes, and the approver signs the new evidence.
- **Record:** full command output, hashes before/after, timeline, who was
  notified, and the resolution.

### 7.8 Circuit or VK mismatch after release

- **Identify:** `bash scripts/verify-vks.sh check` reports drift, proofs that
  should verify fail, or the on-chain VK version is behind the released circuit.
- **Owner:** Component Owner (circuits) diagnoses; Release Operator performs the
  on-chain change; Independent Approver approves.
- **Stop?** Yes for new proof submissions against the affected credential type.
- **Recovery:** register the corrected VK with `set_vk` under a **new** version,
  deprecate the bad version with `deprecate_version`, and leave it available for
  at least the 90-day safety delay before any `prune_version`. Credentials issued
  against a broken circuit follow the re-issue rules in
  [SUPPORT_POLICY.md](../SUPPORT_POLICY.md).
- **Resume when:** fresh proofs verify on-chain against the new VK version and
  `scripts/verify-deployment.sh` passes its VK checks.
- **Record:** circuit version, VK hashes, on-chain versions, affected credential
  types, and the re-issue decision.

---

## 8. Post-release verification

The Verification Owner completes this against the published artifacts, not local
builds, and the Independent Approver signs the result.

**Contracts**

- [ ] `make verify-deployment NETWORK=<network>` passes end to end (IDs,
      on-chain versions, reproducible WASM hashes, VKs).
- [ ] `./scripts/verify-wasm.sh --network <network>` passes.
- [ ] `./scripts/e2e-testnet.sh` passes against the released testnet stack.
- [ ] `node scripts/verify-capabilities.mjs --url https://<host> --manifest deployment-manifests/deployment-<timestamp>.json`
      reports no network, ID or version mismatch.
- [ ] `DEPLOYMENTS.md` matches the live IDs, versions and hashes, including the
      source commit.

**Packages**

- [ ] `npm view @stellarcred/sdk@<version> version` prints the version.
- [ ] `npm view @stellarcred/sdk dist-tags` shows the intended tag.
- [ ] A fresh `npm install @stellarcred/sdk@<version>` in a clean directory
      succeeds and its types resolve.
- [ ] `@stellarcred/issuer` is published if it changed, or the release notes say
      it was intentionally not published.

**App and indexer**

- [ ] `GET /api/health` returns 200 with the release version.
- [ ] `GET /api/ready` is ready and reports the expected contract versions.
- [ ] `GET /health` on the indexer reports `ready: true` with acceptable ledger
      lag ([docs/HEALTHCHECKS.md](HEALTHCHECKS.md)).
- [ ] The holder flow (issue → prove → submit → `is_verified`) works against the
      deployed app using the published SDK.

**Records and communication**

- [ ] `VERSION_COMPATIBILITY.md` and `SUPPORT_POLICY.md` list the released
      versions and any deprecation phase.
- [ ] The GitHub Release body contains the generated changelog section, upgrade
      notes, contract IDs and known issues.
- [ ] The release issue links CI runs, the `wasm-hashes-<sha>` artifact, the
      manifest, the verification output and the approval comment.
- [ ] The release commit's CI is green. The `release.yml` changelog commit uses
      `[skip ci]`, so it has no run of its own; inspect that diff instead.
- [ ] The milestone is closed or the remaining issues are moved with a reason.

Declare the release complete only when every box is ticked or an explicit,
approved deferral is recorded in the release issue.

---

## 9. Release record

Keep the following in the release issue (and link it from the GitHub Release):

- Version, tag, release commit SHA and date.
- Roles: Release Manager, Release Operator, Independent Approver, Verification
  Owner, Component Owners.
- Deployment manifest(s), contract IDs, on-chain versions and WASM hashes per
  network.
- CI run URLs and the `wasm-hashes-<sha>` artifact.
- `verify-deployment`, `verify-wasm`, `verify-vks` and E2E results.
- npm versions published and the registry check output.
- App/indexer versions and health-check output.
- Approval comments with the scope and evidence reviewed.
- Known gaps, deferred components and follow-up issue numbers.

Do not put secret values, private keys, tokens or connection strings in this
record.

---

## 10. Known automation gaps (as of 2026-11-23)

These are facts about the current repository, not policy. Re-check them before
each release and fix them in separate, reviewed changes rather than working
around them during a deployment.

- **No enforced approval gate.** `release.yml` has no protected `environment` or
  required reviewer; a `v*` tag push publishes. The §5 approval is manual.
- **Only the SDK is published.** `release.yml` publishes `@stellarcred/sdk`.
  `@stellarcred/issuer` has no publish step, although
  [ROADMAP.md § 3](../ROADMAP.md) expects both on npm; publish it separately with
  the same review and record it in the release issue.
- **The release is created before npm publish.** A failed publish leaves a
  GitHub Release and a `CHANGELOG.md` commit behind (§7.3).
- **Deploy scripts and constructors have drifted.** `scripts/deploy-mainnet.sh`
  does not pass `--admin` to `proof_registry`, and both deploy scripts pass only
  `--registry` to `gated_pool`, whose constructor requires
  `required_type`, `min_threshold` and `token`. `scripts/deploy.sh` also hashes
  from `target/wasm32-unknown-unknown/release` while the pinned build writes
  `target/wasm32v1-none/release`. A deployment cannot succeed until these are
  aligned — see [ROADMAP.md § 4.7](../ROADMAP.md).
- **Contract versions are inconsistent in `main`.** `Cargo.toml` reports `1.0.0`
  for all contracts while `CONTRACT_VERSION` reports `1.1.0` for
  `issuer_registry`, `proof_registry` and `gated_pool`. `verify-deployment`
  compares the on-chain version to `Cargo.toml`, so it will not catch this;
  reconcile all version locations in §4.6 before releasing.
- **No mainnet dry run.** The deploy scripts have no simulation/no-submit mode,
  despite the rehearsal expectation in [ROADMAP.md § 3](../ROADMAP.md); the
  testnet rehearsal plus constructor review is the substitute.
- **The manifest is not committable.** `deployment-manifests/` is gitignored,
  although `DEPLOYMENTS.md` says to commit the manifest alongside the record;
  attach it to the release issue instead.
- **`DEPLOYMENTS.md` contains a second placeholder registry.** The versioned
  testnet section is authoritative and is the one `verify-deployment` reads; the
  later `TBD` table is stale and should be removed in a docs cleanup.

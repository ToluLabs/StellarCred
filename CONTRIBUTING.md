# Contributing to StellarCred

Thanks for your interest in contributing. StellarCred is a ZK credential layer for Stellar — contributions that improve correctness, security, or developer experience are especially welcome.

## Project layout

```
contracts/    Soroban workspace (Rust, soroban-sdk 26)
circuits/     Noir circuits (UltraHonk · Noir 1.0.0-beta.9 / bb 0.87.0)
frontend/     Next.js 14 app + @stellarcred/sdk
services/     Indexer & off-chain services (see services/indexer/README.md)
scripts/      deploy.sh — wires all contracts on testnet
fixtures/     real vk / proof / public_inputs used by contract tests
```

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

Full install instructions — including exact commands, PATH configuration, and
a troubleshooting table — are in **[SETUP.md](SETUP.md)**.

After following SETUP.md, run:

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

Fix any `[FAIL]` lines before running `make build` or `make test`.

### Pinned versions at a glance

| Tool | Pinned version | Why pinned |
|------|---------------|------------|
| Rust | **1.93.1** | Byte-identical WASM artifacts (`rust-toolchain.toml`) |
| wasm32v1-none | — | Required compile target for Soroban contracts |
| nargo | **1.0.0-beta.9** | VK determinism — must match `bb` exactly |
| bb | **0.87.0** | VK determinism — must match `nargo` exactly |
| Node | **20** | Frontend and indexer |
| pnpm | **9** | Frontend workspace manager |

> **Circuit toolchain warning:** the `nargo` and `bb` versions are load-bearing.
> A mismatch produces a VK that differs from the committed fixture, and CI fails
> with `VK mismatch for <circuit>` — which looks like your change broke
> something but is actually a version problem. Run `make doctor` first.

## Docker quickstart

Skip local toolchain installs — use the pinned dev image:

```bash
# Build the dev image (first time, or after Dockerfile changes)
docker compose build

# Frontend dev server on http://localhost:3000
docker compose up frontend

# Contract tests (21 tests)
docker compose run --rm contracts cargo test

# Compile all Noir circuits
docker compose run --rm circuits nargo compile --workspace
```

The image pins Rust 1.93.1, nargo 1.0.0-beta.9, bb 0.87.0, Node 20, and pnpm 9,
so version mismatches are not possible inside the container.

## Getting started

```bash
# contracts
cargo test                        # 21 tests, real BN254 verification

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
npm install
npm run dev
```

## Development workflow

1. **Pick and claim an issue** (see [Picking up an issue](#picking-up-an-issue) below), then **fork** the repo and create a branch from `main`.
2. Make your changes. Keep commits focused — one logical change per commit.
3. For contract changes: run `cargo test` and confirm all tests pass.
4. For circuit changes: run `./circuits/scripts/build.sh` and update the relevant `fixtures/<type>/` artifacts, then regenerate the regression test vectors with `node circuits/scripts/testvectors.js update` (see `circuits/README.md` — "Test Vectors") and commit the result. CI runs `node circuits/scripts/testvectors.js check` and fails if a circuit or toolchain change silently altered proof output without the vectors being updated.
5. For frontend changes: run `pnpm tsc --noEmit` (zero errors required) and `pnpm build`.
6. Open a pull request against `main` with a clear description of what changed and why.

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

## Code style

- **Rust**: `cargo fmt` before committing. Follow the existing contract structure — cross-contract calls use `#[contractclient]` interface traits, not crate dependencies.
- **TypeScript**: ESLint + Prettier (enforced by `pnpm lint`). No `NEXT_PUBLIC_` prefix on server-only env vars.
- **Noir**: keep circuits as simple as possible — constraint count directly affects browser proving time.
- **Comments**: only when the *why* is non-obvious (a constraint, a workaround, a subtle invariant). Don't explain what the code does.

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

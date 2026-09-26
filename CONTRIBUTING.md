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

The image pins Rust stable, Stellar CLI v27, nargo 1.0.0-beta.9, bb 0.87.0, Node 20, and pnpm 9 — matching the versions in the table below.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | stable | `rustup` |
| wasm32v1-none target | — | `rustup target add wasm32v1-none` |
| Stellar CLI | v27 | `brew install stellar-cli` |
| nargo | 1.0.0-beta.9 | `noirup -v 1.0.0-beta.9` |
| bb | 0.87.0 | `bbup -v 0.87.0` |
| Node | 20 | `nvm` / `volta` |
| pnpm | 9 | `corepack enable && corepack prepare pnpm@9 --activate` |

> The nargo and bb versions must match exactly — the verification key is deterministic from the circuit compiler version, and a mismatch will cause proof verification to fail on-chain.

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

1. **Fork** the repo and create a branch from `main`.
2. Make your changes. Keep commits focused — one logical change per commit.
3. For contract changes: run `cargo test` and confirm all tests pass.
4. For circuit changes: run `./circuits/scripts/build.sh` and update the relevant `fixtures/<type>/` artifacts, then regenerate the regression test vectors with `node circuits/scripts/testvectors.js update` (see `circuits/README.md` — "Test Vectors") and commit the result. CI runs `node circuits/scripts/testvectors.js check` and fails if a circuit or toolchain change silently altered proof output without the vectors being updated.
5. For frontend changes: run `pnpm tsc --noEmit` (zero errors required) and `pnpm build`.
6. Open a pull request against `main` with a clear description of what changed and why.

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

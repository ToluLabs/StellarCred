# Contributing to StellarCred

Thanks for your interest in contributing. StellarCred is a ZK credential layer for Stellar — contributions that improve correctness, security, or developer experience are especially welcome.

## Project layout

```
contracts/    Soroban workspace (Rust, soroban-sdk 26)
circuits/     Noir circuits (UltraHonk · Noir 1.0.0-beta.9 / bb 0.87.0)
frontend/     Next.js 14 app + @stellarcred/sdk
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
```

## Development workflow

1. **Fork** the repo and create a branch from `main`.
2. Make your changes. Keep commits focused — one logical change per commit.
3. For contract changes: run `cargo test` and confirm all tests pass.
4. For circuit changes: run `./circuits/scripts/build.sh` and update the relevant `fixtures/<type>/` artifacts.
5. For frontend changes: run `pnpm tsc --noEmit` (zero errors required) and `pnpm build`.
6. Open a pull request against `main` with a clear description of what changed and why.

## Areas open for contribution

- Additional credential types (employment, accreditation, etc.)
- Multi-issuer trust: allow protocols to specify which issuers they accept
- Proof batching: submit multiple proofs in one transaction
- SDK: additional framework integrations (React hook, Vue composable)
- Circuit optimizations: reduce constraint count for faster browser proving
- Issuer integrations: additional KYC / attestation providers

## Security

Please do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## Code style

- **Rust**: `cargo fmt` before committing. Follow the existing contract structure — cross-contract calls use `#[contractclient]` interface traits, not crate dependencies.
- **TypeScript**: ESLint + Prettier (enforced by `pnpm lint`). No `NEXT_PUBLIC_` prefix on server-only env vars.
- **Noir**: keep circuits as simple as possible — constraint count directly affects browser proving time.
- **Comments**: only when the *why* is non-obvious (a constraint, a workaround, a subtle invariant). Don't explain what the code does.

## Commit messages

Use the imperative mood and be specific: `add income_proof circuit`, `fix check_claim threshold comparison`, `remove SmileID dependency`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

# StellarCred — Local Environment Setup

This document is the single source of truth for setting up a working StellarCred
development environment. It covers all four toolchains in the order you need them,
with the exact pinned versions that CI uses.

Run `make doctor` after setup to confirm every version matches before you start.

---

## Quick reference — pinned versions

| Toolchain | Pinned version | Why pinned |
|-----------|---------------|------------|
| Rust | **1.93.1** | Byte-identical WASM artifacts; see `rust-toolchain.toml` |
| wasm32v1-none target | — (bundled with Rust) | Required compile target for Soroban contracts |
| nargo (Noir) | **1.0.0-beta.9** | VK determinism — must match `bb` exactly |
| bb (Barretenberg) | **0.87.0** | VK determinism — must match `nargo` exactly |
| Node.js | **20** (LTS) | Frontend and indexer |
| pnpm | **9** | Frontend workspace manager |
| npm | bundled with Node | Indexer service |

> **Circuit toolchain warning — read this before touching circuits**
>
> The `nargo` and `bb` versions are load-bearing. The verification key (VK) that
> a circuit produces is deterministic from the exact `(nargo, bb)` pair used to
> compile it. If your local versions do not match the pins above, `make check-circuits`
> will fail with a message like:
>
> ```
> ::error::VK mismatch for kyc (fixtures/kyc/vk differs from freshly compiled circuit)
> Run circuits/scripts/build.sh locally to regenerate staged artifacts
> ```
>
> This looks like your change broke something, but it is actually a toolchain
> version mismatch. Run `make doctor` to diagnose it before assuming your code
> is wrong.

---

## 1 · Rust (contracts)

Soroban contracts compile to `wasm32v1-none`. The toolchain version is pinned in
`rust-toolchain.toml` so `rustup` picks it up automatically.

### Install rustup

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Follow the prompts and restart your shell (or run `source "$HOME/.cargo/env"`).

### Add the WASM target

```bash
rustup target add wasm32v1-none
```

`rustup` reads `rust-toolchain.toml` and downloads `1.93.1` on the first `cargo`
invocation, so no explicit `rustup install` step is needed.

### Verify

```bash
rustc --version
# rustc 1.93.1 (...)

rustup target list --installed | grep wasm32v1-none
# wasm32v1-none
```

### Common failure

If `rustup` fails to download a component (e.g. during a network interruption):

```
error: could not download file from 'https://static.rust-lang.org/...'
```

Re-run the target-add or toolchain-install command. If the error persists,
`rustup self update` then retry.

---

## 2 · Noir circuits (nargo + bb)

Circuit work requires **both** tools at their pinned versions. Installing one
without the other, or using a different version of either, will cause a VK
mismatch at the artifact-freshness check.

### Install noirup and nargo

```bash
curl -sSfL https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
export PATH="$HOME/.nargo/bin:$PATH"   # add to your shell profile too
noirup -v 1.0.0-beta.9
```

Add `$HOME/.nargo/bin` to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.)
so `nargo` is on your PATH in every session.

### Install bbup and bb

```bash
curl -sSfL https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/install | bash
export PATH="$HOME/.bb:$PATH"          # add to your shell profile too
source "$HOME/.bashrc" 2>/dev/null || true
bbup -v 0.87.0
```

### Verify

```bash
nargo --version
# nargo version = 1.0.0-beta.9 ...

bb --version
# 0.87.0
```

### What a version mismatch looks like

Running `make check-circuits` or `./circuits/scripts/build.sh` with the wrong
versions produces a VK mismatch error:

```
::error::VK mismatch for kyc (fixtures/kyc/vk differs from freshly compiled circuit)
Run circuits/scripts/build.sh locally to regenerate staged artifacts
```

Or a hash-mismatch from the test-vector check:

```
FAIL  circuits/testvectors/kyc_proof.json
  Expected vk_hash: 0xabc...
  Got:              0xdef...
```

Neither message means your circuit logic is wrong. Both mean `nargo` or `bb` (or
both) are at the wrong version. Run `make doctor` to confirm, then reinstall with
the exact `noirup -v` / `bbup -v` commands above.

> **Do not run `noirup` without `-v`** — it installs the latest release, which
> may not match `bb`'s expectations.

---

## 3 · Node.js + pnpm (frontend and SDK)

### Install Node 20

Use any version manager you prefer. Examples:

```bash
# nvm
nvm install 20 && nvm use 20

# volta
volta install node@20

# direct download
# https://nodejs.org/en/download (choose LTS 20.x)
```

### Install pnpm 9

```bash
corepack enable
corepack prepare pnpm@9 --activate
```

Or via npm if corepack is unavailable:

```bash
npm install -g pnpm@9
```

### Install frontend dependencies

```bash
cd frontend
pnpm install
```

### Verify

```bash
node --version
# v20.x.x

pnpm --version
# 9.x.x
```

---

## 4 · Indexer service (Node.js + npm)

The indexer uses plain `npm` (not pnpm) and supports both SQLite and Postgres.

### Install dependencies

```bash
cd services/indexer
npm ci
```

### SQLite (default, zero config)

No additional setup. The indexer uses `better-sqlite3` by default.

### Postgres (optional)

Spin up a local instance with Docker:

```bash
docker run -d \
  --name stellarcred-pg \
  -e POSTGRES_USER=indexer \
  -e POSTGRES_PASSWORD=indexer \
  -e POSTGRES_DB=indexer \
  -p 5432:5432 \
  postgres:16
```

Then set `DATABASE_URL` in `services/indexer/.env`:

```
DATABASE_URL=postgres://indexer:indexer@localhost:5432/indexer
```

### Verify

```bash
cd services/indexer
npm run build
# should exit 0 with no TypeScript errors
```

---

## Verifying your full environment

After completing all four sections above, run:

```bash
make doctor
```

`make doctor` checks every pinned version and reports pass/fail for each one.
A clean machine looks like:

```
[ok] rustc         1.93.1
[ok] wasm32v1-none installed
[ok] nargo         1.0.0-beta.9
[ok] bb            0.87.0
[ok] node          v20.x.x  (need 20.x)
[ok] pnpm          9.x.x    (need 9.x)
[ok] npm           bundled with node
```

Fix any `[FAIL]` lines before running `make build` or `make test`.

---

## Docker alternative (skip local toolchain installs)

If you only want to run tests or build artifacts without configuring your host:

```bash
# Build the dev image (first time, or after Dockerfile changes)
docker compose build

# Frontend dev server on http://localhost:3000
docker compose up frontend

# Contract tests
docker compose run --rm contracts cargo test

# Compile all Noir circuits
docker compose run --rm circuits nargo compile --workspace
```

The image pins Rust 1.93.1, nargo 1.0.0-beta.9, bb 0.87.0, Node 20, and pnpm 9,
so version mismatches are not possible inside the container.

---

## First build smoke test

Once `make doctor` is green, confirm the full stack builds:

```bash
# Contracts (Rust → WASM)
cargo build --release --target wasm32v1-none --locked

# Circuits (only needed if you change .nr files; artifacts are pre-committed)
./circuits/scripts/build.sh

# Frontend
cd frontend && pnpm build

# Indexer
cd services/indexer && npm run build
```

Or run all of them in one shot:

```bash
make build
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `VK mismatch for <circuit>` | `nargo` or `bb` version wrong | `noirup -v 1.0.0-beta.9` and `bbup -v 0.87.0` |
| `error[E0463]: can't find crate` on WASM build | Missing `wasm32v1-none` target | `rustup target add wasm32v1-none` |
| `rustup component download failed` | Network interruption | Retry; `rustup self update` if it persists |
| `pnpm: command not found` | corepack not active | `corepack enable && corepack prepare pnpm@9 --activate` |
| `Cannot find module 'better-sqlite3'` | `npm ci` not run in indexer | `cd services/indexer && npm ci` |
| `make doctor` reports `[FAIL] nargo` but nargo is installed | PATH missing `~/.nargo/bin` | Add `export PATH="$HOME/.nargo/bin:$PATH"` to your shell profile |
| `make doctor` reports `[FAIL] bb` but bb is installed | PATH missing `~/.bb` | Add `export PATH="$HOME/.bb:$PATH"` to your shell profile |

For issues not covered here, open a GitHub issue or ask in the project's
discussion channel. Include the output of `make doctor` in your report.

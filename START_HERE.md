# Start here — clone to a green local build

One linear path from an empty directory to the same checks CI runs on your pull
request. Follow the steps in order; each one ends with a command whose output
tells you whether you may continue.

This file is the **path**. The detail lives in the document that owns it:

| You need | Read |
|---|---|
| Full install steps per toolchain, and the troubleshooting table | [SETUP.md](SETUP.md) |
| The per-component command/output checklist, and known failure modes | [docs/CONTRIBUTOR_CHECKLIST.md](docs/CONTRIBUTOR_CHECKLIST.md) |
| Workflow, review routing, trust-model invariants, ADRs, PR rules | [CONTRIBUTING.md](CONTRIBUTING.md) |
| What the product is and how to deploy it | [README.md](README.md) |
| A subsystem reference (events, threat model, issuer lifecycle…) | [`docs/`](docs/) |

**Done looks like:** `make doctor` prints `All checks passed — environment is
ready.`, and the validation command for each component you touched exits 0.

---

## Step 1 · Clone

```bash
git clone https://github.com/ToluLabs/StellarCred.git
cd StellarCred
```

To send a pull request from outside the maintainer team, fork first and clone
your fork — see [CONTRIBUTING.md § Development workflow](CONTRIBUTING.md#development-workflow).

## Step 2 · Install the toolchains your work needs

The repo spans four toolchains, but they are not all mandatory. Install only
what your change touches, then read the matching section of
[SETUP.md](SETUP.md) for the exact commands and pins:

| Your change touches | You need | SETUP.md section |
|---|---|---|
| `contracts/` | rustup + the pinned Rust toolchain + `wasm32v1-none` target | §1 · Rust |
| `circuits/`, `fixtures/` | `nargo` **and** `bb`, at the pinned pair — nothing else can reproduce a committed VK | §2 · Noir circuits |
| `frontend/`, `frontend/packages/sdk/` | Node LTS + pnpm | §3 · Node.js + pnpm |
| `services/indexer/` | Node + npm (bundled) | §4 · Indexer service |

Two traps worth knowing before you start:

- **The circuit toolchain is version-critical.** `nargo` and `bb` must match the
  pins exactly; a mismatch silently produces a different verification key, and
  the failure looks like your circuit is wrong. SETUP.md §2 shows both the error
  text and the reinstall command.
- **Contracts do not need `nargo`/`bb`.** The VKs, proofs and public inputs the
  Rust tests verify against are committed under `fixtures/`, so
  `cargo test --locked` runs on a Rust-only machine.

## Step 3 · Verify the environment before you build anything

```bash
make doctor
```

This is the gate. It prints one line per pinned tool and exits non-zero if any
version is wrong, so `make doctor && make build` short-circuits instead of
producing a confusing compile error later. A passing run ends with:

```
All checks passed — environment is ready.
```

Fix every `[FAIL]` line — the message names the command that fixes it — and
re-run. `make` itself needs GNU Make plus bash; on Windows run it from Git Bash,
and if Make is unavailable run the per-component commands from Step 5 directly
instead.

## Step 4 · Install workspace dependencies

```bash
cd frontend && pnpm install && cd ..        # frontend + SDK
cd services/indexer && npm ci && cd ../..   # indexer (npm, not pnpm)
```

Contracts and circuits have no separate install step: `cargo` resolves from
`Cargo.lock`, and circuit artifacts are committed.

## Step 5 · Validate the components you changed

Run the command for each component you touched and confirm the expected output.
All of these run from the repo root.
[docs/CONTRIBUTOR_CHECKLIST.md](docs/CONTRIBUTOR_CHECKLIST.md) has the full
table — including the CI job each command mirrors and the failure modes specific
to that component.

```bash
# contracts
cargo test --locked
cargo build --release --target wasm32v1-none --locked
cargo clippy --workspace --all-targets -- -D warnings

# circuits (only if you changed .nr files or fixtures — needs the pinned nargo + bb)
bash ./circuits/scripts/build.sh
node circuits/scripts/testvectors.js check

# frontend (subshell: stays in the repo root)
(cd frontend && pnpm lint && pnpm exec tsc --noEmit && pnpm test && pnpm build)

# indexer
(cd services/indexer && npm run build && npm test)
```

## Step 6 · Run the whole thing at once (recommended before opening a PR)

```bash
make build && make test && make lint     # or: make all
cargo fmt --all                           # format the code you changed
```

`make all` mirrors CI: build contracts, frontend and indexer; run contract,
frontend, SDK-example and indexer tests; then clippy and the frontend linters.
It does **not** run the circuits, accessibility or testnet-SDK jobs, and it does
not replace reading the CI job list in the checklist.

`make fmt` is *not* part of that: it runs `cargo fmt --all --check`, and parts of
the committed contracts already fail it, so a fresh checkout reports diffs you did
not cause. CI does not gate formatting — run `cargo fmt --all` and keep the
reformat inside your own diff.

## Step 7 · Open the pull request

- One logical change per commit; messages follow
  [Conventional Commits](CONTRIBUTING.md#commit-messages) — `commitlint` runs in CI.
- Claim the issue before you write code, so two people don't build the same PR:
  [CONTRIBUTING.md § Picking up an issue](CONTRIBUTING.md#picking-up-an-issue).
- Link it with `Closes #<n>`, and name the invariant you preserved if your diff
  touches a sensitive area:
  [CONTRIBUTING.md § Sensitive areas](CONTRIBUTING.md#sensitive-areas-and-their-invariants).
- Do **not** commit an implementation summary, status report or "files modified"
  write-up. They describe a change that ends at merge, so they belong in the PR
  description; if part of one is worth keeping, move that part into the document
  that owns the topic (`circuits/README.md`, a component `README.md`, or
  [`docs/`](docs/)).

## Step 8 · Optional — run the product end to end

Validation (Steps 1–7) never needs a wallet, a funded account, or deployed
contracts. To actually issue and verify a credential on testnet, follow
[README.md § Run it end to end (testnet)](README.md#run-it-end-to-end-testnet-manual)
— it covers the Stellar CLI, `scripts/deploy.sh`, `frontend/.env.local`, and the
`./scripts/demo.sh` smoke test.

---

## If something fails

1. Re-run `make doctor` first. Most "my build is broken" reports are a toolchain
   version or a missing `PATH` entry (`~/.nargo/bin`, `~/.bb`), not a code bug.
2. Look the symptom up in the troubleshooting table at the end of
   [SETUP.md](SETUP.md), then in the pitfalls table of
   [docs/CONTRIBUTOR_CHECKLIST.md](docs/CONTRIBUTOR_CHECKLIST.md).
3. If a CI check is red and no local command reproduces it, find the job in
   [`.github/workflows/ci.yml`](.github/workflows/ci.yml) and run its step
   commands in order — the checklist maps each job to the command to run.
4. Still stuck: open an issue and paste the output of `make doctor` plus the
   failing command.

> Some root-level `.md` files in this repo are one-off reports left over from
> closed issues (`ADMIN_ROTATION_*`, `IMPLEMENTATION_*`, `FINAL_VERIFICATION.md`,
> `PUSH_COMPLETE.md`, and the old admin-rotation `QUICK_START.md`). They describe
> work that already shipped. They are not onboarding documents — the current
> path is this file, [SETUP.md](SETUP.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

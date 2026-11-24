# Contributor checklist

The pre-flight list for a StellarCred change: which toolchain you need, which
command validates each component, what its output looks like when it passes, and
the failure modes that cost previous contributors the most time.

Every command here is the real one — taken from the [`Makefile`](../Makefile),
each component's `package.json` scripts, and
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Install detail lives
in [SETUP.md](../SETUP.md); the linear clone-to-validation path is
[START_HERE.md](../START_HERE.md); process, review routing and trust-model
invariants are in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 1 · Before you write code

- [ ] The issue is **assigned to you** (comment and ask). Never open a PR for an
      issue someone else is already assigned — see
      [CONTRIBUTING.md § Picking up an issue](../CONTRIBUTING.md#picking-up-an-issue).
- [ ] You know which review area your diff lands in, and the invariant that area
      must not break:
      [CONTRIBUTING.md § Sensitive areas](../CONTRIBUTING.md#sensitive-areas-and-their-invariants).
- [ ] If the change touches the trust model, you have read the relevant
      [ADR](../CONTRIBUTING.md#architecture-decision-records).
- [ ] Branch created from an up-to-date `main`, named for what it does.
- [ ] You are **not** planning to commit a summary/status report — the PR
      description is where that belongs.

## 2 · Toolchain setup

- [ ] `make doctor` exits 0. Fix every `[FAIL]` line before anything else; each
      one prints the command that resolves it. Last lines of a clean run:
      ```
      [ok]   npm                    10.x.x

      All checks passed — environment is ready.
      ```
- [ ] `rustc --version` reports the version in `rust-toolchain.toml` (rustup
      installs it on first `cargo` run), and `wasm32v1-none` is in
      `rustup target list --installed`.
- [ ] Circuits work only: `nargo --version` and `bb --version` both match the
      pinned pair exactly, and `~/.nargo/bin` plus `~/.bb` are on `PATH` — not
      just in the shell you installed them from.
- [ ] Frontend work only: Node and pnpm installed, `cd frontend && pnpm install`
      succeeded (its `postinstall` also builds `packages/issuer`).
- [ ] Indexer work only: `cd services/indexer && npm ci` — plain npm, not pnpm.
- [ ] Commit hooks are actually installed: `git config core.hooksPath` prints
      `.husky`. `.husky/pre-commit` runs `pnpm --dir frontend exec lint-staged`
      (`eslint --fix` + `prettier --write` on staged TS, Prettier on JSON/MD/CSS);
      if the config is unset, nothing runs on commit and CI's `format:check` is the
      first place you see the diff. `cd frontend && pnpm install` wires it via the
      `prepare` script.
- [ ] `.env.local` / `services/indexer/.env` created from the examples, and
      `git status` shows them ignored — never commit a private key.

## 3 · Contracts (`contracts/`)

| # | Command | Passes with |
|---|---|---|
| [ ] | `cargo test --locked` | one `test result: ok. N passed; 0 failed` line per test binary, exit 0 |
| [ ] | `cargo build --release --target wasm32v1-none --locked` | `Finished` line, exit 0, `target/wasm32v1-none/release/*.wasm` present |
| [ ] | `cargo clippy --workspace --all-targets -- -D warnings` | no output, exit 0 (warnings are errors) |
| [ ] | `cargo fmt --all` | formats in place; `git diff --stat` should list only the files you edited |

Notes that save time:

- **Formatting is not a CI gate.** No workflow runs `cargo fmt --check`, and
  committed code in `contracts/*/src/test.rs` is already unformatted, so
  `cargo fmt --all --check` (and `make fmt`) can fail on a checkout you have not
  touched. Run `cargo fmt --all` before committing, then keep only the hunks in
  the files your PR actually changes — do not fold a repo-wide reformat into a
  focused diff.
- `--locked` is not decorative: cargo refuses to run when `Cargo.lock` would have
  to change, which is how an uncommitted dependency edit gets caught. If you
  deliberately bumped a dependency, regenerate the lockfile and commit it in the
  same commit as the manifest.
- `--workspace` on clippy matters. The host-only `contracts/test_support` harness
  is not a default member, so a bare clippy/build skips it and CI does not.
- The suites verify **real** BN254 proofs against the committed `fixtures/` VKs,
  so they need no `nargo`, no `bb`, no wallet and no network. `mock_all_auths()`
  mocks signing only — never the verification itself.
- `cargo test -p issuer_registry` narrows one crate; `cargo test <name> -- --nocapture`
  prints one test's output.

## 4 · Circuits (`circuits/`, `fixtures/`)

Only required when you change `.nr` files, `Prover.toml`,
`circuits/circuit-versions.json` or staged artifacts.

| # | Command | Passes with |
|---|---|---|
| [ ] | `bash ./circuits/scripts/build.sh` | every circuit compiles, VK written, artifact staged into `frontend/public/circuits/<type>.json`. One circuit: `bash ./circuits/scripts/build.sh kyc_proof` |
| [ ] | `node circuits/scripts/testvectors.js check` | `<circuit>... ok` per vector, then `All test vectors match.` |
| [ ] | `bash scripts/verify-vks.sh check` | exit 0 (it cds to the repo root itself, so it runs from anywhere) |
| [ ] | `node circuits/scripts/stamp-circuit-version.js check-all` (repo root) | `ok`/`skip` per artifact, then `All compiled circuit artifacts carry the declared circuit version.` — the default `frontend/public/circuits` path resolves from the repo root |
| [ ] | `cd circuits/<name> && nargo test` | `Test '…' passed` per Noir test |

If `testvectors.js check` reports `DRIFT (…)`:

- A warning line naming your installed versions means **toolchain mismatch**, not
  a logic bug — reinstall the pinned `nargo`/`bb` and re-run before anything else.
- Real drift after an intentional circuit change: bump that circuit's entry in
  `circuits/circuit-versions.json`, run `node circuits/scripts/testvectors.js update`,
  and commit the regenerated vectors. See `circuits/README.md` § "Test Vectors".
- Never hand-edit `fixtures/` or `circuits/testvectors/*.json`; they are only
  valid as output of the pinned build.

## 5 · Frontend, SDK, examples

Frontend (`cd frontend`):

| # | Command | Passes with |
|---|---|---|
| [ ] | `pnpm lint` | no output, exit 0 |
| [ ] | `pnpm format:check` | `All matched files use Prettier code style!` |
| [ ] | `pnpm exec tsc --noEmit` | no output, exit 0 |
| [ ] | `pnpm test` | vitest summary, `0 failed` |
| [ ] | `pnpm test:theme` | `node --test` summary, `fail 0` |
| [ ] | `pnpm --filter @stellarcred/issuer test` | package test summary, `0 failed` |
| [ ] | `pnpm check:i18n` | `✅ i18n parity check passed across 2 locale files.` |
| [ ] | `pnpm build` | next build completes, exit 0 |

SDK (`cd frontend/packages/sdk`) — it is **not** in the pnpm workspace, so run
its scripts from its own directory:

| # | Command | Passes with |
|---|---|---|
| [ ] | `pnpm typecheck` | no output, exit 0 |
| [ ] | `pnpm test` | vitest summary, `0 failed` |
| [ ] | `pnpm test:integration` | testnet round-trip passes; the suite skips itself when `SC_TEST_WALLET` / `STELLARCRED_REGISTRY_ID` are unset |
| [ ] | `pnpm build` | tsup emits `dist/` cjs + esm + `.d.ts` |

Examples (each has its own `npm` install; both resolve `@stellarcred/sdk` from
`frontend/packages/sdk` by `file:` path, so build the SDK first):

| # | Command |
|---|---|
| [ ] | `cd examples/typescript-quickstart && npm ci && npm run typecheck && npm start` |
| [ ] | `cd examples/canonical-integration && npm ci && npm run typecheck && npm test` |

Indexer (`cd services/indexer`):

| # | Command | Passes with |
|---|---|---|
| [ ] | `npm run build` | `tsc` no output, exit 0 |
| [ ] | `npm test` | jest summary, `Tests: N passed` |

## 6 · Repo-wide gates (docs and hygiene)

| # | Command | Notes |
|---|---|---|
| [ ] | `bash scripts/check-holder-size.sh` (repo root) | `HolderPageClient.tsx: <n> lines (limit: 520)` then `OK — within limit.` — read the count it prints before you add holder code: the guard fails on the total, so anything that pushes it past 520 belongs in `lib/hooks/` and `components/holder/` instead |
| [ ] | `node .github/scripts/check-api-reference.mjs` | `API reference in sync: N/N public entrypoints documented` — fails when a ProofRegistry entrypoint changed without `docs/PROOF_REGISTRY_API.md` (`make check-api-reference`) |
| [ ] | `cd frontend && node scripts/check-env-sync.mjs && node scripts/validate-deploy-env.mjs --smoke-test` | `All environment variables are documented in .env.example` then `All deploy environment validation smoke tests PASSED.` — the `env-check` job: `.env.example` must stay in sync with what the code reads |
| [ ] | `npx --yes -p @commitlint/cli -p @commitlint/config-conventional commitlint --from <base> --to HEAD --verbose` | the `commitlint` job; prefixes in [CONTRIBUTING.md § Commit messages](../CONTRIBUTING.md#commit-messages) |
| [ ] | `make lint` | clippy (`-D warnings`) + frontend ESLint/typecheck. Use `make fmt` only on a tree you have already formatted — it is `cargo fmt --all --check`, and committed code is not clean (see § 3) |

## 7 · CI job → command map

Use this when a check is red and you cannot reproduce it locally.

| CI job (`.github/workflows/ci.yml`) | Mirror it locally with |
|---|---|
| `contracts` | § 3 commands + `bash ./circuits/scripts/build.sh` (CI regenerates fixtures before building) |
| `circuits` | § 4 commands |
| `circuit-fuzz` | `node circuits/scripts/fuzz_circuits.js --iterations 10` from the repo root (needs the pinned `nargo` and `pnpm install` in `frontend/` for `@noble/curves`) |
| `frontend` | § 5 frontend commands + `bash scripts/check-holder-size.sh` |
| `indexer` | `npm run build && npm test` — CI additionally runs the Postgres leg |
| `sdk-integration` | § 5 SDK commands; skipped on forks without the repo variables |
| `dependency-check` | `cd frontend && pnpm install --frozen-lockfile && node ../.github/scripts/verify-npm-licenses.mjs`; from the repo root, `node .github/scripts/check-runtime-deps.mjs` — a newly added runtime dependency or a disallowed license is the usual cause |
| `env-check` (`.github/workflows/env-check.yml`) | § 6 env commands |
| `commitlint` | § 6 commitlint command |
| `api-reference` | `make check-api-reference` |
| `a11y` | `make test-a11y` — currently disabled in CI (`if: false`) while pre-existing violations are fixed |

Workflows that run outside `ci.yml`: `first-load.yml` and
`preview-deployment.yml` (frontend paths), `proving-perf.yml` (circuit/perf
paths), `e2e.yml` (schedule + manual only, not a PR gate),
`reproducible-build.yml` (push to `main`).

## 8 · Common pitfalls

| Symptom | Actual cause | Fix |
|---|---|---|
| `VK mismatch for <circuit> (fixtures/<type>/vk differs from freshly compiled circuit)` | Local `nargo`/`bb` are not the pinned pair | `noirup -v <pinned>` + `bbup -v <pinned>`, confirm with `make doctor`, then re-run `bash ./circuits/scripts/build.sh` |
| `warning: installed toolchain … does not match the pinned toolchain` then drift | Same as above — the warning is the tell | Reinstall the pinned pair before debugging circuit logic |
| `make doctor` says `[FAIL] nargo` (or `bb`) although it is installed | `~/.nargo/bin` / `~/.bb` are not on `PATH` in this shell | Add the `export PATH=…` line to your shell profile and restart |
| `Error: spawnSync nargo ENOENT` and a Node stack trace from `node circuits/scripts/testvectors.js check` | `nargo` is not installed or not on `PATH` — the script shells out to it directly | Install/PATH the pinned pair (SETUP.md § 2), or use `bash scripts/verify-vks.sh check`, which checks for the tools first and prints the install command |
| `error[E0463]: can't find crate for 'core'` on the WASM build | `wasm32v1-none` target missing | `rustup target add wasm32v1-none` |
| `cargo build`/`test --locked` fails about `Cargo.lock` | Manifest changed without the lockfile | `cargo build --locked` after committing the updated `Cargo.lock` (never revert the lock to dodge it) |
| Clippy clean locally, red in CI | You ran clippy without `--workspace` | `cargo clippy --workspace --all-targets -- -D warnings` |
| `make fmt` fails on files you never opened | `cargo fmt --all --check` reports pre-existing unformatted code; no CI job gates it | Run `cargo fmt --all` and keep the reformat inside your own diff (§ 3) |
| `make: command not found`, or `make` targets error under PowerShell | The Makefile needs GNU Make **and** bash | Use Git Bash / WSL / macOS, install Make, or run the per-component commands in § 3–§ 5 |
| `make: *** No rule to make target 'check-circuits'` | There is no such target — the circuit checks are § 4's commands | `make compile-circuits`, then `node circuits/scripts/testvectors.js check` |
| `docker compose run --rm contracts …` → `no such service: contracts` | `docker-compose.yml` defines only the `indexer` and `frontend` **app** containers | Use the toolchain image: `docker build -f docker/Dockerfile.dev -t stellarcred-dev .` then `docker run --rm -v "$PWD":/workspace -w /workspace stellarcred-dev bash -lc "cargo test --locked"` |
| `pnpm install` in `frontend/` uses a different pnpm than `make doctor` checks | `frontend/package.json` declares a `packageManager` version and corepack honours it per-directory | Either is fine for building; if a lockfile version warning appears, use the version in that `packageManager` field |
| `Cannot find module 'better-sqlite3'` in the indexer | Native module not built for your Node | `cd services/indexer && npm ci` (needs a C toolchain + `pkg-config` on Linux) |
| Indexer tests pass locally but CI's DB suite fails | The Postgres leg only runs when `TEST_POSTGRES_URL` is set | Start a local Postgres (SETUP.md § 4) and `TEST_POSTGRES_URL=postgres://… npm test` |
| `pnpm test` in `frontend/packages/sdk` fails on connect/auth | Testnet variables unset | Export `SC_TEST_WALLET`, `STELLARCRED_REGISTRY_ID` (and optionally `STELLARCRED_RPC_URL`), or let the suite skip |
| `::error::frontend/app/holder/HolderPageClient.tsx has N lines, which exceeds the 520-line limit` | Inline feature code added to the route shell | Move logic to `lib/hooks/`, UI to `components/holder/` — [CONTRIBUTING.md § Holder page architecture](../CONTRIBUTING.md#holder-page-architecture) |
| `pnpm install --frozen-lockfile` fails in CI | Lockfile not committed / edited by hand | Regenerate with `pnpm install` in `frontend/` and commit `pnpm-lock.yaml` |
| Format/lint problems appear only in CI | `core.hooksPath` is unset, so `.husky/pre-commit` never ran | `cd frontend && pnpm install` (its `prepare` step installs the hooks), or run `pnpm format` and `pnpm lint` before committing |
| i18n parity failure | A key added to one locale only | Add it to every `frontend/public/locales/*.json`, then `pnpm check:i18n` |

## 9 · Before you push

- [ ] Every § 3–§ 6 command relevant to your diff passes locally.
- [ ] `git status` shows no `.env`, key file, `target/`, `node_modules/`, or
      `*-SUMMARY.md` being added.
- [ ] Commits are focused and Conventional (`feat:` / `fix:` / `docs:` / …).
- [ ] Circuit or contract change: regenerated artifacts and test vectors are in
      the same commit as the source that changed them.
- [ ] The PR description says what changed, why, which CI checks you ran, and —
      for a sensitive area — which invariant you preserved.
- [ ] `Closes #<n>` links the issue you were assigned.

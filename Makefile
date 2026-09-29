# ==============================================================================
# StellarCred Unified Workspace Makefile
# ==============================================================================
# Provides a unified entry point across Rust contracts (cargo), Noir circuits
# (nargo/bb), Next.js frontend/SDK (pnpm), and indexer service (npm).
# ==============================================================================

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ------------------------------------------------------------------------------
# Pinned toolchain versions (single source of truth — mirrors .github/workflows/ci.yml)
# ------------------------------------------------------------------------------
RUST_VERSION    := 1.93.1
NOIR_VERSION    := 1.0.0-beta.9
BB_VERSION      := 0.87.0
NODE_MAJOR      := 20
PNPM_MAJOR      := 9

.PHONY: help all build test lint fmt clean check-api-reference doctor \
        build-contracts test-contracts lint-contracts \
        compile-circuits check-circuits \
        build-frontend test-frontend lint-frontend test-sdk test-example test-a11y \
        build-indexer test-indexer run-indexer

# ------------------------------------------------------------------------------
# Top-Level Orchestration Targets
# ------------------------------------------------------------------------------

## help: Display this help message with available targets
help:
	@echo "StellarCred Development Commands"
	@echo "================================"
	@echo "Usage: make [target]"
	@echo ""
	@echo "Top-Level Targets:"
	@echo "  make doctor          - Check that every pinned toolchain version is installed correctly"
	@echo "  make all             - Run build, test, and lint across all workspaces"
	@echo "  make build           - Build contracts, circuits, frontend, and indexer"
	@echo "  make test            - Run all unit, integration, and contract test suites"
	@echo "  make lint            - Run clippy, commitlint, and frontend linters"
	@echo "  make fmt             - Check or apply formatting across Rust and TS"
	@echo "  make clean           - Remove build artifacts and caches"
	@echo "  make check-api-reference - Check docs/PROOF_REGISTRY_API.md against the contract source (issue #525)"
	@echo ""
	@echo "Focused Workspace Targets:"
	@echo "  make build-contracts - Compile Soroban contracts to wasm32v1-none"
	@echo "  make test-contracts  - Run cargo contract unit & snapshot tests"
	@echo "  make lint-contracts  - Run clippy with -D warnings on contracts"
	@echo "  make compile-circuits- Compile Noir zk circuits and derive VKs"
	@echo "  make build-frontend  - Build Next.js frontend web app"
	@echo "  make test-frontend   - Run frontend and SDK unit tests"
	@echo "  make lint-frontend   - Run ESLint on frontend code"
	@echo "  make test-sdk        - Run standalone @stellarcred/sdk integration tests"
	@echo "  make test-example    - Run canonical integration example typecheck & tests"
	@echo "  make test-a11y       - Run axe-core accessibility tests (requires Playwright)"
	@echo "  make build-indexer   - Compile TypeScript indexer service"
	@echo "  make test-indexer    - Run Jest test suite for indexer"
	@echo "  make run-indexer     - Start local indexer service"

## all: Run build, test, and lint across all workspaces (CI mirror)
all: build test lint

## build: Build contracts, circuits, frontend, and indexer
build: build-contracts build-frontend build-indexer

## test: Run all unit and integration test suites
test: test-contracts test-frontend test-indexer test-example

## lint: Run clippy and frontend linters
lint: lint-contracts lint-frontend

## fmt: Check Rust formatting
fmt:
	cargo fmt --all --check

## check-api-reference: Verify the ProofRegistry API reference matches the contract source
check-api-reference:
	node .github/scripts/check-api-reference.mjs

## clean: Remove all target outputs and build artifacts
clean:
	cargo clean
	rm -rf frontend/.next frontend/dist services/indexer/dist circuits/target

# ------------------------------------------------------------------------------
# Doctor — environment version check
# ------------------------------------------------------------------------------

# Colour helpers (no-op when stdout is not a terminal)
_RED    := $(shell tput setaf 1 2>/dev/null || true)
_GREEN  := $(shell tput setaf 2 2>/dev/null || true)
_RESET  := $(shell tput sgr0    2>/dev/null || true)

## doctor: Verify every pinned toolchain version is installed and on PATH
# Exits non-zero if any check fails so `make doctor && make build` short-circuits.
doctor:
	@echo ""
	@echo "StellarCred environment check"
	@echo "=============================="
	@PASS=true; \
	\
	ok()   { printf "$(_GREEN)[ok]$(_RESET)   %-22s %s\n" "$$1" "$$2"; }; \
	fail() { printf "$(_RED)[FAIL]$(_RESET) %-22s %s\n" "$$1" "$$2"; PASS=false; }; \
	\
	echo ""; \
	echo "── 1. Rust ──────────────────────────────────────────────────────"; \
	if command -v rustc >/dev/null 2>&1; then \
	  GOT=$$(rustc --version 2>/dev/null | awk '{print $$2}'); \
	  if [ "$$GOT" = "$(RUST_VERSION)" ]; then \
	    ok "rustc" "$$GOT"; \
	  else \
	    fail "rustc" "got $$GOT, need $(RUST_VERSION)  →  rustup install $(RUST_VERSION)"; \
	  fi; \
	else \
	  fail "rustc" "not found  →  curl https://sh.rustup.rs | sh"; \
	fi; \
	\
	if rustup target list --installed 2>/dev/null | grep -q '^wasm32v1-none$$'; then \
	  ok "wasm32v1-none" "installed"; \
	else \
	  fail "wasm32v1-none" "not installed  →  rustup target add wasm32v1-none"; \
	fi; \
	\
	echo ""; \
	echo "── 2. Noir circuits ─────────────────────────────────────────────"; \
	echo "   (nargo and bb MUST match exactly — a mismatch silently"; \
	echo "    produces wrong VKs and the artifact-freshness check fails)"; \
	if command -v nargo >/dev/null 2>&1; then \
	  GOT=$$(nargo --version 2>/dev/null | grep -oP 'nargo version = \K[^\s]+' || nargo --version 2>/dev/null | awk 'NR==1{print $$NF}'); \
	  if [ "$$GOT" = "$(NOIR_VERSION)" ]; then \
	    ok "nargo" "$$GOT"; \
	  else \
	    fail "nargo" "got $$GOT, need $(NOIR_VERSION)  →  noirup -v $(NOIR_VERSION)"; \
	  fi; \
	else \
	  fail "nargo" "not found  →  curl -sSfL https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash && noirup -v $(NOIR_VERSION)"; \
	fi; \
	\
	if command -v bb >/dev/null 2>&1; then \
	  GOT=$$(bb --version 2>/dev/null | tr -d '[:space:]'); \
	  if [ "$$GOT" = "$(BB_VERSION)" ]; then \
	    ok "bb" "$$GOT"; \
	  else \
	    fail "bb" "got $$GOT, need $(BB_VERSION)  →  bbup -v $(BB_VERSION)"; \
	  fi; \
	else \
	  fail "bb" "not found  →  curl -sSfL https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/install | bash && bbup -v $(BB_VERSION)"; \
	fi; \
	\
	echo ""; \
	echo "── 3. Node.js + pnpm (frontend / SDK) ───────────────────────────"; \
	if command -v node >/dev/null 2>&1; then \
	  GOT=$$(node --version 2>/dev/null); \
	  MAJOR=$$(echo "$$GOT" | sed 's/v//' | cut -d. -f1); \
	  if [ "$$MAJOR" = "$(NODE_MAJOR)" ]; then \
	    ok "node" "$$GOT  (need $(NODE_MAJOR).x)"; \
	  else \
	    fail "node" "got $$GOT, need $(NODE_MAJOR).x  →  nvm install $(NODE_MAJOR) && nvm use $(NODE_MAJOR)"; \
	  fi; \
	else \
	  fail "node" "not found  →  https://nodejs.org or nvm install $(NODE_MAJOR)"; \
	fi; \
	\
	if command -v pnpm >/dev/null 2>&1; then \
	  GOT=$$(pnpm --version 2>/dev/null); \
	  MAJOR=$$(echo "$$GOT" | cut -d. -f1); \
	  if [ "$$MAJOR" = "$(PNPM_MAJOR)" ]; then \
	    ok "pnpm" "$$GOT  (need $(PNPM_MAJOR).x)"; \
	  else \
	    fail "pnpm" "got $$GOT, need $(PNPM_MAJOR).x  →  corepack prepare pnpm@9 --activate"; \
	  fi; \
	else \
	  fail "pnpm" "not found  →  corepack enable && corepack prepare pnpm@9 --activate"; \
	fi; \
	\
	echo ""; \
	echo "── 4. Indexer (npm, bundled with Node) ──────────────────────────"; \
	if command -v npm >/dev/null 2>&1; then \
	  GOT=$$(npm --version 2>/dev/null); \
	  ok "npm" "$$GOT"; \
	else \
	  fail "npm" "not found — npm ships with Node; reinstall Node $(NODE_MAJOR)"; \
	fi; \
	\
	echo ""; \
	if [ "$$PASS" = "true" ]; then \
	  echo "$(_GREEN)All checks passed — environment is ready.$(_RESET)"; \
	  echo ""; \
	else \
	  echo "$(_RED)One or more checks failed. Fix the items marked [FAIL] above,$(_RESET)"; \
	  echo "$(_RED)then re-run: make doctor$(_RESET)"; \
	  echo "$(_RED)See SETUP.md for full install instructions.$(_RESET)"; \
	  echo ""; \
	  exit 1; \
	fi

# ------------------------------------------------------------------------------
# Contracts (Soroban / Rust)
# ------------------------------------------------------------------------------

## build-contracts: Compile Soroban WASM artifacts
build-contracts:
	cargo build --release --target wasm32v1-none --locked

## test-contracts: Run contract test suite
test-contracts:
	cargo test --locked

## lint-contracts: Run clippy on contract crates with warnings as errors
# --workspace so the host-only test harness crate is linted too: a bare build
# skips it, since only the deployable contracts are default workspace members.
lint-contracts:
	cargo clippy --workspace --all-targets -- -D warnings

# ------------------------------------------------------------------------------
# Circuits (Noir / Aztec Barretenberg)
# ------------------------------------------------------------------------------

## compile-circuits: Compile Noir circuits and verify VK artifacts
compile-circuits:
	bash ./circuits/scripts/build.sh

# ------------------------------------------------------------------------------
# Frontend & SDK (Next.js / pnpm)
# ------------------------------------------------------------------------------

## build-frontend: Build frontend Next.js production bundle
build-frontend:
	cd frontend && pnpm build

## test-frontend: Run frontend SDK and theme tests
test-frontend:
	cd frontend && pnpm test && pnpm test:theme && pnpm --filter @stellarcred/issuer test

## lint-frontend: Run frontend ESLint and typecheck
lint-frontend:
	cd frontend && pnpm lint && pnpm exec tsc --noEmit

## test-sdk: Run SDK standalone integration tests
test-sdk:
	cd frontend/packages/sdk && pnpm typecheck && pnpm test:integration

## test-example: Run canonical integration example typecheck and test suite
test-example:
	cd examples/canonical-integration && npm run typecheck && npm test

## test-a11y: Run axe-core accessibility tests
test-a11y:
	cd frontend && pnpm test:e2e

# ------------------------------------------------------------------------------
# Indexer Service (Node.js / Express)
# ------------------------------------------------------------------------------

## build-indexer: Compile indexer TypeScript source
build-indexer:
	cd services/indexer && npm run build

## test-indexer: Run Jest tests for indexer
test-indexer:
	cd services/indexer && npm test

## run-indexer: Start the indexer service locally
run-indexer:
	cd services/indexer && npm start

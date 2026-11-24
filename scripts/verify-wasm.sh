#!/usr/bin/env bash
# verify-wasm.sh — Compare locally built WASM against on-chain WASM hashes.
#
# Usage:
#   ./scripts/verify-wasm.sh [--network testnet|mainnet] [--rpc-url <url>]
#
# What it does:
#   1. Reads contract IDs from DEPLOYMENTS.md (or from env vars).
#   2. Fetches the on-chain WASM hash for each contract via `stellar contract
#      info` (requires Stellar CLI ≥ v26).
#   3. Computes SHA-256 of the locally built WASM artifacts.
#   4. Compares them. Exits 0 if all match, non-zero if any differ.
#
# Prerequisites:
#   - `stellar` CLI ≥ v26 installed and on PATH.
#   - WASM artifacts already built:
#       cargo build --release --target wasm32v1-none --locked
#   - For mainnet verification, set STELLAR_NETWORK=mainnet (or pass --network).
#
# Environment variables (all optional — override auto-detected values):
#   STELLAR_NETWORK          testnet | mainnet  (default: testnet)
#   STELLAR_RPC_URL          Override the default RPC for the chosen network.
#   ISSUER_REGISTRY_ID       Contract ID for IssuerRegistry
#   CREDENTIAL_VERIFIER_ID   Contract ID for CredentialVerifier
#   PROOF_REGISTRY_ID        Contract ID for ProofRegistry
#   GATED_POOL_ID            Contract ID for GatedPool

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[verify-wasm]${NC} $*"; }
warn()    { echo -e "${YELLOW}[verify-wasm]${NC} $*"; }
error()   { echo -e "${RED}[verify-wasm] ERROR:${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --network)  NETWORK="$2";  shift 2 ;;
        --rpc-url)  RPC_URL="$2";  shift 2 ;;
        *) die "Unknown argument: $1" ;;
    esac
done

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
    die "Invalid network: '$NETWORK'. Expected 'testnet' or 'mainnet'."
fi

# Default RPC URLs per network.
if [[ -z "$RPC_URL" ]]; then
    case "$NETWORK" in
        testnet) RPC_URL="https://soroban-testnet.stellar.org" ;;
        mainnet) RPC_URL="https://mainnet.sorobanrpc.com" ;;
    esac
fi

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------
command -v stellar >/dev/null 2>&1  || die "'stellar' CLI not found. Install with: cargo install stellar-cli --locked --version 27.0.0"
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || die "sha256sum / shasum not found."

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_DIR="$REPO_ROOT/target/wasm32v1-none/release"

if [[ ! -d "$WASM_DIR" ]]; then
    die "WASM directory not found: $WASM_DIR\nBuild first with:\n  cargo build --release --target wasm32v1-none --locked"
fi

# ---------------------------------------------------------------------------
# Contract ID resolution
# Read from env vars; fall back to the values recorded in DEPLOYMENTS.md.
# ---------------------------------------------------------------------------
parse_deployments_id() {
    # Extract Contract ID from the DEPLOYMENTS.md table for the given WASM name
    # and network section.
    local wasm_name="$1"
    local section="Testnet"
    [[ "$NETWORK" == "mainnet" ]] && section="Mainnet"

    grep -A50 "$section" "$REPO_ROOT/DEPLOYMENTS.md" 2>/dev/null \
        | grep "$wasm_name" \
        | grep -oE 'C[A-Z0-9]{55}' \
        | head -1 || true
}

ISSUER_REGISTRY_ID="${ISSUER_REGISTRY_ID:-$(parse_deployments_id issuer_registry)}"
CREDENTIAL_VERIFIER_ID="${CREDENTIAL_VERIFIER_ID:-$(parse_deployments_id credential_verifier)}"
PROOF_REGISTRY_ID="${PROOF_REGISTRY_ID:-$(parse_deployments_id proof_registry)}"
GATED_POOL_ID="${GATED_POOL_ID:-$(parse_deployments_id gated_pool)}"

# ---------------------------------------------------------------------------
# Build the contract map
# ---------------------------------------------------------------------------
declare -A CONTRACTS=(
    [issuer_registry]="$ISSUER_REGISTRY_ID"
    [credential_verifier]="$CREDENTIAL_VERIFIER_ID"
    [proof_registry]="$PROOF_REGISTRY_ID"
    [gated_pool]="$GATED_POOL_ID"
)

# ---------------------------------------------------------------------------
# sha256 helper — works on Linux (sha256sum) and macOS (shasum -a 256)
# ---------------------------------------------------------------------------
sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

# ---------------------------------------------------------------------------
# Fetch on-chain WASM hash via stellar CLI.
# `stellar contract info --wasm-hash` prints the hex hash stored on-chain.
# ---------------------------------------------------------------------------
fetch_onchain_hash() {
    local contract_id="$1"
    local network="$2"
    local rpc_url="$3"

    stellar contract info hash \
        --id "$contract_id" \
        --network "$network" \
        --rpc-url "$rpc_url" \
        2>/dev/null | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]' || true
}

# ---------------------------------------------------------------------------
# Main verification loop
# ---------------------------------------------------------------------------
info "Network:  $NETWORK"
info "RPC URL:  $RPC_URL"
info ""

PASS=0
FAIL=0
SKIP=0

for name in issuer_registry credential_verifier proof_registry gated_pool; do
    contract_id="${CONTRACTS[$name]}"
    wasm_file="$WASM_DIR/${name}.wasm"

    echo "─────────────────────────────────────"
    info "Contract: $name"

    # Local hash
    if [[ ! -f "$wasm_file" ]]; then
        warn "  WASM not found: $wasm_file  (skipping)"
        (( SKIP++ )) || true
        continue
    fi
    local_hash="$(sha256_file "$wasm_file")"
    info "  Local SHA-256:   $local_hash"

    # On-chain hash
    if [[ -z "$contract_id" || "$contract_id" == *"Placeholder"* ]]; then
        warn "  No contract ID for $NETWORK — skipping on-chain check."
        warn "  Set ${name^^}_ID env var or update DEPLOYMENTS.md."
        (( SKIP++ )) || true
        continue
    fi
    info "  Contract ID:     $contract_id"

    onchain_hash="$(fetch_onchain_hash "$contract_id" "$NETWORK" "$RPC_URL")"

    if [[ -z "$onchain_hash" ]]; then
        warn "  Could not fetch on-chain hash (network error or contract not found)."
        (( SKIP++ )) || true
        continue
    fi
    info "  On-chain hash:   $onchain_hash"

    # Compare
    # On-chain hash is the hash of the WASM stored in the ledger. Soroban stores
    # the raw SHA-256 of the WASM bytes, matching sha256sum output directly.
    if [[ "$local_hash" == "$onchain_hash" ]]; then
        echo -e "  ${GREEN}✓ MATCH${NC}"
        (( PASS++ )) || true
    else
        echo -e "  ${RED}✗ MISMATCH${NC}"
        error "  Local:    $local_hash"
        error "  On-chain: $onchain_hash"
        (( FAIL++ )) || true
    fi
done

echo "═════════════════════════════════════"
info "Results: $PASS matched, $FAIL mismatched, $SKIP skipped"

if [[ $FAIL -gt 0 ]]; then
    error "One or more contracts did not match the on-chain WASM."
    error "Ensure you are building from the correct commit with:"
    error "  cargo build --release --target wasm32v1-none --locked"
    exit 1
fi

if [[ $SKIP -gt 0 && $PASS -eq 0 ]]; then
    warn "All contracts were skipped — no verification performed."
    exit 0
fi

info "All verified contracts match the on-chain deployment. ✓"

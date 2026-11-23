#!/usr/bin/env bash
# scripts/benchmark-with-provenance.sh
#
# Wrapper around scripts/benchmark.sh that records full provenance alongside
# every benchmark run so that results are reproducible and comparable across
# releases.
#
# Provenance captured:
#   - Git commit hash and tags
#   - Rust toolchain version (rustc, cargo)
#   - Stellar CLI version
#   - Noir (nargo) and Barretenberg (bb) versions if present
#   - Network and RPC URL
#   - Ledger context (current ledger sequence, protocol version)
#   - Command parameters used for the run
#   - Timestamp (UTC, ISO-8601)
#
# Output:
#   benchmark_results.txt       â€” raw per-function metrics (appended by benchmark.sh)
#   benchmark_provenance.jsonl  â€” one JSON record per run (newline-delimited)
#
# Usage:
#   # Same flags as benchmark.sh, plus optionally:
#   ./scripts/benchmark-with-provenance.sh [--provenance-file <path>] [all benchmark.sh flags]
#
# The provenance JSONL file can be passed to scripts/benchmark-compare.sh to
# compare any two runs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROVENANCE_FILE="${PROVENANCE_FILE:-$REPO_ROOT/benchmark_provenance.jsonl}"
RESULTS_FILE="${RESULTS_FILE:-$REPO_ROOT/benchmark_results.txt}"

# ---------------------------------------------------------------------------
# Parse out --provenance-file before forwarding remaining args to benchmark.sh
# ---------------------------------------------------------------------------
FORWARD_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provenance-file) PROVENANCE_FILE="$2"; shift 2 ;;
    *) FORWARD_ARGS+=("$1"); shift ;;
  esac
done

# ---------------------------------------------------------------------------
# Collect provenance fields
# ---------------------------------------------------------------------------
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "unknown")"
GIT_TAGS="$(git tag --points-at HEAD 2>/dev/null | tr '\n' ',' | sed 's/,$//' || echo "")"
GIT_DIRTY="$(git status --porcelain 2>/dev/null | grep -c '' || echo "0")"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"

RUSTC_VER="$(rustc --version 2>/dev/null || echo "not found")"
CARGO_VER="$(cargo --version 2>/dev/null || echo "not found")"
RUST_TOOLCHAIN="$(cat "$REPO_ROOT/rust-toolchain.toml" 2>/dev/null | grep 'channel' | tr -d ' "' | sed 's/channel=//' || echo "unknown")"

STELLAR_VER="$(stellar --version 2>/dev/null | head -1 || echo "not found")"
NARGO_VER="$(nargo --version 2>/dev/null | head -1 || echo "not found")"
BB_VER="$(bb --version 2>/dev/null | head -1 || echo "not found")"

NETWORK="${NETWORK:-${STELLAR_NETWORK:-testnet}}"
RPC_URL="${STELLAR_RPC_URL:-}"
if [[ -z "$RPC_URL" ]]; then
  case "$NETWORK" in
    testnet) RPC_URL="https://soroban-testnet.stellar.org" ;;
    mainnet) RPC_URL="https://mainnet.sorobanrpc.com" ;;
  esac
fi

# Try to fetch current ledger context (non-fatal)
LEDGER_SEQ="unknown"
PROTOCOL_VER="unknown"
if command -v stellar >/dev/null 2>&1; then
  LEDGER_INFO="$(stellar network status --network "$NETWORK" 2>/dev/null || true)"
  if [[ -n "$LEDGER_INFO" ]]; then
    LEDGER_SEQ="$(echo "$LEDGER_INFO" | grep -oE '"sequence":\s*[0-9]+' | grep -oE '[0-9]+' | head -1 || echo "unknown")"
    PROTOCOL_VER="$(echo "$LEDGER_INFO" | grep -oE '"protocol_version":\s*[0-9]+' | grep -oE '[0-9]+' | head -1 || echo "unknown")"
  fi
fi

# ---------------------------------------------------------------------------
# Write provenance header to JSONL before the benchmark run
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$PROVENANCE_FILE")"

PROVENANCE_RECORD="$(cat <<EOF
{
  "timestamp": "$TIMESTAMP",
  "git": {
    "commit": "$GIT_COMMIT",
    "branch": "$GIT_BRANCH",
    "tags": "$GIT_TAGS",
    "dirty": $([[ "$GIT_DIRTY" -gt 0 ]] && echo "true" || echo "false")
  },
  "toolchain": {
    "rustc": "$RUSTC_VER",
    "cargo": "$CARGO_VER",
    "rust_channel": "$RUST_TOOLCHAIN",
    "stellar_cli": "$STELLAR_VER",
    "nargo": "$NARGO_VER",
    "barretenberg": "$BB_VER"
  },
  "environment": {
    "network": "$NETWORK",
    "rpc_url": "$RPC_URL",
    "ledger_sequence": "$LEDGER_SEQ",
    "protocol_version": "$PROTOCOL_VER"
  },
  "parameters": $(printf '%s\n' "${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}" | jq -R . | jq -s . 2>/dev/null || echo "[]"),
  "results_file": "$RESULTS_FILE",
  "status": "started"
}
EOF
)"

echo "$PROVENANCE_RECORD" >> "$PROVENANCE_FILE"
echo "[provenance] Recorded run metadata to $PROVENANCE_FILE"
echo "[provenance] git commit: $GIT_COMMIT${GIT_TAGS:+ tags: $GIT_TAGS}"
echo "[provenance] rustc: $RUSTC_VER | stellar: $STELLAR_VER"
echo "[provenance] network: $NETWORK | ledger: $LEDGER_SEQ | protocol: $PROTOCOL_VER"
echo ""

# ---------------------------------------------------------------------------
# Run the actual benchmark
# ---------------------------------------------------------------------------
BENCHMARK_EXIT=0
NETWORK="$NETWORK" RESULTS_FILE="$RESULTS_FILE" \
  bash "$REPO_ROOT/scripts/benchmark.sh" "${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}" || BENCHMARK_EXIT=$?

# ---------------------------------------------------------------------------
# Update provenance record with final status
# ---------------------------------------------------------------------------
STATUS="$([[ $BENCHMARK_EXIT -eq 0 ]] && echo "completed" || echo "failed")"
FINISHED_RECORD="$(cat <<EOF
{
  "timestamp": "$TIMESTAMP",
  "git_commit": "$GIT_COMMIT",
  "network": "$NETWORK",
  "status": "$STATUS",
  "exit_code": $BENCHMARK_EXIT,
  "finished_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)"
echo "$FINISHED_RECORD" >> "$PROVENANCE_FILE"

echo ""
echo "[provenance] Run $STATUS (exit $BENCHMARK_EXIT). Full provenance in $PROVENANCE_FILE"

exit $BENCHMARK_EXIT

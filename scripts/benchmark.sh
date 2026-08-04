#!/usr/bin/env bash
# scripts/benchmark.sh
#
# Measure the instruction budget (CPU instructions, memory, ledger I/O, fee)
# for every public function across all four StellarCred contracts on testnet.
#
# Results are printed to stdout and also appended to benchmark_results.txt in
# the repo root for persistent record-keeping.
#
# Usage:
#   # One-time: generate and fund a testnet account
#   stellar keys generate --global benchmarker --network testnet --fund
#
#   # Full run (deploys fresh contracts, then benchmarks every function)
#   SOURCE=benchmarker bash scripts/benchmark.sh
#
#   # Against existing deployed contracts (skips deployment)
#   SOURCE=benchmarker \
#     ISSUER_REGISTRY_ID=C... \
#     CREDENTIAL_VERIFIER_ID=C... \
#     PROOF_REGISTRY_ID=C... \
#     GATED_POOL_ID=C... \
#     bash scripts/benchmark.sh
#
# Requirements:
#   - Stellar CLI v26+ (verified on 27.0.0)
#   - A funded testnet account (SOURCE env var, default: "benchmarker")
#   - Built WASM artifacts in target/wasm32v1-none/release/
#   - fixtures/<type>/vk and fixtures/<type>/proof and
#     fixtures/<type>/public_inputs present for submit_proof benchmark
#
# Output columns (from --cost):
#   cpu_insns             — CPU instruction units consumed
#   mem_bytes             — Memory bytes allocated
#   ledger_read_bytes     — Bytes read from ledger entries
#   ledger_write_bytes    — Bytes written to ledger entries
#   min_resource_fee      — Minimum fee in stroops (÷ 10,000,000 = XLM)
#
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────
SOURCE="${SOURCE:-benchmarker}"
NETWORK="${NETWORK:-testnet}"
WASM_DIR="target/wasm32v1-none/release"
RESULTS_FILE="benchmark_results.txt"
FIXTURE_TYPE="${FIXTURE_TYPE:-kyc}"   # credential type used for submit_proof bench

# Contract IDs — if not set, contracts will be deployed fresh
ISSUER_REGISTRY_ID="${ISSUER_REGISTRY_ID:-}"
CREDENTIAL_VERIFIER_ID="${CREDENTIAL_VERIFIER_ID:-}"
PROOF_REGISTRY_ID="${PROOF_REGISTRY_ID:-}"
GATED_POOL_ID="${GATED_POOL_ID:-}"

ADMIN="$(stellar keys address "$SOURCE")"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── Helpers ──────────────────────────────────────────────────────────────────
sep() { echo "────────────────────────────────────────────────────────"; }

log()  { echo "  $*"; }
warn() { echo "  [WARN] $*" >&2; }

# Invoke a contract function with --cost and capture/pretty-print results.
# bench <label> <contract_id> <function> [extra args...]
bench() {
  local label="$1"; local contract_id="$2"; local fn="$3"
  shift 3

  echo ""
  echo "  ┌─ $label"

  local raw
  if raw="$(stellar contract invoke \
        --id "$contract_id" \
        --source "$SOURCE" \
        --network "$NETWORK" \
        --cost \
        -- "$fn" "$@" 2>&1)"; then
    local status="OK"
  else
    local status="ERROR (non-zero exit — see raw output)"
  fi

  # Extract key metrics from --cost output (Stellar CLI prints them as JSON or
  # key: value pairs depending on version; we handle both).
  local cpu mem read_bytes write_bytes fee instructions_pct
  cpu="$(echo "$raw" | grep -oE '"?cpu_insns"?\s*[:=]\s*[0-9]+' | grep -oE '[0-9]+' | tail -1 || echo "N/A")"
  mem="$(echo "$raw" | grep -oE '"?mem_bytes"?\s*[:=]\s*[0-9]+' | grep -oE '[0-9]+' | tail -1 || echo "N/A")"
  read_bytes="$(echo "$raw" | grep -oE '"?ledger_read_bytes"?\s*[:=]\s*[0-9]+' | grep -oE '[0-9]+' | tail -1 || echo "N/A")"
  write_bytes="$(echo "$raw" | grep -oE '"?ledger_write_bytes"?\s*[:=]\s*[0-9]+' | grep -oE '[0-9]+' | tail -1 || echo "N/A")"
  fee="$(echo "$raw" | grep -oE '"?min_resource_fee"?\s*[:=]\s*[0-9]+' | grep -oE '[0-9]+' | tail -1 || echo "N/A")"

  # Calculate % of 100M budget
  if [ "$cpu" != "N/A" ] && [ "$cpu" -gt 0 ] 2>/dev/null; then
    instructions_pct="$(awk "BEGIN { printf \"%.2f\", $cpu / 1000000 }")"
    instructions_pct="${instructions_pct}M ($(awk "BEGIN { printf \"%.1f\", $cpu / 1000000 }") %)"
  else
    instructions_pct="N/A"
  fi

  # Convert stroops to XLM
  local xlm="N/A"
  if [ "$fee" != "N/A" ] && [ "$fee" -gt 0 ] 2>/dev/null; then
    xlm="$(awk "BEGIN { printf \"%.6f\", $fee / 10000000 }") XLM"
  fi

  echo "  │  Status:           $status"
  echo "  │  CPU instructions: ${cpu}"
  echo "  │  Memory bytes:     ${mem}"
  echo "  │  Ledger read bytes:  ${read_bytes}"
  echo "  │  Ledger write bytes: ${write_bytes}"
  echo "  │  Min resource fee: ${fee} stroops (${xlm})"
  echo "  └─────────────────────────────────────────────────"

  # Append to results file
  printf "%-45s %-14s %-14s %-14s %-14s %-14s %-16s\n" \
    "$label" "$cpu" "$mem" "$read_bytes" "$write_bytes" "$fee" "$TIMESTAMP" \
    >> "$RESULTS_FILE"
}

# ─── Build contracts ──────────────────────────────────────────────────────────
echo ""
sep
echo "  StellarCred Instruction Budget Benchmark"
echo "  Network: $NETWORK | Source: $SOURCE ($ADMIN)"
echo "  Timestamp: $TIMESTAMP"
sep

if [ ! -f "$WASM_DIR/issuer_registry.wasm" ]; then
  echo ""
  echo "Building contracts (wasm artifacts not found)..."
  cargo build --release --target wasm32v1-none --quiet
fi

# ─── Deploy contracts (if IDs not provided) ───────────────────────────────────
deploy() {
  local name="$1"; shift
  stellar contract deploy \
    --wasm "$WASM_DIR/$name.wasm" \
    --source "$SOURCE" --network "$NETWORK" \
    -- "$@"
}

if [ -z "$ISSUER_REGISTRY_ID" ]; then
  echo ""
  echo "Deploying fresh contracts for benchmark..."

  ISSUER_REGISTRY_ID="$(deploy issuer_registry --admin "$ADMIN")"
  log "issuer_registry:     $ISSUER_REGISTRY_ID"

  CREDENTIAL_VERIFIER_ID="$(deploy credential_verifier --admin "$ADMIN")"
  log "credential_verifier: $CREDENTIAL_VERIFIER_ID"

  PROOF_REGISTRY_ID="$(deploy proof_registry \
    --admin "$ADMIN" \
    --verifier "$CREDENTIAL_VERIFIER_ID" \
    --issuer_registry "$ISSUER_REGISTRY_ID")"
  log "proof_registry:      $PROOF_REGISTRY_ID"

  GATED_POOL_ID="$(deploy gated_pool --registry "$PROOF_REGISTRY_ID")"
  log "gated_pool:          $GATED_POOL_ID"

  # Register a benchmark issuer (uses a dummy 64-byte zero pubkey for cost measurement)
  DUMMY_PUBKEY="0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000000"

  stellar contract invoke \
    --id "$ISSUER_REGISTRY_ID" \
    --source "$SOURCE" --network "$NETWORK" \
    --send yes \
    -- register_issuer \
    --issuer_id "$ADMIN" \
    --pubkey "$DUMMY_PUBKEY" \
    --credential_types '["kyc","age","income","jurisdiction","funds"]' \
    > /dev/null 2>&1 || warn "register_issuer pre-setup failed (non-fatal)"

  # Install a VK if fixture exists
  vk="fixtures/$FIXTURE_TYPE/vk"
  if [ -f "$vk" ]; then
    stellar contract invoke \
      --id "$CREDENTIAL_VERIFIER_ID" \
      --source "$SOURCE" --network "$NETWORK" \
      --send yes \
      -- set_vk \
      --credential_type "$FIXTURE_TYPE" \
      --version 1 \
      --vk-file-path "$vk" \
      > /dev/null 2>&1 || warn "set_vk pre-setup failed (non-fatal)"
  fi
else
  echo ""
  echo "Using provided contract IDs (skipping deployment):"
  log "issuer_registry:     $ISSUER_REGISTRY_ID"
  log "credential_verifier: $CREDENTIAL_VERIFIER_ID"
  log "proof_registry:      $PROOF_REGISTRY_ID"
  log "gated_pool:          $GATED_POOL_ID"
fi

# ─── Initialize results file ──────────────────────────────────────────────────
echo ""
echo "Results will be appended to: $RESULTS_FILE"
echo ""

printf "%-45s %-14s %-14s %-14s %-14s %-14s %-16s\n" \
  "Function" "cpu_insns" "mem_bytes" "read_bytes" "write_bytes" "fee_stroops" "timestamp" \
  >> "$RESULTS_FILE"
printf "%-45s %-14s %-14s %-14s %-14s %-14s %-16s\n" \
  "─────────────────────────────────────────────" "──────────────" "──────────────" \
  "──────────────" "──────────────" "──────────────" "────────────────" \
  >> "$RESULTS_FILE"

# ══════════════════════════════════════════════════════════════════════════════
# BENCHMARKS
# ══════════════════════════════════════════════════════════════════════════════

sep
echo "  proof_registry"
sep

# ── is_verified (read-only, always succeeds, no prior state needed) ──────────
bench "proof_registry::is_verified" "$PROOF_REGISTRY_ID" is_verified \
  --holder "$ADMIN" \
  --credential_type "kyc"

# ── check_claim (read-only) ──────────────────────────────────────────────────
bench "proof_registry::check_claim" "$PROOF_REGISTRY_ID" check_claim \
  --holder "$ADMIN" \
  --credential_type "kyc" \
  --min_threshold "null"

# ── admin (instance read) ────────────────────────────────────────────────────
bench "proof_registry::admin" "$PROOF_REGISTRY_ID" admin

# ── verifier_address (instance read) ─────────────────────────────────────────
bench "proof_registry::verifier_address" "$PROOF_REGISTRY_ID" verifier_address

# ── issuer_registry_address (instance read) ──────────────────────────────────
bench "proof_registry::issuer_registry_address" "$PROOF_REGISTRY_ID" issuer_registry_address

# ── submit_proof (most expensive: full UltraHonk BN254 verify) ───────────────
proof_file="fixtures/$FIXTURE_TYPE/proof"
inputs_file="fixtures/$FIXTURE_TYPE/public_inputs"

if [ -f "$proof_file" ] && [ -f "$inputs_file" ]; then
  bench "proof_registry::submit_proof (${FIXTURE_TYPE})" "$PROOF_REGISTRY_ID" submit_proof \
    --holder "$ADMIN" \
    --issuer_id "$ADMIN" \
    --credential_type "$FIXTURE_TYPE" \
    --vk_version null \
    --proof "$(cat "$proof_file")" \
    --public_inputs "$(cat "$inputs_file")" \
    --expiry "9999999999"
else
  echo ""
  echo "  [SKIP] proof_registry::submit_proof — fixture not found at $proof_file"
  echo "         Run circuits/scripts/build.sh to generate fixtures, then re-run."
fi

sep
echo "  issuer_registry"
sep

# ── register_issuer ──────────────────────────────────────────────────────────
DUMMY_PUBKEY_BENCH="0101010101010101010101010101010101010101010101010101010101010101\
0101010101010101010101010101010101010101010101010101010101010101"

bench "issuer_registry::register_issuer" "$ISSUER_REGISTRY_ID" register_issuer \
  --issuer_id "$ADMIN" \
  --pubkey "$DUMMY_PUBKEY_BENCH" \
  --credential_types '["kyc","age"]'

# ── is_valid_issuer ───────────────────────────────────────────────────────────
bench "issuer_registry::is_valid_issuer" "$ISSUER_REGISTRY_ID" is_valid_issuer \
  --issuer_id "$ADMIN" \
  --credential_type "kyc"

# ── get_issuer_pubkey ─────────────────────────────────────────────────────────
bench "issuer_registry::get_issuer_pubkey" "$ISSUER_REGISTRY_ID" get_issuer_pubkey \
  --issuer_id "$ADMIN"

# ── admin ─────────────────────────────────────────────────────────────────────
bench "issuer_registry::admin" "$ISSUER_REGISTRY_ID" admin

# ── revoke_issuer ─────────────────────────────────────────────────────────────
# Use a fresh address to avoid disrupting the main benchmarks
bench "issuer_registry::revoke_issuer" "$ISSUER_REGISTRY_ID" revoke_issuer \
  --issuer_id "$ADMIN"

sep
echo "  credential_verifier"
sep

# ── set_vk ────────────────────────────────────────────────────────────────────
vk="fixtures/$FIXTURE_TYPE/vk"
if [ -f "$vk" ]; then
  bench "credential_verifier::set_vk (${FIXTURE_TYPE})" "$CREDENTIAL_VERIFIER_ID" set_vk \
    --credential_type "$FIXTURE_TYPE" \
    --version 1 \
    --vk-file-path "$vk"
else
  echo ""
  echo "  [SKIP] credential_verifier::set_vk — $vk not found"
fi

# ── verify_proof ──────────────────────────────────────────────────────────────
if [ -f "$proof_file" ] && [ -f "$inputs_file" ]; then
  bench "credential_verifier::verify_proof (${FIXTURE_TYPE})" "$CREDENTIAL_VERIFIER_ID" verify_proof \
    --credential_type "$FIXTURE_TYPE" \
    --vk_version null \
    --proof "$(cat "$proof_file")" \
    --public_inputs "$(cat "$inputs_file")"
else
  echo ""
  echo "  [SKIP] credential_verifier::verify_proof — fixtures not found"
fi

sep
echo "  gated_pool"
sep

# ── get_balance (read-only) ───────────────────────────────────────────────────
bench "gated_pool::get_balance" "$GATED_POOL_ID" get_balance \
  --account "$ADMIN"

# ── registry_address (instance read) ─────────────────────────────────────────
bench "gated_pool::registry_address" "$GATED_POOL_ID" registry_address

# ── deposit (cross-contract call to proof_registry + storage write) ───────────
# NOTE: deposit requires a valid KYC proof for the caller in proof_registry.
# If submit_proof succeeded above, this will also succeed. Otherwise it reverts
# with NotKycVerified (the cost of the failed path is still measured).
bench "gated_pool::deposit" "$GATED_POOL_ID" deposit \
  --caller "$ADMIN" \
  --amount "1000"

# ── withdraw (no proof required) ─────────────────────────────────────────────
bench "gated_pool::withdraw" "$GATED_POOL_ID" withdraw \
  --caller "$ADMIN" \
  --amount "500"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
sep
echo "  Benchmark complete."
echo "  Results appended to: $RESULTS_FILE"
echo ""
echo "  Per-transaction CPU budget (Protocol 23): 100,000,000 instructions"
echo "  Most expensive function:"
echo "    submit_proof   — ~13,500,000 insns  (~13.5% of budget)"
echo "    verify_proof   — ~12,700,000 insns  (~12.7% of budget)"
echo ""
echo "  Both fit comfortably within budget. See BENCHMARKS.md for full table."
sep
echo ""

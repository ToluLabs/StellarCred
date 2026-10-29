#!/usr/bin/env bash
# verify-deployment.sh — Verify a StellarCred deployment end-to-end.
#
# Verifies the whole chain for a network:
#   1. Fetches deployed contract IDs from DEPLOYMENTS.md.
#   2. Reads each contract version on-chain.
#   3. Rebuilds WASM artifacts reproducibly.
#   4. Compares local rebuilt WASM hashes against on-chain WASM hashes & DEPLOYMENTS.md.
#   5. Compares registered VKs against freshly compiled circuits and on-chain VK versions.
#   6. Prints a single PASS or FAIL result with any mismatches, exiting 0 or 1.
#
# Usage:
#   ./scripts/verify-deployment.sh [--network testnet|mainnet] [options]
#   ./scripts/verify-deployment.sh <manifest_file.json>   (legacy manifest mode)
#
# Options:
#   --network <testnet|mainnet>       Target Stellar network (default: testnet)
#   --rpc-url <url>                   Override default Soroban RPC URL
#   --source <account>                Optional source account for contract invocations
#   --rebuild-mode <auto|docker|local|skip>
#                                     WASM rebuild strategy (default: auto)
#   --skip-build                      Skip WASM rebuilding (use existing artifacts)
#   --skip-vks                        Skip circuit compilation and VK checks
#   --skip-onchain                    Skip on-chain reads (offline check against DEPLOYMENTS.md)
#   --help, -h                        Show this help message
#
# Environment variables:
#   STELLAR_NETWORK                   Default network (testnet | mainnet)
#   STELLAR_RPC_URL                   Default RPC URL
#   SOURCE                            Source account for contract invocation
#   ISSUER_REGISTRY_ID                Override IssuerRegistry contract ID
#   CREDENTIAL_VERIFIER_ID            Override CredentialVerifier contract ID
#   PROOF_REGISTRY_ID                 Override ProofRegistry contract ID
#   GATED_POOL_ID                     Override GatedPool contract ID

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Colors & output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  RED=$(tput setaf 1 2>/dev/null || true)
  GREEN=$(tput setaf 2 2>/dev/null || true)
  YELLOW=$(tput setaf 3 2>/dev/null || true)
  BLUE=$(tput setaf 4 2>/dev/null || true)
  BOLD=$(tput bold 2>/dev/null || true)
  NC=$(tput sgr0 2>/dev/null || true)
else
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  BOLD='\033[1m'
  NC='\033[0m'
fi

info()    { echo -e "${BLUE}[verify]${NC} $*"; }
ok()      { echo -e "  ${GREEN}✓${NC} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $*"; }
bad()     { echo -e "  ${RED}✗${NC} $*"; }
header()  { echo -e "\n${BOLD}$*${NC}"; }

# ---------------------------------------------------------------------------
# Portable key-value store (compatible with bash 3.2 on macOS and bash 4+)
# ---------------------------------------------------------------------------
set_kv() {
  local prefix="$1" key="$2" val="$3"
  eval "${prefix}_${key}=\"\$val\""
}

get_kv() {
  local prefix="$1" key="$2"
  eval "echo \"\${${prefix}_${key}:-}\""
}

# ---------------------------------------------------------------------------
# Legacy manifest-only verification mode
# ---------------------------------------------------------------------------
verify_manifest_legacy() {
  local manifest_file="$1"
  local wasm_dir="target/wasm32-unknown-unknown/release"
  [[ -d "$wasm_dir" ]] || wasm_dir="target/wasm32v1-none/release"

  if [ ! -f "$manifest_file" ]; then
    echo "Error: Manifest file not found: $manifest_file" >&2
    exit 1
  fi

  echo "Verifying deployment manifest: $manifest_file"
  echo ""

  local manifest_timestamp manifest_network manifest_admin
  manifest_timestamp=$(jq -r '.timestamp // "unknown"' "$manifest_file" 2>/dev/null || echo "unknown")
  manifest_network=$(jq -r '.network // "unknown"' "$manifest_file" 2>/dev/null || echo "unknown")
  manifest_admin=$(jq -r '.admin // "unknown"' "$manifest_file" 2>/dev/null || echo "unknown")

  echo "Deployment Info:"
  echo "  Timestamp: $manifest_timestamp"
  echo "  Network:   $manifest_network"
  echo "  Admin:     $manifest_admin"
  echo ""

  local all_valid=0

  echo "Verifying WASM Hashes:"
  for contract in issuer_registry credential_verifier proof_registry gated_pool; do
    local expected_hash
    expected_hash=$(jq -r ".contracts.\"$contract\".wasm_hash // empty" "$manifest_file" 2>/dev/null || true)
    if [ -z "$expected_hash" ]; then
      echo "⚠ $contract: No hash in manifest"
      continue
    fi

    local wasm_path="$wasm_dir/${contract}.wasm"
    if [ ! -f "$wasm_path" ]; then
      echo "✗ $contract: WASM file not found at $wasm_path"
      all_valid=1
      continue
    fi

    local computed_hash
    if command -v sha256sum &>/dev/null; then
      computed_hash=$(sha256sum "$wasm_path" | cut -d' ' -f1)
    else
      computed_hash=$(shasum -a 256 "$wasm_path" | cut -d' ' -f1)
    fi

    if [ "$computed_hash" = "$expected_hash" ]; then
      echo "✓ $contract: Hash matches"
    else
      echo "✗ $contract: Hash MISMATCH"
      echo "  Expected: $expected_hash"
      echo "  Computed: $computed_hash"
      all_valid=1
    fi
  done

  echo ""
  echo "Verifying Contract Versions:"
  for contract in issuer_registry credential_verifier proof_registry gated_pool; do
    local manifest_version cargo_version
    manifest_version=$(jq -r ".contracts.\"$contract\".version // empty" "$manifest_file" 2>/dev/null || true)
    if [ -z "$manifest_version" ]; then
      echo "⚠ $contract: No version in manifest"
      continue
    fi

    cargo_version=$(grep '^version = ' "contracts/$contract/Cargo.toml" 2>/dev/null | head -1 | sed 's/^version = "\(.*\)"/\1/' || echo "")
    if [ "$manifest_version" = "$cargo_version" ]; then
      echo "✓ $contract: Version matches (v$cargo_version)"
    else
      echo "⚠ $contract: Version mismatch"
      echo "  Manifest: v$manifest_version"
      echo "  Cargo:    v$cargo_version"
    fi
  done

  echo ""
  if [ $all_valid -eq 0 ]; then
    echo "✓ All WASM hashes verified successfully!"
    exit 0
  else
    echo "✗ WASM hash verification FAILED"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
show_help() {
  cat << 'EOF'
Usage:
  ./scripts/verify-deployment.sh [--network testnet|mainnet] [options]
  make verify-deployment [NETWORK=testnet|mainnet]

Verifies the entire deployment chain end to end:
  1. Fetches deployed contract IDs from DEPLOYMENTS.md.
  2. Reads each contract version on-chain.
  3. Rebuilds WASM artifacts reproducibly.
  4. Compares local rebuilt WASM hashes against on-chain WASM hashes & DEPLOYMENTS.md.
  5. Compares registered VKs against freshly compiled circuits and on-chain VK versions.
  6. Outputs a single PASS or FAIL result with detailed mismatch diagnostics.

Options:
  --network <testnet|mainnet>       Target network (default: testnet)
  --rpc-url <url>                   Override Soroban RPC URL
  --source <account>                Source account for read invocations (optional)
  --rebuild-mode <auto|docker|local|skip>
                                    Rebuild method: auto (default), docker, local, or skip
  --skip-build                      Skip WASM rebuilding (re-use existing target/ wasm)
  --skip-vks                        Skip circuit compilation and VK verification
  --skip-onchain                    Skip on-chain reads (run offline registry checks)
  --help, -h                        Show this message
EOF
}

NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL="${STELLAR_RPC_URL:-}"
SOURCE="${SOURCE:-}"
REBUILD_MODE="auto"
SKIP_BUILD=0
SKIP_VKS=0
SKIP_ONCHAIN=0

if [[ $# -eq 1 && ( "$1" =~ \.json$ || ( -f "$1" && "$1" != -* && "$1" != "testnet" && "$1" != "mainnet" ) ) ]]; then
  verify_manifest_legacy "$1"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="$2"; shift 2 ;;
    --rpc-url)
      RPC_URL="$2"; shift 2 ;;
    --source)
      SOURCE="$2"; shift 2 ;;
    --rebuild-mode)
      REBUILD_MODE="$2"; shift 2 ;;
    --skip-build)
      SKIP_BUILD=1; shift ;;
    --skip-vks)
      SKIP_VKS=1; shift ;;
    --skip-onchain)
      SKIP_ONCHAIN=1; shift ;;
    --help|-h)
      show_help; exit 0 ;;
    testnet|mainnet)
      NETWORK="$1"; shift ;;
    *)
      if [[ "$1" =~ \.json$ || -f "$1" ]]; then
        verify_manifest_legacy "$1"
      fi
      echo "Error: Unknown argument: $1" >&2
      show_help >&2
      exit 1
      ;;
  esac
done

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "Error: Invalid network '$NETWORK'. Expected 'testnet' or 'mainnet'." >&2
  exit 1
fi

if [[ -z "$RPC_URL" ]]; then
  case "$NETWORK" in
    testnet) RPC_URL="https://soroban-testnet.stellar.org" ;;
    mainnet) RPC_URL="https://mainnet.sorobanrpc.com" ;;
  esac
fi

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  REBUILD_MODE="skip"
fi

# ---------------------------------------------------------------------------
# Tracking mismatches
# ---------------------------------------------------------------------------
MISMATCHES=()

record_mismatch() {
  local msg="$1"
  MISMATCHES+=("$msg")
}

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
sha256_file() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  else
    shasum -a 256 "$f" | awk '{print $1}'
  fi
}

decode_version() {
  local raw="$1"
  raw="$(echo "$raw" | tr -d '[:space:]"')"
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    local major=$((raw / 1000000))
    local minor=$(((raw % 1000000) / 1000))
    local patch=$((raw % 1000))
    echo "$major.$minor.$patch"
  else
    echo "$raw" | sed 's/^v//'
  fi
}

# Extract network section bounded between `## <Network>` and the next `## `
get_deployments_section() {
  local net="$1"
  awk -v sec="^## .*${net}" '
    tolower($0) ~ tolower(sec) { found=1; next }
    found && /^## / { exit }
    found { print }
  ' "$REPO_ROOT/DEPLOYMENTS.md"
}

get_cargo_version() {
  local contract="$1"
  grep '^version = ' "$REPO_ROOT/contracts/$contract/Cargo.toml" 2>/dev/null \
    | head -1 \
    | sed 's/^version = "\(.*\)"/\1/' || echo "unknown"
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo "================================================================================"
echo -e "${BOLD}StellarCred End-to-End Deployment Verification${NC}"
echo "================================================================================"
info "Network:      $NETWORK"
info "RPC URL:      $RPC_URL"
info "Rebuild Mode: $REBUILD_MODE"
info "Skip Build:   $([[ $SKIP_BUILD -eq 1 ]] && echo 'yes' || echo 'no')"
info "Skip VKs:     $([[ $SKIP_VKS -eq 1 ]] && echo 'yes' || echo 'no')"
info "Skip Onchain: $([[ $SKIP_ONCHAIN -eq 1 ]] && echo 'yes' || echo 'no')"

# ---------------------------------------------------------------------------
# Step 1: Fetch Contract IDs & Expected WASM Hashes from DEPLOYMENTS.md
# ---------------------------------------------------------------------------
header "--- Step 1: Contract IDs from DEPLOYMENTS.md ---"

DEPLOYMENTS_SECTION="$(get_deployments_section "$NETWORK")"
CONTRACT_NAMES=(issuer_registry credential_verifier proof_registry gated_pool)

for name in "${CONTRACT_NAMES[@]}"; do
  line="$(echo "$DEPLOYMENTS_SECTION" | grep -i "$name" | head -1 || true)"
  cid="$(echo "$line" | grep -oE 'C[A-Z0-9]{55}' | head -1 || true)"
  hash="$(echo "$line" | grep -oE '[a-f0-9]{64}' | head -1 || true)"

  # Allow environment variable overrides
  case "$name" in
    issuer_registry)     cid="${ISSUER_REGISTRY_ID:-$cid}" ;;
    credential_verifier) cid="${CREDENTIAL_VERIFIER_ID:-$cid}" ;;
    proof_registry)      cid="${PROOF_REGISTRY_ID:-$cid}" ;;
    gated_pool)          cid="${GATED_POOL_ID:-$cid}" ;;
  esac

  expected_ver="$(get_cargo_version "$name")"

  if [[ -n "$cid" && "$cid" != *"Placeholder"* && "$cid" != *"TBD"* ]]; then
    set_kv "CID" "$name" "$cid"
    ok "$name: $cid"
  else
    bad "$name: No contract ID recorded for $NETWORK in DEPLOYMENTS.md"
    record_mismatch "contract_id: $name has no valid deployed contract ID for $NETWORK"
  fi

  if [[ -n "$hash" ]]; then
    set_kv "EXPECTED_HASH" "$name" "$hash"
  else
    warn "$name: No expected WASM hash found in DEPLOYMENTS.md for $NETWORK"
  fi

  set_kv "EXPECTED_VERSION" "$name" "$expected_ver"
done

# ---------------------------------------------------------------------------
# Step 2: Read Each Contract Version On-Chain
# ---------------------------------------------------------------------------
header "--- Step 2: Contract Versions On-Chain ---"

if [[ "$SKIP_ONCHAIN" -eq 1 ]]; then
  info "Skipping on-chain version reads (--skip-onchain)."
else
  if ! command -v stellar >/dev/null 2>&1; then
    bad "'stellar' CLI not found on PATH. Install with: cargo install stellar-cli --locked --version 27.0.0"
    record_mismatch "prerequisite: 'stellar' CLI not installed"
  else
    for name in "${CONTRACT_NAMES[@]}"; do
      cid="$(get_kv "CID" "$name")"
      expected_ver="$(get_kv "EXPECTED_VERSION" "$name")"

      if [[ -z "$cid" ]]; then
        bad "$name: Skipped on-chain version read (no contract ID)"
        continue
      fi

      cmd=(stellar contract invoke --id "$cid" --network "$NETWORK" --rpc-url "$RPC_URL")
      if [[ -n "$SOURCE" ]]; then
        cmd+=(--source "$SOURCE")
      fi
      cmd+=(-- version)

      raw_ver="$("${cmd[@]}" 2>/dev/null | tr -d '[:space:]"' || true)"
      if [[ -z "$raw_ver" ]]; then
        bad "$name: Failed to read on-chain version (contract: $cid)"
        record_mismatch "version: $name on-chain version could not be retrieved from $cid"
        continue
      fi

      decoded_ver="$(decode_version "$raw_ver")"
      set_kv "ONCHAIN_VERSION" "$name" "$decoded_ver"

      # Check version agreement
      if [[ "$decoded_ver" == "$expected_ver" || "$raw_ver" == "$expected_ver" ]]; then
        ok "$name: on-chain v$decoded_ver matches expected v$expected_ver (raw: $raw_ver)"
      else
        bad "$name: version MISMATCH — on-chain is v$decoded_ver (raw: $raw_ver), expected v$expected_ver"
        record_mismatch "version: $name on-chain v$decoded_ver != expected v$expected_ver"
      fi
    done
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: Rebuild WASM Artifacts Reproducibly
# ---------------------------------------------------------------------------
header "--- Step 3: Rebuild WASM Artifacts Reproducibly ---"

WASM_OUTPUT_DIR="$REPO_ROOT/target/wasm32v1-none/release"
BUILD_SUCCESS=1

if [[ "$REBUILD_MODE" == "skip" ]]; then
  info "Skipping rebuild (--skip-build / --rebuild-mode skip)."
  if [[ ! -d "$WASM_OUTPUT_DIR" ]]; then
    bad "WASM output directory not found: $WASM_OUTPUT_DIR"
    record_mismatch "wasm_build: directory $WASM_OUTPUT_DIR not found for hash check"
    BUILD_SUCCESS=0
  fi
else
  # Decide whether to use Docker or local build
  USE_DOCKER=0
  if [[ "$REBUILD_MODE" == "docker" ]]; then
    USE_DOCKER=1
  elif [[ "$REBUILD_MODE" == "auto" ]]; then
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      USE_DOCKER=1
    fi
  fi

  mkdir -p "$WASM_OUTPUT_DIR"

  if [[ "$USE_DOCKER" -eq 1 ]]; then
    info "Rebuilding WASM inside pinned reproducible container (docker/Dockerfile.reproducible)..."
    if docker build -f docker/Dockerfile.reproducible -t stellarcred-build:verify . >/dev/null 2>&1; then
      if docker run --rm \
          -v "$WASM_OUTPUT_DIR:/out" \
          --env SOURCE_DATE_EPOCH=0 \
          stellarcred-build:verify >/dev/null 2>&1; then
        ok "Docker reproducible build succeeded."
      else
        bad "Docker reproducible container run failed."
        record_mismatch "wasm_build: Docker reproducible container run failed"
        BUILD_SUCCESS=0
      fi
    else
      bad "Docker image build failed."
      record_mismatch "wasm_build: docker build -f docker/Dockerfile.reproducible failed"
      BUILD_SUCCESS=0
    fi
  else
    info "Rebuilding WASM locally via cargo (cargo build --release --target wasm32v1-none --locked)..."
    if ! command -v cargo >/dev/null 2>&1; then
      bad "Cargo is not installed on PATH."
      record_mismatch "wasm_build: cargo not installed"
      BUILD_SUCCESS=0
    else
      if SOURCE_DATE_EPOCH=0 cargo build --release --target wasm32v1-none --locked >/dev/null 2>&1; then
        ok "Local reproducible build succeeded."
      else
        bad "Local cargo build failed."
        record_mismatch "wasm_build: cargo build --release --target wasm32v1-none failed"
        BUILD_SUCCESS=0
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 4: Compare WASM Hashes (Local vs On-Chain vs DEPLOYMENTS.md)
# ---------------------------------------------------------------------------
header "--- Step 4: Compare WASM Hashes ---"

fetch_onchain_hash() {
  local contract_id="$1"
  local network="$2"
  local rpc_url="$3"

  stellar contract info hash \
    --id "$contract_id" \
    --network "$network" \
    --rpc-url "$rpc_url" 2>/dev/null \
    | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]' || true
}

for name in "${CONTRACT_NAMES[@]}"; do
  wasm_path="$WASM_OUTPUT_DIR/${name}.wasm"
  cid="$(get_kv "CID" "$name")"
  expected_hash="$(get_kv "EXPECTED_HASH" "$name")"

  echo "Contract: $name"

  # Compute local hash
  local_hash=""
  if [[ -f "$wasm_path" ]]; then
    local_hash="$(sha256_file "$wasm_path")"
    info "  Local Rebuilt SHA-256: $local_hash"
  else
    bad "  WASM artifact missing: $wasm_path"
    record_mismatch "wasm_hash: $name missing artifact at $wasm_path"
  fi

  # Check expected hash from DEPLOYMENTS.md
  if [[ -n "$expected_hash" ]]; then
    info "  DEPLOYMENTS.md SHA-256: $expected_hash"
    if [[ -n "$local_hash" && "$local_hash" == "$expected_hash" ]]; then
      ok "  Local rebuild matches DEPLOYMENTS.md"
    elif [[ -n "$local_hash" ]]; then
      bad "  Local rebuild does NOT match DEPLOYMENTS.md expected hash"
      record_mismatch "wasm_hash: $name local ($local_hash) != DEPLOYMENTS.md ($expected_hash)"
    fi
  fi

  # Check on-chain hash
  if [[ "$SKIP_ONCHAIN" -eq 1 ]]; then
    info "  On-chain hash check skipped (--skip-onchain)"
  elif [[ -z "$cid" ]]; then
    bad "  On-chain hash check skipped (no contract ID)"
  elif ! command -v stellar >/dev/null 2>&1; then
    bad "  On-chain hash check skipped (stellar CLI not installed)"
  else
    onchain_hash="$(fetch_onchain_hash "$cid" "$NETWORK" "$RPC_URL")"
    if [[ -z "$onchain_hash" ]]; then
      bad "  Failed to retrieve on-chain hash for $cid"
      record_mismatch "wasm_hash: $name failed to fetch on-chain hash"
    else
      info "  On-Chain WASM Hash:     $onchain_hash"
      if [[ -n "$local_hash" && "$local_hash" == "$onchain_hash" ]]; then
        ok "  Local rebuild matches on-chain deployment"
      else
        bad "  Local rebuild does NOT match on-chain hash"
        record_mismatch "wasm_hash: $name local ($local_hash) != on-chain ($onchain_hash)"
      fi
    fi
  fi
done

# ---------------------------------------------------------------------------
# Step 5: Compare Registered VKs Against Freshly Compiled Circuits
# ---------------------------------------------------------------------------
header "--- Step 5: Circuit Verification Keys (VKs) ---"

if [[ "$SKIP_VKS" -eq 1 ]]; then
  info "Skipping circuit VK verification (--skip-vks)."
else
  # Check circuit toolchain
  if ! command -v nargo >/dev/null 2>&1 || ! command -v bb >/dev/null 2>&1; then
    bad "Noir (nargo) or Barretenberg (bb) not found on PATH."
    warn "Run: noirup -v 1.0.0-beta.9 && bbup -v 0.87.0"
    record_mismatch "circuit_vks: pinned Noir/Barretenberg toolchain missing"
  else
    info "Compiling Noir circuits and verifying deterministic VK hashes against test vectors..."
    if node circuits/scripts/testvectors.js check; then
      ok "Freshly compiled circuit VKs match committed test vectors and declared circuit versions."
    else
      bad "Circuit test vector or VK check FAILED (circuit drift detected)."
      record_mismatch "circuit_vks: freshly compiled VK hashes do not match committed test vectors"
    fi
  fi

  # Check on-chain registered VK version on CredentialVerifier if available
  verifier_id="$(get_kv "CID" "credential_verifier")"
  if [[ "$SKIP_ONCHAIN" -eq 0 && -n "$verifier_id" ]] && command -v stellar >/dev/null 2>&1; then
    info "Verifying on-chain registered VK versions in CredentialVerifier ($verifier_id)..."

    CIRCUIT_VERSIONS_FILE="$REPO_ROOT/circuits/circuit-versions.json"
    for type in kyc age income jurisdiction funds accreditation employment; do
      cmd=(stellar contract invoke --id "$verifier_id" --network "$NETWORK" --rpc-url "$RPC_URL")
      if [[ -n "$SOURCE" ]]; then
        cmd+=(--source "$SOURCE")
      fi
      cmd+=(-- get_latest_version --credential_type "$type")

      latest_vk_ver="$("${cmd[@]}" 2>/dev/null | tr -d '[:space:]"' || true)"
      expected_vk_ver="1"
      if [[ -f "$CIRCUIT_VERSIONS_FILE" ]]; then
        expected_vk_ver="$(jq -r ".circuits.\"${type}_proof\".vkVersion // 1" "$CIRCUIT_VERSIONS_FILE" 2>/dev/null || echo "1")"
      fi

      if [[ -n "$latest_vk_ver" ]]; then
        if [[ "$latest_vk_ver" == "$expected_vk_ver" ]]; then
          ok "VK for '$type': on-chain latest version is v$latest_vk_ver (expected v$expected_vk_ver)"
        else
          bad "VK for '$type': version MISMATCH — on-chain is v$latest_vk_ver, expected v$expected_vk_ver"
          record_mismatch "vk_version: $type on-chain VK version v$latest_vk_ver != expected v$expected_vk_ver"
        fi
      else
        warn "Could not read on-chain VK version for '$type' (may not be registered yet on $verifier_id)"
      fi
    done
  fi
fi

# ---------------------------------------------------------------------------
# Final Summary and Pass/Fail
# ---------------------------------------------------------------------------
echo ""
echo "================================================================================"
echo -e "${BOLD}VERIFICATION SUMMARY${NC}"
echo "================================================================================"

TOTAL_MISMATCHES=${#MISMATCHES[@]}

if [[ $TOTAL_MISMATCHES -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}RESULT: PASS${NC}"
  echo ""
  ok "All contract IDs, versions, reproducible WASM hashes, and VKs verified successfully."
  ok "The deployment at $NETWORK is running the code in this repository."
  echo "================================================================================"
  exit 0
else
  echo -e "${RED}${BOLD}RESULT: FAIL ($TOTAL_MISMATCHES mismatch(es) detected)${NC}"
  echo ""
  echo "Mismatches:"
  for m in "${MISMATCHES[@]}"; do
    echo -e "  ${RED}•${NC} $m"
  done
  echo ""
  echo "================================================================================"
  exit 1
fi

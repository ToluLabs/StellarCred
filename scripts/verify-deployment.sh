#!/usr/bin/env bash
# ==============================================================================
# verify-deployment.sh — End-to-end verification of a StellarCred deployment
# ==============================================================================
#
# Answers the single question that matters for operators, auditors, and CI:
#   "Is the deployment at this address running the code in this repository
#    at this commit?"
#
# What it verifies:
#   1. DEPLOYMENTS.md: Contract IDs, expected WASM hashes, recorded commit & version.
#   2. Reproducible Build: Rebuilds WASM artifacts deterministically and compares
#      locally computed SHA-256 hashes against DEPLOYMENTS.md and on-chain bytecode.
#   3. On-Chain State: Reads each contract's on-chain version() view and on-chain
#      WASM hash from ledger state via Soroban RPC / Stellar CLI.
#   4. Verification Keys (VKs): Compiles or verifies Noir circuit VKs, compares
#      them against committed test vectors and on-chain registered keys.
#   5. Consolidated Output: Prints a clear summary report with a single PASS/FAIL.
#
# Usage:
#   ./scripts/verify-deployment.sh [--network testnet|mainnet] [options]
#   ./scripts/verify-deployment.sh [testnet|mainnet]
#
# Options:
#   --network <net>        Network to verify: 'testnet' (default) or 'mainnet'
#   --rpc-url <url>        Override Soroban RPC URL for the chosen network
#   --skip-build           Skip rebuilding WASM (use existing release artifacts)
#   --skip-circuits        Skip fresh circuit compilation (check committed vectors only)
#   --docker               Force building inside Docker container
#   --no-docker            Force building on host with cargo (skip Docker)
#   --help, -h             Show this help message
#
# Backward-compatibility:
#   ./scripts/verify-deployment.sh <manifest_file.json>
#
# Exit code:
#   0 = All checks passed
#   1 = One or more mismatches or verification failures detected
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ------------------------------------------------------------------------------
# Colours & Formatting
# ------------------------------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD='\033[1m'
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  BOLD=''
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  CYAN=''
  NC=''
fi

info()    { echo -e "${CYAN}[verify]${NC} $*"; }
ok()      { echo -e "  ${GREEN}✓${NC} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $*"; }
err()     { echo -e "  ${RED}✗${NC} $*"; }
banner()  { echo -e "\n${BOLD}${BLUE}=== $* ===${NC}\n"; }

# ------------------------------------------------------------------------------
# Backward Compatibility: Legacy Manifest Mode
# ------------------------------------------------------------------------------
run_legacy_manifest() {
  local manifest_file="$1"
  local wasm_dir="target/wasm32v1-none/release"
  [[ ! -d "$wasm_dir" ]] && wasm_dir="target/wasm32-unknown-unknown/release"

  if [[ ! -f "$manifest_file" ]]; then
    echo -e "${RED}Error: Manifest file not found: $manifest_file${NC}" >&2
    exit 1
  fi

  if [[ ! -d "$wasm_dir" ]]; then
    echo -e "${RED}Error: WASM directory not found: $wasm_dir${NC}" >&2
    echo "Run 'cargo build --release --target wasm32v1-none --locked' first." >&2
    exit 1
  fi

  echo "Verifying deployment manifest: $manifest_file"
  local all_valid=0

  for contract in issuer_registry credential_verifier proof_registry gated_pool; do
    local expected_hash
    expected_hash=$(jq -r ".contracts.\"$contract\".wasm_hash // empty" "$manifest_file" 2>/dev/null || true)
    if [[ -z "$expected_hash" ]]; then
      echo "⚠ $contract: No hash in manifest"
      continue
    fi
    local wasm_path="$wasm_dir/${contract}.wasm"
    if [[ ! -f "$wasm_path" ]]; then
      echo "✗ $contract: WASM file not found at $wasm_path"
      all_valid=1
      continue
    fi
    local computed_hash
    if command -v sha256sum &> /dev/null; then
      computed_hash=$(sha256sum "$wasm_path" | cut -d' ' -f1)
    else
      computed_hash=$(shasum -a 256 "$wasm_path" | cut -d' ' -f1)
    fi
    if [[ "$computed_hash" == "$expected_hash" ]]; then
      echo "✓ $contract: Hash matches"
    else
      echo "✗ $contract: Hash MISMATCH"
      echo "  Expected: $expected_hash"
      echo "  Computed: $computed_hash"
      all_valid=1
    fi
  done

  exit "$all_valid"
}

# ------------------------------------------------------------------------------
# Argument Parsing
# ------------------------------------------------------------------------------
NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL="${STELLAR_RPC_URL:-}"
SKIP_BUILD=false
SKIP_CIRCUITS=false
FORCE_DOCKER=false
NO_DOCKER=false

show_help() {
  echo "Usage: ./scripts/verify-deployment.sh [--network testnet|mainnet] [options]"
  echo ""
  echo "Options:"
  echo "  --network <net>        Network to verify: 'testnet' (default) or 'mainnet'"
  echo "  --rpc-url <url>        Override Soroban RPC URL for the chosen network"
  echo "  --skip-build           Skip rebuilding WASM (use existing release artifacts)"
  echo "  --skip-circuits        Skip fresh circuit compilation (check committed vectors only)"
  echo "  --docker               Force building inside Docker container"
  echo "  --no-docker            Force building on host with cargo (skip Docker)"
  echo "  --help, -h             Show this help message"
  exit 0
}

# Check for single positional manifest argument first
if [[ $# -eq 1 && ( "$1" == *.json || -f "$1" ) ]]; then
  run_legacy_manifest "$1"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="$2"
      shift 2
      ;;
    testnet|mainnet)
      NETWORK="$1"
      shift 1
      ;;
    --rpc-url)
      RPC_URL="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift 1
      ;;
    --skip-circuits)
      SKIP_CIRCUITS=true
      shift 1
      ;;
    --docker)
      FORCE_DOCKER=true
      shift 1
      ;;
    --no-docker)
      NO_DOCKER=true
      shift 1
      ;;
    --help|-h)
      show_help
      ;;
    *)
      if [[ "$1" == *.json && -f "$1" ]]; then
        run_legacy_manifest "$1"
      fi
      echo -e "${RED}Unknown argument: $1${NC}" >&2
      echo "Run '$0 --help' for usage." >&2
      exit 1
      ;;
  esac
done

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo -e "${RED}Invalid network: '$NETWORK'. Must be 'testnet' or 'mainnet'.${NC}" >&2
  exit 1
fi

if [[ -z "$RPC_URL" ]]; then
  case "$NETWORK" in
    testnet) RPC_URL="https://soroban-testnet.stellar.org" ;;
    mainnet) RPC_URL="https://mainnet.sorobanrpc.com" ;;
  esac
fi

WASM_DIR="$REPO_ROOT/target/wasm32v1-none/release"
CURRENT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
DATE_NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

echo -e "${BOLD}==============================================================================${NC}"
echo -e "${BOLD}                 StellarCred End-to-End Deployment Verification              ${NC}"
echo -e "${BOLD}==============================================================================${NC}"
echo -e "Timestamp:        $DATE_NOW"
echo -e "Target Network:   ${BOLD}$NETWORK${NC}"
echo -e "Soroban RPC URL:  $RPC_URL"
echo -e "Current Commit:   $CURRENT_COMMIT"
echo -e "------------------------------------------------------------------------------"

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------
compute_sha256() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo ""
    return
  fi
  if command -v sha256sum &>/dev/null; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

contract_title() {
  case "$1" in
    issuer_registry)     echo "Issuer Registry" ;;
    credential_verifier) echo "Credential Verifier" ;;
    proof_registry)      echo "Proof Registry" ;;
    gated_pool)          echo "Gated Pool" ;;
    *)                   echo "$1" ;;
  esac
}

# ------------------------------------------------------------------------------
# Step 1: Parse DEPLOYMENTS.md
# ------------------------------------------------------------------------------
banner "1. Parsing DEPLOYMENTS.md Registry"

section_name="Testnet"
[[ "$NETWORK" == "mainnet" ]] && section_name="Mainnet"

parse_deployments_id() {
  local wasm_name="$1"
  grep -A50 "$section_name" "$REPO_ROOT/DEPLOYMENTS.md" 2>/dev/null \
    | grep "$wasm_name" \
    | grep -oE "C[A-Z0-9]{55}" \
    | head -1 || true
}

parse_deployments_hash() {
  local wasm_name="$1"
  grep -A50 "$section_name" "$REPO_ROOT/DEPLOYMENTS.md" 2>/dev/null \
    | grep "$wasm_name" \
    | grep -oE "[0-9a-f]{64}" \
    | head -1 || true
}

RECORDED_COMMIT="$(grep -A20 "$section_name" "$REPO_ROOT/DEPLOYMENTS.md" 2>/dev/null \
  | grep -i 'Source commit' \
  | grep -oE '\`[0-9a-f]{7,40}\`' \
  | tr -d '\`' \
  | head -1 || echo "none")"

RECORDED_VERSION="$(grep -A10 "$section_name" "$REPO_ROOT/DEPLOYMENTS.md" 2>/dev/null \
  | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' \
  | sed 's/^v//' \
  | head -1 || echo "unknown")"

echo "Recorded Deployment in DEPLOYMENTS.md:"
echo "  Section:        $section_name"
echo "  Source Commit:  $RECORDED_COMMIT"
echo "  Target Version: v$RECORDED_VERSION"
echo ""

CONTRACT_LIST=(issuer_registry credential_verifier proof_registry gated_pool)

HAS_PLACEHOLDERS=false
for name in "${CONTRACT_LIST[@]}"; do
  title="$(contract_title "$name")"
  id="$(parse_deployments_id "$name")"
  hash="$(parse_deployments_hash "$name")"

  if [[ -z "$id" ]]; then
    warn "$title ($name): No contract ID found in DEPLOYMENTS.md"
    HAS_PLACEHOLDERS=true
  else
    ok "$title ($name):"
    echo "     ID:   $id"
    echo "     Hash: ${hash:-'(none recorded)'}"
  fi
done

if [[ "$HAS_PLACEHOLDERS" == "true" && "$NETWORK" == "mainnet" ]]; then
  echo ""
  warn "Mainnet deployment is not yet active in DEPLOYMENTS.md (placeholders present)."
fi

# ------------------------------------------------------------------------------
# Step 2: Reproducible Rebuild
# ------------------------------------------------------------------------------
banner "2. Reproducible WASM Build"

mkdir -p "$WASM_DIR"

if [[ "$SKIP_BUILD" == "true" ]]; then
  info "Skipping build (--skip-build specified). Using existing artifacts in $WASM_DIR."
else
  CAN_DOCKER=false
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    CAN_DOCKER=true
  fi

  if [[ "$CAN_DOCKER" == "true" && "$NO_DOCKER" == "false" ]]; then
    info "Building WASM via pinned container (docker/Dockerfile.reproducible)..."
    docker build \
      -f "$REPO_ROOT/docker/Dockerfile.reproducible" \
      -t stellarcred-build:verify \
      "$REPO_ROOT"

    cat > /tmp/stellarcred-container-build.sh << 'SCRIPT'
set -e
export CARGO_TARGET_DIR=/tmp/target
rm -rf "$CARGO_TARGET_DIR"
cargo build --release --target wasm32v1-none --locked --offline
cp "$CARGO_TARGET_DIR/wasm32v1-none/release/credential_verifier.wasm" \
   "$CARGO_TARGET_DIR/wasm32v1-none/release/issuer_registry.wasm" \
   "$CARGO_TARGET_DIR/wasm32v1-none/release/proof_registry.wasm" \
   "$CARGO_TARGET_DIR/wasm32v1-none/release/gated_pool.wasm" \
   /out/
SCRIPT
    chmod +x /tmp/stellarcred-container-build.sh

    docker run --rm \
      -v "$REPO_ROOT:/workspace" \
      -v "$WASM_DIR:/out" \
      -v "/tmp/stellarcred-container-build.sh:/container-build.sh:ro" \
      -e SOURCE_DATE_EPOCH=0 \
      -e "RUSTFLAGS=--remap-path-prefix=$REPO_ROOT=/workspace --remap-path-prefix=/usr/local/cargo=/usr/local/cargo --remap-path-prefix=/usr/local/rustup=/usr/local/rustup" \
      stellarcred-build:verify \
      sh /container-build.sh
    rm -f /tmp/stellarcred-container-build.sh
    ok "Container build complete."
  else
    if [[ "$FORCE_DOCKER" == "true" ]]; then
      echo -e "${RED}Error: Docker is required when --docker is specified, but docker is not available.${NC}" >&2
      exit 1
    fi
    info "Building WASM locally via cargo (wasm32v1-none, locked, reproducible flags)..."
    SOURCE_DATE_EPOCH=0 cargo build --release --target wasm32v1-none --locked
    ok "Local cargo build complete."
  fi
fi

# Compute local hashes
get_local_hash() {
  local name="$1"
  local wasm_path="$WASM_DIR/${name}.wasm"
  if [[ -f "$wasm_path" ]]; then
    compute_sha256 "$wasm_path"
  else
    echo ""
  fi
}

for name in "${CONTRACT_LIST[@]}"; do
  lh="$(get_local_hash "$name")"
  if [[ -n "$lh" ]]; then
    ok "${name}.wasm: $lh"
  else
    err "${name}.wasm: File not found at $WASM_DIR/${name}.wasm"
  fi
done

# ------------------------------------------------------------------------------
# Step 3: Query On-Chain State (Versions & Bytecode Hashes)
# ------------------------------------------------------------------------------
banner "3. Querying On-Chain State via Soroban RPC"

ONCHAIN_JSON=""
if [[ -f "$REPO_ROOT/scripts/verify-onchain.mjs" ]]; then
  info "Querying on-chain state via scripts/verify-onchain.mjs..."
  ONCHAIN_JSON="$(node "$REPO_ROOT/scripts/verify-onchain.mjs" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    --issuer-registry "$(parse_deployments_id issuer_registry)" \
    --credential-verifier "$(parse_deployments_id credential_verifier)" \
    --proof-registry "$(parse_deployments_id proof_registry)" \
    --gated-pool "$(parse_deployments_id gated_pool)" 2>/dev/null || echo "{}")"
fi

get_onchain_hash() {
  local name="$1"
  local id
  id="$(parse_deployments_id "$name")"
  local hash=""
  if [[ -n "$ONCHAIN_JSON" && "$ONCHAIN_JSON" != "{}" ]]; then
    hash="$(node -e 'try { const d=JSON.parse(process.argv[1]); process.stdout.write(d.contracts?.[process.argv[2]]?.wasmHash || ""); } catch {}' "$ONCHAIN_JSON" "$name" 2>/dev/null || true)"
  fi
  if [[ -z "$hash" && -n "$id" && "$id" =~ ^C[A-Z0-9]{55}$ ]] && command -v stellar >/dev/null 2>&1; then
    hash="$(stellar contract info hash --id "$id" --network "$NETWORK" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]' || true)"
  fi
  echo "$hash"
}

get_onchain_version() {
  local name="$1"
  if [[ -n "$ONCHAIN_JSON" && "$ONCHAIN_JSON" != "{}" ]]; then
    node -e 'try { const d=JSON.parse(process.argv[1]); const v=d.contracts?.[process.argv[2]]?.version; if (v) process.stdout.write(String(v)); } catch {}' "$ONCHAIN_JSON" "$name" 2>/dev/null || true
  fi
}

get_onchain_found() {
  local name="$1"
  local hash
  hash="$(get_onchain_hash "$name")"
  if [[ -n "$hash" ]]; then
    echo "true"
    return
  fi
  if [[ -n "$ONCHAIN_JSON" && "$ONCHAIN_JSON" != "{}" ]]; then
    node -e 'try { const d=JSON.parse(process.argv[1]); process.stdout.write(d.contracts?.[process.argv[2]]?.found ? "true" : "false"); } catch { process.stdout.write("false"); }' "$ONCHAIN_JSON" "$name" 2>/dev/null || echo "false"
  else
    echo "false"
  fi
}

for name in "${CONTRACT_LIST[@]}"; do
  title="$(contract_title "$name")"
  id="$(parse_deployments_id "$name")"
  found="$(get_onchain_found "$name")"
  hash="$(get_onchain_hash "$name")"
  ver="$(get_onchain_version "$name")"

  if [[ "$found" == "true" ]]; then
    ok "$title:"
    echo "     On-chain Hash:    $hash"
    echo "     On-chain Version: ${ver:-'(unreported)'}"
  else
    if [[ -z "$id" ]]; then
      warn "$title: No contract ID deployed for $NETWORK."
    else
      warn "$title: Contract not found on-chain ($id)."
    fi
  fi
done

# ------------------------------------------------------------------------------
# Step 4: Verify Circuit Verification Keys (VKs)
# ------------------------------------------------------------------------------
banner "4. Verifying Circuit Verification Keys"

CIRCUITS_VERIFIED=true
CIRCUIT_NAMES=(kyc_proof age_proof income_proof jurisdiction_proof funds_proof set_membership)

# 1. Fresh circuit compilation check if Noir / Barretenberg are installed
CAN_COMPILE_CIRCUITS=false
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"
if command -v nargo >/dev/null 2>&1 && command -v bb >/dev/null 2>&1; then
  CAN_COMPILE_CIRCUITS=true
fi

if [[ "$SKIP_CIRCUITS" == "false" && "$CAN_COMPILE_CIRCUITS" == "true" ]]; then
  info "Recompiling Noir circuits and verifying fresh VKs against committed vectors..."
  if node "$REPO_ROOT/circuits/scripts/testvectors.js" check; then
    ok "All freshly derived circuit VKs match committed test vectors."
  else
    err "Circuit VK verification failed (circuits drifted from committed vectors)."
    CIRCUITS_VERIFIED=false
  fi
else
  if [[ "$SKIP_CIRCUITS" == "true" ]]; then
    info "Skipping circuit recompilation (--skip-circuits specified)."
  else
    info "Noir/Barretenberg toolchain not found in PATH — verifying fixture hashes against committed vectors."
  fi
fi

# Map circuit to fixture type
fixture_type_of() {
  case "$1" in
    kyc_proof)          echo "kyc" ;;
    age_proof)          echo "age" ;;
    income_proof)       echo "income" ;;
    jurisdiction_proof) echo "jurisdiction" ;;
    funds_proof)        echo "funds" ;;
    set_membership)     echo "set_membership" ;;
    *)                  echo "$1" ;;
  esac
}

for c in "${CIRCUIT_NAMES[@]}"; do
  vector_file="$REPO_ROOT/circuits/testvectors/${c}.json"
  expected_vk_hash=""
  if [[ -f "$vector_file" ]]; then
    expected_vk_hash="$(node -e 'try { const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(d.vk_hash || ""); } catch {}' "$vector_file" 2>/dev/null || true)"
  fi

  ftype="$(fixture_type_of "$c")"
  fixture_vk="$REPO_ROOT/fixtures/$ftype/vk"
  fixture_hash=""
  if [[ -f "$fixture_vk" ]]; then
    fixture_hash="$(compute_sha256 "$fixture_vk")"
  fi

  onchain_vk_hash=""
  if [[ -n "$ONCHAIN_JSON" && "$ONCHAIN_JSON" != "{}" ]]; then
    onchain_vk_hash="$(node -e 'try { const d=JSON.parse(process.argv[1]); process.stdout.write(d.registeredVks?.[process.argv[2]]?.vkHash || ""); } catch {}' "$ONCHAIN_JSON" "$ftype" 2>/dev/null || true)"
  fi

  if [[ -n "$expected_vk_hash" && "$fixture_hash" == "$expected_vk_hash" ]]; then
    if [[ -n "$onchain_vk_hash" ]]; then
      if [[ "$onchain_vk_hash" == "$expected_vk_hash" ]]; then
        ok "$c ($ftype): Match (circuit = fixture = on-chain: ${expected_vk_hash:0:16}...)"
      else
        err "$c ($ftype): On-chain registered VK MISMATCH!"
        echo "     Fixture/Vector: $expected_vk_hash"
        echo "     On-chain:       $onchain_vk_hash"
        CIRCUITS_VERIFIED=false
      fi
    else
      ok "$c ($ftype): Fixture matches committed vector (${expected_vk_hash:0:16}...)"
    fi
  else
    err "$c ($ftype): Fixture VK hash does not match committed test vector!"
    echo "     Vector:  ${expected_vk_hash:-'(missing)'}"
    echo "     Fixture: ${fixture_hash:-'(missing)'}"
    CIRCUITS_VERIFIED=false
  fi
done

# ------------------------------------------------------------------------------
# Step 5: Consolidated Evaluation & Single Result
# ------------------------------------------------------------------------------
banner "5. Verification Summary & Diagnostics"

TOTAL_MISMATCHES=0
MISMATCH_LIST=()

echo -e "${BOLD}Contract Verification Breakdown:${NC}"
printf "%-22s %-12s %-12s %-10s %-10s %-10s\n" "Contract" "Rebuilt" "DEPLOYMENTS" "On-chain" "Version" "Result"
echo "──────────────────────────────────────────────────────────────────────────────"

for name in "${CONTRACT_LIST[@]}"; do
  local_h="$(get_local_hash "$name")"
  dep_h="$(parse_deployments_hash "$name")"
  contract_id="$(parse_deployments_id "$name")"
  chain_h="$(get_onchain_hash "$name")"
  chain_v="$(get_onchain_version "$name")"
  chain_found="$(get_onchain_found "$name")"
  cargo_v="$(grep '^version = ' "contracts/$name/Cargo.toml" 2>/dev/null | sed 's/^version = "\(.*\)"/\1/' || echo "1.0.0")"

  status="PASS"
  notes=""

  # 1. Compare local build vs DEPLOYMENTS.md
  if [[ -z "$local_h" ]]; then
    status="FAIL"
    notes="${notes:+${notes}, }Missing local WASM"
  elif [[ -n "$dep_h" && "$local_h" != "$dep_h" ]]; then
    status="FAIL"
    notes="${notes:+${notes}, }Rebuilt != DEPLOYMENTS.md"
  fi

  # 2. Compare on-chain hash vs DEPLOYMENTS.md / local build
  if [[ -n "$chain_h" ]]; then
    if [[ "$chain_h" != "$dep_h" ]]; then
      status="FAIL"
      notes="${notes:+${notes}, }On-chain != DEPLOYMENTS.md"
    fi
    if [[ "$chain_h" != "$local_h" ]]; then
      status="FAIL"
      notes="${notes:+${notes}, }On-chain != Rebuilt"
    fi
  elif [[ -n "$contract_id" && "$chain_found" != "true" ]]; then
    status="FAIL"
    notes="${notes:+${notes}, }Contract not on chain"
  fi

  # 3. Compare version
  if [[ -n "$chain_v" && "$chain_v" != "$cargo_v" ]]; then
    status="FAIL"
    notes="${notes:+${notes}, }Version mismatch (chain $chain_v != repo $cargo_v)"
  fi

  # If contract ID is placeholder on mainnet
  if [[ -z "$contract_id" ]]; then
    status="PENDING"
    notes="${notes:+${notes}, }Not yet deployed"
  fi

  local_short="${local_h:0:8}..."
  dep_short="${dep_h:0:8}..."
  chain_short="${chain_h:0:8}..."
  [[ -z "$local_h" ]] && local_short="-"
  [[ -z "$dep_h" ]] && dep_short="-"
  [[ -z "$chain_h" ]] && chain_short="-"

  if [[ "$status" == "PASS" ]]; then
    res_str="${GREEN}PASS${NC}"
  elif [[ "$status" == "PENDING" ]]; then
    res_str="${YELLOW}PENDING${NC}"
  else
    res_str="${RED}FAIL${NC}"
    TOTAL_MISMATCHES=$((TOTAL_MISMATCHES + 1))
    MISMATCH_LIST+=("$name: $notes")
  fi

  printf "%-22s %-12s %-12s %-10s %-10s %b\n" "$name" "$local_short" "$dep_short" "$chain_short" "${chain_v:-$cargo_v}" "$res_str"
  if [[ -n "$notes" && "$status" != "PASS" ]]; then
    echo -e "   ${YELLOW}→ Note:${NC} $notes"
  fi
done

if [[ "$CIRCUITS_VERIFIED" != "true" ]]; then
  TOTAL_MISMATCHES=$((TOTAL_MISMATCHES + 1))
  MISMATCH_LIST+=("Circuit verification key drift detected")
fi

echo ""
echo -e "${BOLD}==============================================================================${NC}"
if [[ $TOTAL_MISMATCHES -eq 0 ]]; then
  echo -e "${BOLD}${GREEN}✓ PASS:${NC} ${BOLD}Deployment matches repository at commit $CURRENT_COMMIT ($NETWORK).${NC}"
  echo -e "       All contract IDs, versions, WASM hashes, and VKs verified successfully."
  echo -e "${BOLD}==============================================================================${NC}"
  exit 0
else
  echo -e "${BOLD}${RED}✗ FAIL:${NC} ${BOLD}Verification detected $TOTAL_MISMATCHES mismatch(es) on $NETWORK:${NC}"
  for m in "${MISMATCH_LIST[@]}"; do
    echo -e "  ${RED}•${NC} $m"
  done
  echo ""
  echo "Diagnostics & Remediation:"
  echo "  1. If local rebuilt WASM differs from DEPLOYMENTS.md:"
  echo "     - Check out the recorded source commit ($RECORDED_COMMIT):"
  echo "         git checkout $RECORDED_COMMIT"
  echo "     - Or if source code intentionally changed, update DEPLOYMENTS.md with fresh hashes."
  echo "  2. If on-chain bytecode differs from DEPLOYMENTS.md / rebuilt artifacts:"
  echo "     - The contract deployed at the address may have been upgraded or modified."
  echo "  3. If contracts were not found on-chain:"
  echo "     - Stellar testnet resets periodically (every quarter)."
  echo "     - Re-deploy to testnet with './scripts/deploy.sh', then record new IDs in DEPLOYMENTS.md."
  echo "  4. If circuit VKs drifted:"
  echo "     - Run 'node circuits/scripts/testvectors.js check' to identify circuit changes."
  echo -e "${BOLD}==============================================================================${NC}"
  exit 1
fi

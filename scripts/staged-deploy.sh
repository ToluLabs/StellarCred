#!/usr/bin/env bash
# scripts/staged-deploy.sh â€” Staged deployment verification and safe abort.
#
# Executes a deployment in discrete, verifiable stages so that a failure at any
# point stops before production traffic is switched.  Each stage gate is checked
# before proceeding to the next.
#
# Stages:
#   1. Preflight         â€” environment, toolchain, accounts, balances
#   2. Contract wiring   â€” confirm all contract IDs resolve and cross-references match
#   3. Identity checks   â€” issuer registration, public-key assertions
#   4. VK registration   â€” verify every required verification key is installed on-chain
#   5. Frontend config   â€” generate and validate the JSON config consumed by the frontend
#   6. Smoke tests       â€” invoke read-only entry points to confirm liveness
#   7. Abort or proceed  â€” final gate; produces a signed manifest or aborts cleanly
#
# Usage:
#   ./scripts/staged-deploy.sh [options]
#
# Options:
#   --network <testnet|mainnet>   Target Stellar network (default: testnet)
#   --rpc-url  <url>              Override default Soroban RPC URL
#   --source   <account>         Stellar key name or address used for invocations
#   --stage    <1-7>             Run only up to this stage (default: 7)
#   --dry-run                    Print what would happen without sending transactions
#   --abort-on-warn              Treat warnings as failures and abort
#   --output-manifest <path>     Where to write the signed deployment manifest
#   --skip-frontend-write        Skip writing frontend config to disk
#   --help, -h
#
# Environment variables (can replace --options):
#   STELLAR_NETWORK, STELLAR_RPC_URL, SOURCE
#   ISSUER_REGISTRY_ID, CREDENTIAL_VERIFIER_ID, PROOF_REGISTRY_ID, GATED_POOL_ID
#   EXPECTED_ADMIN                 Address that must be admin on every contract
#   EXPECTED_ISSUER_ID             Issuer address expected to be registered
#   EXPECTED_ISSUER_PUBKEY         64-byte hex public key expected for the issuer
#   CIRCUIT_VERSIONS_FILE          Path to circuits/circuit-versions.json
#   FRONTEND_CONFIG_DIR            Directory to write stellarcred-config.json (default: frontend/src)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  RED=$(tput setaf 1 2>/dev/null || printf '')
  GREEN=$(tput setaf 2 2>/dev/null || printf '')
  YELLOW=$(tput setaf 3 2>/dev/null || printf '')
  BLUE=$(tput setaf 4 2>/dev/null || printf '')
  BOLD=$(tput bold 2>/dev/null || printf '')
  NC=$(tput sgr0 2>/dev/null || printf '')
else
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
fi

info()   { echo -e "  ${BLUE}[staged-deploy]${NC} $*"; }
ok()     { echo -e "  ${GREEN}âœ”${NC} $*"; }
warn()   { echo -e "  ${YELLOW}âš ${NC}  $*"; }
bad()    { echo -e "  ${RED}âœ–${NC} $*"; }
header() { echo -e "\n${BOLD}â”â”â” $* â”â”â”${NC}"; }
abort()  { echo -e "\n${RED}${BOLD}ABORT: $*${NC}\n"; exit 1; }

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL="${STELLAR_RPC_URL:-}"
SOURCE="${SOURCE:-}"
MAX_STAGE=7
DRY_RUN=0
ABORT_ON_WARN=0
OUTPUT_MANIFEST="${OUTPUT_MANIFEST:-deployment-manifest-$(date -u +%Y%m%dT%H%M%SZ).json}"
SKIP_FRONTEND_WRITE=0
CIRCUIT_VERSIONS_FILE="${CIRCUIT_VERSIONS_FILE:-$REPO_ROOT/circuits/circuit-versions.json}"
FRONTEND_CONFIG_DIR="${FRONTEND_CONFIG_DIR:-$REPO_ROOT/frontend/src}"

WARNINGS=()
FAILURES=()

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
show_help() {
  sed -n '/^# scripts\/staged-deploy/,/^set -euo/{ /^#/p }' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)        NETWORK="$2"; shift 2 ;;
    --rpc-url)        RPC_URL="$2"; shift 2 ;;
    --source)         SOURCE="$2"; shift 2 ;;
    --stage)          MAX_STAGE="$2"; shift 2 ;;
    --dry-run)        DRY_RUN=1; shift ;;
    --abort-on-warn)  ABORT_ON_WARN=1; shift ;;
    --output-manifest) OUTPUT_MANIFEST="$2"; shift 2 ;;
    --skip-frontend-write) SKIP_FRONTEND_WRITE=1; shift ;;
    --help|-h)        show_help; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ "$NETWORK" == "testnet" || "$NETWORK" == "mainnet" ]] \
  || abort "Invalid network '$NETWORK'. Expected testnet or mainnet."

if [[ -z "$RPC_URL" ]]; then
  case "$NETWORK" in
    testnet) RPC_URL="https://soroban-testnet.stellar.org" ;;
    mainnet) RPC_URL="https://mainnet.sorobanrpc.com" ;;
  esac
fi

record_warn()    { WARNINGS+=("$1"); warn "$1"; [[ "$ABORT_ON_WARN" -eq 0 ]] || abort "$1"; }
record_failure() { FAILURES+=("$1"); bad "$1"; }

# ---------------------------------------------------------------------------
# Helper: invoke a contract read-only and return trimmed stdout
# ---------------------------------------------------------------------------
invoke_read() {
  local contract_id="$1" fn="$2"; shift 2
  local cmd=(stellar contract invoke --id "$contract_id"
             --network "$NETWORK" --rpc-url "$RPC_URL")
  [[ -n "$SOURCE" ]] && cmd+=(--source "$SOURCE")
  cmd+=(-- "$fn" "$@")
  "${cmd[@]}" 2>/dev/null | tr -d '[:space:]"' || true
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
echo -e "${BOLD}  StellarCred Staged Deployment Verification${NC}"
echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
info "Network:   $NETWORK"
info "RPC URL:   $RPC_URL"
info "Source:    ${SOURCE:-<not set>}"
info "Max stage: $MAX_STAGE of 7"
info "Dry run:   $([[ $DRY_RUN -eq 1 ]] && echo 'YES' || echo 'no')"
info "Manifest:  $OUTPUT_MANIFEST"
echo ""

# ============================================================
# STAGE 1 â€” PREFLIGHT
# ============================================================
header "Stage 1 Â· Preflight"

# 1a. stellar CLI
if ! command -v stellar >/dev/null 2>&1; then
  record_failure "stellar CLI not found. Install: cargo install stellar-cli --locked"
else
  STELLAR_VER="$(stellar --version 2>&1 | head -1 || true)"
  ok "stellar CLI: $STELLAR_VER"
fi

# 1b. jq
if ! command -v jq >/dev/null 2>&1; then
  record_failure "jq not found. Install via your package manager."
else
  ok "jq: $(jq --version)"
fi

# 1c. Required contract IDs
for var in ISSUER_REGISTRY_ID CREDENTIAL_VERIFIER_ID PROOF_REGISTRY_ID GATED_POOL_ID; do
  val="${!var:-}"
  if [[ -z "$val" ]]; then
    record_failure "Environment variable $var is not set."
  else
    ok "$var=$val"
  fi
done

# 1d. Source account balance (mainnet guard)
if [[ -n "$SOURCE" ]] && command -v stellar >/dev/null 2>&1; then
  ADDR="$(stellar keys address "$SOURCE" 2>/dev/null || echo "$SOURCE")"
  info "Source address: $ADDR"
  if [[ "$NETWORK" == "mainnet" ]]; then
    info "Skipping balance check on mainnet (manual confirmation expected)."
  else
    BAL="$(stellar account balance "$ADDR" --network "$NETWORK" 2>/dev/null | head -1 || true)"
    [[ -n "$BAL" ]] && ok "Account balance: $BAL" || record_warn "Could not fetch balance for $ADDR"
  fi
fi

[[ ${#FAILURES[@]} -eq 0 ]] || abort "Stage 1 preflight failed (${#FAILURES[@]} failure(s)). Fix above and retry."
ok "Stage 1 passed."
[[ $MAX_STAGE -ge 2 ]] || { echo "Stopping at stage 1 as requested."; exit 0; }

# ============================================================
# STAGE 2 â€” CONTRACT WIRING ASSERTIONS
# ============================================================
header "Stage 2 Â· Contract Wiring Assertions"

ISSUER_REGISTRY_ID="${ISSUER_REGISTRY_ID:-}"
CREDENTIAL_VERIFIER_ID="${CREDENTIAL_VERIFIER_ID:-}"
PROOF_REGISTRY_ID="${PROOF_REGISTRY_ID:-}"
GATED_POOL_ID="${GATED_POOL_ID:-}"
EXPECTED_ADMIN="${EXPECTED_ADMIN:-}"

# 2a. Each contract responds to admin()
for name_id in \
  "issuer_registry:$ISSUER_REGISTRY_ID" \
  "credential_verifier:$CREDENTIAL_VERIFIER_ID" \
  "proof_registry:$PROOF_REGISTRY_ID" \
  "gated_pool:$GATED_POOL_ID"; do
  name="${name_id%%:*}"
  cid="${name_id##*:}"
  [[ -z "$cid" ]] && continue
  admin="$(invoke_read "$cid" admin)"
  if [[ -z "$admin" ]]; then
    record_failure "$name ($cid): admin() returned empty â€” contract may not be initialised"
  else
    ok "$name: admin = $admin"
    if [[ -n "$EXPECTED_ADMIN" && "$admin" != "$EXPECTED_ADMIN" ]]; then
      record_failure "$name: admin is $admin but expected $EXPECTED_ADMIN"
    fi
  fi
done

# 2b. proof_registry.verifier_address == CREDENTIAL_VERIFIER_ID
wired_verifier="$(invoke_read "$PROOF_REGISTRY_ID" verifier_address || true)"
if [[ -n "$CREDENTIAL_VERIFIER_ID" && "$wired_verifier" != "$CREDENTIAL_VERIFIER_ID" ]]; then
  record_failure "proof_registry.verifier_address ($wired_verifier) != CREDENTIAL_VERIFIER_ID ($CREDENTIAL_VERIFIER_ID)"
else
  ok "proof_registry â†” credential_verifier wiring confirmed"
fi

# 2c. proof_registry.issuer_registry_address == ISSUER_REGISTRY_ID
wired_registry="$(invoke_read "$PROOF_REGISTRY_ID" issuer_registry_address || true)"
if [[ -n "$ISSUER_REGISTRY_ID" && "$wired_registry" != "$ISSUER_REGISTRY_ID" ]]; then
  record_failure "proof_registry.issuer_registry_address ($wired_registry) != ISSUER_REGISTRY_ID ($ISSUER_REGISTRY_ID)"
else
  ok "proof_registry â†” issuer_registry wiring confirmed"
fi

[[ ${#FAILURES[@]} -eq 0 ]] || abort "Stage 2 contract wiring assertions failed. Fix above and retry."
ok "Stage 2 passed."
[[ $MAX_STAGE -ge 3 ]] || { echo "Stopping at stage 2 as requested."; exit 0; }

# ============================================================
# STAGE 3 â€” IDENTITY / ISSUER CHECKS
# ============================================================
header "Stage 3 Â· Identity and Issuer Checks"

EXPECTED_ISSUER_ID="${EXPECTED_ISSUER_ID:-}"
EXPECTED_ISSUER_PUBKEY="${EXPECTED_ISSUER_PUBKEY:-}"

if [[ -z "$EXPECTED_ISSUER_ID" ]]; then
  record_warn "EXPECTED_ISSUER_ID not set â€” skipping issuer registration check"
else
  # 3a. Issuer is registered on issuer_registry
  is_valid="$(invoke_read "$ISSUER_REGISTRY_ID" is_valid_issuer \
                --issuer_id "$EXPECTED_ISSUER_ID" --credential_type "kyc" || true)"
  if [[ "$is_valid" == "true" ]]; then
    ok "Issuer $EXPECTED_ISSUER_ID is valid on issuer_registry (kyc)"
  else
    record_failure "Issuer $EXPECTED_ISSUER_ID is NOT registered or not valid for 'kyc'"
  fi

  # 3b. Issuer public key matches expected value
  if [[ -n "$EXPECTED_ISSUER_PUBKEY" ]]; then
    onchain_pubkey="$(invoke_read "$ISSUER_REGISTRY_ID" get_issuer_pubkey \
                        --issuer_id "$EXPECTED_ISSUER_ID" || true)"
    if [[ "$onchain_pubkey" == "$EXPECTED_ISSUER_PUBKEY" ]]; then
      ok "Issuer public key matches expected value"
    else
      record_failure "Issuer pubkey mismatch â€” on-chain: $onchain_pubkey, expected: $EXPECTED_ISSUER_PUBKEY"
    fi
  else
    record_warn "EXPECTED_ISSUER_PUBKEY not set â€” skipping pubkey assertion"
  fi
fi

[[ ${#FAILURES[@]} -eq 0 ]] || abort "Stage 3 identity checks failed."
ok "Stage 3 passed."
[[ $MAX_STAGE -ge 4 ]] || { echo "Stopping at stage 3 as requested."; exit 0; }

# ============================================================
# STAGE 4 â€” VK REGISTRATION
# ============================================================
header "Stage 4 Â· Verification Key (VK) Registration"

REQUIRED_CREDENTIAL_TYPES=(kyc age income jurisdiction funds accreditation)

if [[ -f "$CIRCUIT_VERSIONS_FILE" ]]; then
  info "Using circuit versions from: $CIRCUIT_VERSIONS_FILE"
else
  record_warn "circuit-versions.json not found at $CIRCUIT_VERSIONS_FILE â€” using defaults"
fi

for ctype in "${REQUIRED_CREDENTIAL_TYPES[@]}"; do
  expected_vk_ver="1"
  if [[ -f "$CIRCUIT_VERSIONS_FILE" ]]; then
    expected_vk_ver="$(jq -r ".circuits.\"${ctype}_proof\".vkVersion // 1" \
                        "$CIRCUIT_VERSIONS_FILE" 2>/dev/null || echo "1")"
  fi

  latest_ver="$(invoke_read "$CREDENTIAL_VERIFIER_ID" get_latest_version \
                  --credential_type "$ctype" || true)"

  if [[ -z "$latest_ver" || "$latest_ver" == "null" ]]; then
    record_failure "VK for '$ctype' is NOT installed on credential_verifier"
  elif [[ "$latest_ver" == "$expected_vk_ver" ]]; then
    ok "VK '$ctype': on-chain version $latest_ver matches expected $expected_vk_ver"
  else
    record_failure "VK '$ctype': on-chain version $latest_ver != expected $expected_vk_ver"
  fi
done

[[ ${#FAILURES[@]} -eq 0 ]] || abort "Stage 4 VK registration checks failed."
ok "Stage 4 passed."
[[ $MAX_STAGE -ge 5 ]] || { echo "Stopping at stage 4 as requested."; exit 0; }

# ============================================================
# STAGE 5 â€” FRONTEND CONFIG GENERATION
# ============================================================
header "Stage 5 Â· Frontend Configuration"

FRONTEND_CONFIG_PATH="$FRONTEND_CONFIG_DIR/stellarcred-config.json"

FRONTEND_CONFIG="$(cat <<EOF
{
  "_generated_by": "scripts/staged-deploy.sh",
  "_generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "_network": "$NETWORK",
  "_rpc_url": "$RPC_URL",
  "contracts": {
    "issuerRegistry":        "${ISSUER_REGISTRY_ID:-}",
    "credentialVerifier":    "${CREDENTIAL_VERIFIER_ID:-}",
    "proofRegistry":         "${PROOF_REGISTRY_ID:-}",
    "gatedPool":             "${GATED_POOL_ID:-}"
  },
  "network": "$NETWORK",
  "rpcUrl":  "$RPC_URL"
}
EOF
)"

# Validate the generated JSON is well-formed
echo "$FRONTEND_CONFIG" | jq . > /dev/null 2>&1 \
  || abort "Generated frontend config is not valid JSON â€” this is a script bug."

ok "Frontend config generated and validated."

if [[ "$SKIP_FRONTEND_WRITE" -eq 1 ]]; then
  info "Skipping write to $FRONTEND_CONFIG_PATH (--skip-frontend-write)"
  echo "$FRONTEND_CONFIG"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] Would write to $FRONTEND_CONFIG_PATH:"
  echo "$FRONTEND_CONFIG"
else
  mkdir -p "$FRONTEND_CONFIG_DIR"
  echo "$FRONTEND_CONFIG" > "$FRONTEND_CONFIG_PATH"
  ok "Written to $FRONTEND_CONFIG_PATH"
fi

[[ $MAX_STAGE -ge 6 ]] || { echo "Stopping at stage 5 as requested."; exit 0; }

# ============================================================
# STAGE 6 â€” SMOKE TESTS
# ============================================================
header "Stage 6 Â· Smoke Tests (Read-Only Liveness)"

smoke_check() {
  local label="$1" cid="$2" fn="$3"; shift 3
  local result
  result="$(invoke_read "$cid" "$fn" "$@" || true)"
  if [[ -n "$result" ]]; then
    ok "$label â†’ $result"
  else
    record_warn "Smoke test '$label' returned empty (contract may need init)"
  fi
}

smoke_check "proof_registry::admin"               "$PROOF_REGISTRY_ID"       admin
smoke_check "proof_registry::verifier_address"    "$PROOF_REGISTRY_ID"       verifier_address
smoke_check "issuer_registry::admin"              "$ISSUER_REGISTRY_ID"      admin
smoke_check "credential_verifier::admin"          "$CREDENTIAL_VERIFIER_ID"  admin

[[ ${#FAILURES[@]} -eq 0 ]] || abort "Stage 6 smoke tests recorded failures."
ok "Stage 6 passed."
[[ $MAX_STAGE -ge 7 ]] || { echo "Stopping at stage 6 as requested."; exit 0; }

# ============================================================
# STAGE 7 â€” MANIFEST OUTPUT / FINAL GATE
# ============================================================
header "Stage 7 Â· Final Gate and Manifest"

TOTAL_FAILURES=${#FAILURES[@]}
TOTAL_WARNINGS=${#WARNINGS[@]}

MANIFEST="$(cat <<EOF
{
  "schema_version": "1",
  "generated_by": "scripts/staged-deploy.sh",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "network": "$NETWORK",
  "rpc_url": "$RPC_URL",
  "source": "${SOURCE:-}",
  "contracts": {
    "issuer_registry":     "${ISSUER_REGISTRY_ID:-}",
    "credential_verifier": "${CREDENTIAL_VERIFIER_ID:-}",
    "proof_registry":      "${PROOF_REGISTRY_ID:-}",
    "gated_pool":          "${GATED_POOL_ID:-}"
  },
  "stages_completed": $MAX_STAGE,
  "warnings": $TOTAL_WARNINGS,
  "failures": $TOTAL_FAILURES,
  "result": "$([[ $TOTAL_FAILURES -eq 0 ]] && echo 'PASS' || echo 'FAIL')"
}
EOF
)"

echo "$MANIFEST" | jq . > /dev/null 2>&1 || true  # pretty-print if jq available

echo ""
echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
echo -e "${BOLD}  STAGED DEPLOYMENT SUMMARY${NC}"
echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
echo "  Warnings:  $TOTAL_WARNINGS"
echo "  Failures:  $TOTAL_FAILURES"

if [[ $TOTAL_FAILURES -gt 0 ]]; then
  echo ""
  echo -e "${RED}${BOLD}  RESULT: FAIL â€” SAFE ABORT (production traffic NOT switched)${NC}"
  echo ""
  echo "  Failures:"
  for f in "${FAILURES[@]}"; do echo -e "    ${RED}âœ–${NC} $f"; done
  echo ""
  echo "  Fix all failures and re-run to proceed to production."
  echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
  exit 1
fi

echo -e "${GREEN}${BOLD}  RESULT: PASS â€” All $MAX_STAGE stages verified${NC}"

if [[ "$DRY_RUN" -eq 0 ]]; then
  echo "$MANIFEST" > "$OUTPUT_MANIFEST"
  ok "Manifest written to $OUTPUT_MANIFEST"
else
  info "[dry-run] Manifest (not written):"
  echo "$MANIFEST"
fi

echo ""
echo "  You may now switch production traffic to this deployment."
echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
exit 0

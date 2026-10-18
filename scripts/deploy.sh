#!/usr/bin/env bash
# Deploy the StellarCred contracts to testnet, wiring them together in
# dependency order, and print the resulting env vars for the frontend.
#
# Usage:
#   stellar keys generate --global deployer --network testnet --fund
#   SOURCE=deployer ./scripts/deploy.sh
#
# Requires stellar CLI v26+ (the verifier uses BN254 host functions / protocol
# 23). Registers the deployer as a trusted issuer and installs all VKs, so the
# system works as-is. The issuer wallet to connect in the UI is the deployer.
#
# This script also:
# - Records WASM hashes for verification (SHA-256)
# - Creates a deployment manifest with version info
# - Validates WASM files before deployment
# - Is safe to rerun: contract IDs are recorded in .deploy-state/ and reused
#   while still live, and an already-registered issuer or VK is skipped. Set
#   DEPLOY_FRESH=1 to ignore recorded state and deploy a new set.
set -euo pipefail

SOURCE="${SOURCE:-deployer}"
NETWORK="${NETWORK:-testnet}"
WASM_DIR="target/wasm32-unknown-unknown/release"
NET_ARGS=(--network "$NETWORK")
# shellcheck source=lib/deploy-state.sh
source "$(dirname "$0")/lib/deploy-state.sh"

# Create deployment manifest directory
MANIFEST_DIR="deployment-manifests"
mkdir -p "$MANIFEST_DIR"

# Generate deployment manifest filename with timestamp
MANIFEST_FILE="$MANIFEST_DIR/deployment-$(date +%Y%m%d-%H%M%S).json"

# Verify that ISSUER_PRIVATE_KEY is set before proceeding
# secp256k1 public key (x || y, 64 bytes) derived from ISSUER_PRIVATE_KEY.
# The same key must be in frontend/.env.local so /api/issue signs with it.
if [ -z "${ISSUER_PRIVATE_KEY:-}" ]; then
  echo "Error: ISSUER_PRIVATE_KEY is not set. Export it before running deploy.sh." >&2
  exit 1
fi

echo "Building contracts..."
stellar contract build >/dev/null

if ! ADMIN="$(stellar keys address "$SOURCE" 2>/dev/null)"; then
  echo "Error: Source account '$SOURCE' not found in stellar CLI keys." >&2
  echo "Please generate or import the key first. Example:" >&2
  echo "  stellar keys generate --global $SOURCE --network $NETWORK --fund" >&2
  exit 1
fi
echo "Admin / deployer: $ADMIN"
state_init "$NETWORK" "$ADMIN"

# Record the exact source commit so verifiers can git-checkout the same tree.
SOURCE_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
echo "Source commit: $SOURCE_COMMIT"

# Function to compute and record WASM hash
compute_wasm_hash() {
  local name="$1"
  local wasm_path="$WASM_DIR/$name.wasm"
  
  if [ ! -f "$wasm_path" ]; then
    echo "Error: WASM file not found: $wasm_path" >&2
    return 1
  fi
  
  # Compute SHA-256 hash
  local hash
  if command -v sha256sum &> /dev/null; then
    hash=$(sha256sum "$wasm_path" | cut -d' ' -f1)
  else
    # macOS fallback
    hash=$(shasum -a 256 "$wasm_path" | cut -d' ' -f1)
  fi
  
  echo "$hash"
}

# Function to get contract version from Cargo.toml
get_contract_version() {
  local contract_path="contracts/$1/Cargo.toml"
  grep '^version = ' "$contract_path" | sed 's/^version = "\(.*\)"/\1/'
}

# Compute all WASM hashes before deployment
echo "Computing WASM hashes for verification..."
ISSUER_REGISTRY_HASH=$(compute_wasm_hash "issuer_registry")
CREDENTIAL_VERIFIER_HASH=$(compute_wasm_hash "credential_verifier")
PROOF_REGISTRY_HASH=$(compute_wasm_hash "proof_registry")
GATED_POOL_HASH=$(compute_wasm_hash "gated_pool")

echo "WASM Hash Verification:"
echo "  issuer_registry:      $ISSUER_REGISTRY_HASH"
echo "  credential_verifier:  $CREDENTIAL_VERIFIER_HASH"
echo "  proof_registry:       $PROOF_REGISTRY_HASH"
echo "  gated_pool:           $GATED_POOL_HASH"

# Get contract versions from Cargo.toml
ISSUER_REGISTRY_VERSION=$(get_contract_version "issuer_registry")
CREDENTIAL_VERIFIER_VERSION=$(get_contract_version "credential_verifier")
PROOF_REGISTRY_VERSION=$(get_contract_version "proof_registry")
GATED_POOL_VERSION=$(get_contract_version "gated_pool")

ISSUER_REGISTRY_ID="$(ensure_contract issuer_registry --admin "$ADMIN")"
CREDENTIAL_VERIFIER_ID="$(ensure_contract credential_verifier --admin "$ADMIN")"
PROOF_REGISTRY_ID="$(ensure_contract proof_registry --admin "$ADMIN" --verifier "$CREDENTIAL_VERIFIER_ID" --issuer_registry "$ISSUER_REGISTRY_ID")"
GATED_POOL_ID="$(ensure_contract gated_pool --registry "$PROOF_REGISTRY_ID")"

ISSUER_PUBKEY="$(node circuits/scripts/sign.js --pubkey-hex)"
ensure_issuer "$ISSUER_REGISTRY_ID" "$ADMIN" "$ISSUER_PUBKEY" \
  kyc age income jurisdiction funds accreditation employment

for type in kyc age income jurisdiction funds accreditation employment; do
  vk="fixtures/$type/vk"
  [ -f "$vk" ] || { echo "skip $type (no VK — run circuits/scripts/build.sh)"; continue; }
  ensure_vk "$CREDENTIAL_VERIFIER_ID" "$type" "$vk"
done

export NEXT_PUBLIC_STELLAR_NETWORK=$NETWORK
export NEXT_PUBLIC_ISSUER_ADDRESS=$ADMIN
export NEXT_PUBLIC_ISSUER_REGISTRY_ID=$ISSUER_REGISTRY_ID
export NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID=$CREDENTIAL_VERIFIER_ID
export NEXT_PUBLIC_PROOF_REGISTRY_ID=$PROOF_REGISTRY_ID
export NEXT_PUBLIC_GATED_POOL_ID=$GATED_POOL_ID

echo "Generating TypeScript bindings..."
./scripts/gen-bindings.sh

# Create deployment manifest JSON
cat > "$MANIFEST_FILE" <<MANIFEST_JSON
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "network": "$NETWORK",
  "admin": "$ADMIN",
  "source_commit": "$SOURCE_COMMIT",
  "verify_command": "git checkout $SOURCE_COMMIT && docker build -f docker/Dockerfile.reproducible -t sc . && docker run --rm -v \$(pwd)/out:/out --env SOURCE_DATE_EPOCH=0 sc sh -c 'cargo build --release --target wasm32v1-none --locked --offline && cp target/wasm32v1-none/release/*.wasm /out/' && sha256sum out/*.wasm",
  "contracts": {
    "issuer_registry": {
      "id": "$ISSUER_REGISTRY_ID",
      "version": "$ISSUER_REGISTRY_VERSION",
      "wasm_hash": "$ISSUER_REGISTRY_HASH"
    },
    "credential_verifier": {
      "id": "$CREDENTIAL_VERIFIER_ID",
      "version": "$CREDENTIAL_VERIFIER_VERSION",
      "wasm_hash": "$CREDENTIAL_VERIFIER_HASH"
    },
    "proof_registry": {
      "id": "$PROOF_REGISTRY_ID",
      "version": "$PROOF_REGISTRY_VERSION",
      "wasm_hash": "$PROOF_REGISTRY_HASH"
    },
    "gated_pool": {
      "id": "$GATED_POOL_ID",
      "version": "$GATED_POOL_VERSION",
      "wasm_hash": "$GATED_POOL_HASH"
    }
  },
  "sha256sums": {
    "issuer_registry": "$ISSUER_REGISTRY_HASH",
    "credential_verifier": "$CREDENTIAL_VERIFIER_HASH",
    "proof_registry": "$PROOF_REGISTRY_HASH",
    "gated_pool": "$GATED_POOL_HASH"
  }
}
MANIFEST_JSON

echo ""
echo "Deployment manifest saved to: $MANIFEST_FILE"
echo ""
cat "$MANIFEST_FILE" | jq '.' 2>/dev/null || cat "$MANIFEST_FILE"

cat <<EOF

Deployed. Copy into frontend/.env.local:

NEXT_PUBLIC_STELLAR_NETWORK=$NETWORK
NEXT_PUBLIC_ISSUER_ADDRESS=$ADMIN
NEXT_PUBLIC_ISSUER_REGISTRY_ID=$ISSUER_REGISTRY_ID
NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID=$CREDENTIAL_VERIFIER_ID
NEXT_PUBLIC_PROOF_REGISTRY_ID=$PROOF_REGISTRY_ID
NEXT_PUBLIC_GATED_POOL_ID=$GATED_POOL_ID

# Already set (keep it):
# ISSUER_PRIVATE_KEY=<your 64-char hex secp256k1 key>

Contract Versions:
  issuer_registry:      v$ISSUER_REGISTRY_VERSION
  credential_verifier:  v$CREDENTIAL_VERIFIER_VERSION
  proof_registry:       v$PROOF_REGISTRY_VERSION
  gated_pool:           v$GATED_POOL_VERSION

Source commit: $SOURCE_COMMIT
Deployment manifest: $MANIFEST_FILE

To independently verify the deployed WASM matches this source commit:
  git checkout $SOURCE_COMMIT
  docker build -f docker/Dockerfile.reproducible -t sc .
  mkdir -p out
  docker run --rm -v \$(pwd)/out:/out --env SOURCE_DATE_EPOCH=0 sc \\
    sh -c "cargo build --release --target wasm32v1-none --locked --offline \\
           && cp target/wasm32v1-none/release/*.wasm /out/"
  sha256sum out/*.wasm   # compare against hashes in $MANIFEST_FILE

To verify against the live on-chain hashes (requires stellar CLI ≥ v26):
  ./scripts/verify-wasm.sh --network $NETWORK

Record this deployment in DEPLOYMENTS.md using the source_commit and
sha256sums fields from $MANIFEST_FILE.
EOF

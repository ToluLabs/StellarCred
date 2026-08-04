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
set -euo pipefail

SOURCE="${SOURCE:-deployer}"
NETWORK="${NETWORK:-testnet}"
WASM_DIR="target/wasm32v1-none/release"

echo "Building contracts..."
stellar contract build >/dev/null

ADMIN="$(stellar keys address "$SOURCE")"
echo "Admin / deployer: $ADMIN"

deploy() {
  # $1 = wasm name (no extension); remaining args = constructor args
  local name="$1"; shift
  stellar contract deploy \
    --wasm "$WASM_DIR/$name.wasm" \
    --source "$SOURCE" --network "$NETWORK" \
    -- "$@"
}

echo "Deploying issuer_registry..."
ISSUER_REGISTRY_ID="$(deploy issuer_registry --admin "$ADMIN")"

echo "Deploying credential_verifier..."
CREDENTIAL_VERIFIER_ID="$(deploy credential_verifier --admin "$ADMIN")"

echo "Deploying proof_registry (-> verifier, issuer_registry)..."
PROOF_REGISTRY_ID="$(deploy proof_registry --admin "$ADMIN" --verifier "$CREDENTIAL_VERIFIER_ID" --issuer_registry "$ISSUER_REGISTRY_ID")"

echo "Deploying gated_pool (-> registry)..."
GATED_POOL_ID="$(deploy gated_pool --registry "$PROOF_REGISTRY_ID")"

echo "Registering deployer as a trusted issuer for all credential types..."
# secp256k1 public key (x || y, 64 bytes) derived from ISSUER_PRIVATE_KEY.
# Set ISSUER_PRIVATE_KEY in the environment before running this script.
# The same key must be in frontend/.env.local so /api/issue signs with it.
if [ -z "${ISSUER_PRIVATE_KEY:-}" ]; then
  echo "Error: ISSUER_PRIVATE_KEY is not set. Export it before running deploy.sh." >&2
  exit 1
fi
ISSUER_PUBKEY="$(node circuits/scripts/sign.js --pubkey-hex)"
stellar contract invoke \
  --id "$ISSUER_REGISTRY_ID" \
  --source "$SOURCE" --network "$NETWORK" \
  --send yes \
  -- register_issuer \
  --issuer_id "$ADMIN" \
  --pubkey "$ISSUER_PUBKEY" \
  --credential_types '["kyc","age","income","jurisdiction","funds","accreditation","employment"]'

for type in kyc age income jurisdiction funds accreditation employment; do
  vk="fixtures/$type/vk"
  [ -f "$vk" ] || { echo "skip $type (no VK — run circuits/scripts/build.sh)"; continue; }
  echo "Registering $type verification key..."
  stellar contract invoke \
    --id "$CREDENTIAL_VERIFIER_ID" \
    --source "$SOURCE" --network "$NETWORK" \
    --send yes \
    -- set_vk \
    --credential_type "$type" \
    --version 1 \
    --vk-file-path "$vk"
done

export NEXT_PUBLIC_ISSUER_ADDRESS=$ADMIN
export NEXT_PUBLIC_ISSUER_REGISTRY_ID=$ISSUER_REGISTRY_ID
export NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID=$CREDENTIAL_VERIFIER_ID
export NEXT_PUBLIC_PROOF_REGISTRY_ID=$PROOF_REGISTRY_ID
export NEXT_PUBLIC_GATED_POOL_ID=$GATED_POOL_ID

echo "Generating TypeScript bindings..."
./scripts/gen-bindings.sh

cat <<EOF

Deployed. Copy into frontend/.env.local:

NEXT_PUBLIC_ISSUER_ADDRESS=$ADMIN
NEXT_PUBLIC_ISSUER_REGISTRY_ID=$ISSUER_REGISTRY_ID
NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID=$CREDENTIAL_VERIFIER_ID
NEXT_PUBLIC_PROOF_REGISTRY_ID=$PROOF_REGISTRY_ID
NEXT_PUBLIC_GATED_POOL_ID=$GATED_POOL_ID

# Already set (keep it):
# ISSUER_PRIVATE_KEY=<your 64-char hex secp256k1 key>
EOF

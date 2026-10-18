#!/usr/bin/env bash
# Deploy the StellarCred contracts to mainnet, wiring them together in
# dependency order, and print the resulting env vars for the frontend.
#
# Usage:
#   # Make sure you have a funded mainnet identity imported in Stellar CLI
#   # e.g., stellar keys import deployer --private-key <key>
#   SOURCE=deployer ./scripts/deploy-mainnet.sh
#
# Requires stellar CLI v26+ (the verifier uses BN254 host functions / protocol
# 23). Registers the deployer as a trusted issuer and installs all VKs.
#
# Safe to rerun: contract IDs are recorded in .deploy-state/ and reused while
# still live, and an already-registered issuer or VK is skipped. Set
# DEPLOY_FRESH=1 to ignore recorded state and deploy a new set.
set -euo pipefail

SOURCE="${SOURCE:-deployer}"
RPC_URL="${RPC_URL:-https://mainnet.sorobanrpc.com}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Public Global Stellar Network ; September 2015}"
WASM_DIR="target/wasm32v1-none/release"
NET_ARGS=(--rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")
# shellcheck source=lib/deploy-state.sh
source "$(dirname "$0")/lib/deploy-state.sh"

# Verify that ISSUER_PRIVATE_KEY is set before proceeding
# secp256k1 public key (x || y, 64 bytes) derived from ISSUER_PRIVATE_KEY.
# The same key must be in frontend/.env.local so /api/issue signs with it.
if [ -z "${ISSUER_PRIVATE_KEY:-}" ]; then
  echo "Error: ISSUER_PRIVATE_KEY is not set. Export it before running deploy-mainnet.sh." >&2
  exit 1
fi
ISSUER_PUBKEY="$(node circuits/scripts/sign.js --pubkey-hex)"

echo "Building contracts..."
stellar contract build >/dev/null

# Verify the source account exists and can be retrieved
if ! ADMIN="$(stellar keys address "$SOURCE" 2>/dev/null)"; then
  echo "Error: Source account '$SOURCE' not found in stellar CLI keys." >&2
  echo "Please import/generate the key first. Example:" >&2
  echo "  stellar keys import $SOURCE --private-key <your-secret-key>" >&2
  exit 1
fi

echo "Admin / deployer: $ADMIN"
state_init mainnet "$ADMIN"

ISSUER_REGISTRY_ID="$(ensure_contract issuer_registry --admin "$ADMIN")"
CREDENTIAL_VERIFIER_ID="$(ensure_contract credential_verifier --admin "$ADMIN")"
PROOF_REGISTRY_ID="$(ensure_contract proof_registry --verifier "$CREDENTIAL_VERIFIER_ID" --issuer_registry "$ISSUER_REGISTRY_ID")"
GATED_POOL_ID="$(ensure_contract gated_pool --registry "$PROOF_REGISTRY_ID")"

ensure_issuer "$ISSUER_REGISTRY_ID" "$ADMIN" "$ISSUER_PUBKEY" \
  kyc age income jurisdiction funds

for type in kyc age income jurisdiction funds; do
  vk="fixtures/$type/vk"
  [ -f "$vk" ] || { echo "skip $type (no VK — run circuits/scripts/build.sh)"; continue; }
  ensure_vk "$CREDENTIAL_VERIFIER_ID" "$type" "$vk"
done

cat <<EOF

Deployed to Mainnet. Copy into frontend/.env.local:

NEXT_PUBLIC_STELLAR_NETWORK=mainnet
NEXT_PUBLIC_RPC_URL=$RPC_URL
NEXT_PUBLIC_NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE
NEXT_PUBLIC_ISSUER_ADDRESS=$ADMIN
NEXT_PUBLIC_ISSUER_REGISTRY_ID=$ISSUER_REGISTRY_ID
NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID=$CREDENTIAL_VERIFIER_ID
NEXT_PUBLIC_PROOF_REGISTRY_ID=$PROOF_REGISTRY_ID
NEXT_PUBLIC_GATED_POOL_ID=$GATED_POOL_ID

# Already set (keep it):
# ISSUER_PRIVATE_KEY=<your 64-char hex secp256k1 key>
EOF

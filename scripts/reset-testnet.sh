#!/usr/bin/env bash
# Reset testnet: re-fund the deployer, redeploy contracts, and update frontend/.env.local

set -euo pipefail

if [ -z "${ISSUER_PRIVATE_KEY:-}" ]; then
  echo "Error: ISSUER_PRIVATE_KEY is not set. Export it before running reset-testnet.sh." >&2
  exit 1
fi

if [ -z "${SOURCE:-}" ]; then
  echo "Error: SOURCE is not set. Export it (e.g. SOURCE=deployer) before running reset-testnet.sh." >&2
  exit 1
fi

echo "Funding $SOURCE on testnet..."
stellar keys fund "$SOURCE" --network testnet

echo "Deploying contracts..."
# Capture the output of deploy.sh. A reset wants new contracts, so skip the
# reuse of recorded deploy state.
DEPLOY_OUTPUT=$(DEPLOY_FRESH=1 ./scripts/deploy.sh)

echo "$DEPLOY_OUTPUT"

# Extract values from output
ISSUER_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "NEXT_PUBLIC_ISSUER_ADDRESS=" | cut -d '=' -f 2)
[ -z "$ISSUER_ADDRESS" ] && { echo "ERROR: failed to extract ISSUER_ADDRESS from deploy output" >&2; exit 1; }

ISSUER_REGISTRY_ID=$(echo "$DEPLOY_OUTPUT" | grep "NEXT_PUBLIC_ISSUER_REGISTRY_ID=" | cut -d '=' -f 2)
[ -z "$ISSUER_REGISTRY_ID" ] && { echo "ERROR: failed to extract ISSUER_REGISTRY_ID from deploy output" >&2; exit 1; }

CREDENTIAL_VERIFIER_ID=$(echo "$DEPLOY_OUTPUT" | grep "NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID=" | cut -d '=' -f 2)
[ -z "$CREDENTIAL_VERIFIER_ID" ] && { echo "ERROR: failed to extract CREDENTIAL_VERIFIER_ID from deploy output" >&2; exit 1; }

PROOF_REGISTRY_ID=$(echo "$DEPLOY_OUTPUT" | grep "NEXT_PUBLIC_PROOF_REGISTRY_ID=" | cut -d '=' -f 2)
[ -z "$PROOF_REGISTRY_ID" ] && { echo "ERROR: failed to extract PROOF_REGISTRY_ID from deploy output" >&2; exit 1; }

GATED_POOL_ID=$(echo "$DEPLOY_OUTPUT" | grep "NEXT_PUBLIC_GATED_POOL_ID=" | cut -d '=' -f 2)
[ -z "$GATED_POOL_ID" ] && { echo "ERROR: failed to extract GATED_POOL_ID from deploy output" >&2; exit 1; }

ENV_FILE="frontend/.env.local"

if [ ! -f "$ENV_FILE" ]; then
    echo "Creating $ENV_FILE..."
    touch "$ENV_FILE"
fi

# Function to update or append env var
update_env() {
    local key=$1
    local value=$2
    if grep -q "^${key}=" "$ENV_FILE"; then
        # Use sed to replace the line, using | as delimiter to avoid path issues if any, though they are IDs
        # macOS sed needs empty string for -i, Linux doesn't. We'll use a temp file to be safe.
        awk -v key="$key" -v value="$value" -F= 'BEGIN { OFS="=" } $1 == key { $2 = value } { print }' "$ENV_FILE" > "${ENV_FILE}.tmp"
        mv "${ENV_FILE}.tmp" "$ENV_FILE"
    else
        echo "${key}=${value}" >> "$ENV_FILE"
    fi
}

echo "Updating $ENV_FILE..."
update_env "NEXT_PUBLIC_ISSUER_ADDRESS" "$ISSUER_ADDRESS"
update_env "NEXT_PUBLIC_ISSUER_REGISTRY_ID" "$ISSUER_REGISTRY_ID"
update_env "NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID" "$CREDENTIAL_VERIFIER_ID"
update_env "NEXT_PUBLIC_PROOF_REGISTRY_ID" "$PROOF_REGISTRY_ID"
update_env "NEXT_PUBLIC_GATED_POOL_ID" "$GATED_POOL_ID"

cat <<EOF

==================================================
Testnet Reset Recovery Complete
==================================================

Updated $ENV_FILE with new IDs:
Issuer Address:      $ISSUER_ADDRESS
Issuer Registry:     $ISSUER_REGISTRY_ID
Credential Verifier: $CREDENTIAL_VERIFIER_ID
Proof Registry:      $PROOF_REGISTRY_ID
Gated Pool:          $GATED_POOL_ID

Next Steps:
- Restart your frontend dev server if it was running.
- Ensure you have the Issuer Wallet connected to mint new credentials.
- Users will need to request new credentials as previous state has been wiped.
EOF

#!/usr/bin/env bash
set -euo pipefail

# Regenerate TypeScript bindings for the contracts.
# Expected env vars (set by deploy.sh or manual export):
# NEXT_PUBLIC_PROOF_REGISTRY_ID
# NEXT_PUBLIC_ISSUER_REGISTRY_ID

NETWORK="${NETWORK:-testnet}"

if [ -z "${NEXT_PUBLIC_PROOF_REGISTRY_ID:-}" ] || [ -z "${NEXT_PUBLIC_ISSUER_REGISTRY_ID:-}" ]; then
  echo "Error: Required contract IDs are not set in the environment." >&2
  exit 1
fi

echo "Generating bindings for ProofRegistry ($NEXT_PUBLIC_PROOF_REGISTRY_ID)..."
stellar contract bindings typescript \
  --contract-id "$NEXT_PUBLIC_PROOF_REGISTRY_ID" \
  --network "$NETWORK" \
  --output-dir frontend/packages/proof-registry \
  --overwrite

echo "Generating bindings for IssuerRegistry ($NEXT_PUBLIC_ISSUER_REGISTRY_ID)..."
stellar contract bindings typescript \
  --contract-id "$NEXT_PUBLIC_ISSUER_REGISTRY_ID" \
  --network "$NETWORK" \
  --output-dir frontend/packages/issuer-registry \
  --overwrite

# stellar CLI generates unused imports for Timepoint and Duration that break in stellar-sdk v13
if [ -f frontend/packages/proof-registry/src/index.ts ]; then
  perl -pi -e 's/Timepoint,//g' frontend/packages/proof-registry/src/index.ts
  perl -pi -e 's/Duration,//g' frontend/packages/proof-registry/src/index.ts
fi
if [ -f frontend/packages/issuer-registry/src/index.ts ]; then
  perl -pi -e 's/Timepoint,//g' frontend/packages/issuer-registry/src/index.ts
  perl -pi -e 's/Duration,//g' frontend/packages/issuer-registry/src/index.ts
fi

echo "Done generating bindings."

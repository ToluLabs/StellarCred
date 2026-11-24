#!/usr/bin/env bash
# Run the complete StellarCred happy path against an ephemeral testnet wallet.
# The contracts are deployed fresh; the wallet and local artifacts are removed
# on exit. Testnet contract instances are immutable and remain network state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${SOURCE:-stellarcred-e2e-$$}"
NETWORK="${NETWORK:-testnet}"
STARTED_AT="$(date +%s)"
TMP="$(mktemp -d)"
DEPLOY_LOG="$TMP/deploy.log"

cleanup() {
  status=$?
  set +e
  if stellar keys address "$SOURCE" >/dev/null 2>&1; then
    stellar keys delete --global "$SOURCE" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  elapsed=$(( $(date +%s) - STARTED_AT ))
  echo "E2E elapsed: ${elapsed}s"
  exit "$status"
}
trap cleanup EXIT

: "${ISSUER_PRIVATE_KEY:?ISSUER_PRIVATE_KEY is required}"
command -v stellar >/dev/null || { echo "stellar CLI is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

# A fresh funded wallet makes every run independent. The private issuer key is
# supplied by the protected GitHub environment and is never written to disk.
echo "Creating ephemeral testnet wallet"
stellar keys generate --global "$SOURCE" --network "$NETWORK" --fund >/dev/null

cd "$ROOT"
echo "Deploying contracts and registering issuer"
SOURCE="$SOURCE" NETWORK="$NETWORK" ./scripts/deploy.sh >"$DEPLOY_LOG"

# Export only public contract IDs printed by deploy.sh; no secret is parsed.
for key in ISSUER_ADDRESS ISSUER_REGISTRY_ID CREDENTIAL_VERIFIER_ID PROOF_REGISTRY_ID GATED_POOL_ID; do
  value="$(grep -E "^NEXT_PUBLIC_${key}=" "$DEPLOY_LOG" | tail -1 | cut -d= -f2-)"
  [ -n "$value" ] || { echo "deploy.sh did not emit NEXT_PUBLIC_${key}" >&2; exit 1; }
  export "NEXT_PUBLIC_${key}=$value"
done
export STELLAR_NETWORK="$NETWORK"
export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"

echo "Issuing credentials, generating real proofs, and submitting them"
./scripts/demo.sh >"$TMP/demo.log"

# demo.sh queries is_verified after each submission. Require all three real
# proof submissions to be reported as verified, rather than only checking exit.
verified="$(grep -c '✅ Yes' "$TMP/demo.log" || true)"
if [ "$verified" -ne 3 ]; then
  echo "Expected 3 verified proofs; observed $verified" >&2
  grep -E 'Verified claims|Yes|No|Could not parse|Error' "$TMP/demo.log" >&2 || true
  exit 1
fi

echo "E2E verified: 3/3 proofs"

#!/usr/bin/env bash
# Verify WASM hashes and contract versions for a StellarCred deployment.
#
# Usage:
#   ./scripts/verify-deployment.sh <manifest_file>
#
# Compares computed WASM hashes against those recorded in the deployment
# manifest. Exits with 0 if all hashes match, 1 if any mismatch is detected.
#
# This script helps detect:
# - Accidental WASM file modifications
# - Build environment inconsistencies
# - Deployment tampering
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <manifest_file>"
  echo ""
  echo "Example:"
  echo "  $0 deployment-manifests/deployment-20240830-120000.json"
  exit 1
fi

MANIFEST_FILE="$1"
WASM_DIR="target/wasm32-unknown-unknown/release"

if [ ! -f "$MANIFEST_FILE" ]; then
  echo "Error: Manifest file not found: $MANIFEST_FILE"
  exit 1
fi

if [ ! -d "$WASM_DIR" ]; then
  echo "Error: WASM directory not found: $WASM_DIR"
  echo "Run 'stellar contract build' first"
  exit 1
fi

echo "Verifying deployment manifest: $MANIFEST_FILE"
echo ""

# Extract manifest metadata
MANIFEST_TIMESTAMP=$(jq -r '.timestamp // "unknown"' "$MANIFEST_FILE")
MANIFEST_NETWORK=$(jq -r '.network // "unknown"' "$MANIFEST_FILE")
MANIFEST_ADMIN=$(jq -r '.admin // "unknown"' "$MANIFEST_FILE")

echo "Deployment Info:"
echo "  Timestamp: $MANIFEST_TIMESTAMP"
echo "  Network:   $MANIFEST_NETWORK"
echo "  Admin:     $MANIFEST_ADMIN"
echo ""

# Function to verify WASM hash
verify_wasm_hash() {
  local contract_name="$1"
  local expected_hash="$2"
  local wasm_path="$WASM_DIR/${contract_name}.wasm"
  
  if [ ! -f "$wasm_path" ]; then
    echo "✗ $contract_name: WASM file not found at $wasm_path"
    return 1
  fi
  
  # Compute hash
  local computed_hash
  if command -v sha256sum &> /dev/null; then
    computed_hash=$(sha256sum "$wasm_path" | cut -d' ' -f1)
  else
    # macOS fallback
    computed_hash=$(shasum -a 256 "$wasm_path" | cut -d' ' -f1)
  fi
  
  if [ "$computed_hash" = "$expected_hash" ]; then
    echo "✓ $contract_name: Hash matches"
    return 0
  else
    echo "✗ $contract_name: Hash MISMATCH"
    echo "  Expected: $expected_hash"
    echo "  Computed: $computed_hash"
    return 1
  fi
}

# Verify all contracts
echo "Verifying WASM Hashes:"
all_valid=0

for contract in issuer_registry credential_verifier proof_registry gated_pool; do
  expected_hash=$(jq -r ".contracts.\"$contract\".wasm_hash // empty" "$MANIFEST_FILE")
  
  if [ -z "$expected_hash" ]; then
    echo "⚠ $contract: No hash in manifest"
    continue
  fi
  
  if ! verify_wasm_hash "$contract" "$expected_hash"; then
    all_valid=1
  fi
done

echo ""

# Verify contract versions match Cargo.toml
echo "Verifying Contract Versions:"
for contract in issuer_registry credential_verifier proof_registry gated_pool; do
  manifest_version=$(jq -r ".contracts.\"$contract\".version // empty" "$MANIFEST_FILE")
  
  if [ -z "$manifest_version" ]; then
    echo "⚠ $contract: No version in manifest"
    continue
  fi
  
  # Extract version from Cargo.toml
  cargo_version=$(grep '^version = ' "contracts/$contract/Cargo.toml" | sed 's/^version = "\(.*\)"/\1/')
  
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
  echo "This may indicate:"
  echo "  - Accidental source code changes after deployment"
  echo "  - Build environment differences (Rust version, dependencies)"
  echo "  - Deployment tampering or corruption"
  echo ""
  echo "To rebuild with identical hashes:"
  echo "  1. Ensure same Rust version as original deployment"
  echo "  2. Clear build cache: cargo clean"
  echo "  3. Rebuild: stellar contract build"
  exit 1
fi

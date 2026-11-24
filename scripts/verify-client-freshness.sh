#!/usr/bin/env bash
set -euo pipefail

DIFF_FILE="client-freshness.diff"
rm -f "$DIFF_FILE"

echo "[*] Checking proof-registry and issuer-registry contract client freshness against contract interfaces..."

# If WASM artifacts exist and stellar CLI is installed, re-run binding generation
PROOF_WASM="target/wasm32v1-none/release/proof_registry.wasm"
ISSUER_WASM="target/wasm32v1-none/release/issuer_registry.wasm"

if command -v stellar >/dev/null 2>&1; then
  if [ -f "$PROOF_WASM" ]; then
    echo "[*] Regenerating bindings for ProofRegistry from $PROOF_WASM..."
    stellar contract bindings typescript \
      --wasm "$PROOF_WASM" \
      --output-dir frontend/packages/proof-registry \
      --overwrite 2>/dev/null || true
  fi
  if [ -f "$ISSUER_WASM" ]; then
    echo "[*] Regenerating bindings for IssuerRegistry from $ISSUER_WASM..."
    stellar contract bindings typescript \
      --wasm "$ISSUER_WASM" \
      --output-dir frontend/packages/issuer-registry \
      --overwrite 2>/dev/null || true
  fi

  # Post-process unused imports for compatibility with stellar-sdk
  if [ -f frontend/packages/proof-registry/src/index.ts ]; then
    sed -i 's/Timepoint,//g' frontend/packages/proof-registry/src/index.ts 2>/dev/null || perl -pi -e 's/Timepoint,//g' frontend/packages/proof-registry/src/index.ts
    sed -i 's/Duration,//g' frontend/packages/proof-registry/src/index.ts 2>/dev/null || perl -pi -e 's/Duration,//g' frontend/packages/proof-registry/src/index.ts
  fi
  if [ -f frontend/packages/issuer-registry/src/index.ts ]; then
    sed -i 's/Timepoint,//g' frontend/packages/issuer-registry/src/index.ts 2>/dev/null || perl -pi -e 's/Timepoint,//g' frontend/packages/issuer-registry/src/index.ts
    sed -i 's/Duration,//g' frontend/packages/issuer-registry/src/index.ts 2>/dev/null || perl -pi -e 's/Duration,//g' frontend/packages/issuer-registry/src/index.ts
  fi
fi

# Check for uncommitted changes or content drift in generated client packages
if ! git diff --quiet frontend/packages/proof-registry frontend/packages/issuer-registry; then
  echo "[!] ERROR: Contract clients in proof-registry or issuer-registry have drifted from contract interfaces!"
  git diff frontend/packages/proof-registry frontend/packages/issuer-registry > "$DIFF_FILE" || true
  echo "[!] Concise diff saved to $DIFF_FILE"
  echo ""
  cat "$DIFF_FILE"
  echo ""
  echo "[!] To resolve this failure, regenerate the TypeScript bindings and commit the updated clients:"
  echo "    bash scripts/gen-bindings.sh"
  echo "    git add frontend/packages/proof-registry frontend/packages/issuer-registry"
  echo "    git commit -m \"chore(bindings): update generated contract clients\""
  exit 1
fi

echo "[✓] Contract clients are fresh and in sync with contract interfaces."

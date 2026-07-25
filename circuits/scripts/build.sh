#!/usr/bin/env bash
# Build StellarCred circuits with the pinned proving stack and stage artifacts.
#
# For each circuit it produces (in circuits/<name>/target/):
#   <name>.json      compiled ACIR  -> copied to frontend/public/circuits/<type>.json
#   vk, proof, public_inputs   the UltraHonk artifacts (bb)
# The vk is what you deploy into CredentialVerifier.set_vk(<type>, vk).
#
# Requires the EXACT versions the on-chain verifier was built against, or the VK
# will not validate proofs:
#   noirup -v 1.0.0-beta.9        (Noir / nargo)
#   bbup   -v 0.87.0              (Barretenberg / bb)
set -euo pipefail

NOIR_VERSION="1.0.0-beta.9"
BB_VERSION="0.87.0"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_CIRCUITS="$(cd "$ROOT/.." && pwd)/frontend/public/circuits"
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"

command -v nargo >/dev/null || { echo "nargo not found — run: noirup -v $NOIR_VERSION"; exit 1; }
command -v bb >/dev/null    || { echo "bb not found — run: bbup -v $BB_VERSION"; exit 1; }

# Map circuit directory -> frontend credential-type filename (bash 3.2 safe).
type_of() {
  case "$1" in
    kyc_proof) echo kyc ;;
    age_proof) echo age ;;
    income_proof) echo income ;;
    jurisdiction_proof) echo jurisdiction ;;
    funds_proof) echo funds ;;
    accreditation_proof) echo accreditation ;;
    *) echo "$1" ;;
  esac
}

REPO="$(cd "$ROOT/.." && pwd)"
FIXTURES="$REPO/fixtures"
mkdir -p "$FRONTEND_CIRCUITS"

build() {
  local name="$1"
  local dir="$ROOT/$name"
  [ -f "$dir/Nargo.toml" ] || { echo "skip $name"; return; }
  echo "=== $name ==="
  pushd "$dir" >/dev/null

  local type
  type="$(type_of "$name")"
  local json="target/${name}.json"
  local gz="target/${name}.gz"

  # The commit helper is only ever executed (to derive commitments), never
  # proven — compile and stage its JSON, nothing else.
  if [ "$name" = "commit" ]; then
    nargo compile
    cp "$json" "$FRONTEND_CIRCUITS/commit.json"
    echo "  -> frontend/public/circuits/commit.json"
    popd >/dev/null
    return
  fi

  # Compile + VK are always possible (write_vk needs only the bytecode).
  nargo compile
  bb write_vk --scheme ultra_honk --oracle_hash keccak \
    --bytecode_path "$json" \
    --output_path target --output_format bytes_and_fields
  # bb may emit vk as target/vk/vk — normalise to target/vk.
  [ -f target/vk/vk ] && mv target/vk/vk target/vk.tmp && rmdir target/vk && mv target/vk.tmp target/vk || true

  # Commit the VK (deployed into CredentialVerifier) and stage the circuit JSON.
  mkdir -p "$FIXTURES/$type"
  cp target/vk "$FIXTURES/$type/vk"
  cp "$json" "$FRONTEND_CIRCUITS/${type}.json"
  echo "  -> fixtures/${type}/vk"
  echo "  -> frontend/public/circuits/${type}.json"

  # A sample proof needs concrete inputs; only build it when Prover.toml exists.
  if [ -f Prover.toml ]; then
    nargo execute
    bb prove --scheme ultra_honk --oracle_hash keccak \
      --bytecode_path "$json" --witness_path "$gz" \
      --output_path target --output_format bytes_and_fields
    cp target/proof "$FIXTURES/$type/proof"
    cp target/public_inputs "$FIXTURES/$type/public_inputs"
    echo "  -> fixtures/${type}/{proof,public_inputs}"
  fi

  popd >/dev/null
}

if [ "$#" -gt 0 ]; then
  for n in "$@"; do build "$n"; done
else
  for n in commit kyc_proof age_proof income_proof jurisdiction_proof funds_proof accreditation_proof; do build "$n"; done
fi

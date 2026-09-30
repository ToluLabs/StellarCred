#!/usr/bin/env bash
# Build StellarCred circuits with the pinned proving stack and stage artifacts.
#
# For each circuit it produces (in circuits/<name>/target/):
#   <name>.json      compiled ACIR  -> copied to frontend/public/circuits/<type>.json
#   vk, proof, public_inputs   the UltraHonk artifacts (bb)
# The vk is what you deploy into CredentialVerifier.set_vk(<type>, vk).
#
# Each staged artifact is also stamped with the circuit version declared in
# circuits/circuit-versions.json, so the browser can tell which circuit a
# credential was issued against (#633). The credential-type filename and the
# version table are both resolved through circuits/scripts/circuit-versions.js
# so they cannot drift apart.
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

# Map circuit directory -> frontend credential-type filename. Resolved from the
# shared version module rather than duplicated here, so the two never disagree
# (e.g. a new circuit would otherwise get a filename nobody versioned).
type_of() {
  # Absolute path: build() runs from the circuit's own directory via pushd.
  node -e 'process.stdout.write(require(process.argv[1]).typeOfCircuit(process.argv[2]))' \
    "$ROOT/scripts/circuit-versions.js" "$1"
}

# Stamp the declared circuit version into a staged compiled artifact.
stamp_version() {
  node "$ROOT/scripts/stamp-circuit-version.js" stamp "$1" "$2"
}

REPO="$(cd "$ROOT/.." && pwd)"
FIXTURES="$REPO/fixtures"
mkdir -p "$FRONTEND_CIRCUITS"

if [ -f "$ROOT/scripts/gen_inputs.sh" ]; then
  echo "Generating circuit prover inputs..."
  bash "$ROOT/scripts/gen_inputs.sh"
fi

build() {
  local name="$1"
  local dir="$ROOT/$name"
  [ -f "$dir/Nargo.toml" ] || { echo "skip $name"; return; }
  echo "=== $name ==="
  pushd "$dir" >/dev/null

  local type
  type="$(type_of "$name")"
  # nargo resolves the output dir to the *workspace* root (circuits/target/),
  # not a per-member target/, since these are workspace members — not bb's
  # target, which is always relative to --output_path below.
  local json="$ROOT/target/${name}.json"
  local gz="$ROOT/target/${name}.gz"

  # The commit helpers are only ever executed (to derive commitments), never
  # proven and never registered on-chain, so they have no VK to version against
  # and are deliberately not stamped. Every other circuit IS proven, and
  # stamp_version below fails loudly if it has no declared version.
  case "$name" in
    commit|commit3)
      nargo compile
      cp "$json" "$FRONTEND_CIRCUITS/${name}.json"
      echo "  -> frontend/public/circuits/${name}.json"
      popd >/dev/null
      return
      ;;
  esac

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
  stamp_version "$name" "$FRONTEND_CIRCUITS/${type}.json"
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

  # For jurisdiction_proof: also build an allowlist fixture if Prover_allowlist.toml exists.
  if [ "$name" = "jurisdiction_proof" ] && [ -f Prover_allowlist.toml ]; then
    echo "  --- allowlist fixture ---"
    cp Prover.toml Prover.toml.bak
    cp Prover_allowlist.toml Prover.toml
    nargo execute
    bb prove --scheme ultra_honk --oracle_hash keccak \
      --bytecode_path "$json" --witness_path "$gz" \
      --output_path target --output_format bytes_and_fields
    mkdir -p "$FIXTURES/jurisdiction_allow"
    cp target/vk "$FIXTURES/jurisdiction_allow/vk"
    cp target/proof "$FIXTURES/jurisdiction_allow/proof"
    cp target/public_inputs "$FIXTURES/jurisdiction_allow/public_inputs"
    echo "  -> fixtures/jurisdiction_allow/{vk,proof,public_inputs}"
    mv Prover.toml.bak Prover.toml
  fi

  popd >/dev/null
}

if [ "$#" -gt 0 ]; then
  for n in "$@"; do build "$n"; done
else
  for n in commit commit3 kyc_proof age_proof income_proof jurisdiction_proof funds_proof accreditation_proof range_proof employment_proof aggregate_proof set_membership; do build "$n"; done
fi


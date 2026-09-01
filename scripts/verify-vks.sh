#!/usr/bin/env bash
# verify-vks.sh — Rebuild the committed Noir circuit VKs and compare them to the
# published sha256 hashes stored in circuits/testvectors/*.json.
#
# Usage:
#   ./scripts/verify-vks.sh [check|update]
#
# The script forwards to circuits/scripts/testvectors.js, which recompiles each
# circuit using the pinned Noir + Barretenberg versions and fails if the generated
# VK hash, public inputs or witness drift from the committed vectors.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"

if ! command -v nargo >/dev/null 2>&1; then
  echo "nargo not found — install the pinned Noir toolchain first:" >&2
  echo "  noirup -v 1.0.0-beta.9" >&2
  exit 1
fi

if ! command -v bb >/dev/null 2>&1; then
  echo "bb not found — installing the pinned Barretenberg toolchain..." >&2
  curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/install | bash
  export PATH="$HOME/.bb:$PATH"
  source "$HOME/.bashrc" 2>/dev/null || true
  bbup -v 0.87.0
fi

node circuits/scripts/testvectors.js "$@"

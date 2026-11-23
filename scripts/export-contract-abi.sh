#!/usr/bin/env bash
set -euo pipefail

# scripts/export-contract-abi.sh
# Cross-platform entrypoint for ABI export script.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

exec node scripts/export-contract-abi.mjs "$@"

#!/usr/bin/env bash
set -euo pipefail

# scripts/check-contract-abi.sh
# Cross-platform entrypoint for ABI verification check.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

exec node scripts/check-contract-abi.mjs "$@"

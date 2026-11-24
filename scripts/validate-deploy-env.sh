#!/usr/bin/env bash
# Pre-deploy environment variable validation wrapper.
#
# Usage:
#   ./scripts/validate-deploy-env.sh [--target=staging|preview|contracts|production]
#   ./scripts/validate-deploy-env.sh --smoke-test
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required to run deploy environment validation." >&2
  exit 1
fi

exec node "$ROOT/frontend/scripts/validate-deploy-env.mjs" "$@"

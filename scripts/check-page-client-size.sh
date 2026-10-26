#!/usr/bin/env bash
# check-page-client-size.sh — Guard against page-client monoliths (#606, #685).
# Fails CI when a *PageClient.tsx shell grows past its line-count ceiling.
#
# Usage: bash scripts/check-page-client-size.sh
#
# Each cap is pinned at the file's size when it entered this list, so the file
# can only shrink — a third regrowth of the holder page is exactly what #685
# exists to prevent. Lower a cap as extraction proceeds. If a page genuinely
# needs more scope, extract it into lib/hooks and components rather than
# raising the cap.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# "<path relative to repo root>:<max lines>"
TARGETS=(
  "frontend/app/holder/HolderPageClient.tsx:506"
  "frontend/app/verify/VerifyPageClient.tsx:316"
  "frontend/app/docs/DocsPageClient.tsx:1145"
)

failed=0
for entry in "${TARGETS[@]}"; do
  path="${entry%:*}"
  max="${entry##*:}"
  file="$ROOT/$path"

  if [[ ! -f "$file" ]]; then
    echo "::error::$path not found"
    failed=1
    continue
  fi

  lines=$(wc -l < "$file" | tr -d '[:space:]')
  echo "$path: ${lines} lines (limit: ${max})"

  if (( lines > max )); then
    echo "::error::$path has ${lines} lines, exceeding its ${max}-line limit."
    failed=1
  fi
done

if (( failed )); then
  echo "::error::Page-level features belong in frontend/lib/hooks/ and frontend/components/."
  echo "::error::See CONTRIBUTING.md §\"Holder page architecture\" and issues #606 / #685."
  exit 1
fi

echo "OK — all page clients within limit."
exit 0

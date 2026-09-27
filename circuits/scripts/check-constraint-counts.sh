#!/usr/bin/env bash
# check-constraint-counts.sh — Record and enforce Noir circuit constraint counts.
#
# Usage:
#   check-constraint-counts.sh update   — re-derive baselines and write circuits/CIRCUIT_SIZES.json
#   check-constraint-counts.sh check    — compare current counts to baselines; exit 1 if any
#                                         circuit exceeds THRESHOLD_PCT% over baseline (default 10%).
#
# nargo info --json outputs the ACIR opcode count per circuit.  This is the
# fastest available proxy for proving time — computed as a side-effect of
# compilation already done by the CI compile step, so it adds no extra nargo
# invocations.
#
# Environment:
#   THRESHOLD_PCT  — integer percentage over baseline that triggers failure (default: 10)
#   NARGO          — path to nargo binary (default: nargo from PATH)
#
# In `check` mode the script prints a Markdown table to stdout.  The CI step
# captures it and posts it as a PR comment via actions/github-script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$CIRCUITS_DIR/CIRCUIT_SIZES.json"
THRESHOLD_PCT="${THRESHOLD_PCT:-10}"
NARGO="${NARGO:-nargo}"

# Circuits to track — must match the compile loop in .github/workflows/ci.yml.
# range_proof is excluded (it's an internal helper, not a user-facing proof).
CIRCUITS=(
  commit
  commit3
  kyc_proof
  age_proof
  income_proof
  jurisdiction_proof
  funds_proof
  accreditation_proof
  employment_proof
  aggregate_proof
  set_membership
)

# ── Helpers ───────────────────────────────────────────────────────────────────

die() { echo "::error::$*" >&2; exit 1; }

# Returns the ACIR opcode count for the circuit in the current directory.
# nargo info --json outputs:
#   {"programs":[{"package_name":"...","functions":[{"name":"main","acir_opcodes":N,...}]}]}
get_count() {
  local json
  json=$("$NARGO" info --json 2>/dev/null) || die "nargo info failed in $(pwd)"
  python3 -c "
import json, sys
data = json.load(sys.stdin)
programs = data.get('programs', [])
if not programs:
    sys.exit(1)
fns = programs[0].get('functions', [])
main = next((f for f in fns if f.get('name') == 'main'), fns[0] if fns else None)
if main is None:
    sys.exit(1)
print(main['acir_opcodes'])
" <<< "$json" 2>/dev/null || die "Could not parse nargo info output in $(pwd)"
}

# ── Mode: update ─────────────────────────────────────────────────────────────

if [[ "${1:-}" == "update" ]]; then
  echo "Updating constraint baselines…"

  # Build JSON incrementally — no associative arrays needed.
  json_body=""
  for dir in "${CIRCUITS[@]}"; do
    echo -n "  $dir … "
    count=$(cd "$CIRCUITS_DIR/$dir" && get_count)
    echo "$count opcodes"
    json_body="${json_body}  \"${dir}\": ${count},"$'\n'
  done

  # Remove trailing comma from last line, wrap in braces.
  json_body="${json_body%,$'\n'}"$'\n'
  printf '{\n%s}\n' "$json_body" | python3 -c "
import json, sys
# Re-parse to sort keys and pretty-print canonically.
data = json.load(sys.stdin)
print(json.dumps(data, indent=2, sort_keys=True))
" > "$BASELINE_FILE"

  echo "Wrote $BASELINE_FILE"
  exit 0
fi

# ── Mode: check ──────────────────────────────────────────────────────────────

[[ "${1:-}" == "check" ]] || { echo "Usage: $0 [update|check]" >&2; exit 1; }

[[ -f "$BASELINE_FILE" ]] || \
  die "Baseline file not found: $BASELINE_FILE — run '$0 update' first."

FAILED=0
WARNED=0
TABLE_ROWS=""

# Read baselines one key at a time using python to avoid jq dependency.
while IFS="=" read -r circuit baseline; do
  [[ -z "$circuit" ]] && continue

  dir="$CIRCUITS_DIR/$circuit"
  if [[ ! -d "$dir" ]]; then
    echo "::warning::Circuit directory not found: $circuit — skipping"
    continue
  fi

  # Baseline might be 0 (placeholder) — treat as "no baseline yet".
  if [[ "$baseline" -eq 0 ]]; then
    current=$(cd "$dir" && get_count)
    TABLE_ROWS="${TABLE_ROWS}| \`${circuit}\` | — | ${current} | — | ⚪ no baseline |"$'\n'
    continue
  fi

  current=$(cd "$dir" && get_count)
  delta=$((current - baseline))
  pct=0
  [[ $baseline -gt 0 ]] && pct=$(( (delta * 100) / baseline ))

  if [[ $delta -gt 0 && $pct -gt $THRESHOLD_PCT ]]; then
    status="❌ +${pct}%"
    FAILED=1
  elif [[ $delta -gt 0 ]]; then
    status="⚠️  +${pct}%"
    WARNED=1
  elif [[ $delta -lt 0 ]]; then
    status="✅ ${pct}%"
  else
    status="✅ 0%"
  fi

  TABLE_ROWS="${TABLE_ROWS}| \`${circuit}\` | ${baseline} | ${current} | ${delta:+"+"}${delta} | ${status} |"$'\n'

done < <(python3 -c "
import json
with open('$BASELINE_FILE') as f:
    d = json.load(f)
for k, v in sorted(d.items()):
    print(f'{k}={v}')
")

# Print Markdown table (captured by CI and posted as PR comment).
echo ""
echo "## Circuit Constraint Counts"
echo ""
echo "| Circuit | Baseline | Current | Δ opcodes | Status |"
echo "|---------|----------|---------|-----------|--------|"
printf "%s" "$TABLE_ROWS"
echo ""
echo "> Threshold: **+${THRESHOLD_PCT}%** over baseline triggers a failure."
echo "> To update baselines after an intentional change: \`circuits/scripts/check-constraint-counts.sh update\`"
echo ""

if [[ $FAILED -ne 0 ]]; then
  echo "::error::One or more circuits exceeded the +${THRESHOLD_PCT}% constraint-count threshold."
  echo "::error::Review the table above. If the increase is intentional, run 'circuits/scripts/check-constraint-counts.sh update' and commit CIRCUIT_SIZES.json."
  exit 1
fi

[[ $WARNED -ne 0 ]] && echo "::warning::Some circuits grew but stayed within the ${THRESHOLD_PCT}% threshold."
echo "All circuits within threshold. ✅"
exit 0

#!/usr/bin/env bash
# scripts/benchmark-compare.sh
#
# Compare two benchmark result files produced by scripts/benchmark.sh and flag
# regressions in CPU instruction use and fees.
#
# Usage:
#   ./scripts/benchmark-compare.sh <baseline.txt> <candidate.txt> [options]
#
# Options:
#   --threshold-cpu  <pct>   Fail if cpu_insns grows more than N% (default: 10)
#   --threshold-fee  <pct>   Fail if min_resource_fee grows more than N% (default: 10)
#   --format <text|json>     Output format (default: text)
#   --output <file>          Write report to file instead of stdout
#   --provenance-baseline <file>   JSONL file for baseline run metadata
#   --provenance-candidate <file>  JSONL file for candidate run metadata
#   --help, -h
#
# Exit codes:
#   0  No regressions detected
#   1  One or more functions exceeded the threshold
#   2  Usage error
#
# Input format (from benchmark.sh):
#   Function                                      cpu_insns      mem_bytes      ...  timestamp
#   proof_registry::submit_proof (kyc)            12345678       ...

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
BASELINE_FILE=""
CANDIDATE_FILE=""
THRESHOLD_CPU=10
THRESHOLD_FEE=10
OUTPUT_FORMAT="text"
OUTPUT_FILE=""
PROVENANCE_BASELINE=""
PROVENANCE_CANDIDATE=""

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
show_help() {
  grep '^#' "$0" | head -40 | sed 's/^# \{0,1\}//'
}

if [[ $# -lt 2 ]]; then
  show_help >&2
  exit 2
fi

BASELINE_FILE="$1"; shift
CANDIDATE_FILE="$1"; shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --threshold-cpu)        THRESHOLD_CPU="$2"; shift 2 ;;
    --threshold-fee)        THRESHOLD_FEE="$2"; shift 2 ;;
    --format)               OUTPUT_FORMAT="$2"; shift 2 ;;
    --output)               OUTPUT_FILE="$2"; shift 2 ;;
    --provenance-baseline)  PROVENANCE_BASELINE="$2"; shift 2 ;;
    --provenance-candidate) PROVENANCE_CANDIDATE="$2"; shift 2 ;;
    --help|-h)              show_help; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -f "$BASELINE_FILE" ]]  || { echo "Error: baseline file not found: $BASELINE_FILE" >&2; exit 2; }
[[ -f "$CANDIDATE_FILE" ]] || { echo "Error: candidate file not found: $CANDIDATE_FILE" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Parse a benchmark results file into an associative array
# key = function name, value = "cpu|mem|read|write|fee"
# Skips header/separator lines (those containing --- or starting with Function)
# ---------------------------------------------------------------------------
declare -A BASE_CPU BASE_FEE BASE_MEM
declare -A CAND_CPU CAND_FEE CAND_MEM

parse_file() {
  local file="$1"
  local -n ref_cpu="$2"
  local -n ref_fee="$3"
  local -n ref_mem="$4"

  while IFS= read -r line; do
    # Skip blank, header, and separator lines
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*Function ]] && continue
    [[ "$line" =~ ^[[:space:]]*----- ]] && continue

    # Columns: Function(45) cpu(14) mem(14) read(14) write(14) fee(14) ts(16)
    fn="$(echo "$line" | awk '{print $1}')"
    # Rejoin multi-word function labels (e.g. "proof_registry::submit_proof (kyc)")
    # The function name ends at the first column-looking number
    fn_full="$(echo "$line" | sed 's/[[:space:]]\{2,\}.*//' | sed 's/[[:space:]]*$//')"
    nums=( $(echo "$line" | grep -oE '[0-9]+' | head -6) )

    [[ ${#nums[@]} -ge 1 ]] || continue

    ref_cpu["$fn_full"]="${nums[0]:-0}"
    ref_mem["$fn_full"]="${nums[1]:-0}"
    ref_fee["$fn_full"]="${nums[4]:-0}"
  done < "$file"
}

parse_file "$BASELINE_FILE"  BASE_CPU BASE_FEE BASE_MEM
parse_file "$CANDIDATE_FILE" CAND_CPU CAND_FEE CAND_MEM

# ---------------------------------------------------------------------------
# Read provenance metadata (last completed record from JSONL)
# ---------------------------------------------------------------------------
get_provenance_field() {
  local file="$1" field="$2"
  [[ -f "$file" ]] || { echo "N/A"; return; }
  # Read the last line that has status=completed
  grep '"status".*"completed"' "$file" 2>/dev/null | tail -1 \
    | grep -oE "\"$field\":\\s*\"[^\"]+\"" | head -1 \
    | sed 's/.*": "//;s/"//' || echo "N/A"
}

BASELINE_COMMIT="$(get_provenance_field "$PROVENANCE_BASELINE" "git_commit")"
CANDIDATE_COMMIT="$(get_provenance_field "$PROVENANCE_CANDIDATE" "git_commit")"

# ---------------------------------------------------------------------------
# Comparison logic
# ---------------------------------------------------------------------------
REGRESSIONS=()
IMPROVEMENTS=()
RESULTS=()   # for JSON output

compare_metric() {
  local fn="$1" metric="$2" base="$3" cand="$4" threshold="$5"
  [[ "$base" == "0" || "$base" == "N/A" ]] && return
  [[ "$cand" == "0" || "$cand" == "N/A" ]] && return

  local pct_change
  pct_change="$(awk "BEGIN { printf \"%.1f\", (($cand - $base) / $base) * 100 }")"
  local abs_change=$(( cand - base ))

  local flag="ok"
  if awk "BEGIN { exit ($pct_change > $threshold) ? 0 : 1 }"; then
    flag="regression"
    REGRESSIONS+=("$fn [$metric] +${pct_change}% ($base â†’ $cand)")
  elif awk "BEGIN { exit ($pct_change < -1) ? 0 : 1 }"; then
    flag="improvement"
    IMPROVEMENTS+=("$fn [$metric] ${pct_change}% ($base â†’ $cand)")
  fi

  RESULTS+=("{\"function\":$(printf '%s' "$fn" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$fn"),\"metric\":\"$metric\",\"baseline\":$base,\"candidate\":$cand,\"pct_change\":$pct_change,\"flag\":\"$flag\"}")
}

ALL_FUNCTIONS=()
for fn in "${!BASE_CPU[@]}"; do ALL_FUNCTIONS+=("$fn"); done
for fn in "${!CAND_CPU[@]}"; do
  already=0
  for existing in "${ALL_FUNCTIONS[@]}"; do [[ "$existing" == "$fn" ]] && already=1; done
  [[ $already -eq 0 ]] && ALL_FUNCTIONS+=("$fn")
done

for fn in "${ALL_FUNCTIONS[@]}"; do
  base_cpu="${BASE_CPU[$fn]:-0}"
  cand_cpu="${CAND_CPU[$fn]:-0}"
  base_fee="${BASE_FEE[$fn]:-0}"
  cand_fee="${CAND_FEE[$fn]:-0}"
  base_mem="${BASE_MEM[$fn]:-0}"
  cand_mem="${CAND_MEM[$fn]:-0}"

  compare_metric "$fn" "cpu_insns" "$base_cpu" "$cand_cpu" "$THRESHOLD_CPU"
  compare_metric "$fn" "fee_stroops" "$base_fee" "$cand_fee" "$THRESHOLD_FEE"
done

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
emit_text() {
  echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
  echo "  StellarCred Benchmark Comparison"
  echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
  echo "  Baseline:  $BASELINE_FILE"
  [[ -n "$BASELINE_COMMIT"  ]] && echo "  Commit:    $BASELINE_COMMIT"
  echo "  Candidate: $CANDIDATE_FILE"
  [[ -n "$CANDIDATE_COMMIT" ]] && echo "  Commit:    $CANDIDATE_COMMIT"
  echo "  Threshold: cpu >${THRESHOLD_CPU}%  fee >${THRESHOLD_FEE}%"
  echo ""

  if [[ ${#REGRESSIONS[@]} -gt 0 ]]; then
    echo "  âœ– REGRESSIONS (${#REGRESSIONS[@]}):"
    for r in "${REGRESSIONS[@]}"; do echo "      â†‘ $r"; done
    echo ""
  fi

  if [[ ${#IMPROVEMENTS[@]} -gt 0 ]]; then
    echo "  âœ” IMPROVEMENTS (${#IMPROVEMENTS[@]}):"
    for i in "${IMPROVEMENTS[@]}"; do echo "      â†“ $i"; done
    echo ""
  fi

  if [[ ${#REGRESSIONS[@]} -eq 0 ]]; then
    echo "  âœ” No regressions detected."
  fi

  echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
  echo "  RESULT: $([[ ${#REGRESSIONS[@]} -eq 0 ]] && echo 'PASS' || echo "FAIL (${#REGRESSIONS[@]} regression(s))")"
  echo "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
}

emit_json() {
  local results_json
  results_json="$(IFS=,; echo "[${RESULTS[*]}]")"
  cat <<EOF
{
  "baseline_file": "$BASELINE_FILE",
  "candidate_file": "$CANDIDATE_FILE",
  "baseline_commit": "$BASELINE_COMMIT",
  "candidate_commit": "$CANDIDATE_COMMIT",
  "thresholds": { "cpu_pct": $THRESHOLD_CPU, "fee_pct": $THRESHOLD_FEE },
  "regressions": $(printf '%s\n' "${REGRESSIONS[@]+"${REGRESSIONS[@]}"}" | jq -R . | jq -s . 2>/dev/null || echo "[]"),
  "improvements": $(printf '%s\n' "${IMPROVEMENTS[@]+"${IMPROVEMENTS[@]}"}" | jq -R . | jq -s . 2>/dev/null || echo "[]"),
  "details": $results_json,
  "result": "$([[ ${#REGRESSIONS[@]} -eq 0 ]] && echo 'PASS' || echo 'FAIL')"
}
EOF
}

REPORT=""
case "$OUTPUT_FORMAT" in
  json) REPORT="$(emit_json)" ;;
  *)    REPORT="$(emit_text)" ;;
esac

if [[ -n "$OUTPUT_FILE" ]]; then
  echo "$REPORT" > "$OUTPUT_FILE"
  echo "Report written to $OUTPUT_FILE"
else
  echo "$REPORT"
fi

# Exit 1 if there are regressions
[[ ${#REGRESSIONS[@]} -eq 0 ]] && exit 0 || exit 1

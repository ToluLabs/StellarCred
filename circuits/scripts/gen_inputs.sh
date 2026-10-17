#!/usr/bin/env bash
# Regenerate Prover.toml for every credential circuit: compute the Poseidon2
# commitment (via the commit circuit) and the issuer's Schnorr signature over it
# (via sign.js), then write the circuit inputs. Run before circuits/scripts/build.sh.
set -euo pipefail
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"

# Shared timestamped logging + fail-fast helpers.
source "$(dirname "${BASH_SOURCE[0]}")/log.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
COMMIT="$ROOT/commit"

# Validate required tooling before doing any work.
if ! command -v nargo >/dev/null 2>&1; then
  log_error "nargo not found — run: noirup -v 1.0.0-beta.9"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  log_error "node not found — install Node.js to run the signing helpers"
  exit 1
fi

require_env GEN_ISSUER_PRIVATE_KEY

commit() { # value salt -> canonical decimal commitment (2-arity)
  printf 'value = "%s"\nsalt = "%s"\n' "$1" "$2" > "$COMMIT/Prover.toml"
  local raw
  raw=$(cd "$COMMIT" && nargo execute 2>&1 | grep "Circuit output" | sed -E 's/.*Field\((-?[0-9]+)\).*/\1/')
  if [ -z "$raw" ]; then
    log_error "commit: nargo execute produced no Circuit output for value=$1 salt=$2"
    return 1
  fi
  RAW="$raw" node -e 'const r=21888242871839275222246405745257275088548364400416034343698204186575808495617n;let x=BigInt(process.env.RAW);if(x<0n)x+=r;console.log(x.toString())'
}

commit3() { # value1 value2 salt -> canonical decimal commitment (3-arity, for employment)
  printf 'status = "%s"\nseniority = "%s"\nsalt = "%s"\n' "$1" "$2" "$3" > "$ROOT/commit3/Prover.toml"
  local raw
  raw=$(cd "$ROOT/commit3" && nargo execute 2>&1 | grep "Circuit output" | sed -E 's/.*Field\((-?[0-9]+)\).*/\1/')
  if [ -z "$raw" ]; then
    log_error "commit3: nargo execute produced no Circuit output for status=$1 seniority=$2 salt=$3"
    return 1
  fi
  RAW="$raw" node -e 'const r=2188824287183927522246405745257275088548364400416034343698204186575808495617n;let x=BigInt(process.env.RAW);if(x<0n)x+=r;console.log(x.toString())'
}

log_info "kyc_proof..."
C=$(commit 42 7) || exit 1
{ echo "secret = \"42\""; echo "salt = \"7\""; echo "commitment = \"$C\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/kyc_proof/Prover.toml"

log_info "age_proof..."
C=$(commit 3650 12345) || exit 1
{ echo "date_of_birth = \"3650\""; echo "salt = \"12345\""; echo "commitment = \"$C\""; \
  echo "current_date = \"20000\""; echo "threshold_years = \"18\""; node "$SCRIPTS"/sign.js" "$C"; } \
  > "$ROOT/age_proof/Prover.toml"

log_info "income_proof..."
C=$(commit 250000 99) || exit 1
{
  echo "income = \"250000\""; echo "salt = \"99\""; echo "commitment = \"$C\""; \
  echo "threshold = \"200000\""; node "$SCRIPTS"/sign.js" "$C"; } \
  > "$ROOT/income_proof/Prover.toml"

log_info "accreditation_proof..."
C=$(commit 1500000 99) || exit 1
{ echo "net_worth = \"1500000\""; echo "salt = \"99\""; echo "commitment = \"$C\""; \
  echo "threshold = \"1000000\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/accreditation_proof/Prover.toml"

log_info "funds_proof..."
C=$(commit 250000 99) || exit 1
{ echo "balance = \"250000\""; echo "salt = \"99\""; echo "commitment = \"$C\""; \
  echo "threshold = \"200000\""; node "$SCRIPTS"/sign.js" "$C"; } \
  > "$ROOT/funds_proof/Prover.toml"

log_info "range_proof..."
C=$(commit 40000 2024) || exit 1
{ echo "value = \"40000\""; echo "salt = \"2024\""; echo "commitment = \"$C\""; \
  echo "min = \"30000\""; echo "max = \"50000\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/range_proof/Prover.toml"

log_info "jurisdiction_proof (denylist)..."
C=$(commit 566 77) || exit 1
{ echo "jurisdiction = \"566\""; echo "salt = \"77\""; echo "commitment = \"$C\""; \
  echo "denylist = \"true\""; node "$SCRIPTS"/sign.js" "$C"; } \
  > "$ROOT/jurisdiction_proof/Prover.toml"
{
  echo "country_code = \"566\""; echo "salt = \"77\""; echo "commitment = \"$C\""; \
  echo "restricted = [\"840\", \"364\", \"408\", \"0\", \"0\", \"0\", \"0\", \"0\"]"; \
  echo "mode = \"0\""; node "$SCRIPTS"/sign.js" "$C"; } \
 > "$ROOT/jurisdiction_proof/Prover.toml"

log_info "jurisdiction_proof (allowlist)..."
C=$(commit 566 77) || exit 1
{
  echo "country_code = \"566\""; echo "salt = \"77\""; echo "commitment = \"$C\""; \
  echo "restricted = [\"566\", \"276\", \"356\", \"0\", \"0\", \"0\", \"0\", \"0\"]"; \
  echo "mode = \"1\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/jurisdiction_proof/Prover_allowlist.toml"

log_info "employment_proof..."
# Commitment binds BOTH status (1=employed) AND the holder's specific
# seniority so the issuer's signature attests to tenure, not just the
# binary "is employed" tag.
C=$(commit3 1 5 11) || exit 1
{ echo "employment_status = \"1\""; echo "seniority = \"5\""; echo "salt = \"11\""; \
  echo "commitment = \"$C\""; echo "min_seniority = \"3\""; node "$SCRIPTS"/sign.js" "$C"; } \
  > "$ROOT/employment_proof/Prover.toml"

log_info "set_membership..."
# Allowlist: [840, 276, 566, 356] — ISO 3166-1 numeric codes for US, Germany,
# Nigeria, Israel (a small sample covering varied regions).
# We prove membership for value 840 (US, leaf index 0).
SM_VALUES="840 276 566 356"
SM_MEMBER="840"
SM_SALT="42"
C=$(commit $SM_MEMBER $SM_SALT) || exit 1
# Compute merkle_root and the Merkle path lines for the member value.
MERKLE_ROOT=$(node "$SCRIPTS/merkle_tree.js" root $SM_VALUES) || exit 1
MERKLE_LINES=$(node "$SCRIPTS"/merkle_tree.js" path $SM_VALUES --for $SM_MEMBER) || exit 1
{
  echo "value = \"$SM_MEMBER\""
  echo "salt = \"$SM_SALT\""
  echo "commitment = \"$C\""
  echo "$MERKLE_LINES"
  node "$SCRIPTS/sign.js" "$C"
} > "$ROOT/set_membership/Prover.toml"

log_info "done. demo issuer public key:"
node "$SCRIPTS"/sign.js" --pubkey

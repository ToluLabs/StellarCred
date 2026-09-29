#!/usr/bin/env bash
# Regenerate Prover.toml for every credential circuit: compute the Poseidon2
# commitment (via the commit circuit) and the issuer's Schnorr signature over it
# (via sign.js), then write the circuit inputs. Run before circuits/scripts/build.sh.
set -euo pipefail
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
COMMIT="$ROOT/commit"

commit() { # value salt -> canonical decimal commitment (2-arity)
  printf 'value = "%s"\nsalt = "%s"\n' "$1" "$2" > "$COMMIT/Prover.toml"
  local raw
  raw=$(cd "$COMMIT" && nargo execute 2>&1 | grep "Circuit output" | sed -E 's/.*Field\((-?[0-9]+)\).*/\1/')
  RAW="$raw" node -e 'const r=21888242871839275222246405745257275088548364400416034343698204186575808495617n;let x=BigInt(process.env.RAW);if(x<0n)x+=r;console.log(x.toString())'
}

commit3() { # value1 value2 salt -> canonical decimal commitment (3-arity, for employment)
  printf 'status = "%s"\nseniority = "%s"\nsalt = "%s"\n' "$1" "$2" "$3" > "$ROOT/commit3/Prover.toml"
  local raw
  raw=$(cd "$ROOT/commit3" && nargo execute 2>&1 | grep "Circuit output" | sed -E 's/.*Field\((-?[0-9]+)\).*/\1/')
  RAW="$raw" node -e 'const r=21888242871839275222246405745257275088548364400416034343698204186575808495617n;let x=BigInt(process.env.RAW);if(x<0n)x+=r;console.log(x.toString())'
}

echo "kyc_proof..."
C=$(commit 42 7)
{ echo "secret = \"42\""; echo "salt = \"7\""; echo "commitment = \"$C\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/kyc_proof/Prover.toml"

echo "age_proof..."
C=$(commit 3650 12345)
{ echo "date_of_birth = \"3650\""; echo "salt = \"12345\""; echo "commitment = \"$C\""; \
  echo "current_date = \"20000\""; echo "threshold_years = \"18\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/age_proof/Prover.toml"

echo "date_range..."
C=$(commit 3650 12345)
{ echo "issuance_date = \"3650\""; echo "salt = \"12345\""; echo "commitment = \"$C\""; \
  echo "current_date = \"3700\""; echo "max_age_days = \"90\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/date_range/Prover.toml"

echo "income_proof..."
C=$(commit 250000 99)
{ echo "income = \"250000\""; echo "salt = \"99\""; echo "commitment = \"$C\""; \
  echo "threshold = \"200000\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/income_proof/Prover.toml"

echo "accreditation_proof..."
C=$(commit 1500000 99)
{ echo "net_worth = \"1500000\""; echo "salt = \"99\""; echo "commitment = \"$C\""; \
  echo "threshold = \"1000000\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/accreditation_proof/Prover.toml"

echo "funds_proof..."
C=$(commit 250000 99)
{ echo "balance = \"250000\""; echo "salt = \"99\""; echo "commitment = \"$C\""; \
  echo "threshold = \"200000\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/funds_proof/Prover.toml"

echo "range_proof..."
C=$(commit 40000 2024)
{ echo "value = \"40000\""; echo "salt = \"2024\""; echo "commitment = \"$C\""; \
  echo "min = \"30000\""; echo "max = \"50000\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/range_proof/Prover.toml"

echo "jurisdiction_proof (denylist)..."
C=$(commit 566 77)
{ echo "jurisdiction = \"566\""; echo "salt = \"77\""; echo "commitment = \"$C\""; \
  echo "denylist = \"true\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/jurisdiction_proof/Prover.toml"
{ echo "country_code = \"566\""; echo "salt = \"77\""; echo "commitment = \"$C\""; \
  echo "restricted = [\"840\", \"364\", \"408\", \"0\", \"0\", \"0\", \"0\", \"0\"]"; \
  echo "mode = \"0\""; node "$SCRIPTS/sign.js" "$C"; } \
 > "$ROOT/jurisdiction_proof/Prover.toml"

echo "jurisdiction_proof (allowlist)..."
C=$(commit 566 77)
{ echo "country_code = \"566\""; echo "salt = \"77\""; echo "commitment = \"$C\""; \
  echo "restricted = [\"566\", \"276\", \"356\", \"0\", \"0\", \"0\", \"0\", \"0\"]"; \
  echo "mode = \"1\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/jurisdiction_proof/Prover_allowlist.toml"

echo "employment_proof..."
# Commitment binds BOTH status (1=employed) AND the holder's specific
# seniority so the issuer's signature attests to tenure, not just the
# binary "is employed" tag.
C=$(commit3 1 5 11)
{ echo "employment_status = \"1\""; echo "seniority = \"5\""; echo "salt = \"11\""; \
  echo "commitment = \"$C\""; echo "min_seniority = \"3\""; node "$SCRIPTS/sign.js" "$C"; } \
  > "$ROOT/employment_proof/Prover.toml"

echo "set_membership..."
# Allowlist: [840, 276, 566, 356] — ISO 3166-1 numeric codes for US, Germany,
# Nigeria, Israel (a small sample covering varied regions).
# We prove membership for value 840 (US, leaf index 0).
SM_VALUES="840 276 566 356"
SM_MEMBER="840"
SM_SALT="42"
C=$(commit $SM_MEMBER $SM_SALT)
# Compute merkle_root and the Merkle path lines for the member value.
MERKLE_ROOT=$(node "$SCRIPTS/merkle_tree.js" root $SM_VALUES)
MERKLE_LINES=$(node "$SCRIPTS/merkle_tree.js" path $SM_VALUES --for $SM_MEMBER)
{
  echo "value = \"$SM_MEMBER\""
  echo "salt = \"$SM_SALT\""
  echo "commitment = \"$C\""
  echo "$MERKLE_LINES"
  node "$SCRIPTS/sign.js" "$C"
} > "$ROOT/set_membership/Prover.toml"

echo "done. demo issuer public key:"
node "$SCRIPTS/sign.js" --pubkey


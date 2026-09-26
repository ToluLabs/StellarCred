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


echo "composite_proof..."
# Policy: (T0 AND T1) AND T2, encoded as ops = [0, 2, 0]:
#   ops[0]=0 (AND)  -> r0 = T0 & T1
#   ops[1]=2 (LEFT) -> r1 = T2 only; T3 is never referenced by r0/r1/final
#   ops[2]=0 (AND)  -> final_res = r0 & r1
# T0 = age >= 18 (kind 1), T1 = value in allowlist (kind 2), T2 = jurisdiction
# eligibility proved as a second Merkle membership (kind 2). T2 must NOT be
# kind 0 padding: main.nr's kind-dispatch sends kind 0 to the else branch,
# forcing term_results[2] = false and making the final AND unsatisfiable.
# T3 stays kind 0 (safe: eval_logic only reads term_results[3] when ops[1] is
# AND(0), OR(1) or RIGHT(3)).
C_AGE=$(commit 3650 12345)
SM_VALUES="840 276 566 356"
SM_MEMBER="840"
SM_SALT="42"
C_SM=$(commit $SM_MEMBER $SM_SALT)
MERKLE_ROOT=$(node "$SCRIPTS/merkle_tree.js" root $SM_VALUES)
MERKLE_LINES=$(node "$SCRIPTS/merkle_tree.js" path $SM_VALUES --for $SM_MEMBER | grep -v 'value =' | grep -v 'salt =' | grep -v 'commitment =')
# merkle_tree.js prints TOML lines (`path = ["...", ...]`, `indices = ["0", ...]`).
# Extract the bracketed values with sed here — a JS `.match()` inside the
# double-quoted node -e string below would be interpreted as a bash parameter
# expansion ("bad substitution"). Same extraction pattern as the commit() helper.
SM_PATH=$(printf '%s\n' "$MERKLE_LINES" | sed -nE 's/^path = \[(.*)\]$/\1/p')
SM_INDICES=$(printf '%s\n' "$MERKLE_LINES" | sed -nE 's/^indices = \[(.*)\]$/\1/p')
# T2: jurisdiction eligibility (566 = Nigeria, leaf index 2) against the same
# demo allowlist, mirroring jurisdiction_proof's fixture value (commit 566 77).
JUR_MEMBER="566"
JUR_SALT="77"
C_JUR=$(commit $JUR_MEMBER $JUR_SALT)
JUR_LINES=$(node "$SCRIPTS/merkle_tree.js" path $SM_VALUES --for $JUR_MEMBER)
JUR_PATH=$(printf '%s\n' "$JUR_LINES" | sed -nE 's/^path = \[(.*)\]$/\1/p')
JUR_INDICES=$(printf '%s\n' "$JUR_LINES" | sed -nE 's/^indices = \[(.*)\]$/\1/p')

node -e "
const fs = require('fs');
const sign = require('$SCRIPTS/sign.js');
const c_age = '$C_AGE';
const c_sm = '$C_SM';
const c_jur = '$C_JUR';
const sig_age = sign.sign(BigInt(c_age));
const sig_sm = sign.sign(BigInt(c_sm));
const sig_jur = sign.sign(BigInt(c_jur));
const arr = (u) => '[' + Array.from(u).join(', ') + ']';

const values = ['3650', '$SM_MEMBER', '$JUR_MEMBER', '3650'];
const salts = ['12345', '$SM_SALT', '$JUR_SALT', '12345'];
const sigs = [arr(sig_age.sig), arr(sig_sm.sig), arr(sig_jur.sig), arr(sig_age.sig)];
const commitments = ['\"'+c_age+'\"', '\"'+c_sm+'\"', '\"'+c_jur+'\"', '\"'+c_age+'\"'];
const issuer_xs = [arr(sig_age.x), arr(sig_sm.x), arr(sig_jur.x), arr(sig_age.x)];
const issuer_ys = [arr(sig_age.y), arr(sig_sm.y), arr(sig_jur.y), arr(sig_age.y)];

const paths = [
    Array(8).fill('0'),
    [$SM_PATH],
    [$JUR_PATH],
    Array(8).fill('0')
];
const indices = [
    Array(8).fill(0),
    [$SM_INDICES],
    [$JUR_INDICES],
    Array(8).fill(0)
];

const kinds = [1, 2, 2, 0]; // T0=threshold(age), T1/T2=membership, T3=padding
const thresholds = ['3650', '0', '0', '0']; // only T0's threshold is evaluated (kind 1)
const merkle_roots = ['\"0\"', '\"$MERKLE_ROOT\"', '\"$MERKLE_ROOT\"', '\"0\"']; // same demo allowlist root for T1 and T2
const ops = [0, 2, 0]; // (T0 AND T1) AND T2; ops[1]=LEFT drops T3

console.log(\`values = [\${values.map(v => '\"'+v+'\"').join(', ')}]\`);
console.log(\`salts = [\${salts.map(v => '\"'+v+'\"').join(', ')}]\`);
console.log(\`sigs = [\${sigs.join(', ')}]\`);
console.log(\`paths = [\${paths.map(p => '['+p.map(x => '\"'+x+'\"').join(', ')+']').join(', ')}]\`);
console.log(\`indices = [\${indices.map(i => '['+i.map(x => '\"'+x+'\"').join(', ')+']').join(', ')}]\`);
console.log(\`commitments = [\${commitments.join(', ')}]\`);
console.log(\`issuer_xs = [\${issuer_xs.join(', ')}]\`);
console.log(\`issuer_ys = [\${issuer_ys.join(', ')}]\`);
console.log(\`kinds = [\${kinds.join(', ')}]\`);
console.log(\`thresholds = [\${thresholds.map(v => '\"'+v+'\"').join(', ')}]\`);
console.log(\`merkle_roots = [\${merkle_roots.join(', ')}]\`);
console.log(\`ops = [\${ops.join(', ')}]\`);
" > "$ROOT/composite_proof/Prover.toml"


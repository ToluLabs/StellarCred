#!/usr/bin/env node
// Property-based fuzzing harness for StellarCred circuits.
//
// Generates randomised valid and invalid witnesses for each credential circuit,
// computes the Poseidon2 commitment locally (using the same constants as
// merkle_tree.js), signs with the demo issuer key, writes a Prover.toml, and
// runs `nargo execute` to verify the circuit accepts or rejects as expected.
//
// Coverage strategy:
//   - Valid pass space: random value/salt with correct commitment + signature
//     and constraint-satisfying public inputs.
//   - Invalid fail space: tampered commitment, wrong salt, threshold boundary
//     violations (off-by-one), date boundaries.
//   - Deterministic boundary cases: threshold exactly met, threshold ± 1.
//
// Usage:
//   node circuits/scripts/fuzz_circuits.js [--iterations N] [--circuit NAME]
//
// Requires:
//   - nargo on PATH (pinned version, see build.sh)
//   - frontend node_modules installed (for @noble/curves in sign.js)
//
// Exit 0 if every generated case matched its expected outcome, 1 otherwise.

"use strict";

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── Paths ────────────────────────────────────────────────────────────────────
const SCRIPTS_DIR = __dirname;
const CIRCUITS_ROOT = path.join(SCRIPTS_DIR, "..");
const WORKSPACE_TARGET = path.join(CIRCUITS_ROOT, "target");

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}
const ITERATIONS = Math.max(1, parseInt(flag("--iterations", "20"), 10));
const ONLY_CIRCUIT = flag("--circuit", null);

// ── Poseidon2 BN254 (mirrors merkle_tree.js, kept in sync) ──────────────────
const P = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);
const mod = (a) => {
  const r = a % P;
  return r < 0n ? r + P : r;
};
const add = (a, b) => mod(a + b);
const mul = (a, b) => mod(a * b);

const INTERNAL_DIAG = [
  0x10dc6e9c006ea38b04b1e03b4bd9490c0d03f98929ca1d7fb56821fd19d3b6e7n,
  0x0c28145b6a44df3e0149b3d0a30b3bb599df9756d4dd9b84a86b38cfb45a740bn,
  0x00544b8338791518b2c7645a50392798b21f75bb60e3596170067d00141cac15n,
  0x222c01175718386f2e2e82eb122789e352e105a3b8fa852613bc534433ee428bn,
];

// Round constants (t=4, Rf=8, Rp=56).  Imported lazily from merkle_tree.js to
// avoid duplicating the large literal here.
let RC;
function loadRC() {
  if (RC) return;
  // merkle_tree.js exports nothing by default; read the source and eval the
  // constant.  This keeps a single source of truth.
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, "merkle_tree.js"), "utf8");
  const m = src.match(/const RC = \[([\s\S]*?)\];/);
  if (!m) throw new Error("Could not extract RC from merkle_tree.js");
  // eslint-disable-next-line no-eval
  RC = eval("[" + m[1] + "]");
}

function sbox1(x) {
  const x2 = mul(x, x);
  return mul(mul(x2, x2), x);
}
function matMul4(s) {
  const t0 = add(s[0], s[1]);
  const t1 = add(s[2], s[3]);
  const t2 = add(add(s[1], s[1]), t1);
  const t3 = add(add(s[3], s[3]), t0);
  const t4 = add(add(add(t1, t1), t1), add(t1, t3));
  const t5 = add(add(add(t0, t0), t0), add(t0, t2));
  const t6 = add(t3, t5);
  const t7 = add(t2, t4);
  return [t6, t5, t7, t4];
}
function internalMul(s) {
  const sum = s.reduce((a, b) => add(a, b), 0n);
  return s.map((si, i) => add(mul(si, INTERNAL_DIAG[i]), sum));
}
function permute(state) {
  loadRC();
  const RF = 8,
    RP = 56;
  let s = matMul4(state);
  for (let r = 0; r < RF / 2; r++) {
    s = s.map((x, i) => add(x, RC[r][i]));
    s = s.map(sbox1);
    s = matMul4(s);
  }
  for (let r = RF / 2; r < RF / 2 + RP; r++) {
    s = [add(s[0], RC[r][0]), s[1], s[2], s[3]];
    s = [sbox1(s[0]), s[1], s[2], s[3]];
    s = internalMul(s);
  }
  for (let r = RF / 2 + RP; r < RF + RP; r++) {
    s = s.map((x, i) => add(x, RC[r][i]));
    s = s.map(sbox1);
    s = matMul4(s);
  }
  return s;
}
function poseidon2Hash(inputs, messageSize) {
  const RATE = 3;
  const iv = BigInt(messageSize) * (1n << 64n);
  let state = [0n, 0n, 0n, iv];
  let i = 0;
  while (i + RATE <= messageSize) {
    state[0] = add(state[0], inputs[i]);
    state[1] = add(state[1], inputs[i + 1]);
    state[2] = add(state[2], inputs[i + 2]);
    state = permute(state);
    i += RATE;
  }
  const rem = messageSize - i;
  if (rem > 0) state[0] = add(state[0], inputs[i]);
  if (rem > 1) state[1] = add(state[1], inputs[i + 1]);
  if (messageSize === 0 || messageSize % RATE !== 0) {
    state = permute(state);
  }
  return state[0];
}

// ── Commitment helpers ───────────────────────────────────────────────────────
function commitment2(value, salt) {
  return poseidon2Hash([BigInt(value), BigInt(salt)], 2);
}
function commitment3(v1, v2, salt) {
  return poseidon2Hash([BigInt(v1), BigInt(v2), BigInt(salt)], 3);
}

// ── Signing ──────────────────────────────────────────────────────────────────
const { sign: ecdsaSign } = require(path.join(SCRIPTS_DIR, "sign.js"));

function signCommitment(commitmentBig) {
  return ecdsaSign(commitmentBig);
}

// ── Random helpers ───────────────────────────────────────────────────────────
function randU64(max = 2n ** 64n - 1n) {
  const buf = crypto.randomBytes(8);
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[i]);
  return v > max ? v % (max + 1n) : v;
}
function randSalt() {
  // Non-zero salt in the BN254 scalar field.
  let s;
  do {
    s = randU64();
  } while (s === 0n);
  return s;
}
function randRange(lo, hi) {
  return lo + randU64(BigInt(hi - lo));
}

// ── TOML formatting ──────────────────────────────────────────────────────────
function tomlStr(v) {
  return `"${v}"`;
}
function tomlArr(arr) {
  return "[" + arr.map((x) => `"${x}"`).join(", ") + "]";
}
function byteArr(u8) {
  return "[" + Array.from(u8).join(", ") + "]";
}
function byteArrFromBigInt(x) {
  const b = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

// ── Prover.toml writers ──────────────────────────────────────────────────────
function writeAgeProofProver(dir, opts) {
  const { date_of_birth, salt, commitment, sig, issuer_x, issuer_y, current_date, threshold_years } = opts;
  const lines = [
    `date_of_birth = ${tomlStr(date_of_birth)}`,
    `salt = ${tomlStr(salt)}`,
    `sig = ${byteArr(sig)}`,
    `commitment = ${tomlStr(commitment)}`,
    `issuer_x = ${byteArr(issuer_x)}`,
    `issuer_y = ${byteArr(issuer_y)}`,
    `current_date = ${tomlStr(current_date)}`,
    `threshold_years = ${tomlStr(threshold_years)}`,
  ];
  fs.writeFileSync(path.join(dir, "Prover.toml"), lines.join("\n") + "\n");
}

function writeIncomeProofProver(dir, opts) {
  const { income, salt, commitment, sig, issuer_x, issuer_y, threshold } = opts;
  const lines = [
    `income = ${tomlStr(income)}`,
    `salt = ${tomlStr(salt)}`,
    `sig = ${byteArr(sig)}`,
    `commitment = ${tomlStr(commitment)}`,
    `issuer_x = ${byteArr(issuer_x)}`,
    `issuer_y = ${byteArr(issuer_y)}`,
    `threshold = ${tomlStr(threshold)}`,
  ];
  fs.writeFileSync(path.join(dir, "Prover.toml"), lines.join("\n") + "\n");
}

function writeFundsProofProver(dir, opts) {
  const { balance, salt, commitment, sig, issuer_x, issuer_y, threshold } = opts;
  const lines = [
    `balance = ${tomlStr(balance)}`,
    `salt = ${tomlStr(salt)}`,
    `sig = ${byteArr(sig)}`,
    `commitment = ${tomlStr(commitment)}`,
    `issuer_x = ${byteArr(issuer_x)}`,
    `issuer_y = ${byteArr(issuer_y)}`,
    `threshold = ${tomlStr(threshold)}`,
  ];
  fs.writeFileSync(path.join(dir, "Prover.toml"), lines.join("\n") + "\n");
}

function writeAccreditationProofProver(dir, opts) {
  const { net_worth, salt, commitment, sig, issuer_x, issuer_y, threshold } = opts;
  const lines = [
    `net_worth = ${tomlStr(net_worth)}`,
    `salt = ${tomlStr(salt)}`,
    `sig = ${byteArr(sig)}`,
    `commitment = ${tomlStr(commitment)}`,
    `issuer_x = ${byteArr(issuer_x)}`,
    `issuer_y = ${byteArr(issuer_y)}`,
    `threshold = ${tomlStr(threshold)}`,
  ];
  fs.writeFileSync(path.join(dir, "Prover.toml"), lines.join("\n") + "\n");
}

function writeKycProofProver(dir, opts) {
  const { secret, salt, commitment, sig, issuer_x, issuer_y } = opts;
  const lines = [
    `secret = ${tomlStr(secret)}`,
    `salt = ${tomlStr(salt)}`,
    `sig = ${byteArr(sig)}`,
    `commitment = ${tomlStr(commitment)}`,
    `issuer_x = ${byteArr(issuer_x)}`,
    `issuer_y = ${byteArr(issuer_y)}`,
  ];
  fs.writeFileSync(path.join(dir, "Prover.toml"), lines.join("\n") + "\n");
}

function writeJurisdictionProofProver(dir, opts) {
  const { country_code, salt, commitment, sig, issuer_x, issuer_y, restricted, mode } = opts;
  const lines = [
    `country_code = ${tomlStr(country_code)}`,
    `salt = ${tomlStr(salt)}`,
    `sig = ${byteArr(sig)}`,
    `commitment = ${tomlStr(commitment)}`,
    `issuer_x = ${byteArr(issuer_x)}`,
    `issuer_y = ${byteArr(issuer_y)}`,
    `restricted = ${tomlArr(restricted)}`,
    `mode = ${tomlStr(mode)}`,
  ];
  fs.writeFileSync(path.join(dir, "Prover.toml"), lines.join("\n") + "\n");
}

function writeRangeProofProver(dir, opts) {
  const { value, salt, commitment, sig, issuer_x, issuer_y, min, max } = opts;
  const lines = [
    `value = ${tomlStr(value)}`,
    `salt = ${tomlStr(salt)}`,
    `sig = ${byteArr(sig)}`,
    `commitment = ${tomlStr(commitment)}`,
    `issuer_x = ${byteArr(issuer_x)}`,
    `issuer_y = ${byteArr(issuer_y)}`,
    `min = ${tomlStr(min)}`,
    `max = ${tomlStr(max)}`,
  ];
  fs.writeFileSync(path.join(dir, "Prover.toml"), lines.join("\n") + "\n");
}

function writeEmploymentProofProver(dir, opts) {
  const { employment_status, seniority, salt, commitment, sig, issuer_x, issuer_y, min_seniority } = opts;
  const lines = [
    `employment_status = ${tomlStr(employment_status)}`,
    `seniority = ${tomlStr(seniority)}`,
    `salt = ${tomlStr(salt)}`,
    `sig = ${byteArr(sig)}`,
    `commitment = ${tomlStr(commitment)}`,
    `issuer_x = ${byteArr(issuer_x)}`,
    `issuer_y = ${byteArr(issuer_y)}`,
    `min_seniority = ${tomlStr(min_seniority)}`,
  ];
  fs.writeFileSync(path.join(dir, "Prover.toml"), lines.join("\n") + "\n");
}

// ── nargo execute runner ─────────────────────────────────────────────────────
function nargoExecute(circuitName) {
  try {
    execFileSync("nargo", ["execute", "--package", circuitName], {
      cwd: CIRCUITS_ROOT,
      encoding: "utf8",
      timeout: 120000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Test case runner ─────────────────────────────────────────────────────────
function runCase(label, circuitName, writer, dir, opts, shouldPass) {
  writer(dir, opts);
  const passed = nargoExecute(circuitName);
  const ok = passed === shouldPass;
  return { label, ok, passed, shouldPass };
}

// ── Shared credential setup ──────────────────────────────────────────────────
function makeCredential(value, salt) {
  const c = commitment2(value, salt);
  const { x, y, sig } = signCommitment(c);
  return {
    commitment: c.toString(),
    issuer_x: x,
    issuer_y: y,
    sig,
  };
}
function makeCredential3(v1, v2, salt) {
  const c = commitment3(v1, v2, salt);
  const { x, y, sig } = signCommitment(c);
  return {
    commitment: c.toString(),
    issuer_x: x,
    issuer_y: y,
    sig,
  };
}

// Tamper a commitment by adding 1 (guaranteed mismatch).
function tamperCommitment(c) {
  const v = BigInt(c);
  return ((v + 1n) % P).toString();
}

// ── Circuit fuzzers ──────────────────────────────────────────────────────────

function fuzzAgeProof(results) {
  const name = "age_proof";
  const dir = path.join(CIRCUITS_ROOT, name);
  console.log(`\n─── ${name} ───`);

  // Deterministic boundary cases.
  const boundaryCases = [
    // Exact boundary: current_date == dob + threshold * 365  →  PASS
    {
      label: "boundary: exact threshold date",
      dob: 10000n,
      threshold: 18n,
      current: 10000n + 18n * 365n,
      shouldPass: true,
    },
    // Off-by-one below: current_date == dob + threshold * 365 - 1  →  FAIL
    {
      label: "boundary: one day below threshold",
      dob: 10000n,
      threshold: 18n,
      current: 10000n + 18n * 365n - 1n,
      shouldPass: false,
    },
    // Off-by-one above: current_date == dob + threshold * 365 + 1  →  PASS
    {
      label: "boundary: one day above threshold",
      dob: 10000n,
      threshold: 18n,
      current: 10000n + 18n * 365n + 1n,
      shouldPass: true,
    },
    // threshold = 0: any current_date >= dob passes
    {
      label: "boundary: threshold zero",
      dob: 10000n,
      threshold: 0n,
      current: 10000n,
      shouldPass: true,
    },
    // threshold = 200: maximum allowed threshold
    {
      label: "boundary: max threshold (200)",
      dob: 1000n,
      threshold: 200n,
      current: 1000n + 200n * 365n,
      shouldPass: true,
    },
    // threshold = 201: exceeds max  →  FAIL
    {
      label: "boundary: threshold exceeds max (201)",
      dob: 1000n,
      threshold: 201n,
      current: 1000n + 201n * 365n,
      shouldPass: false,
    },
  ];

  for (const tc of boundaryCases) {
    const salt = randSalt();
    const cred = makeCredential(tc.dob, salt);
    results.push(
      runCase(
        tc.label,
        name,
        writeAgeProofProver,
        dir,
        {
          date_of_birth: tc.dob.toString(),
          salt: salt.toString(),
          ...cred,
          current_date: tc.current.toString(),
          threshold_years: tc.threshold.toString(),
        },
        tc.shouldPass,
      ),
    );
  }

  // Randomised pass cases.
  for (let i = 0; i < ITERATIONS; i++) {
    const dob = randRange(1000n, 20000n);
    const threshold = randRange(0n, 150n);
    const minCurrent = dob + threshold * 365n;
    const current = minCurrent + randRange(0n, 5000n);
    const salt = randSalt();
    const cred = makeCredential(dob, salt);

    results.push(
      runCase(
        `random pass #${i + 1} (dob=${dob}, thr=${threshold}, cur=${current})`,
        name,
        writeAgeProofProver,
        dir,
        {
          date_of_birth: dob.toString(),
          salt: salt.toString(),
          ...cred,
          current_date: current.toString(),
          threshold_years: threshold.toString(),
        },
        true,
      ),
    );
  }

  // Randomised fail cases: age below threshold.
  for (let i = 0; i < ITERATIONS; i++) {
    const dob = randRange(1000n, 20000n);
    const threshold = randRange(1n, 100n);
    // current_date strictly less than dob + threshold*365
    const maxCurrent = dob + threshold * 365n - 1n;
    if (maxCurrent < dob) continue; // skip degenerate
    const current = randRange(dob, maxCurrent);
    const salt = randSalt();
    const cred = makeCredential(dob, salt);

    results.push(
      runCase(
        `random fail (age below threshold) #${i + 1}`,
        name,
        writeAgeProofProver,
        dir,
        {
          date_of_birth: dob.toString(),
          salt: salt.toString(),
          ...cred,
          current_date: current.toString(),
          threshold_years: threshold.toString(),
        },
        false,
      ),
    );
  }

  // Tampered commitment cases.
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const dob = randRange(1000n, 20000n);
    const threshold = randRange(0n, 50n);
    const current = dob + threshold * 365n + randRange(0n, 1000n);
    const salt = randSalt();
    const cred = makeCredential(dob, salt);
    cred.commitment = tamperCommitment(cred.commitment);

    results.push(
      runCase(
        `tampered commitment #${i + 1}`,
        name,
        writeAgeProofProver,
        dir,
        {
          date_of_birth: dob.toString(),
          salt: salt.toString(),
          ...cred,
          current_date: current.toString(),
          threshold_years: threshold.toString(),
        },
        false,
      ),
    );
  }

  // Wrong salt cases.
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const dob = randRange(1000n, 20000n);
    const threshold = randRange(0n, 50n);
    const current = dob + threshold * 365n + randRange(0n, 1000n);
    const realSalt = randSalt();
    const wrongSalt = randSalt();
    const cred = makeCredential(dob, realSalt);

    results.push(
      runCase(
        `wrong salt #${i + 1}`,
        name,
        writeAgeProofProver,
        dir,
        {
          date_of_birth: dob.toString(),
          salt: wrongSalt.toString(),
          ...cred,
          current_date: current.toString(),
          threshold_years: threshold.toString(),
        },
        false,
      ),
    );
  }
}

function fuzzThresholdCircuit(name, writer, fieldName, results) {
  const dir = path.join(CIRCUITS_ROOT, name);
  console.log(`\n─── ${name} ───`);

  // Deterministic boundary cases.
  const boundaryCases = [
    { label: "boundary: value == threshold", value: 100000n, threshold: 100000n, shouldPass: true },
    { label: "boundary: value == threshold + 1", value: 100001n, threshold: 100000n, shouldPass: true },
    { label: "boundary: value == threshold - 1", value: 99999n, threshold: 100000n, shouldPass: false },
    { label: "boundary: threshold == 0", value: 0n, threshold: 0n, shouldPass: true },
    { label: "boundary: large value", value: 2n ** 50n, threshold: 2n ** 50n, shouldPass: true },
    { label: "boundary: large value, threshold + 1", value: 2n ** 50n + 1n, threshold: 2n ** 50n, shouldPass: true },
    { label: "boundary: large value, threshold - 1", value: 2n ** 50n - 1n, threshold: 2n ** 50n, shouldPass: false },
  ];

  for (const tc of boundaryCases) {
    const salt = randSalt();
    const cred = makeCredential(tc.value, salt);
    const opts = {
      [fieldName]: tc.value.toString(),
      salt: salt.toString(),
      ...cred,
      threshold: tc.threshold.toString(),
    };
    results.push(runCase(tc.label, name, writer, dir, opts, tc.shouldPass));
  }

  // Randomised pass cases.
  for (let i = 0; i < ITERATIONS; i++) {
    const threshold = randRange(1n, 10n ** 12n);
    const value = threshold + randRange(0n, 10n ** 12n);
    const salt = randSalt();
    const cred = makeCredential(value, salt);
    const opts = {
      [fieldName]: value.toString(),
      salt: salt.toString(),
      ...cred,
      threshold: threshold.toString(),
    };
    results.push(
      runCase(
        `random pass #${i + 1} (${fieldName}=${value}, thr=${threshold})`,
        name,
        writer,
        dir,
        opts,
        true,
      ),
    );
  }

  // Randomised fail cases.
  for (let i = 0; i < ITERATIONS; i++) {
    const threshold = randRange(100n, 10n ** 12n);
    const value = randRange(0n, threshold - 1n);
    const salt = randSalt();
    const cred = makeCredential(value, salt);
    const opts = {
      [fieldName]: value.toString(),
      salt: salt.toString(),
      ...cred,
      threshold: threshold.toString(),
    };
    results.push(
      runCase(
        `random fail (${fieldName} < threshold) #${i + 1}`,
        name,
        writer,
        dir,
        opts,
        false,
      ),
    );
  }

  // Tampered commitment.
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const value = randRange(1000n, 10n ** 9n);
    const threshold = randRange(0n, value);
    const salt = randSalt();
    const cred = makeCredential(value, salt);
    cred.commitment = tamperCommitment(cred.commitment);
    const opts = {
      [fieldName]: value.toString(),
      salt: salt.toString(),
      ...cred,
      threshold: threshold.toString(),
    };
    results.push(
      runCase(`tampered commitment #${i + 1}`, name, writer, dir, opts, false),
    );
  }

  // Wrong salt.
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const value = randRange(1000n, 10n ** 9n);
    const threshold = randRange(0n, value);
    const realSalt = randSalt();
    const wrongSalt = randSalt();
    const cred = makeCredential(value, realSalt);
    const opts = {
      [fieldName]: value.toString(),
      salt: wrongSalt.toString(),
      ...cred,
      threshold: threshold.toString(),
    };
    results.push(runCase(`wrong salt #${i + 1}`, name, writer, dir, opts, false));
  }
}

function fuzzKycProof(results) {
  const name = "kyc_proof";
  const dir = path.join(CIRCUITS_ROOT, name);
  console.log(`\n─── ${name} ───`);

  // KYC is a boolean claim: valid commitment + signature → always pass.
  for (let i = 0; i < ITERATIONS; i++) {
    const secret = randRange(1n, 2n ** 60n);
    const salt = randSalt();
    const cred = makeCredential(secret, salt);
    results.push(
      runCase(
        `random pass #${i + 1} (secret=${secret})`,
        name,
        writeKycProofProver,
        dir,
        {
          secret: secret.toString(),
          salt: salt.toString(),
          ...cred,
        },
        true,
      ),
    );
  }

  // Tampered commitment.
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const secret = randRange(1n, 2n ** 60n);
    const salt = randSalt();
    const cred = makeCredential(secret, salt);
    cred.commitment = tamperCommitment(cred.commitment);
    results.push(
      runCase(
        `tampered commitment #${i + 1}`,
        name,
        writeKycProofProver,
        dir,
        {
          secret: secret.toString(),
          salt: salt.toString(),
          ...cred,
        },
        false,
      ),
    );
  }

  // Wrong salt.
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const secret = randRange(1n, 2n ** 60n);
    const realSalt = randSalt();
    const wrongSalt = randSalt();
    const cred = makeCredential(secret, realSalt);
    results.push(
      runCase(
        `wrong salt #${i + 1}`,
        name,
        writeKycProofProver,
        dir,
        {
          secret: secret.toString(),
          salt: wrongSalt.toString(),
          ...cred,
        },
        false,
      ),
    );
  }
}

function fuzzJurisdictionProof(results) {
  const name = "jurisdiction_proof";
  const dir = path.join(CIRCUITS_ROOT, name);
  console.log(`\n─── ${name} ───`);

  const RESTRICTED_LEN = 8;
  // Known country codes for testing.
  const ALLOWED_CODES = [566n, 276n, 356n, 840n, 826n, 392n, 76n, 124n];
  const DENIED_CODES = [364n, 408n, 760n, 4n];

  // Deterministic denylist boundary cases.
  const denylistBoundary = [
    {
      label: "denylist: country not in list (pass)",
      cc: 566n,
      restricted: [840n, 364n, 408n, 0n, 0n, 0n, 0n, 0n],
      mode: 0n,
      shouldPass: true,
    },
    {
      label: "denylist: country at index 0 (fail)",
      cc: 840n,
      restricted: [840n, 364n, 408n, 0n, 0n, 0n, 0n, 0n],
      mode: 0n,
      shouldPass: false,
    },
    {
      label: "denylist: country at last real index (fail)",
      cc: 408n,
      restricted: [840n, 364n, 408n, 0n, 0n, 0n, 0n, 0n],
      mode: 0n,
      shouldPass: false,
    },
    {
      label: "denylist: country == padding zero (fail)",
      cc: 0n,
      restricted: [840n, 364n, 408n, 0n, 0n, 0n, 0n, 0n],
      mode: 0n,
      shouldPass: false,
    },
  ];

  for (const tc of denylistBoundary) {
    const salt = randSalt();
    const cred = makeCredential(tc.cc, salt);
    results.push(
      runCase(
        tc.label,
        name,
        writeJurisdictionProofProver,
        dir,
        {
          country_code: tc.cc.toString(),
          salt: salt.toString(),
          ...cred,
          restricted: tc.restricted.map(String),
          mode: tc.mode.toString(),
        },
        tc.shouldPass,
      ),
    );
  }

  // Deterministic allowlist boundary cases.
  const allowlistBoundary = [
    {
      label: "allowlist: country at index 0 (pass)",
      cc: 566n,
      restricted: [566n, 276n, 356n, 840n, 826n, 392n, 76n, 124n],
      mode: 1n,
      shouldPass: true,
    },
    {
      label: "allowlist: country at last index (pass)",
      cc: 124n,
      restricted: [566n, 276n, 356n, 840n, 826n, 392n, 76n, 124n],
      mode: 1n,
      shouldPass: true,
    },
    {
      label: "allowlist: country not in list (fail)",
      cc: 999n,
      restricted: [566n, 276n, 356n, 840n, 826n, 392n, 76n, 124n],
      mode: 1n,
      shouldPass: false,
    },
  ];

  for (const tc of allowlistBoundary) {
    const salt = randSalt();
    const cred = makeCredential(tc.cc, salt);
    results.push(
      runCase(
        tc.label,
        name,
        writeJurisdictionProofProver,
        dir,
        {
          country_code: tc.cc.toString(),
          salt: salt.toString(),
          ...cred,
          restricted: tc.restricted.map(String),
          mode: tc.mode.toString(),
        },
        tc.shouldPass,
      ),
    );
  }

  // Randomised denylist pass cases.
  for (let i = 0; i < ITERATIONS; i++) {
    const cc = ALLOWED_CODES[Math.floor(Math.random() * ALLOWED_CODES.length)];
    const salt = randSalt();
    const cred = makeCredential(cc, salt);
    results.push(
      runCase(
        `random denylist pass #${i + 1} (cc=${cc})`,
        name,
        writeJurisdictionProofProver,
        dir,
        {
          country_code: cc.toString(),
          salt: salt.toString(),
          ...cred,
          restricted: DENIED_CODES.concat(
            Array(RESTRICTED_LEN - DENIED_CODES.length).fill(0n),
          ).map(String),
          mode: "0",
        },
        true,
      ),
    );
  }

  // Randomised denylist fail cases.
  for (let i = 0; i < Math.min(ITERATIONS, 10); i++) {
    const cc = DENIED_CODES[Math.floor(Math.random() * DENIED_CODES.length)];
    const salt = randSalt();
    const cred = makeCredential(cc, salt);
    results.push(
      runCase(
        `random denylist fail #${i + 1} (cc=${cc})`,
        name,
        writeJurisdictionProofProver,
        dir,
        {
          country_code: cc.toString(),
          salt: salt.toString(),
          ...cred,
          restricted: DENIED_CODES.concat(
            Array(RESTRICTED_LEN - DENIED_CODES.length).fill(0n),
          ).map(String),
          mode: "0",
        },
        false,
      ),
    );
  }

  // Tampered commitment.
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const cc = ALLOWED_CODES[0];
    const salt = randSalt();
    const cred = makeCredential(cc, salt);
    cred.commitment = tamperCommitment(cred.commitment);
    results.push(
      runCase(
        `tampered commitment #${i + 1}`,
        name,
        writeJurisdictionProofProver,
        dir,
        {
          country_code: cc.toString(),
          salt: salt.toString(),
          ...cred,
          restricted: DENIED_CODES.concat(
            Array(RESTRICTED_LEN - DENIED_CODES.length).fill(0n),
          ).map(String),
          mode: "0",
        },
        false,
      ),
    );
  }
}

function fuzzRangeProof(results) {
  const name = "range_proof";
  const dir = path.join(CIRCUITS_ROOT, name);
  console.log(`\n─── ${name} ───`);

  // Deterministic boundary cases.
  const boundaryCases = [
    { label: "boundary: value == min", value: 100n, min: 100n, max: 200n, shouldPass: true },
    { label: "boundary: value == max", value: 200n, min: 100n, max: 200n, shouldPass: true },
    { label: "boundary: value == min - 1", value: 99n, min: 100n, max: 200n, shouldPass: false },
    { label: "boundary: value == max + 1", value: 201n, min: 100n, max: 200n, shouldPass: false },
    { label: "boundary: value == min == max", value: 42n, min: 42n, max: 42n, shouldPass: true },
    { label: "boundary: value == 0, range [0, 100]", value: 0n, min: 0n, max: 100n, shouldPass: true },
    { label: "boundary: large range", value: 2n ** 50n, min: 2n ** 50n - 100n, max: 2n ** 50n + 100n, shouldPass: true },
  ];

  for (const tc of boundaryCases) {
    const salt = randSalt();
    const cred = makeCredential(tc.value, salt);
    results.push(
      runCase(
        tc.label,
        name,
        writeRangeProofProver,
        dir,
        {
          value: tc.value.toString(),
          salt: salt.toString(),
          ...cred,
          min: tc.min.toString(),
          max: tc.max.toString(),
        },
        tc.shouldPass,
      ),
    );
  }

  // Randomised pass cases.
  for (let i = 0; i < ITERATIONS; i++) {
    const min = randRange(0n, 10n ** 10n);
    const span = randRange(1n, 10n ** 10n);
    const max = min + span;
    const value = randRange(min, max);
    const salt = randSalt();
    const cred = makeCredential(value, salt);
    results.push(
      runCase(
        `random pass #${i + 1} (v=${value}, [${min},${max}])`,
        name,
        writeRangeProofProver,
        dir,
        {
          value: value.toString(),
          salt: salt.toString(),
          ...cred,
          min: min.toString(),
          max: max.toString(),
        },
        true,
      ),
    );
  }

  // Randomised fail cases (out of range).
  for (let i = 0; i < ITERATIONS; i++) {
    const min = randRange(100n, 10n ** 10n);
    const max = min + randRange(1n, 10n ** 9n);
    // value below min or above max
    const belowMin = Math.random() < 0.5;
    const value = belowMin
      ? randRange(0n, min - 1n)
      : max + randRange(1n, 10n ** 9n);
    const salt = randSalt();
    const cred = makeCredential(value, salt);
    results.push(
      runCase(
        `random fail (out of range) #${i + 1}`,
        name,
        writeRangeProofProver,
        dir,
        {
          value: value.toString(),
          salt: salt.toString(),
          ...cred,
          min: min.toString(),
          max: max.toString(),
        },
        false,
      ),
    );
  }

  // Zero salt must fail.
  {
    const value = 50n;
    const cred = makeCredential(value, 1n); // sign with salt=1 for valid sig
    results.push(
      runCase(
        "zero salt rejected",
        name,
        writeRangeProofProver,
        dir,
        {
          value: value.toString(),
          salt: "0",
          ...cred,
          min: "0",
          max: "100",
        },
        false,
      ),
    );
  }
}

function fuzzEmploymentProof(results) {
  const name = "employment_proof";
  const dir = path.join(CIRCUITS_ROOT, name);
  console.log(`\n─── ${name} ───`);

  // Employment uses a 3-arity commitment: Poseidon2([status, seniority, salt], 3)
  // Deterministic boundary cases.
  const boundaryCases = [
    {
      label: "boundary: seniority == min_seniority",
      status: 1n,
      seniority: 5n,
      min_seniority: 5n,
      shouldPass: true,
    },
    {
      label: "boundary: seniority == min_seniority + 1",
      status: 1n,
      seniority: 6n,
      min_seniority: 5n,
      shouldPass: true,
    },
    {
      label: "boundary: seniority == min_seniority - 1",
      status: 1n,
      seniority: 4n,
      min_seniority: 5n,
      shouldPass: false,
    },
    {
      label: "boundary: zero seniority, min 0",
      status: 1n,
      seniority: 0n,
      min_seniority: 0n,
      shouldPass: true,
    },
    {
      label: "boundary: status == 0 (unemployed, fail)",
      status: 0n,
      seniority: 5n,
      min_seniority: 3n,
      shouldPass: false,
    },
    {
      label: "boundary: zero salt rejected",
      status: 1n,
      seniority: 5n,
      min_seniority: 3n,
      saltOverride: 0n,
      shouldPass: false,
    },
  ];

  for (const tc of boundaryCases) {
    const salt = tc.saltOverride !== undefined ? tc.saltOverride : randSalt();
    const cred = makeCredential3(tc.status, tc.seniority, salt);
    results.push(
      runCase(
        tc.label,
        name,
        writeEmploymentProofProver,
        dir,
        {
          employment_status: tc.status.toString(),
          seniority: tc.seniority.toString(),
          salt: salt.toString(),
          ...cred,
          min_seniority: tc.min_seniority.toString(),
        },
        tc.shouldPass,
      ),
    );
  }

  // Randomised pass cases.
  for (let i = 0; i < ITERATIONS; i++) {
    const status = randRange(1n, 5n); // non-zero status
    const minSeniority = randRange(0n, 30n);
    const seniority = minSeniority + randRange(0n, 20n);
    const salt = randSalt();
    const cred = makeCredential3(status, seniority, salt);
    results.push(
      runCase(
        `random pass #${i + 1} (status=${status}, sen=${seniority}, min=${minSeniority})`,
        name,
        writeEmploymentProofProver,
        dir,
        {
          employment_status: status.toString(),
          seniority: seniority.toString(),
          salt: salt.toString(),
          ...cred,
          min_seniority: minSeniority.toString(),
        },
        true,
      ),
    );
  }

  // Randomised fail cases: seniority below minimum.
  for (let i = 0; i < ITERATIONS; i++) {
    const status = randRange(1n, 5n);
    const minSeniority = randRange(5n, 50n);
    const seniority = randRange(0n, minSeniority - 1n);
    const salt = randSalt();
    const cred = makeCredential3(status, seniority, salt);
    results.push(
      runCase(
        `random fail (seniority < min) #${i + 1}`,
        name,
        writeEmploymentProofProver,
        dir,
        {
          employment_status: status.toString(),
          seniority: seniority.toString(),
          salt: salt.toString(),
          ...cred,
          min_seniority: minSeniority.toString(),
        },
        false,
      ),
    );
  }

  // Tampered commitment.
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const status = 1n;
    const seniority = 10n;
    const salt = randSalt();
    const cred = makeCredential3(status, seniority, salt);
    cred.commitment = tamperCommitment(cred.commitment);
    results.push(
      runCase(
        `tampered commitment #${i + 1}`,
        name,
        writeEmploymentProofProver,
        dir,
        {
          employment_status: status.toString(),
          seniority: seniority.toString(),
          salt: salt.toString(),
          ...cred,
          min_seniority: "5",
        },
        false,
      ),
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  console.log(`Property-based circuit fuzzer — ${ITERATIONS} random iterations per circuit`);
  console.log(`Toolchain: nargo`);

  // Verify nargo is available.
  try {
    execFileSync("nargo", ["--version"], { stdio: "pipe" });
  } catch {
    console.error("ERROR: nargo not found on PATH. Install Noir toolchain first.");
    process.exit(2);
  }

  // Ensure the workspace target directory exists.
  fs.mkdirSync(WORKSPACE_TARGET, { recursive: true });

  const results = [];

  // Save and restore Prover.toml files so the fuzz run does not corrupt the
  // committed demo witnesses.
  const backups = {};
  const circuits = [
    "age_proof", "income_proof", "funds_proof", "accreditation_proof",
    "kyc_proof", "jurisdiction_proof", "range_proof", "employment_proof",
  ];
  for (const c of circuits) {
    const p = path.join(CIRCUITS_ROOT, c, "Prover.toml");
    if (fs.existsSync(p)) backups[c] = fs.readFileSync(p, "utf8");
  }

  try {
    const fuzzers = {
      age_proof: () => fuzzAgeProof(results),
      income_proof: () => fuzzThresholdCircuit("income_proof", writeIncomeProofProver, "income", results),
      funds_proof: () => fuzzThresholdCircuit("funds_proof", writeFundsProofProver, "balance", results),
      accreditation_proof: () => fuzzThresholdCircuit("accreditation_proof", writeAccreditationProofProver, "net_worth", results),
      kyc_proof: () => fuzzKycProof(results),
      jurisdiction_proof: () => fuzzJurisdictionProof(results),
      range_proof: () => fuzzRangeProof(results),
      employment_proof: () => fuzzEmploymentProof(results),
    };

    if (ONLY_CIRCUIT) {
      if (!fuzzers[ONLY_CIRCUIT]) {
        console.error(`Unknown circuit: ${ONLY_CIRCUIT}`);
        process.exit(2);
      }
      fuzzers[ONLY_CIRCUIT]();
    } else {
      for (const f of Object.values(fuzzers)) f();
    }
  } finally {
    // Restore committed Prover.toml files.
    for (const c of circuits) {
      const p = path.join(CIRCUITS_ROOT, c, "Prover.toml");
      if (backups[c] !== undefined) {
        fs.writeFileSync(p, backups[c]);
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`RESULTS: ${passed}/${total} cases matched expected outcome`);
  console.log(`${"═".repeat(60)}`);

  if (failed.length) {
    console.log(`\nFAILED CASES (${failed.length}):`);
    for (const f of failed) {
      console.log(
        `  ✗ ${f.label} — expected ${f.shouldPass ? "PASS" : "FAIL"}, got ${f.passed ? "PASS" : "FAIL"}`,
      );
    }
    process.exit(1);
  }

  console.log("\nAll property-based circuit tests passed.");
}

main();

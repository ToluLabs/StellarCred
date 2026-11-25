#!/usr/bin/env node
// Deterministic edge-case test vectors for the credential circuits (#1039).
//
// The committed Prover.toml witnesses and circuits/testvectors/*.json pin one
// happy path per circuit, and fuzz_circuits.js draws random witnesses that
// change on every run. Neither gives a reviewer a fixed, readable list of the
// inputs that sit on a boundary: zero values, u64 and BN254 field maxima,
// threshold +/- 1, inverted windows, the last slot of a list, the last leaf of
// a Merkle tree. This script generates exactly those, as standardized JSON under
// circuits/testvectors/edge/<circuit>.json, and records for each one whether
// the circuit must accept or reject it.
//
// Everything is derived from fixed inputs: Poseidon2 commitments are computed
// locally (merkle_tree.js), signatures use RFC 6979 deterministic nonces with
// the fixed demo issuer key, and nothing reads the clock or a random source.
// Running `generate` twice produces byte-identical files.
//
// Usage:
//   node circuits/scripts/edge_vectors.js check     # default: committed files match a fresh generation
//   node circuits/scripts/edge_vectors.js generate  # rewrite circuits/testvectors/edge/*.json
//   node circuits/scripts/edge_vectors.js execute   # run every vector through `nargo execute`
//
// All three take an optional `--circuit <name>`. `check` and `generate` need
// only Node and the frontend's @noble/curves (for signing). `execute` also
// needs the pinned nargo (1.0.0-beta.9) on PATH; it is what proves each
// recorded expectation is what the circuit actually does.

"use strict";

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { poseidon2Hash, buildTree, merklePathForIndex, DEPTH } = require("./merkle_tree.js");
const { sign } = require("./sign.js");

const CIRCUITS_ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(CIRCUITS_ROOT, "testvectors", "edge");
const SCHEMA = "stellarcred.edge-vectors/v1";
const PROVER_NAME = "edge_vector"; // nargo --prover-name; gitignored

// ── Domain constants ────────────────────────────────────────────────────────
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FIELD_MAX = P - 1n;
const U64_MAX = 2n ** 64n - 1n;
const U64_OVERFLOW = 2n ** 64n; // one past u64: must fail witness parsing
const DAYS_PER_YEAR = 365n;
const AGE_MAX_THRESHOLD = 200n;
const RESTRICTED_LEN = 8;

// Keys are fixed rather than read from ISSUER_PRIVATE_KEY, so the vectors do
// not change with the environment they are generated in.
const ISSUER_SK = new Uint8Array(
  crypto.createHash("sha256").update("stellarcred-demo-issuer").digest(),
);
const FOREIGN_SK = new Uint8Array(
  crypto.createHash("sha256").update("stellarcred-edge-vectors-foreign-issuer").digest(),
);

// ── Helpers ─────────────────────────────────────────────────────────────────
const dec = (v) => BigInt(v).toString();
const bytes = (u8) => Array.from(u8);

function commit(values, salt) {
  const inputs = [...values.map(BigInt), BigInt(salt)];
  return poseidon2Hash(inputs, inputs.length);
}

// A credential the demo issuer signed over Poseidon2([...values, salt]).
// `mutate` lets a case break exactly one part of it after signing.
function credential(values, salt, mutate = {}) {
  const c = commit(values, salt);
  const signed = sign(c, ISSUER_SK);
  const cred = {
    salt: dec(salt),
    sig: bytes(signed.sig),
    commitment: dec(c),
    issuer_x: bytes(signed.x),
    issuer_y: bytes(signed.y),
  };
  if (mutate.commitment !== undefined) cred.commitment = dec(mutate.commitment(c));
  if (mutate.zeroSig) cred.sig = new Array(64).fill(0);
  if (mutate.foreignSig) cred.sig = bytes(sign(c, FOREIGN_SK).sig);
  if (mutate.flipIssuerX) cred.issuer_x[31] ^= 1;
  return cred;
}

function vector(id, category, description, expect, reason, inputs) {
  if (expect !== "accept" && expect !== "reject") throw new Error(`bad expectation for ${id}`);
  return { id, category, description, expect, reason, inputs };
}

// The commitment and signature reject paths are shared by every circuit that
// goes through credential_lib::assert_committed_and_signed (or its inline
// equivalent). `build(cred)` returns the circuit-specific inputs around it.
function credentialCases(values, salt, build) {
  return [
    vector(
      "commitment_plus_one",
      "commitment",
      "Commitment off by one from Poseidon2(value, salt)",
      "reject",
      "Poseidon2 commitment mismatch",
      build(credential(values, salt, { commitment: (c) => (c + 1n) % P })),
    ),
    vector(
      "commitment_zero",
      "commitment",
      "Commitment is the zero field element",
      "reject",
      "Poseidon2 commitment mismatch",
      build(credential(values, salt, { commitment: () => 0n })),
    ),
    vector(
      "commitment_field_max",
      "commitment",
      "Commitment is p - 1, the largest field element",
      "reject",
      "Poseidon2 commitment mismatch",
      build(credential(values, salt, { commitment: () => FIELD_MAX })),
    ),
    vector(
      "signature_all_zero",
      "signature",
      "All-zero 64-byte signature",
      "reject",
      "secp256k1 signature does not verify",
      build(credential(values, salt, { zeroSig: true })),
    ),
    vector(
      "signature_foreign_issuer",
      "signature",
      "Valid signature by a key other than issuer_x/issuer_y",
      "reject",
      "secp256k1 signature does not verify",
      build(credential(values, salt, { foreignSig: true })),
    ),
    vector(
      "issuer_key_bit_flip",
      "signature",
      "Lowest bit of issuer_x flipped",
      "reject",
      "secp256k1 signature does not verify",
      build(credential(values, salt, { flipIssuerX: true })),
    ),
  ];
}

// Salt edge cases. `zeroSaltBlocked` is per circuit: range_proof, date_range,
// accreditation_proof and employment_proof assert salt != 0; the circuits that
// rely only on credential_lib do not, and these vectors pin that as it stands.
function saltCases(values, build, zeroSaltBlocked) {
  return [
    vector(
      "salt_one",
      "salt",
      "Smallest non-zero salt",
      "accept",
      "valid credential",
      build(credential(values, 1n)),
    ),
    vector(
      "salt_field_max",
      "salt",
      "Salt is p - 1, the largest field element",
      "accept",
      "valid credential",
      build(credential(values, FIELD_MAX)),
    ),
    zeroSaltBlocked
      ? vector(
          "salt_zero",
          "salt",
          "Zero salt with a correctly signed commitment",
          "reject",
          "assert(salt != 0)",
          build(credential(values, 0n)),
        )
      : vector(
          "salt_zero",
          "salt",
          "Zero salt with a correctly signed commitment",
          "accept",
          "no zero-salt guard in this circuit; the issuer must never sign a zero-salt commitment",
          build(credential(values, 0n)),
        ),
  ];
}

// ── Circuit specs ───────────────────────────────────────────────────────────
// Each returns the full ordered list of vectors for one circuit. Input key
// order mirrors the circuit's `main` signature.

function kycProof() {
  const build = (secret) => (cred) => ({ secret: dec(secret), ...cred });
  return [
    vector(
      "secret_zero",
      "zero",
      "Secret is zero",
      "accept",
      "valid credential",
      build(0n)(credential([0n], 7n)),
    ),
    vector(
      "secret_one",
      "boundary",
      "Secret is one",
      "accept",
      "valid credential",
      build(1n)(credential([1n], 7n)),
    ),
    vector(
      "secret_u64_max",
      "max",
      "Secret is 2^64 - 1",
      "accept",
      "valid credential",
      build(U64_MAX)(credential([U64_MAX], 7n)),
    ),
    vector(
      "secret_field_max",
      "max",
      "Secret is p - 1, the largest field element",
      "accept",
      "valid credential",
      build(FIELD_MAX)(credential([FIELD_MAX], 7n)),
    ),
    vector(
      "secret_mismatch",
      "commitment",
      "Witness secret differs by one from the signed secret",
      "reject",
      "Poseidon2 commitment mismatch",
      build(43n)(credential([42n], 7n)),
    ),
    ...saltCases([42n], build(42n), false),
    ...credentialCases([42n], 7n, build(42n)),
  ];
}

function ageProof() {
  const build = (dob, current, threshold) => (cred) => ({
    date_of_birth: dec(dob),
    salt: cred.salt,
    sig: cred.sig,
    commitment: cred.commitment,
    issuer_x: cred.issuer_x,
    issuer_y: cred.issuer_y,
    current_date: dec(current),
    threshold_years: dec(threshold),
  });
  const ok = (id, cat, desc, dob, current, t) =>
    vector(
      id,
      cat,
      desc,
      "accept",
      "valid credential",
      build(dob, current, t)(credential([dob], 12345n)),
    );
  const no = (id, cat, desc, reason, dob, current, t) =>
    vector(id, cat, desc, "reject", reason, build(dob, current, t)(credential([dob], 12345n)));
  const eighteen = 18n * DAYS_PER_YEAR;
  return [
    ok(
      "dob_epoch_exact_threshold",
      "zero",
      "Born on day 0, current_date exactly 18*365 days later",
      0n,
      eighteen,
      18n,
    ),
    no(
      "dob_epoch_one_day_short",
      "boundary",
      "Born on day 0, one day short of 18*365",
      "current_date < dob + threshold*365",
      0n,
      eighteen - 1n,
      18n,
    ),
    ok(
      "one_day_past_threshold",
      "boundary",
      "One day past the threshold",
      10000n,
      10000n + eighteen + 1n,
      18n,
    ),
    ok(
      "threshold_zero_same_day",
      "zero",
      "threshold_years = 0 and current_date == dob",
      10000n,
      10000n,
      0n,
    ),
    no(
      "current_before_dob",
      "boundary",
      "current_date one day before dob with threshold 0",
      "current_date < dob + threshold*365",
      10000n,
      9999n,
      0n,
    ),
    ok(
      "threshold_max_200",
      "max",
      "threshold_years at the cap of 200",
      0n,
      AGE_MAX_THRESHOLD * DAYS_PER_YEAR,
      200n,
    ),
    no(
      "threshold_201",
      "max",
      "threshold_years one above the cap",
      "assert(threshold_years <= 200)",
      0n,
      201n * DAYS_PER_YEAR,
      201n,
    ),
    no(
      "threshold_u64_max",
      "max",
      "threshold_years = 2^64 - 1",
      "assert(threshold_years <= 200)",
      0n,
      U64_MAX,
      U64_MAX,
    ),
    ok(
      "dates_at_u64_max",
      "max",
      "current_date = 2^64 - 1 and dob exactly 18 years earlier",
      U64_MAX - eighteen,
      U64_MAX,
      18n,
    ),
    no(
      "dob_u64_max_overflows",
      "max",
      "dob = 2^64 - 1 so dob + threshold*365 overflows u64",
      "u64 addition overflow",
      U64_MAX,
      U64_MAX,
      1n,
    ),
    no(
      "dob_u64_overflow_input",
      "max",
      "dob = 2^64 does not fit the u64 input",
      "input out of range for u64",
      U64_OVERFLOW,
      U64_OVERFLOW,
      0n,
    ),
    ...saltCases([3650n], build(3650n, 20000n, 0n), false),
    ...credentialCases([3650n], 12345n, build(3650n, 20000n, 18n)),
  ];
}

// income_proof, funds_proof and accreditation_proof share one shape:
// `value >= threshold` over a single signed u64.
function thresholdCircuit(field, zeroSaltBlocked) {
  return () => {
    const build = (value, threshold) => (cred) => ({
      [field]: dec(value),
      salt: cred.salt,
      sig: cred.sig,
      commitment: cred.commitment,
      issuer_x: cred.issuer_x,
      issuer_y: cred.issuer_y,
      threshold: dec(threshold),
    });
    const c = (v) => credential([v], 2024n);
    return [
      vector(
        "zero_value_zero_threshold",
        "zero",
        "Value 0 against threshold 0",
        "accept",
        "valid credential",
        build(0n, 0n)(c(0n)),
      ),
      vector(
        "zero_value_threshold_one",
        "zero",
        "Value 0 against threshold 1",
        "reject",
        `${field} < threshold`,
        build(0n, 1n)(c(0n)),
      ),
      vector(
        "value_equals_threshold",
        "boundary",
        "Value exactly at the threshold",
        "accept",
        "valid credential",
        build(50000n, 50000n)(c(50000n)),
      ),
      vector(
        "value_one_below_threshold",
        "boundary",
        "Value one below the threshold",
        "reject",
        `${field} < threshold`,
        build(49999n, 50000n)(c(49999n)),
      ),
      vector(
        "value_one_above_threshold",
        "boundary",
        "Value one above the threshold",
        "accept",
        "valid credential",
        build(50001n, 50000n)(c(50001n)),
      ),
      vector(
        "both_u64_max",
        "max",
        "Value and threshold both 2^64 - 1",
        "accept",
        "valid credential",
        build(U64_MAX, U64_MAX)(c(U64_MAX)),
      ),
      vector(
        "max_value_zero_threshold",
        "max",
        "Value 2^64 - 1 against threshold 0",
        "accept",
        "valid credential",
        build(U64_MAX, 0n)(c(U64_MAX)),
      ),
      vector(
        "threshold_u64_max_value_below",
        "max",
        "Threshold 2^64 - 1 with value one below",
        "reject",
        `${field} < threshold`,
        build(U64_MAX - 1n, U64_MAX)(c(U64_MAX - 1n)),
      ),
      vector(
        "value_u64_overflow_input",
        "max",
        "Value 2^64 does not fit the u64 input",
        "reject",
        "input out of range for u64",
        build(U64_OVERFLOW, 0n)(c(U64_OVERFLOW)),
      ),
      ...saltCases([50000n], build(50000n, 50000n), zeroSaltBlocked),
      ...credentialCases([50000n], 2024n, build(50000n, 50000n)),
    ];
  };
}

function rangeLike(valueField, minField, maxField, invertedReason) {
  return () => {
    const build = (value, min, max) => (cred) => ({
      [valueField]: dec(value),
      salt: cred.salt,
      sig: cred.sig,
      commitment: cred.commitment,
      issuer_x: cred.issuer_x,
      issuer_y: cred.issuer_y,
      [minField]: dec(min),
      [maxField]: dec(max),
    });
    const c = (v) => credential([v], 12345n);
    const ok = (id, cat, desc, v, lo, hi) =>
      vector(id, cat, desc, "accept", "valid credential", build(v, lo, hi)(c(v)));
    const no = (id, cat, desc, reason, v, lo, hi) =>
      vector(id, cat, desc, "reject", reason, build(v, lo, hi)(c(v)));
    return [
      ok("all_zero", "zero", "Value, lower and upper bound all 0", 0n, 0n, 0n),
      ok("at_lower_bound", "boundary", "Value equals the lower bound", 3000n, 3000n, 4000n),
      ok("at_upper_bound", "boundary", "Value equals the upper bound", 4000n, 3000n, 4000n),
      no(
        "one_below_lower_bound",
        "boundary",
        "Value one below the lower bound",
        "value < lower bound",
        2999n,
        3000n,
        4000n,
      ),
      no(
        "one_above_upper_bound",
        "boundary",
        "Value one above the upper bound",
        "value > upper bound",
        4001n,
        3000n,
        4000n,
      ),
      ok(
        "single_point_window",
        "boundary",
        "Lower and upper bound equal, value on them",
        3650n,
        3650n,
        3650n,
      ),
      no(
        "inverted_window",
        "boundary",
        "Lower bound one above the upper bound",
        invertedReason,
        3650n,
        3651n,
        3650n,
      ),
      ok(
        "full_u64_window_at_max",
        "max",
        "Window [0, 2^64 - 1] with value 2^64 - 1",
        U64_MAX,
        0n,
        U64_MAX,
      ),
      ok("full_u64_window_at_zero", "max", "Window [0, 2^64 - 1] with value 0", 0n, 0n, U64_MAX),
      no(
        "upper_bound_u64_overflow_input",
        "max",
        "Upper bound 2^64 does not fit the u64 input",
        "input out of range for u64",
        3650n,
        0n,
        U64_OVERFLOW,
      ),
      ...saltCases([3650n], build(3650n, 3000n, 4000n), true),
      ...credentialCases([3650n], 12345n, build(3650n, 3000n, 4000n)),
    ];
  };
}

function jurisdictionProof() {
  const pad = (codes) => [...codes, ...new Array(RESTRICTED_LEN - codes.length).fill(0n)].map(dec);
  const build = (country, list, mode) => (cred) => ({
    country_code: dec(country),
    salt: cred.salt,
    sig: cred.sig,
    commitment: cred.commitment,
    issuer_x: cred.issuer_x,
    issuer_y: cred.issuer_y,
    restricted: pad(list),
    mode: dec(mode),
  });
  const c = (v) => credential([v], 7n);
  const deny = [364n, 408n, 760n, 192n, 729n, 112n, 643n];
  const full = [...deny, 999n];
  const ok = (id, cat, desc, v, list, mode) =>
    vector(id, cat, desc, "accept", "valid credential", build(v, list, mode)(c(v)));
  const no = (id, cat, desc, reason, v, list, mode) =>
    vector(id, cat, desc, "reject", reason, build(v, list, mode)(c(v)));
  return [
    ok(
      "deny_not_listed",
      "boundary",
      "Denylist: country absent from a 7-entry list",
      840n,
      deny,
      0n,
    ),
    no(
      "deny_first_slot",
      "boundary",
      "Denylist: country in slot 0",
      "country_code in restricted",
      364n,
      deny,
      0n,
    ),
    no(
      "deny_last_real_slot",
      "boundary",
      "Denylist: country in slot 6, the last non-padding slot",
      "country_code in restricted",
      643n,
      deny,
      0n,
    ),
    no(
      "deny_full_list_last_slot",
      "boundary",
      "Denylist: all 8 slots filled, country in slot 7",
      "country_code in restricted",
      999n,
      full,
      0n,
    ),
    no(
      "deny_zero_country_with_padding",
      "zero",
      "Denylist: country 0 collides with zero padding",
      "country_code in restricted (padding)",
      0n,
      deny,
      0n,
    ),
    ok(
      "deny_zero_country_full_list",
      "zero",
      "Denylist: country 0 accepted once no padding slot is left (see the note in main.nr)",
      0n,
      full,
      0n,
    ),
    ok(
      "deny_empty_list",
      "zero",
      "Denylist: all-zero list accepts any non-zero country",
      840n,
      [],
      0n,
    ),
    ok("deny_country_u64_max", "max", "Denylist: country 2^64 - 1", U64_MAX, deny, 0n),
    ok("allow_first_slot", "boundary", "Allowlist: country in slot 0", 840n, [840n, 276n], 1n),
    ok(
      "allow_last_slot",
      "boundary",
      "Allowlist: country in slot 7 of a full list",
      999n,
      full,
      1n,
    ),
    no(
      "allow_not_listed",
      "boundary",
      "Allowlist: country absent",
      "country_code not in allowlist",
      250n,
      [840n, 276n],
      1n,
    ),
    ok(
      "allow_zero_country_with_padding",
      "zero",
      "Allowlist: country 0 matches zero padding; the contract's policy list must not be padded",
      0n,
      [840n],
      1n,
    ),
    no(
      "allow_empty_list",
      "zero",
      "Allowlist: all-zero list rejects a non-zero country",
      "country_code not in allowlist",
      840n,
      [],
      1n,
    ),
    no(
      "mode_two",
      "boundary",
      "mode = 2 is neither denylist nor allowlist",
      "assert(mode == 0 | mode == 1)",
      840n,
      deny,
      2n,
    ),
    no(
      "mode_u64_max",
      "max",
      "mode = 2^64 - 1",
      "assert(mode == 0 | mode == 1)",
      840n,
      deny,
      U64_MAX,
    ),
    ...saltCases([840n], build(840n, deny, 0n), false),
    ...credentialCases([840n], 7n, build(840n, deny, 0n)),
  ];
}

function employmentProof() {
  const build = (status, seniority, min) => (cred) => ({
    employment_status: dec(status),
    seniority: dec(seniority),
    salt: cred.salt,
    sig: cred.sig,
    commitment: cred.commitment,
    issuer_x: cred.issuer_x,
    issuer_y: cred.issuer_y,
    min_seniority: dec(min),
  });
  const c = (s, y) => credential([s, y], 99n);
  const ok = (id, cat, desc, s, y, m) =>
    vector(id, cat, desc, "accept", "valid credential", build(s, y, m)(c(s, y)));
  const no = (id, cat, desc, reason, s, y, m) =>
    vector(id, cat, desc, "reject", reason, build(s, y, m)(c(s, y)));
  return [
    no(
      "status_zero",
      "zero",
      "employment_status 0 (unemployed) with seniority met",
      "assert(employment_status != 0)",
      0n,
      5n,
      1n,
    ),
    ok("status_one_zero_seniority", "zero", "Status 1, seniority 0 against minimum 0", 1n, 0n, 0n),
    ok("seniority_equals_min", "boundary", "Seniority exactly at the minimum", 1n, 3n, 3n),
    no(
      "seniority_one_below_min",
      "boundary",
      "Seniority one below the minimum",
      "seniority < min_seniority",
      1n,
      2n,
      3n,
    ),
    ok("status_u64_max", "max", "employment_status 2^64 - 1", U64_MAX, 3n, 3n),
    ok(
      "seniority_and_min_u64_max",
      "max",
      "Seniority and minimum both 2^64 - 1",
      1n,
      U64_MAX,
      U64_MAX,
    ),
    no(
      "min_u64_max_seniority_below",
      "max",
      "Minimum 2^64 - 1 with seniority one below",
      "seniority < min_seniority",
      1n,
      U64_MAX - 1n,
      U64_MAX,
    ),
    vector(
      "fields_swapped",
      "commitment",
      "Witness swaps status and seniority against the signed (1, 3)",
      "reject",
      "Poseidon2 commitment mismatch",
      build(3n, 1n, 1n)(c(1n, 3n)),
    ),
    ...saltCases([1n, 3n], build(1n, 3n, 3n), true),
    ...credentialCases([1n, 3n], 99n, build(1n, 3n, 3n)),
  ];
}

function setMembership() {
  const SET = [840n, 276n, 566n, 356n];
  const FULL = Array.from({ length: 1 << DEPTH }, (_, i) => BigInt(1000 + i));
  const treeOf = (values) => buildTree(values);
  const rootOf = (tree) => tree[DEPTH][0];
  const build =
    (value, tree, leafIndex, tweak = {}) =>
    (cred) => {
      const { path: siblings, indices } = merklePathForIndex(tree, leafIndex);
      const idx = indices.map((b) => dec(b));
      if (tweak.flipIndex !== undefined)
        idx[tweak.flipIndex] = idx[tweak.flipIndex] === "0" ? "1" : "0";
      let root = rootOf(tree);
      if (tweak.root !== undefined) root = tweak.root(root);
      return {
        value: dec(value),
        salt: cred.salt,
        sig: cred.sig,
        path: siblings.map(dec),
        indices: idx,
        commitment: cred.commitment,
        issuer_x: cred.issuer_x,
        issuer_y: cred.issuer_y,
        merkle_root: dec(root),
      };
    };
  const c = (v) => credential([v], 42n);
  const small = treeOf(SET);
  const full = treeOf(FULL);
  return [
    vector(
      "member_first_leaf",
      "boundary",
      "Member at leaf 0 (all index bits 0)",
      "accept",
      "valid credential",
      build(840n, small, 0)(c(840n)),
    ),
    vector(
      "member_last_populated_leaf",
      "boundary",
      "Member at leaf 3, the last populated leaf",
      "accept",
      "valid credential",
      build(356n, small, 3)(c(356n)),
    ),
    vector(
      "member_last_leaf_full_tree",
      "max",
      "Member at leaf 255 of a full 256-leaf tree (all index bits 1)",
      "accept",
      "valid credential",
      build(FULL[255], full, 255)(c(FULL[255])),
    ),
    vector(
      "non_member_borrowed_path",
      "boundary",
      "Non-member value using leaf 0's path",
      "reject",
      "computed root != merkle_root",
      build(250n, small, 0)(c(250n)),
    ),
    vector(
      "zero_value_padding_leaf",
      "zero",
      "Value 0 proves membership through an empty padding leaf; the published set must be full or 0 must be excluded",
      "accept",
      "Poseidon2([0], 1) is the padding leaf",
      build(0n, small, 4)(c(0n)),
    ),
    vector(
      "zero_value_full_tree",
      "zero",
      "Value 0 against a full tree has no padding leaf to borrow",
      "reject",
      "computed root != merkle_root",
      build(0n, full, 0)(c(0n)),
    ),
    vector(
      "index_bit_flipped",
      "boundary",
      "Top-level index bit flipped",
      "reject",
      "computed root != merkle_root",
      build(840n, small, 0, { flipIndex: DEPTH - 1 })(c(840n)),
    ),
    vector(
      "root_plus_one",
      "boundary",
      "merkle_root off by one",
      "reject",
      "computed root != merkle_root",
      build(840n, small, 0, { root: (r) => (r + 1n) % P })(c(840n)),
    ),
    vector(
      "root_zero",
      "zero",
      "merkle_root is zero",
      "reject",
      "computed root != merkle_root",
      build(840n, small, 0, { root: () => 0n })(c(840n)),
    ),
    vector(
      "value_u64_max_member",
      "max",
      "Value 2^64 - 1 as a member",
      "accept",
      "valid credential",
      build(U64_MAX, treeOf([U64_MAX]), 0)(c(U64_MAX)),
    ),
    ...saltCases([840n], build(840n, small, 0), false),
    ...credentialCases([840n], 42n, build(840n, small, 0)),
  ];
}

const SPECS = {
  kyc_proof: kycProof,
  age_proof: ageProof,
  income_proof: thresholdCircuit("income", false),
  funds_proof: thresholdCircuit("balance", false),
  accreditation_proof: thresholdCircuit("net_worth", true),
  range_proof: rangeLike("value", "min", "max", "value > max"),
  date_range: rangeLike(
    "issued_at",
    "window_start",
    "window_end",
    "assert(window_start <= window_end)",
  ),
  jurisdiction_proof: jurisdictionProof,
  employment_proof: employmentProof,
  set_membership: setMembership,
};
const CIRCUITS = Object.keys(SPECS);

// ── Generation ──────────────────────────────────────────────────────────────
function generate(circuit) {
  const spec = SPECS[circuit];
  if (!spec) throw new Error(`unknown circuit '${circuit}'; known: ${CIRCUITS.join(", ")}`);
  const cases = spec();
  const ids = new Set();
  for (const v of cases) {
    if (ids.has(v.id)) throw new Error(`${circuit}: duplicate vector id '${v.id}'`);
    ids.add(v.id);
  }
  return {
    schema: SCHEMA,
    circuit,
    generator: "circuits/scripts/edge_vectors.js",
    regenerate: "node circuits/scripts/edge_vectors.js generate",
    cases,
  };
}

// Two-space JSON, except that arrays of scalars (byte arrays, Merkle paths,
// country lists) stay on one line so each vector reads as a single block.
function serialize(doc) {
  const render = (value, indent) => {
    if (Array.isArray(value)) {
      if (value.every((x) => x === null || typeof x !== "object")) {
        return "[" + value.map((x) => JSON.stringify(x)).join(", ") + "]";
      }
      const inner = indent + "  ";
      return "[\n" + value.map((x) => inner + render(x, inner)).join(",\n") + "\n" + indent + "]";
    }
    if (value && typeof value === "object") {
      const inner = indent + "  ";
      const entries = Object.entries(value).map(
        ([k, v]) => `${inner}${JSON.stringify(k)}: ${render(v, inner)}`,
      );
      return "{\n" + entries.join(",\n") + "\n" + indent + "}";
    }
    return JSON.stringify(value);
  };
  return render(doc, "") + "\n";
}

function vectorPath(circuit) {
  return path.join(OUT_DIR, `${circuit}.json`);
}

function loadCommitted(circuit) {
  const p = vectorPath(circuit);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

// ── Prover.toml rendering ───────────────────────────────────────────────────
// Strings for scalars, quoted strings for Field/u64 arrays and bare numbers for
// byte arrays, matching the committed Prover.toml files.
function toToml(inputs) {
  const lines = [];
  for (const [key, value] of Object.entries(inputs)) {
    if (Array.isArray(value)) {
      const quoted = typeof value[0] === "string";
      lines.push(`${key} = [${value.map((x) => (quoted ? `"${x}"` : String(x))).join(", ")}]`);
    } else {
      lines.push(`${key} = "${value}"`);
    }
  }
  return lines.join("\n") + "\n";
}

function nargoExecute(circuit, inputs) {
  const proverFile = path.join(CIRCUITS_ROOT, circuit, `${PROVER_NAME}.toml`);
  fs.writeFileSync(proverFile, toToml(inputs));
  try {
    execFileSync("nargo", ["execute", "--package", circuit, "--prover-name", PROVER_NAME], {
      cwd: CIRCUITS_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    return { accepted: true, output: "" };
  } catch (err) {
    if (err.code === "ENOENT")
      throw new Error("nargo not found on PATH (need the pinned 1.0.0-beta.9)");
    const output = `${err.stdout || ""}${err.stderr || ""}`.trim();
    return { accepted: false, output };
  } finally {
    fs.rmSync(proverFile, { force: true });
  }
}

// ── Commands ────────────────────────────────────────────────────────────────
function cmdGenerate(circuits) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const circuit of circuits) {
    const doc = generate(circuit);
    fs.writeFileSync(vectorPath(circuit), serialize(doc));
    console.log(`${circuit}: wrote ${doc.cases.length} vectors`);
  }
  return 0;
}

function cmdCheck(circuits) {
  let failed = 0;
  for (const circuit of circuits) {
    const expected = serialize(generate(circuit));
    const committed = loadCommitted(circuit);
    if (committed === null) {
      console.error(`${circuit}: MISSING circuits/testvectors/edge/${circuit}.json`);
      failed++;
    } else if (committed !== expected) {
      console.error(`${circuit}: DRIFT, the committed vectors differ from a fresh generation`);
      failed++;
    } else {
      console.log(`${circuit}: ok`);
    }
  }
  if (failed) {
    console.error("\nRegenerate with: node circuits/scripts/edge_vectors.js generate");
    return 1;
  }
  console.log("All edge-case vectors match.");
  return 0;
}

function cmdExecute(circuits) {
  let mismatches = 0;
  let total = 0;
  for (const circuit of circuits) {
    const committed = loadCommitted(circuit);
    if (committed === null) throw new Error(`${circuit}: no committed vectors; run generate first`);
    const doc = JSON.parse(committed);
    for (const v of doc.cases) {
      total++;
      const { accepted, output } = nargoExecute(circuit, v.inputs);
      const got = accepted ? "accept" : "reject";
      if (got === v.expect) {
        console.log(`  ok   ${circuit}/${v.id} (${got})`);
      } else {
        mismatches++;
        console.error(`  FAIL ${circuit}/${v.id}: expected ${v.expect}, circuit said ${got}`);
        if (output)
          console.error(
            output
              .split("\n")
              .map((l) => `       ${l}`)
              .join("\n"),
          );
      }
    }
  }
  console.log(`\n${total - mismatches}/${total} vectors matched their expected outcome.`);
  return mismatches ? 1 : 0;
}

function main(argv) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "check";
  const at = args.indexOf("--circuit");
  const only = at !== -1 ? args[at + 1] : null;
  if (only && !SPECS[only]) {
    console.error(`unknown circuit '${only}'; known: ${CIRCUITS.join(", ")}`);
    return 2;
  }
  const circuits = only ? [only] : CIRCUITS;
  switch (command) {
    case "generate":
      return cmdGenerate(circuits);
    case "check":
      return cmdCheck(circuits);
    case "execute":
      return cmdExecute(circuits);
    default:
      console.error(
        "Usage: node circuits/scripts/edge_vectors.js [check|generate|execute] [--circuit <name>]",
      );
      return 2;
  }
}

module.exports = {
  CIRCUITS,
  SCHEMA,
  FIELD_MAX,
  U64_MAX,
  U64_OVERFLOW,
  ISSUER_SK,
  generate,
  serialize,
  loadCommitted,
  toToml,
  commit,
};

if (require.main === module) process.exit(main(process.argv));

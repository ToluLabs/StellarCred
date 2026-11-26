// Unit tests for the deterministic edge-case vector generator (#1039).
// Run: node --test circuits/scripts/edge_vectors.test.js
//
// These run without nargo. The `execute` command (run in CI's circuit-fuzz
// job) is what checks every recorded expectation against the real circuits;
// these tests check the generator itself: determinism, schema, coverage, and
// that its Poseidon2 and secp256k1 output agrees with the committed witnesses.

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ev = require("./edge_vectors.js");
const { parseProverToml } = require("./testvectors.js");

const SCRIPT = path.join(__dirname, "edge_vectors.js");
const CIRCUITS_ROOT = path.join(__dirname, "..");
const CATEGORIES = new Set(["zero", "max", "boundary", "salt", "commitment", "signature"]);

function loadNoble() {
  const candidates = [
    path.join(__dirname, "../../frontend/node_modules"),
    path.join(__dirname, "../../node_modules"),
  ];
  for (const base of candidates) {
    const p = path.join(base, "@noble/curves/secp256k1.js");
    if (fs.existsSync(p)) return require(p).secp256k1;
  }
  throw new Error("@noble/curves not installed (pnpm install in frontend/)");
}

const be32 = (v) => {
  const b = new Uint8Array(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(x & 255n);
    x >>= 8n;
  }
  return b;
};

const all = () => ev.CIRCUITS.map((c) => ev.generate(c));

describe("edge-case vector generator (#1039)", () => {
  it("covers every signed credential circuit", () => {
    assert.deepStrictEqual([...ev.CIRCUITS].sort(), [
      "accreditation_proof",
      "age_proof",
      "date_range",
      "employment_proof",
      "funds_proof",
      "income_proof",
      "jurisdiction_proof",
      "kyc_proof",
      "range_proof",
      "set_membership",
    ]);
  });

  it("is deterministic within a process", () => {
    for (const c of ev.CIRCUITS) {
      assert.strictEqual(ev.serialize(ev.generate(c)), ev.serialize(ev.generate(c)), c);
    }
  });

  it("ignores ISSUER_PRIVATE_KEY and produces the same bytes in a fresh process", () => {
    const hashOf = (env) =>
      execFileSync(
        process.execPath,
        [
          "-e",
          `const ev=require(${JSON.stringify(SCRIPT)});process.stdout.write(require("crypto").createHash("sha256").update(ev.CIRCUITS.map(c=>ev.serialize(ev.generate(c))).join("")).digest("hex"))`,
        ],
        { env: { ...process.env, ...env }, encoding: "utf8" },
      );
    const local = crypto
      .createHash("sha256")
      .update(ev.CIRCUITS.map((c) => ev.serialize(ev.generate(c))).join(""))
      .digest("hex");
    assert.strictEqual(hashOf({}), local);
    assert.strictEqual(hashOf({ ISSUER_PRIVATE_KEY: "11".repeat(32) }), local);
  });

  it("matches the committed circuits/testvectors/edge/*.json byte for byte", () => {
    for (const c of ev.CIRCUITS) {
      const committed = ev.loadCommitted(c);
      assert.ok(committed, `missing circuits/testvectors/edge/${c}.json`);
      assert.strictEqual(
        committed,
        ev.serialize(ev.generate(c)),
        `${c} drifted; run edge_vectors.js generate`,
      );
    }
  });

  it("emits well-formed vectors with unique ids", () => {
    for (const doc of all()) {
      assert.strictEqual(doc.schema, ev.SCHEMA);
      assert.ok(doc.cases.length > 0);
      const ids = new Set();
      for (const v of doc.cases) {
        assert.match(v.id, /^[a-z0-9_]+$/, `${doc.circuit}: bad id ${v.id}`);
        assert.ok(!ids.has(v.id), `${doc.circuit}: duplicate id ${v.id}`);
        ids.add(v.id);
        assert.ok(
          CATEGORIES.has(v.category),
          `${doc.circuit}/${v.id}: unknown category ${v.category}`,
        );
        assert.ok(v.expect === "accept" || v.expect === "reject");
        assert.strictEqual(typeof v.description, "string");
        assert.strictEqual(typeof v.reason, "string");
        for (const [k, val] of Object.entries(v.inputs)) {
          if (Array.isArray(val)) {
            assert.ok(
              val.every((x) => typeof x === "string" || Number.isInteger(x)),
              `${doc.circuit}/${v.id}.${k}`,
            );
          } else {
            assert.match(val, /^\d+$/, `${doc.circuit}/${v.id}.${k} must be a decimal string`);
          }
        }
      }
    }
  });

  it("covers zero, max and boundary inputs with both outcomes in every circuit", () => {
    for (const doc of all()) {
      const cats = new Set(doc.cases.map((v) => v.category));
      for (const need of ["zero", "max", "boundary", "salt", "commitment", "signature"]) {
        assert.ok(cats.has(need), `${doc.circuit} has no '${need}' vector`);
      }
      assert.ok(
        doc.cases.some((v) => v.expect === "accept"),
        `${doc.circuit} has no accepting vector`,
      );
      assert.ok(
        doc.cases.some((v) => v.expect === "reject"),
        `${doc.circuit} has no rejecting vector`,
      );
    }
  });

  it("uses the extreme values of each input domain", () => {
    const flat = JSON.stringify(all());
    assert.ok(flat.includes(`"${ev.U64_MAX}"`), "u64 max");
    assert.ok(flat.includes(`"${ev.U64_OVERFLOW}"`), "u64 overflow");
    assert.ok(flat.includes(`"${ev.FIELD_MAX}"`), "field max");
  });

  it("computes Poseidon2 commitments identical to the committed Prover.toml witnesses", () => {
    const pairs = [
      ["kyc_proof", (w) => [w.secret]],
      ["age_proof", (w) => [w.date_of_birth]],
      ["range_proof", (w) => [w.value]],
      ["date_range", (w) => [w.issued_at]],
      ["set_membership", (w) => [w.value]],
    ];
    for (const [circuit, values] of pairs) {
      const w = parseProverToml(
        fs.readFileSync(path.join(CIRCUITS_ROOT, circuit, "Prover.toml"), "utf8"),
      );
      assert.strictEqual(ev.commit(values(w), w.salt).toString(), w.commitment, circuit);
    }
  });

  it("signs every accepting vector with the demo issuer, and the foreign-key vector with another key", () => {
    const secp = loadNoble();
    const pub = secp.getPublicKey(ev.ISSUER_SK, false);
    for (const doc of all()) {
      for (const v of doc.cases) {
        const { sig, commitment, issuer_x, issuer_y } = v.inputs;
        const key = new Uint8Array([4, ...issuer_x, ...issuer_y]);
        const ok = secp.verify(new Uint8Array(sig), be32(commitment), key, { prehash: false });
        if (v.expect === "accept") {
          assert.ok(ok, `${doc.circuit}/${v.id}: signature must verify`);
          assert.deepStrictEqual(key, pub, `${doc.circuit}/${v.id}: must use the demo issuer key`);
        }
        if (
          v.id === "signature_foreign_issuer" ||
          v.id === "signature_all_zero" ||
          v.id === "issuer_key_bit_flip"
        ) {
          assert.ok(!ok, `${doc.circuit}/${v.id}: signature must not verify`);
        }
      }
    }
  });

  it("renders inputs as Prover.toml the repo's parser reads back unchanged", () => {
    for (const doc of all()) {
      for (const v of doc.cases) {
        assert.deepStrictEqual(
          parseProverToml(ev.toToml(v.inputs)),
          v.inputs,
          `${doc.circuit}/${v.id}`,
        );
      }
    }
  });

  it("CLI: check passes on the committed tree and rejects an unknown circuit", () => {
    const ok = spawnSync(process.execPath, [SCRIPT, "check"], { encoding: "utf8" });
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /All edge-case vectors match\./);
    const bad = spawnSync(process.execPath, [SCRIPT, "check", "--circuit", "nope"], {
      encoding: "utf8",
    });
    assert.strictEqual(bad.status, 2);
  });
});

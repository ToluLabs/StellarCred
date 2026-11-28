"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-circuit-release-consistency.mjs");
const TYPES = ["kyc", "age", "income", "jurisdiction", "funds", "accreditation", "employment", "aggregate"];

function makeTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "circuit-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const files = [
    "circuits/circuit-versions.json",
    "circuits/supported-circuits.v1.json",
    "deployment/circuit-registrations.json",
    ...TYPES.flatMap((type) => [`frontend/public/circuits/${type}.json`, `fixtures/${type}/vk`]),
  ];
  for (const rel of files) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), target);
  }
  fs.cpSync(path.join(ROOT, "circuits", "testvectors"), path.join(dir, "circuits", "testvectors"), {
    recursive: true,
  });
  return dir;
}

function editJson(dir, rel, mutate) {
  const file = path.join(dir, rel);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function run(dir) {
  const reportPath = path.join(dir, "report.json");
  const result = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--report", "report.json"], {
    encoding: "utf8",
  });
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  return { result, report };
}

function entry(report, id) {
  return report.circuits.find((circuit) => circuit.id === id);
}

test("release gate passes on the committed release inputs and writes a machine-readable report", (t) => {
  const dir = makeTree(t);
  const { result, report } = run(dir);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, "pass");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.summary.supportedCircuits, 8);
  assert.equal(report.summary.mismatches, 0);
  assert.deepEqual(report.globalMismatches, []);
  assert.deepEqual(report.circuits.map((circuit) => circuit.status), Array(8).fill("ok"));
  for (const circuit of report.circuits) {
    assert.equal(typeof circuit.declaredVersion, "string");
    assert.equal(typeof circuit.artifactVersion, "string");
    assert.match(circuit.fixtureVkHash, /^[a-f0-9]{64}$/);
    assert.equal(typeof circuit.registeredVersion, "string");
    assert.ok(Number.isInteger(circuit.registeredVkVersion));
  }
});

test("staged artifact version drift fails with per-circuit details", (t) => {
  const dir = makeTree(t);
  editJson(dir, "frontend/public/circuits/kyc.json", (artifact) => {
    artifact.circuit_version = "9.9.9";
  });
  const { result, report } = run(dir);

  assert.equal(result.status, 1);
  assert.equal(report.status, "fail");
  assert.equal(report.summary.mismatches, 1);
  assert.equal(entry(report, "kyc_proof").status, "mismatch");
  assert.match(entry(report, "kyc_proof").mismatches[0], /^artifact: circuit_version/);
  assert.match(result.stderr, /kyc_proof.*artifact: circuit_version/s);
  assert.match(result.stderr, /RESULT: FAIL/);
  assert.equal(entry(report, "age_proof").status, "ok");
});

test("deployment registration vkVersion drift fails", (t) => {
  const dir = makeTree(t);
  editJson(dir, "deployment/circuit-registrations.json", (data) => {
    data.circuits.age.vkVersion = 2;
  });
  const { result, report } = run(dir);

  assert.equal(result.status, 1);
  assert.equal(report.status, "fail");
  assert.equal(entry(report, "age_proof").status, "mismatch");
  assert.match(entry(report, "age_proof").mismatches[0], /^registration: vkVersion/);
});

test("fixture VK hash drift fails against the registration and test vector", (t) => {
  const dir = makeTree(t);
  const fixture = path.join(dir, "fixtures", "income", "vk");
  const bytes = fs.readFileSync(fixture);
  bytes[0] ^= 0xff;
  fs.writeFileSync(fixture, bytes);
  const { result, report } = run(dir);

  assert.equal(result.status, 1);
  assert.equal(report.status, "fail");
  const mismatches = entry(report, "income_proof").mismatches;
  assert.ok(mismatches.some((message) => message.startsWith("registration: vkHash")));
  assert.ok(mismatches.some((message) => message.startsWith("testVector: vk_hash")));
});

test("missing deployment registration is reported for the supported circuit", (t) => {
  const dir = makeTree(t);
  editJson(dir, "deployment/circuit-registrations.json", (data) => {
    delete data.circuits.aggregate;
  });
  const { result, report } = run(dir);

  assert.equal(result.status, 1);
  assert.equal(report.status, "fail");
  assert.equal(entry(report, "aggregate_proof").status, "mismatch");
  assert.match(entry(report, "aggregate_proof").mismatches[0], /^registration: no entry/);
});

test("declared version drift fails even when artifacts and registrations agree", (t) => {
  const dir = makeTree(t);
  editJson(dir, "circuits/circuit-versions.json", (data) => {
    data.circuits.funds_proof.version = "1.2.3";
  });
  const { result, report } = run(dir);

  assert.equal(result.status, 1);
  assert.equal(report.status, "fail");
  assert.equal(entry(report, "funds_proof").declaredVersion, "1.2.3");
  assert.match(entry(report, "funds_proof").mismatches[0], /^declared: version/);
});

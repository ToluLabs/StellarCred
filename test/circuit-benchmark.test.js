const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  CIRCUITS,
  measureCircuitBenchmark,
  runAllCircuitBenchmarks,
} = require("../circuits/scripts/benchmark-harness.js");

describe("circuit benchmark harness (#1030)", () => {
  it("tracks all required Noir circuits", () => {
    assert.strictEqual(CIRCUITS.length, 12);
    assert(CIRCUITS.includes("kyc_proof"));
    assert(CIRCUITS.includes("aggregate_proof"));
  });

  it("measures gate count and proving time per constraint accurately", () => {
    const kyc = measureCircuitBenchmark("kyc_proof");
    assert.strictEqual(kyc.circuit, "kyc_proof");
    assert.strictEqual(kyc.constraints, 582);
    assert(kyc.provingTimePerConstraintMs > 0);
  });

  it("validates all circuits against performance thresholds", () => {
    const results = runAllCircuitBenchmarks();
    for (const name of CIRCUITS) {
      assert(results[name]);
      assert.strictEqual(results[name].passed, true);
    }
  });
});

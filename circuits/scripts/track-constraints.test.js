const { describe, it } = require("node:test");
const assert = require("node:assert");
const { getCircuitConstraints, estimateProvingSeconds, CIRCUITS } = require("./track-constraints.js");

describe("track-constraints (#534)", () => {
  it("includes all 12 circuits in tracking list", () => {
    assert.strictEqual(CIRCUITS.length, 12);
    assert(CIRCUITS.includes("kyc_proof"));
    assert(CIRCUITS.includes("age_proof"));
    assert(CIRCUITS.includes("income_proof"));
    assert(CIRCUITS.includes("funds_proof"));
    assert(CIRCUITS.includes("jurisdiction_proof"));
    assert(CIRCUITS.includes("accreditation_proof"));
    assert(CIRCUITS.includes("employment_proof"));
    assert(CIRCUITS.includes("range_proof"));
    assert(CIRCUITS.includes("set_membership"));
    assert(CIRCUITS.includes("aggregate_proof"));
    assert(CIRCUITS.includes("commit"));
    assert(CIRCUITS.includes("commit3"));
  });

  it("retrieves baseline constraints for kyc_proof", () => {
    const count = getCircuitConstraints("kyc_proof");
    assert.strictEqual(count, 582);
  });

  it("calculates estimated proving seconds accurately", () => {
    const kycTime = estimateProvingSeconds("kyc_proof", 582);
    assert.strictEqual(kycTime, 2.3);

    const aggTime = estimateProvingSeconds("aggregate_proof", 1210);
    assert.strictEqual(aggTime, 4.6);

    const commitTime = estimateProvingSeconds("commit", 4);
    assert.strictEqual(commitTime, 0.05);
  });
});

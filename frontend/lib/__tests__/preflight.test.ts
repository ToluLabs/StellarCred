import { describe, it, expect, vi } from "vitest";

// contracts.ts imports ./wallet at module scope; stub it so loading the
// module (and reading the pure preflight helpers) doesn't pull in the
// Stellar Wallets Kit in a unit test.
vi.mock("../wallet", () => ({ signTx: vi.fn() }));

import {
  formatFeeXlm,
  normalizeSimulationError,
  evaluateSimulation,
  PROOF_REGISTRY_ERRORS,
} from "../contracts";

describe("formatFeeXlm", () => {
  it("formats stroops as a compact XLM string", () => {
    expect(formatFeeXlm(12345)).toBe("0.0012345 XLM");
    expect(formatFeeXlm(1e7)).toBe("1 XLM");
  });

  it("strips trailing zeros", () => {
    expect(formatFeeXlm(100)).toBe("0.00001 XLM");
  });

  it("renders zero and negative values as 0 XLM", () => {
    expect(formatFeeXlm(0)).toBe("0 XLM");
    expect(formatFeeXlm(-5)).toBe("0 XLM");
  });

  it("treats NaN/Infinity as 0 XLM", () => {
    expect(formatFeeXlm(Number.NaN)).toBe("0 XLM");
    expect(formatFeeXlm(Number.POSITIVE_INFINITY)).toBe("0 XLM");
  });
});

describe("normalizeSimulationError", () => {
  it("leaves the canonical Error(Contract, #N) form untouched", () => {
    expect(normalizeSimulationError("Error(Contract, #4)")).toBe("Error(Contract, #4)");
  });

  it("folds ContractError(N) into the canonical form", () => {
    expect(normalizeSimulationError("Result(ContractError(4))")).toBe("Error(Contract, #4)");
  });

  it("folds ContractError(Some(N)) into the canonical form", () => {
    expect(normalizeSimulationError("ContractError(Some(9))")).toBe("Error(Contract, #9)");
  });

  it("passes through unrecognised strings unchanged", () => {
    expect(normalizeSimulationError("something unrelated")).toBe("something unrelated");
    expect(normalizeSimulationError("")).toBe("");
  });
});

describe("evaluateSimulation", () => {
  it("returns a fee estimate on success", () => {
    const result = evaluateSimulation({ success: true, minResourceFee: 25000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fee.stroops).toBe(25000);
      expect(result.fee.display).toBe(formatFeeXlm(25000));
    }
  });

  it("reports 0 fee when minResourceFee is absent", () => {
    const result = evaluateSimulation({ success: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fee.stroops).toBe(0);
      expect(result.fee.display).toBe("0 XLM");
    }
  });

  it("ignores non-finite minResourceFee values", () => {
    const result = evaluateSimulation({ success: true, minResourceFee: Number.NaN });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fee.stroops).toBe(0);
  });

  it("maps a failure to the human-mapped ContractError, without the default fallback", () => {
    const result = evaluateSimulation({
      success: false,
      error: "Execution: Error(Contract, #2)",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(2);
      expect(result.error.friendly).toBe(PROOF_REGISTRY_ERRORS[2]);
      expect(result.error.friendly).not.toMatch(/^Contract error #\\d+\\.$/);
    }
  });

  it("maps a ContractError(N) failure form", () => {
    const result = evaluateSimulation({ success: false, error: "Result(ContractError(12))" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(12);
      expect(result.error.friendly).toBe(PROOF_REGISTRY_ERRORS[12]);
    }
  });

  it("passes through the raw message when the failure has no known code", () => {
    const result = evaluateSimulation({ success: false, error: "boom" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBeNull();
      expect(result.error.raw).toBe("boom");
      expect(result.error.friendly).toBe("boom");
    }
  });
});
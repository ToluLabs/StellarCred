import { describe, it, expect, vi } from "vitest";

vi.mock("../wallet", () => ({ signTx: vi.fn() }));

import { parseContractError, PROOF_REGISTRY_ERRORS } from "../contracts";

// ── ProofRegistry Error enum coverage ────────────────────────────────────────
//
// The Rust enum in contracts/proof_registry/src/lib.rs assigns explicit u32
// discriminants.  This suite acts as a compile-time (well, test-time) guard:
// if a new variant is added to the enum but not to PROOF_REGISTRY_ERRORS the
// "every code has a mapped message" test below will fail.
//
// Keep this list in sync with the Rust enum:
//   NotInitialized        = 1
//   VerificationFailed    = 2
//   NotAuthorized         = 3
//   IssuerNotTrusted      = 4
//   IssuerKeyMismatch     = 5
//   ProofNotFound         = 6
//   BatchTooLarge         = 7
//   BatchEmpty            = 8
//   DuplicateCredentialType = 9
//   AggregateLayoutInvalid  = 10
//   SubmissionsPaused       = 11
//   InvalidExpiry           = 12
//   RoleNotHeld             = 13
//   RoleHolderMismatch      = 14
//   NoPendingAdmin          = 15
//   NullifierAlreadyUsed    = 16

const KNOWN_CODES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

describe("PROOF_REGISTRY_ERRORS", () => {
  it("has a non-empty message for every known contract error code", () => {
    for (const code of KNOWN_CODES) {
      expect(
        PROOF_REGISTRY_ERRORS[code],
        `Error code ${code} is missing from PROOF_REGISTRY_ERRORS`,
      ).toBeTruthy();
    }
  });

  it("contains no extra codes beyond the known enum range", () => {
    const mappedCodes = Object.keys(PROOF_REGISTRY_ERRORS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(mappedCodes).toEqual([...KNOWN_CODES]);
  });
});

describe("parseContractError", () => {
  describe("contract error codes", () => {
    it.each(KNOWN_CODES)("maps code %i to its friendly message", (code) => {
      const raw = `Error(Contract, #${code})`;
      const result = parseContractError(raw);

      expect(result.code).toBe(code);
      expect(result.raw).toBe(String(code));
      expect(result.diagnosticCode).toBe(code);
      expect(result.friendly).toBe(PROOF_REGISTRY_ERRORS[code]);
      // Friendly message must never fall back to the raw "Contract error #N." default.
      expect(result.friendly).not.toMatch(/^Contract error #\d+\.$/);
    });

    it("returns code and a fallback message for an unknown contract error code", () => {
      const raw = "Error(Contract, #99)";
      const result = parseContractError(raw);

      expect(result.code).toBe(99);
      expect(result.friendly).toBe("Contract error #99.");
      expect(result.raw).toBe("99");
    });
  });

  describe("individual code semantics", () => {
    it("1 — not initialised", () => {
      const { friendly } = parseContractError("Error(Contract, #1)");
      expect(friendly).toMatch(/not initialised/i);
    });

    it("2 — verification failed", () => {
      const { friendly } = parseContractError("Error(Contract, #2)");
      expect(friendly).toMatch(/verification failed/i);
    });

    it("3 — not authorised", () => {
      const { friendly } = parseContractError("Error(Contract, #3)");
      expect(friendly).toMatch(/not authorised/i);
    });

    it("4 — issuer not trusted", () => {
      const { friendly } = parseContractError("Error(Contract, #4)");
      expect(friendly).toMatch(/issuer not trusted/i);
    });

    it("5 — issuer key mismatch", () => {
      const { friendly } = parseContractError("Error(Contract, #5)");
      expect(friendly).toMatch(/key.*mismatch|mismatch.*key/i);
    });

    it("6 — proof not found", () => {
      const { friendly } = parseContractError("Error(Contract, #6)");
      expect(friendly).toMatch(/proof not found/i);
    });

    it("7 — batch too large", () => {
      const { friendly } = parseContractError("Error(Contract, #7)");
      expect(friendly).toMatch(/batch too large|reduce the number/i);
    });

    it("8 — batch empty", () => {
      const { friendly } = parseContractError("Error(Contract, #8)");
      expect(friendly).toMatch(/batch is empty|at least one/i);
    });

    it("9 — duplicate credential type", () => {
      const { friendly } = parseContractError("Error(Contract, #9)");
      expect(friendly).toMatch(/duplicate credential/i);
    });

    it("10 — aggregate layout invalid", () => {
      const { friendly } = parseContractError("Error(Contract, #10)");
      expect(friendly).toMatch(/aggregate|layout/i);
    });

    it("11 — submissions paused", () => {
      const { friendly } = parseContractError("Error(Contract, #11)");
      expect(friendly).toMatch(/paused/i);
    });

    it("12 — invalid expiry", () => {
      const { friendly } = parseContractError("Error(Contract, #12)");
      expect(friendly).toMatch(/expiry/i);
    });
  });

  describe("non-contract error strings", () => {
    it("handles Error(Auth, ...) with a wallet-authorisation message", () => {
      const raw = "Error(Auth, #0)";
      const result = parseContractError(raw);

      expect(result.code).toBeNull();
      expect(result.friendly).toMatch(/wallet authorisation/i);
      expect(result.raw).toBe("wallet_authorization");
    });

    it("handles Error(WasmVm, ...) with an execution-failure message", () => {
      const raw = "Error(WasmVm, #1)";
      const result = parseContractError(raw);

      expect(result.code).toBeNull();
      expect(result.friendly).toMatch(/credential data/i);
      expect(result.raw).toBe("malformed_proof");
    });

    it("does not expose unrecognised error strings", () => {
      const raw = "credential=secret salt=secret signature=secret witness=[secret]";
      const result = parseContractError(raw);

      expect(result.code).toBeNull();
      expect(result.friendly).toBe(
        "The operation could not be completed. Try again or contact support with the diagnostic code.",
      );
      expect(result.raw).toBe("unknown");
    });

    it("uses a safe non-empty message for an empty string", () => {
      const result = parseContractError("");
      expect(result.code).toBeNull();
      expect(result.friendly).toBe(
        "The operation could not be completed. Try again or contact support with the diagnostic code.",
      );
      expect(result.raw).toBe("unknown");
    });
  });
});

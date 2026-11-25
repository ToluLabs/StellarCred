import { describe, it, expect, vi } from "vitest";
import {
  maskWalletAddress,
  sanitizeContext,
  buildTelemetryRecord,
  emitTelemetry,
  registerTelemetryListener,
  recordWalletFailure,
  recordProofFailure,
  recordApiFailure,
} from "../telemetry";

describe("structured error reporting and production telemetry (#941)", () => {
  describe("maskWalletAddress", () => {
    it("safely masks public keys", () => {
      expect(maskWalletAddress("GDEXAMPLEWALLETKEY1234567890STEL")).toBe("GDEX...STEL");
    });

    it("returns null or fallback for empty or short values", () => {
      expect(maskWalletAddress(null)).toBeNull();
      expect(maskWalletAddress("")).toBeNull();
      expect(maskWalletAddress("short")).toBe("[invalid-wallet]");
    });
  });

  describe("sanitizeContext", () => {
    it("strips sensitive keys such as secrets, tokens, and passphrases", () => {
      const raw = {
        walletAddress: "GDEXAMPLE",
        clientSecret: "very-secret-token",
        userPassphrase: "super-secret-password",
        privateKey: "SABCDEF",
        credentialType: "kyc",
        email: "alice@example.com",
      };

      const cleaned = sanitizeContext(raw);
      expect(cleaned["clientSecret"]).toBeUndefined();
      expect(cleaned["userPassphrase"]).toBeUndefined();
      expect(cleaned["privateKey"]).toBeUndefined();
      expect(cleaned["credentialType"]).toBe("kyc");
    });
  });

  describe("buildTelemetryRecord and emitTelemetry", () => {
    it("includes correlation requestId and standardized fields", () => {
      const record = buildTelemetryRecord({
        category: "proof",
        severity: "error",
        event: "proof_generation_timeout",
        errorCode: "TIMEOUT",
        requestId: "req-12345",
        walletAddress: "GABC1234567890XYZW",
        durationMs: 1500,
        error: new Error("Prover exceeded time limit user@example.com"),
      });

      expect(record.requestId).toBe("req-12345");
      expect(record.category).toBe("proof");
      expect(record.severity).toBe("error");
      expect(record.walletAddress).toBe("GABC...XYZW");
      expect(record.durationMs).toBe(1500);
      expect(record.errorMessage).toContain("[redacted]");
    });

    it("notifies listeners on emission", () => {
      const listener = vi.fn();
      const unregister = registerTelemetryListener(listener);

      emitTelemetry({
        category: "api",
        severity: "info",
        event: "api_request_success",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0];
      expect(emitted.category).toBe("api");

      unregister();
    });

    it("records wallet and proof failures with expected metadata", () => {
      const walletRecord = recordWalletFailure(
        "wallet_connect_failed",
        new Error("User rejected connection"),
        { method: "freighter" },
        "GBAMIE1234567890XYZ",
      );

      expect(walletRecord.category).toBe("wallet");
      expect(walletRecord.walletAddress).toBe("GBAM...0XYZ");

      const proofRecord = recordProofFailure(
        "prover_circuit_error",
        new Error("circuit constraint failure"),
        { credentialType: "age" },
        320,
      );

      expect(proofRecord.category).toBe("proof");
      expect(proofRecord.errorCode).toBe("PROOF_GENERATION_FAILED");
      expect(proofRecord.durationMs).toBe(320);

      const apiRecord = recordApiFailure(
        "api_internal_error",
        new Error("Database unavailable"),
        500,
        "req-api-99",
      );

      expect(apiRecord.category).toBe("api");
      expect(apiRecord.severity).toBe("error");
      expect(apiRecord.errorCode).toBe("HTTP_500");
    });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  validateSubmission,
  validateUrl,
  validateEmail,
  submitApp,
  reviewApp,
  listApprovedApps,
  getAppSubmission,
  __resetAppSubmissionsForTesting,
} from "../apps-store";

describe("Apps gallery submission and review flow (#433)", () => {
  beforeEach(() => {
    __resetAppSubmissionsForTesting();
  });

  describe("Validation", () => {
    it("validates verify URLs strictly", () => {
      expect(validateUrl("https://example.com/verify")).toBe(true);
      expect(validateUrl("http://localhost:3000")).toBe(true);
      expect(validateUrl("javascript:alert(1)")).toBe(false);
      expect(validateUrl("data:text/html,<html>")).toBe(false);
      expect(validateUrl("ftp://example.com")).toBe(false);
      expect(validateUrl("not-a-url")).toBe(false);
      expect(validateUrl("")).toBe(false);
    });

    it("validates contact emails", () => {
      expect(validateEmail("partner@example.com")).toBe(true);
      expect(validateEmail("dev+integration@sub.domain.org")).toBe(true);
      expect(validateEmail("invalid-email")).toBe(false);
      expect(validateEmail("missing@domain")).toBe(false);
      expect(validateEmail("@missing-user.com")).toBe(false);
      expect(validateEmail("")).toBe(false);
    });

    it("rejects invalid app submissions with clear error messages", () => {
      // Empty app name
      expect(
        validateSubmission({
          appName: "",
          description: "A DeFi protocol",
          requiredClaims: ["kyc"],
          verifyUrl: "https://example.com",
          contactEmail: "dev@example.com",
        }).valid,
      ).toBe(false);

      // Invalid claim type
      const invalidClaim = validateSubmission({
        appName: "Test App",
        description: "A DeFi protocol",
        requiredClaims: ["kyc", "nonexistent-claim"],
        verifyUrl: "https://example.com",
        contactEmail: "dev@example.com",
      });
      expect(invalidClaim.valid).toBe(false);
      expect(invalidClaim.errors.requiredClaims).toContain("Invalid claim type");

      // Empty claims array
      expect(
        validateSubmission({
          appName: "Test App",
          description: "A DeFi protocol",
          requiredClaims: [],
          verifyUrl: "https://example.com",
          contactEmail: "dev@example.com",
        }).valid,
      ).toBe(false);

      // Malformed URL
      expect(
        validateSubmission({
          appName: "Test App",
          description: "A DeFi protocol",
          requiredClaims: ["kyc"],
          verifyUrl: "javascript:evil()",
          contactEmail: "dev@example.com",
        }).valid,
      ).toBe(false);
    });

    it("accepts valid app submissions", () => {
      const valid = validateSubmission({
        appName: "Blend Protocol",
        description: "Decentralized lending and borrowing protocol on Stellar.",
        requiredClaims: ["kyc", "accreditation"],
        verifyUrl: "https://blend.capital/verify",
        contactEmail: "integrations@blend.capital",
      });
      expect(valid.valid).toBe(true);
      expect(Object.keys(valid.errors).length).toBe(0);
    });
  });

  describe("Submission, storage, and review/approval workflow", () => {
    it("submits an app, stores it in pending status, and approves it", async () => {
      const subResult = await submitApp({
        appName: "Aquarius AMM",
        description: "Liquidity management protocol on Stellar.",
        requiredClaims: ["funds"],
        verifyUrl: "https://aqua.network/kyc",
        contactEmail: "team@aqua.network",
      });

      expect(subResult.id).toBeDefined();
      expect(subResult.status).toBe("pending");

      // Pending apps should NOT appear in approved apps list
      const approvedBefore = await listApprovedApps();
      expect(approvedBefore.some((a) => a.id === subResult.id)).toBe(false);

      // Verify stored details
      const stored = await getAppSubmission(subResult.id);
      expect(stored).not.toBeNull();
      expect(stored?.app_name).toBe("Aquarius AMM");
      expect(stored?.status).toBe("pending");
      expect(stored?.reviewed_at).toBeNull();

      // Approve the app
      const approved = await reviewApp(subResult.id, "approved");
      expect(approved).not.toBeNull();
      expect(approved?.status).toBe("approved");
      expect(approved?.reviewed_at).toBeTruthy();

      // Approved app should now appear in listApprovedApps
      const approvedAfter = await listApprovedApps();
      expect(approvedAfter.some((a) => a.id === subResult.id)).toBe(true);
      const listed = approvedAfter.find((a) => a.id === subResult.id)!;
      expect(listed.app_name).toBe("Aquarius AMM");
      expect(listed.status).toBe("approved");
    });

    it("handles app rejection in review workflow", async () => {
      const subResult = await submitApp({
        appName: "Untrusted Integration",
        description: "Suspicious app submission.",
        requiredClaims: ["kyc"],
        verifyUrl: "https://untrusted.xyz",
        contactEmail: "dev@untrusted.xyz",
      });

      const rejected = await reviewApp(subResult.id, "rejected");
      expect(rejected?.status).toBe("rejected");

      const approvedList = await listApprovedApps();
      expect(approvedList.some((a) => a.id === subResult.id)).toBe(false);
    });
  });
});

// @vitest-environment node
/**
 * Tests for error-reporting.ts — issue #553
 *
 * Acceptance criteria:
 *  - Error payloads are redacted by the same allowlist as logs.
 *  - No identity fields (name, DOB, government IDs, email, raw request body)
 *    leave the process during a mid-issuance failure.
 *  - Stack frames are never included in the outgoing payload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { redactPayload, safeErrorMessage, reportError } from "./error-reporting";
import { SAFE_FIELDS } from "./logger";

// ---------------------------------------------------------------------------
// redactPayload
// ---------------------------------------------------------------------------
describe("redactPayload", () => {
  it("keeps fields that are on the SAFE_FIELDS allowlist", () => {
    const input: Record<string, unknown> = {
      event: "signing_failed",
      requestId: "req_abc",
      status: 500,
      method: "POST",
      path: "/api/issue",
      environment: "test",
      error: "something went wrong",
      timestamp: new Date().toISOString(),
    };
    const out = redactPayload(input);
    // All these keys are on SAFE_FIELDS
    expect(out).toHaveProperty("requestId", "req_abc");
    expect(out).toHaveProperty("status", 500);
    expect(out).toHaveProperty("error", "something went wrong");
  });

  it("drops fields that are NOT on the SAFE_FIELDS allowlist", () => {
    const input: Record<string, unknown> = {
      requestId: "req_xyz",
      // These fields must never appear in an outgoing payload
      name: "John Doe",
      date_of_birth: "1990-01-15",
      ssn: "123-45-6789",
      email: "user@example.com",
      rawBody: JSON.stringify({ holder: "GAAA...", attributes: { date_of_birth: "1990-01-15" } }),
      personaFields: { birthdate: "1990-01-15", "address-street": "123 Main St" },
      plaidAccounts: [{ name: "Checking", account_id: "acc_secret" }],
    };
    const out = redactPayload(input);

    // Identity fields must be absent
    expect(out).not.toHaveProperty("name");
    expect(out).not.toHaveProperty("date_of_birth");
    expect(out).not.toHaveProperty("ssn");
    expect(out).not.toHaveProperty("email");
    expect(out).not.toHaveProperty("rawBody");
    expect(out).not.toHaveProperty("personaFields");
    expect(out).not.toHaveProperty("plaidAccounts");

    // requestId is on the allowlist and must survive
    expect(out).toHaveProperty("requestId", "req_xyz");
  });

  it("produces output whose keys are all on SAFE_FIELDS", () => {
    const input: Record<string, unknown> = {
      requestId: "req_1",
      unknown_field: "secret",
      another_pii: "data",
      event: "error",
    };
    const out = redactPayload(input);
    for (const key of Object.keys(out)) {
      expect(SAFE_FIELDS).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// safeErrorMessage
// ---------------------------------------------------------------------------
describe("safeErrorMessage", () => {
  it("returns the truncated message of an Error", () => {
    const err = new Error("something generic failed");
    expect(safeErrorMessage(err)).toBe("something generic failed");
  });

  it("never includes a stack frame in the output", () => {
    const err = new Error("failed");
    // Ensure there is a stack
    expect(err.stack).toBeTruthy();
    const result = safeErrorMessage(err);
    // Stack frames look like '    at <function> (<file>:<line>:<col>)'
    expect(result).not.toMatch(/\s+at\s+\S+\s+\(/);
  });

  it("redacts email addresses embedded in the message", () => {
    const err = new Error("KYC failed for user@example.com — inquiry rejected");
    expect(safeErrorMessage(err)).not.toContain("user@example.com");
    expect(safeErrorMessage(err)).toContain("[redacted]");
  });

  it("redacts ISO date-of-birth patterns (YYYY-MM-DD)", () => {
    const err = new Error("Age check failed: DOB 1990-07-22 does not meet threshold");
    const out = safeErrorMessage(err);
    expect(out).not.toContain("1990-07-22");
    expect(out).toContain("[redacted]");
  });

  it("redacts long numeric strings (≥6 digits) that could be IDs or account numbers", () => {
    // A Persona inquiry ID or Plaid account_id often looks like a long number
    const err = new Error("Plaid error for account 123456789012");
    const out = safeErrorMessage(err);
    expect(out).not.toContain("123456789012");
    expect(out).toContain("[redacted]");
  });

  it("does NOT redact short numbers that are not identifiers", () => {
    const err = new Error("Expected 2 accounts, got 3");
    const out = safeErrorMessage(err);
    expect(out).toContain("2");
    expect(out).toContain("3");
  });

  it("truncates messages longer than 200 characters", () => {
    const longMsg = "x".repeat(500);
    expect(safeErrorMessage(new Error(longMsg)).length).toBeLessThanOrEqual(200);
  });

  it("handles non-Error exceptions gracefully", () => {
    expect(safeErrorMessage("a plain string error")).toBe("a plain string error");
    expect(safeErrorMessage(42)).toBe("[non-error exception]");
    expect(safeErrorMessage(null)).toBe("[non-error exception]");
    expect(safeErrorMessage(undefined)).toBe("[non-error exception]");
    expect(safeErrorMessage({ code: "ERR_X" })).toBe("[non-error exception]");
  });

  // ---- Mid-issuance failure scenarios -----

  it("redacts identity data from a mid-Persona-resolution failure", () => {
    // Simulates an exception whose message was constructed with Persona response data
    const err = new Error(
      "Persona inquiry inq_12345678: birthdate=1985-03-14, email=john.doe@example.com, status=failed",
    );
    const out = safeErrorMessage(err);
    expect(out).not.toContain("1985-03-14");
    expect(out).not.toContain("john.doe@example.com");
    // inq_ prefix + 8-digit id — long numeric part should be redacted
    expect(out).not.toContain("12345678");
  });

  it("redacts identity data from a mid-Plaid-resolution failure", () => {
    const err = new Error(
      "Plaid returned ITEM_LOGIN_REQUIRED for access_token=access-sandbox-111122223333-4444 account 987654321",
    );
    const out = safeErrorMessage(err);
    expect(out).not.toContain("111122223333");
    expect(out).not.toContain("987654321");
  });

  it("redacts identity data from a mid-signing failure", () => {
    const err = new Error(
      "Commitment generation failed for holder GAAAAABBBBBCCCCCDDDDDEEEEE with DOB 1992-11-30",
    );
    const out = safeErrorMessage(err);
    expect(out).not.toContain("1992-11-30");
  });
});

// ---------------------------------------------------------------------------
// reportError — integration: verifies that the outgoing fetch payload is clean
// ---------------------------------------------------------------------------
describe("reportError", () => {
  const originalEnv = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ERROR_REPORTING_WEBHOOK = "https://webhook.example.com/errors";
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("does nothing when ERROR_REPORTING_WEBHOOK is not configured", async () => {
    delete process.env.ERROR_REPORTING_WEBHOOK;
    await reportError({ method: "POST", path: "/api/issue", requestId: "r1", status: 500 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the configured webhook URL", async () => {
    await reportError({ method: "POST", path: "/api/issue", requestId: "r2", status: 500 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://webhook.example.com/errors",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends only allowlisted fields in the payload", async () => {
    await reportError({ method: "POST", path: "/api/issue", requestId: "r3", status: 500 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    for (const key of Object.keys(body)) {
      expect(SAFE_FIELDS).toContain(key);
    }
  });

  it("does not include a stack trace in the payload", async () => {
    const err = new Error("signing error");
    await reportError({ method: "POST", path: "/api/issue", requestId: "r4", status: 500, exception: err });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/\s+at\s+\S+\s+\(/);
    expect(bodyStr).not.toContain("stack");
  });

  it("does not include identity fields when exception carries Persona data", async () => {
    const err = new Error(
      "Persona KYC failed for john.doe@example.com DOB=1990-05-20 inquiry=inq_99887766",
    );
    await reportError({ method: "POST", path: "/api/issue", requestId: "r5", status: 500, exception: err });
    const bodyStr = fetchMock.mock.calls[0][1].body;

    expect(bodyStr).not.toContain("john.doe@example.com");
    expect(bodyStr).not.toContain("1990-05-20");
    expect(bodyStr).not.toContain("99887766");
  });

  it("does not include identity fields when exception carries Plaid data", async () => {
    const err = new Error(
      "Plaid balance fetch failed: account_id=567890123456 holder=GABCDE token=access-sandbox-abc123",
    );
    await reportError({ method: "POST", path: "/api/issue", requestId: "r6", status: 500, exception: err });
    const bodyStr = fetchMock.mock.calls[0][1].body;

    expect(bodyStr).not.toContain("567890123456");
  });

  it("does not include the raw request body or holder address in the payload", async () => {
    const err = new Error("signing failure");
    // Simulate that a holder address ended up in scope
    Object.assign(err, { holder: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" });
    await reportError({ method: "POST", path: "/api/issue", requestId: "r7", status: 500, exception: err });
    const bodyStr = fetchMock.mock.calls[0][1].body;

    // The holder property on the error object is not in our message — verify
    // the full serialised payload also does not contain it
    expect(bodyStr).not.toContain("holder");
    expect(bodyStr).not.toContain("GAAAAAAAAA");
  });

  it("includes a sanitised error message (not the full original) in the payload", async () => {
    const err = new Error("Signing commitment failed — see logs");
    await reportError({ method: "POST", path: "/api/issue", requestId: "r8", status: 500, exception: err });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.error).toContain("Signing commitment failed");
  });

  it("attaches a 5-second AbortSignal to the fetch call", async () => {
    await reportError({ method: "POST", path: "/api/issue", requestId: "r9", status: 500 });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not throw when the webhook returns a non-OK response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422 });
    await expect(
      reportError({ method: "POST", path: "/api/issue", requestId: "r10", status: 500 }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the fetch itself rejects (network error)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      reportError({ method: "POST", path: "/api/issue", requestId: "r11", status: 500 }),
    ).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger, safeInfo, safeWarn, safeError, stripSensitiveFields, SAFE_FIELDS } from "./logger";

describe("stripSensitiveFields", () => {
  it("keeps only allowlisted fields", () => {
    const input = {
      event: "issue",
      requestId: "abc",
      secretToken: "shh",
      walletAddress: "0x1",
    };
    expect(stripSensitiveFields(input)).toEqual({
      event: "issue",
      requestId: "abc",
      walletAddress: "0x1",
    });
  });

  it("returns an empty object when no fields are allowlisted", () => {
    expect(stripSensitiveFields({ foo: 1, bar: 2 })).toEqual({});
  });

  it("includes every SAFE_FIELDS key that is present", () => {
    const input: Record<string, unknown> = {};
    for (const key of SAFE_FIELDS) input[key] = 1;
    input.notAllowed = 2;
    const out = stripSensitiveFields(input);
    expect(Object.keys(out).sort()).toEqual([...SAFE_FIELDS].sort());
  });
});

describe("safe logging wrappers", () => {
  beforeEach(() => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("safeInfo scrubs sensitive fields before logging", () => {
    safeInfo({ event: "issue", secret: "nope" }, "done");
    expect(logger.info).toHaveBeenCalledWith({ event: "issue" }, "done");
  });

  it("safeInfo works without a message", () => {
    safeInfo({ event: "issue", secret: "nope" });
    expect(logger.info).toHaveBeenCalledWith({ event: "issue" });
  });

  it("safeWarn scrubs sensitive fields before logging", () => {
    safeWarn({ requestId: "r1", token: "x" }, "warn");
    expect(logger.warn).toHaveBeenCalledWith({ requestId: "r1" }, "warn");
  });

  it("safeError scrubs sensitive fields before logging", () => {
    safeError({ error: "boom", password: "x" }, "failed");
    expect(logger.error).toHaveBeenCalledWith({ error: "boom" }, "failed");
  });
});

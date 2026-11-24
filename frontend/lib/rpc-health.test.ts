// Coverage for the app-level RPC health monitor (Issue #634).
//
// The point of this module is that a read which never reached the ledger
// becomes a typed, attributable problem instead of a silent `false`. These
// tests pin the classification, the store, and the probe that drives the
// degraded-mode banner.

import { describe, it, expect, beforeEach, vi } from "vitest";

// The SDK is only ever reached through a dynamic import; mocking it here lets
// us drive both the healthy and the unreachable probe without a network.
const ledger = vi.fn();

vi.mock("@stellar/stellar-sdk", () => {
  class Server {
    getLatestLedger = ledger;
  }
  return { rpc: { Server } };
});

async function loadModule() {
  vi.resetModules();
  return import("./rpc-health");
}

beforeEach(() => {
  ledger.mockReset();
});

describe("classifyRpcError", () => {
  it("treats transport failures as an RPC outage", async () => {
    const { classifyRpcError } = await loadModule();
    for (const message of [
      "Failed to fetch",
      "connect ECONNREFUSED 127.0.0.1:8000",
      "getaddrinfo ENOTFOUND soroban-testnet.stellar.org",
      "request timed out after 8000ms",
      "socket hang up",
      "503 Service Unavailable",
    ]) {
      const issue = classifyRpcError(new Error(message));
      expect(issue.kind, message).toBe("rpc-unreachable");
    }
  });

  it("treats a missing deployment as a configuration problem, not an outage", async () => {
    const { classifyRpcError } = await loadModule();
    const issue = classifyRpcError("NEXT_PUBLIC_PROOF_REGISTRY_ID is not configured");
    expect(issue.kind).toBe("not-configured");
  });

  it("falls back to read-failed for anything it cannot place", async () => {
    const { classifyRpcError } = await loadModule();
    const issue = classifyRpcError(new Error("unexpected sim response shape"));
    expect(issue.kind).toBe("read-failed");
    expect(issue.message).toContain("unexpected sim response shape");
  });

  it("never throws on non-Error input", async () => {
    const { classifyRpcError } = await loadModule();
    expect(classifyRpcError(undefined).kind).toBe("read-failed");
    expect(classifyRpcError("Failed to fetch").kind).toBe("rpc-unreachable");
  });
});

describe("isMissingAccountError", () => {
  it("recognises a holder with no account on the ledger", async () => {
    const { isMissingAccountError } = await loadModule();
    expect(isMissingAccountError(new Error("Account not found"))).toBe(true);
    expect(
      isMissingAccountError(new Error("Failed to fetch: account not found")),
    ).toBe(false);
  });
});

describe("shared health store", () => {
  it("starts unchecked, then records reported read outcomes", async () => {
    const { getRpcHealth, reportRpcHealthy, reportRpcIssue, subscribeRpcHealth } =
      await loadModule();

    expect(getRpcHealth()).toEqual({ status: "unchecked", issue: null, checkedAt: 0 });

    const seen: string[] = [];
    const unsubscribe = subscribeRpcHealth(() => seen.push(getRpcHealth().status));

    reportRpcHealthy();
    expect(getRpcHealth().status).toBe("ok");

    reportRpcIssue({ kind: "rpc-unreachable", message: "node down" });
    expect(getRpcHealth()).toMatchObject({
      status: "degraded",
      issue: { kind: "rpc-unreachable", message: "node down" },
    });

    unsubscribe();
    reportRpcHealthy();
    expect(seen).toEqual(["ok", "degraded"]);
  });
});

describe("probeRpcHealth", () => {
  it("resolves null and marks the network healthy when the node answers", async () => {
    ledger.mockResolvedValue({ sequence: 1 });
    const { probeRpcHealth, getRpcHealth } = await loadModule();

    await expect(probeRpcHealth()).resolves.toBeNull();
    expect(getRpcHealth().status).toBe("ok");
  });

  it("resolves the classified issue and marks the network degraded otherwise", async () => {
    ledger.mockRejectedValue(new Error("Failed to fetch"));
    const { probeRpcHealth, getRpcHealth } = await loadModule();

    const issue = await probeRpcHealth();
    expect(issue?.kind).toBe("rpc-unreachable");
    expect(getRpcHealth().status).toBe("degraded");
  });

  it("degrades when the probe deadline passes", async () => {
    ledger.mockReturnValue(new Promise(() => {}));
    const { probeRpcHealth, getRpcHealth } = await loadModule();

    const issue = await probeRpcHealth({ timeoutMs: 5 });
    expect(issue?.kind).toBe("rpc-unreachable");
    expect(issue?.message).toContain("did not respond in time");
    expect(getRpcHealth().status).toBe("degraded");
  });
});

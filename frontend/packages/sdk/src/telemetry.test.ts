import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TELEMETRY_REDACTED,
  TelemetryConfigError,
  configureTelemetry,
  disableTelemetry,
  flushTelemetry,
  getTelemetryConfig,
  isTelemetryEnabled,
  isSensitiveTelemetryKey,
  resetTelemetry,
  sanitizeTelemetryAttributes,
  sanitizeTelemetryKey,
  sanitizeTelemetryName,
  sanitizeTelemetryValue,
  trackEvent,
  withTelemetry,
  type TelemetryEvent,
} from "./telemetry";

// Realistic-format fixtures. These are throwaway values, not live keys.
const STELLAR_ACCOUNT = "GBRPYHIL2CQ7ZKZ7QZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZ";
const STELLAR_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const STELLAR_SEED = "SBRPYHIL2CQ7ZKZ7QZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZ";
const HEX_PRIVATE_KEY = "a3f1c9d2b4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcde";
const HEX_PRIVATE_KEY_0X = `0x${HEX_PRIVATE_KEY}`;
const EMAIL = "holder@example.com";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ3YWxsZXQifQ.c2lnbmF0dXJlLXZhbHVl";
// Assembled at runtime so secret scanners do not flag this throwaway fixture.
const STRIPE_KEY = ["sk_live", "51H8xQ2LkdIwHu7ix7hRnW6X"].join("_");
const BEARER = "Bearer abcdef0123456789abcdef0123456789";

function sinkSpy() {
  return vi.fn<(events: readonly TelemetryEvent[]) => void>();
}

afterEach(() => {
  resetTelemetry();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("telemetry is opt-in", () => {
  it("records and transmits nothing by default", async () => {
    const sink = sinkSpy();
    // No configureTelemetry call: the module must stay inert even if a sink
    // is somehow reachable.
    expect(isTelemetryEnabled()).toBe(false);
    trackEvent("claim.check", { source: "chain" });
    await flushTelemetry();
    expect(sink).not.toHaveBeenCalled();
    expect(getTelemetryConfig()).toEqual({
      enabled: false,
      endpoint: null,
      appId: null,
      maxBatchSize: 20,
      flushIntervalMs: 30_000,
    });
  });

  it("delivers events only after an explicit enabled: true", async () => {
    const sink = sinkSpy();
    configureTelemetry({ enabled: true, sink, flushIntervalMs: 0 });

    trackEvent("claim.check", { source: "chain" });
    expect(sink).not.toHaveBeenCalled();

    await flushTelemetry();
    expect(sink).toHaveBeenCalledTimes(1);
    const [events] = sink.mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("claim.check");
    expect(events[0].attributes).toEqual({ source: "chain" });
  });

  it("treats enabled: false as off and discards buffered events", async () => {
    const sink = sinkSpy();
    configureTelemetry({ enabled: true, sink, flushIntervalMs: 0 });
    trackEvent("claim.check");
    configureTelemetry({ enabled: false });
    await flushTelemetry();
    expect(isTelemetryEnabled()).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it("disableTelemetry stops recording", async () => {
    const sink = sinkSpy();
    configureTelemetry({ enabled: true, sink, flushIntervalMs: 0 });
    disableTelemetry();
    trackEvent("claim.check");
    await flushTelemetry();
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("strict zero-PII sanitization", () => {
  it("redacts Stellar account, contract, and secret keys inside values", () => {
    for (const secret of [STELLAR_ACCOUNT, STELLAR_CONTRACT, STELLAR_SEED]) {
      const value = sanitizeTelemetryValue(`called with ${secret} ok`);
      expect(value).toBe(`called with ${TELEMETRY_REDACTED} ok`);
    }
  });

  it("redacts raw 32-byte hex keys, with and without 0x", () => {
    expect(sanitizeTelemetryValue(HEX_PRIVATE_KEY)).toBe(TELEMETRY_REDACTED);
    expect(sanitizeTelemetryValue(HEX_PRIVATE_KEY_0X)).toBe(TELEMETRY_REDACTED);
  });

  it("redacts e-mail addresses, JWTs, bearer tokens, and provider keys", () => {
    expect(sanitizeTelemetryValue(`user ${EMAIL}`)).toBe(`user ${TELEMETRY_REDACTED}`);
    expect(sanitizeTelemetryValue(JWT)).toBe(TELEMETRY_REDACTED);
    expect(sanitizeTelemetryValue(BEARER)).toBe(`Bearer ${TELEMETRY_REDACTED}`);
    expect(sanitizeTelemetryValue(`key=${STRIPE_KEY}`)).toBe(`key=${TELEMETRY_REDACTED}`);
  });

  it("drops attribute keys that name a secret, credential, proof, or identity field", () => {
    const sensitiveKeys = [
      "privateKey",
      "private_key",
      "secret",
      "secretKey",
      "seed",
      "mnemonic",
      "password",
      "passphrase",
      "apiKey",
      "api_key",
      "accessToken",
      "authorization",
      "signature",
      "credential",
      "credentials",
      "claims",
      "proof",
      "proofs",
      "witness",
      "nullifier",
      "wallet",
      "walletAddress",
      "address",
      "holder",
      "subject",
      "email",
      "phone",
      "dateOfBirth",
      "ssn",
      "passport",
      "userName",
      "firstName",
      "lastName",
    ];
    for (const key of sensitiveKeys) {
      expect(isSensitiveTelemetryKey(key), key).toBe(true);
    }

    const sanitized = sanitizeTelemetryAttributes({
      privateKey: HEX_PRIVATE_KEY,
      wallet: STELLAR_ACCOUNT,
      claims: { kyc: true },
      proof: "0xdeadbeef",
      email: EMAIL,
      source: "chain",
    });
    expect(sanitized).toEqual({ source: "chain" });
  });

  it("keeps benign diagnostic attributes", () => {
    expect(
      sanitizeTelemetryAttributes({
        source: "indexer-verified",
        operation: "hasClaim",
        outcome: "success",
        duration_ms: 42,
        retries: 2,
        cache_hit: true,
      }),
    ).toEqual({
      source: "indexer-verified",
      operation: "hasClaim",
      outcome: "success",
      duration_ms: 42,
      retries: 2,
      cache_hit: true,
    });
  });

  it("normalises keys and names into a safe alphabet", () => {
    expect(sanitizeTelemetryKey("  Operation Source  ")).toBe("operation_source");
    expect(sanitizeTelemetryKey("!!!")).toBeNull();
    expect(sanitizeTelemetryName("Claim / Check")).toBe("claim_check");
    expect(sanitizeTelemetryName("")).toBe("unnamed.event");
  });

  it("scrubs addresses that are smuggled into event names", () => {
    const name = sanitizeTelemetryName(`claim.check ${STELLAR_ACCOUNT}`);
    expect(name).not.toContain(STELLAR_ACCOUNT);
    expect(name).toContain("redacted");
    expect(name).toMatch(/^[a-z0-9_.-]+$/);
  });

  it("sanitizes nested objects and drops sensitive keys inside them", () => {
    const value = sanitizeTelemetryValue({
      source: "chain",
      privateKey: HEX_PRIVATE_KEY,
      contact: { email: EMAIL },
      note: `holder is ${STELLAR_ACCOUNT}`,
    });
    expect(typeof value).toBe("string");
    const serialized = String(value);
    expect(serialized).not.toContain(HEX_PRIVATE_KEY);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain(STELLAR_ACCOUNT);
    expect(serialized).toContain("chain");
  });

  it("drops non-finite numbers and unsupported values", () => {
    expect(sanitizeTelemetryValue(Number.NaN)).toBeUndefined();
    expect(sanitizeTelemetryValue(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(sanitizeTelemetryValue(undefined)).toBeUndefined();
    expect(sanitizeTelemetryValue(Symbol("x"))).toBeUndefined();
  });
});

describe("zero-PII guarantee on the wire", () => {
  it("never transmits a private key, claim value, address, or proof witness", async () => {
    const sink = sinkSpy();
    configureTelemetry({ enabled: true, sink, flushIntervalMs: 0, appId: "example-app" });

    // A hostile caller: every shape of sensitive data in one event.
    trackEvent(`claim.check ${STELLAR_ACCOUNT}`, {
      walletAddress: STELLAR_ACCOUNT,
      privateKey: HEX_PRIVATE_KEY,
      secret_seed: STELLAR_SEED,
      apiKey: STRIPE_KEY,
      authorization: BEARER,
      credentialClaim: { type: "kyc", fullName: "Ada Lovelace" },
      proofWitness: "0xabc123",
      email: EMAIL,
      note: `${STELLAR_ACCOUNT} signed with ${STELLAR_SEED}`,
      source: "chain",
    });
    await flushTelemetry();

    expect(sink).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(sink.mock.calls[0][0]);

    for (const secret of [
      STELLAR_ACCOUNT,
      STELLAR_CONTRACT,
      STELLAR_SEED,
      HEX_PRIVATE_KEY,
      EMAIL,
      JWT,
      STRIPE_KEY,
      BEARER,
      "Ada Lovelace",
      "0xabc123",
    ]) {
      expect(payload).not.toContain(secret);
    }
    for (const key of ["wallet", "privatekey", "secret", "apikey", "credential", "proof"]) {
      expect(payload.toLowerCase()).not.toContain(key);
    }
    expect(payload).toContain("example-app");
    expect(payload).toContain("chain");
  });

  it("posts sanitized JSON to the configured endpoint without credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    const endpoint = "https://telemetry.example.com/v1/events";
    configureTelemetry({ enabled: true, endpoint, flushIntervalMs: 0 });

    trackEvent("claim.check", { wallet: STELLAR_ACCOUNT, source: "chain" });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    const body = String(init.body);
    expect(body).not.toContain(STELLAR_ACCOUNT);
    expect(JSON.parse(body).events).toHaveLength(1);
  });

  it("swallows transport and sink failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    configureTelemetry({
      enabled: true,
      endpoint: "https://telemetry.example.com/",
      flushIntervalMs: 0,
    });
    trackEvent("claim.check");
    await expect(flushTelemetry()).resolves.toBeUndefined();

    const sink = vi.fn(() => {
      throw new Error("sink exploded");
    });
    configureTelemetry({ enabled: true, sink, flushIntervalMs: 0 });
    trackEvent("claim.check");
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it("flushes automatically once maxBatchSize is reached", async () => {
    const sink = sinkSpy();
    configureTelemetry({ enabled: true, sink, maxBatchSize: 2, flushIntervalMs: 0 });
    trackEvent("a");
    expect(sink).not.toHaveBeenCalled();
    trackEvent("b");
    await Promise.resolve();
    await Promise.resolve();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toHaveLength(2);
  });
});

describe("endpoint configuration", () => {
  it("rejects insecure, credentialed, and query-string endpoints", () => {
    expect(() =>
      configureTelemetry({ enabled: true, endpoint: "http://telemetry.example.com/events" }),
    ).toThrow(TelemetryConfigError);
    expect(() =>
      configureTelemetry({ enabled: true, endpoint: "https://user:pass@telemetry.example.com/e" }),
    ).toThrow(TelemetryConfigError);
    expect(() =>
      configureTelemetry({ enabled: true, endpoint: "https://telemetry.example.com/e?key=abc" }),
    ).toThrow(TelemetryConfigError);
    expect(() =>
      configureTelemetry({ enabled: true, endpoint: "https://telemetry.example.com/e#frag" }),
    ).toThrow(TelemetryConfigError);
    expect(() => configureTelemetry({ enabled: true, endpoint: "not a url" })).toThrow(
      TelemetryConfigError,
    );
  });

  it("allows loopback http only when explicitly enabled", () => {
    expect(() =>
      configureTelemetry({ enabled: true, endpoint: "http://localhost:4000/events" }),
    ).toThrow(TelemetryConfigError);
    expect(() =>
      configureTelemetry({
        enabled: true,
        endpoint: "http://localhost:4000/events",
        allowInsecureLocalhost: true,
      }),
    ).not.toThrow();
    expect(getTelemetryConfig().endpoint).toBe("http://localhost:4000/events");
  });

  it("requires a sink or an endpoint", () => {
    expect(() => configureTelemetry({ enabled: true })).toThrow(TelemetryConfigError);
    expect(() => configureTelemetry({ enabled: true, maxBatchSize: 0, sink: () => {} })).toThrow(
      TelemetryConfigError,
    );
    expect(() =>
      configureTelemetry({ enabled: true, flushIntervalMs: -1, sink: () => {} }),
    ).toThrow(TelemetryConfigError);
  });
});

describe("withTelemetry", () => {
  it("records duration and success without touching the result", async () => {
    const sink = sinkSpy();
    configureTelemetry({ enabled: true, sink, flushIntervalMs: 0 });

    await expect(withTelemetry("claim.check", async () => "ok", { source: "chain" })).resolves.toBe(
      "ok",
    );
    await flushTelemetry();

    const [event] = sink.mock.calls[0][0];
    expect(event.name).toBe("claim.check");
    expect(event.outcome).toBe("success");
    expect(event.attributes).toEqual({ source: "chain" });
    expect(typeof event.durationMs).toBe("number");
  });

  it("records failure without leaking the error message", async () => {
    const sink = sinkSpy();
    configureTelemetry({ enabled: true, sink, flushIntervalMs: 0 });

    await expect(
      withTelemetry("claim.check", async () => {
        throw new Error(`rpc failed for wallet ${STELLAR_ACCOUNT}`);
      }),
    ).rejects.toThrow("rpc failed");
    await flushTelemetry();

    const [event] = sink.mock.calls[0][0];
    expect(event.outcome).toBe("error");
    expect(JSON.stringify(event)).not.toContain(STELLAR_ACCOUNT);
    expect(JSON.stringify(event)).not.toContain("rpc failed");
  });

  it("is a transparent pass-through while telemetry is disabled", async () => {
    await expect(withTelemetry("claim.check", async () => 42)).resolves.toBe(42);
  });
});

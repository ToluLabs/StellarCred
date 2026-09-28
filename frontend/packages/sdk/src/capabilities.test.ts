// capabilities.test.ts — descriptor bootstrap (issue #639)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bootstrap,
  capabilitiesUrl,
  fetchCapabilities,
  validateCapabilitiesDescriptor,
  type CapabilitiesDescriptor,
} from "./capabilities";
import { configure, getConfig, resetConfig } from "./claims";

const PROOF_REGISTRY_ID = "CPROOFDESCRIPTOR000000000000000000000000000000000000000001";

const VALID_DESCRIPTOR: CapabilitiesDescriptor = {
  descriptor_version: 1,
  app_version: "1.0.0",
  network: {
    id: "testnet",
    passphrase: "Test SDF Network ; September 2015",
    rpc_url: "https://soroban-testnet.stellar.org",
  },
  contracts: {
    proof_registry: { id: PROOF_REGISTRY_ID, version: "1.1.0" },
    issuer_registry: { id: "CISSUERDESCRIPTOR00000000000000000000000000000000000000001", version: "1.1.0" },
  },
  credential_types: ["kyc", "age"],
  issuers: { count: 2, credential_types: ["kyc"] },
  indexer: null,
  sponsored_submission: { available: false },
  sdk: { package: "@stellarcred/sdk", version_range: ">=0.1.1 <1" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetConfig();
  configure({ baseUrl: "https://deployment.example" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetConfig();
});

describe("validateCapabilitiesDescriptor", () => {
  it("accepts a well-formed descriptor", () => {
    expect(validateCapabilitiesDescriptor(VALID_DESCRIPTOR)).toEqual(VALID_DESCRIPTOR);
  });

  it("rejects null, strings, and arrays", () => {
    expect(() => validateCapabilitiesDescriptor(null)).toThrow(/expected a JSON object/);
    expect(() => validateCapabilitiesDescriptor("nope")).toThrow(/expected a JSON object/);
    expect(() => validateCapabilitiesDescriptor([VALID_DESCRIPTOR])).toThrow(
      /expected a JSON object/,
    );
  });

  it("rejects a missing/non-numeric descriptor_version", () => {
    const withoutVersion = {
      ...VALID_DESCRIPTOR,
      descriptor_version: undefined,
    } as unknown as CapabilitiesDescriptor;
    expect(() => validateCapabilitiesDescriptor(withoutVersion)).toThrow(/descriptor_version/);
    expect(() =>
      validateCapabilitiesDescriptor({ ...VALID_DESCRIPTOR, descriptor_version: "1" }),
    ).toThrow(/descriptor_version/);
  });

  it("rejects a missing network object", () => {
    const { network, ...rest } = VALID_DESCRIPTOR;
    expect(() => validateCapabilitiesDescriptor(rest)).toThrow(/network/);
  });

  it("rejects an empty network passphrase", () => {
    expect(() =>
      validateCapabilitiesDescriptor({
        ...VALID_DESCRIPTOR,
        network: { ...VALID_DESCRIPTOR.network, passphrase: "" },
      }),
    ).toThrow(/network\.passphrase/);
  });

  it("rejects a non-object contracts field", () => {
    expect(() =>
      validateCapabilitiesDescriptor({ ...VALID_DESCRIPTOR, contracts: [] }),
    ).toThrow(/contracts/);
  });
});

describe("capabilitiesUrl", () => {
  it("joins the configured base URL with the well-known path", () => {
    expect(capabilitiesUrl()).toBe("https://deployment.example/api/capabilities");
  });

  it("strips trailing slashes from the base URL", () => {
    expect(capabilitiesUrl("https://deployment.example/")).toBe(
      "https://deployment.example/api/capabilities",
    );
  });
});

describe("fetchCapabilities", () => {
  it("fetches {baseUrl}/api/capabilities by default and validates the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_DESCRIPTOR));
    const descriptor = await fetchCapabilities({ fetchImpl: fetchMock as unknown as typeof fetch });

    expect(descriptor).toEqual(VALID_DESCRIPTOR);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://deployment.example/api/capabilities",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("honors an explicit descriptorUrl override", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_DESCRIPTOR));
    await fetchCapabilities({
      descriptorUrl: "https://other.example/api/capabilities",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://other.example/api/capabilities",
      expect.anything(),
    );
  });

  it("throws ConfigError on HTTP failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(
      fetchCapabilities({ fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("throws ConfigError when the network fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      fetchCapabilities({ fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws ConfigError on invalid JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>not json</html>", { status: 200 }));
    await expect(
      fetchCapabilities({ fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("throws ConfigError on a malformed payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hello: "world" }));
    await expect(
      fetchCapabilities({ fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/Invalid capability descriptor/);
  });

  it("applies the request timeout as an abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_DESCRIPTOR));
    await fetchCapabilities({
      requestTimeoutMs: 1234,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("bootstrap", () => {
  it("configures registryId, rpcUrl, and networkPassphrase from the descriptor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_DESCRIPTOR));
    const descriptor = await bootstrap({ fetchImpl: fetchMock as unknown as typeof fetch });

    expect(descriptor).toEqual(VALID_DESCRIPTOR);
    const cfg = getConfig();
    expect(cfg.registryId).toBe(PROOF_REGISTRY_ID);
    expect(cfg.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(cfg.networkPassphrase).toBe("Test SDF Network ; September 2015");
  });

  it("keeps the existing rpcUrl when the descriptor omits it", async () => {
    configure({ rpcUrl: "https://keep.example" });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        descriptor_version: 1,
        network: { passphrase: "Descriptor Network" },
        contracts: { proof_registry: { id: "CPROOF" } },
      }),
    );
    await bootstrap({ fetchImpl: fetchMock as unknown as typeof fetch });

    const cfg = getConfig();
    expect(cfg.registryId).toBe("CPROOF");
    expect(cfg.rpcUrl).toBe("https://keep.example");
    expect(cfg.networkPassphrase).toBe("Descriptor Network");
  });

  it("throws ConfigError (config untouched) when proof_registry is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        descriptor_version: 1,
        network: { passphrase: "Test SDF Network ; September 2015" },
        contracts: {},
      }),
    );
    await expect(
      bootstrap({ fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/proof_registry/);

    const cfg = getConfig();
    expect(cfg.registryId).toBe("");
  });

  it("does not swallow descriptor fetch failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      bootstrap({ fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/offline/);
  });
});

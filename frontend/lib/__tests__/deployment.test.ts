import { describe, expect, it, vi } from "vitest";

const { TESTNET_PASSPHRASE, CURRENT_CONTRACTS } = vi.hoisted(() => ({
  TESTNET_PASSPHRASE: "Test SDF Network ; September 2015",
  CURRENT_CONTRACTS: {
    issuerRegistry: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMOCKR",
    credentialVerifier: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMOCKV",
    proofRegistry: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMOCKP",
    gatedPool: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMOCKG",
  },
}));
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

// lib/deployment.ts reads the module-scope config from lib/stellar; mock it so
// "this deployment" is a fixed, fully-configured testnet app.
vi.mock("../stellar", () => ({
  NETWORK: "testnet",
  NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
  CONTRACTS: { ...CURRENT_CONTRACTS },
  CREDENTIAL_TYPES: [
    "kyc",
    "age",
    "jurisdiction",
    "income",
    "funds",
    "accreditation",
    "employment",
  ],
}));

import { currentDeploymentRef, deploymentMismatchMessage, parseDeploymentRef } from "../deployment";
import { parseCredential } from "../credential";

const CURRENT = {
  network: "testnet" as const,
  networkPassphrase: TESTNET_PASSPHRASE,
  contracts: { ...CURRENT_CONTRACTS },
};

function ref(overrides: {
  networkPassphrase?: string;
  network?: "testnet" | "mainnet";
  contracts?: Partial<typeof CURRENT_CONTRACTS>;
}) {
  return {
    network: overrides.network ?? "testnet",
    networkPassphrase: overrides.networkPassphrase ?? TESTNET_PASSPHRASE,
    contracts: { ...CURRENT_CONTRACTS, ...overrides.contracts },
  };
}

/** A structurally valid credential JSON for parseCredential. */
function credentialJson(deployment?: unknown): string {
  return JSON.stringify({
    type: "kyc",
    value: "0x1234",
    salt: "0xabcd",
    commitment: "0xdeadbeef",
    issuerId: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY234",
    sig: Array(64).fill(7),
    issuerPubX: Array(32).fill(1),
    issuerPubY: Array(32).fill(2),
    expiry: "90 days",
    ...(deployment === undefined ? {} : { deployment }),
  });
}

describe("currentDeploymentRef", () => {
  it("mirrors the effective network, passphrase, and contract IDs", () => {
    expect(currentDeploymentRef()).toEqual(CURRENT);
  });
});

describe("parseDeploymentRef", () => {
  it("accepts a well-formed reference", () => {
    expect(parseDeploymentRef(ref({}))).toEqual(CURRENT);
  });

  it("rejects absent, non-object, and structurally broken references", () => {
    expect(parseDeploymentRef(undefined)).toBeNull();
    expect(parseDeploymentRef(null)).toBeNull();
    expect(parseDeploymentRef("testnet")).toBeNull();
    expect(parseDeploymentRef({ networkPassphrase: TESTNET_PASSPHRASE })).toBeNull();
    expect(parseDeploymentRef({ networkPassphrase: 42, contracts: {} })).toBeNull();
  });

  it("keeps unset contract IDs as empty strings", () => {
    const parsed = parseDeploymentRef({
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
      contracts: { issuerRegistry: CURRENT_CONTRACTS.issuerRegistry },
    });
    expect(parsed?.contracts).toEqual({
      issuerRegistry: CURRENT_CONTRACTS.issuerRegistry,
      credentialVerifier: "",
      proofRegistry: "",
      gatedPool: "",
    });
  });
});

describe("deploymentMismatchMessage", () => {
  it("allows credentials with no (or malformed) deployment — legacy import path", () => {
    expect(deploymentMismatchMessage(undefined)).toBeNull();
    expect(deploymentMismatchMessage({ garbage: true })).toBeNull();
  });

  it("allows a credential minted by this exact deployment", () => {
    expect(deploymentMismatchMessage(ref({}))).toBeNull();
  });

  it("rejects a credential from another network (testnet → mainnet)", () => {
    const message = deploymentMismatchMessage(
      ref({ network: "mainnet", networkPassphrase: MAINNET_PASSPHRASE }),
      CURRENT,
    );
    expect(message).toContain("another deployment");
    expect(message).toContain("mainnet");
    expect(message).toContain("testnet");
    expect(message).toContain("testnet credential can never be proven on mainnet");
  });

  it("rejects a same-network credential from a different contract set", () => {
    const message = deploymentMismatchMessage(
      ref({ contracts: { proofRegistry: "COTHERDEPLOYMENTCONTRACTID000000000000000000000" } }),
      CURRENT,
    );
    expect(message).toContain("different StellarCred deployment");
    expect(message).toContain("proof registry");
    expect(message).toContain("not registered here");
  });

  it("names every contract that differs", () => {
    const message = deploymentMismatchMessage(
      ref({
        contracts: {
          issuerRegistry: "CISSUEROFANOTHERDEPLOYMENT0000000000000000000000000000",
          proofRegistry: "CPROOOFOFANOTHERDEPLOYMENT00000000000000000000000000000",
        },
      }),
      CURRENT,
    );
    expect(message).toContain("issuer registry");
    expect(message).toContain("proof registry");
  });

  it("compares only fields configured on both sides", () => {
    const partialCurrent = {
      network: "testnet" as const,
      networkPassphrase: TESTNET_PASSPHRASE,
      contracts: {
        ...CURRENT_CONTRACTS,
        gatedPool: "", // this deployment didn't configure the pool
      },
    };
    expect(
      deploymentMismatchMessage(
        ref({ contracts: { gatedPool: "CSOMEOTHERPOOL00000000000000000000000000000000000" } }),
        partialCurrent,
      ),
    ).toBeNull();
  });
});

describe("parseCredential cross-deployment guard (#545)", () => {
  it("accepts a credential with no deployment reference (legacy)", () => {
    expect(() => parseCredential(credentialJson())).not.toThrow();
  });

  it("accepts a credential minted by this deployment", () => {
    expect(() => parseCredential(credentialJson(ref({})))).not.toThrow();
    expect(parseCredential(credentialJson(ref({}))).deployment).toEqual(CURRENT);
  });

  it("rejects a cross-network credential at import with a clear message", () => {
    expect(() =>
      parseCredential(
        credentialJson(ref({ network: "mainnet", networkPassphrase: MAINNET_PASSPHRASE })),
      ),
    ).toThrow(/belongs to another deployment/);
  });

  it("rejects a same-network, different-contracts credential at import", () => {
    expect(() =>
      parseCredential(
        credentialJson(
          ref({ contracts: { issuerRegistry: "COTHERISSUERREGISTRY00000000000000000000000000" } }),
        ),
      ),
    ).toThrow(/different StellarCred deployment/);
  });
});

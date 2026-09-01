import { describe, expect, it, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: unknown, result: { stdout: string; stderr: string }) => void;
    execFileMock(...args.slice(0, -1)).then(
      (result: { stdout: string; stderr: string }) => cb(null, result),
      (err: unknown) => cb(err, { stdout: "", stderr: "" }),
    );
  },
}));

import { invokeContract, StellarCliNotFoundError, StellarCliError } from "./stellarCli";

beforeEach(() => {
  execFileMock.mockReset();
});

describe("invokeContract", () => {
  it("builds the expected `stellar contract invoke` argv for a write call", async () => {
    execFileMock.mockResolvedValue({ stdout: "ok\n", stderr: "" });
    const result = await invokeContract({
      contractId: "CISSUER",
      source: "deployer",
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      send: true,
      functionArgs: ["register_issuer", "--issuer_id", "GADMIN", "--pubkey", "aabb", "--credential_types", '["kyc"]'],
    });

    expect(result).toBe("ok");
    expect(execFileMock).toHaveBeenCalledWith("stellar", [
      "contract",
      "invoke",
      "--id",
      "CISSUER",
      "--source",
      "deployer",
      "--rpc-url",
      "https://soroban-testnet.stellar.org",
      "--network-passphrase",
      "Test SDF Network ; September 2015",
      "--send",
      "yes",
      "--",
      "register_issuer",
      "--issuer_id",
      "GADMIN",
      "--pubkey",
      "aabb",
      "--credential_types",
      '["kyc"]',
    ]);
  });

  it("falls back to --network when no explicit passphrase/rpc-url is given, and omits --send for reads", async () => {
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    await invokeContract({
      contractId: "CISSUER",
      source: "deployer",
      network: "testnet",
      functionArgs: ["get_issuer_pubkey", "--issuer_id", "GADMIN"],
    });

    expect(execFileMock).toHaveBeenCalledWith("stellar", [
      "contract",
      "invoke",
      "--id",
      "CISSUER",
      "--source",
      "deployer",
      "--network",
      "testnet",
      "--",
      "get_issuer_pubkey",
      "--issuer_id",
      "GADMIN",
    ]);
  });

  it("throws StellarCliNotFoundError when the binary is missing", async () => {
    const enoent = Object.assign(new Error("not found"), { code: "ENOENT" });
    execFileMock.mockRejectedValue(enoent);
    await expect(
      invokeContract({ contractId: "C", source: "deployer", network: "testnet", functionArgs: ["x"] }),
    ).rejects.toBeInstanceOf(StellarCliNotFoundError);
  });

  it("wraps a non-zero exit in StellarCliError with stderr attached", async () => {
    const failure = Object.assign(new Error("Command failed"), { stderr: "contract not found" });
    execFileMock.mockRejectedValue(failure);
    await expect(
      invokeContract({ contractId: "C", source: "deployer", network: "testnet", functionArgs: ["x"] }),
    ).rejects.toMatchObject({ stderr: "contract not found" });
  });
});

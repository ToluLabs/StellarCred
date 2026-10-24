import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake Soroban RPC: answers each IssuerRegistry method from `chain`, encoding
// return values with the real stellar-sdk so decoding is exercised for real.
const chain = vi.hoisted(() => ({
  calls: [] as string[],
  answers: new Map<string, (args: unknown[]) => unknown>(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class Server {
    constructor(public url: string) {}
    async simulateTransaction(tx: InstanceType<typeof actual.Transaction>) {
      const op = tx.operations[0] as unknown as {
        func: { invokeContract(): { functionName(): Buffer; args(): unknown[] } };
      };
      const invoke = op.func.invokeContract();
      const method = invoke.functionName().toString();
      const args = invoke.args().map((a) => actual.scValToNative(a as never));
      chain.calls.push(method);
      const answer = chain.answers.get(method);
      if (!answer) return { error: `HostError: Error(WasmVm, MissingValue) ${method}`, events: [] };
      const value = answer(args);
      if (value instanceof Error) return { error: value.message, events: [] };
      return { result: { retval: value }, events: [] };
    }
  }
  return { ...actual, rpc: { ...actual.rpc, Server } };
});

import * as Stellar from "@stellar/stellar-sdk";
import { configure, resetConfig, ConfigError } from "./claims";
import {
  getIssuer,
  isValidIssuer,
  listIssuerIds,
  listIssuers,
  resetIssuerClientForTesting,
} from "./issuers";
import * as fromIndex from "./index";

const { nativeToScVal, xdr } = Stellar;
const ISSUER_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const ISSUER_B = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const PUBKEY = new Uint8Array(64).map((_, i) => i);

const issuerVal = (types: string[], revoked: boolean) =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("credential_types", { type: "symbol" }),
      val: nativeToScVal(types.map((t) => nativeToScVal(t, { type: "symbol" }))),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("pubkey", { type: "symbol" }),
      val: xdr.ScVal.scvBytes(Buffer.from(PUBKEY)),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("revoked", { type: "symbol" }),
      val: nativeToScVal(revoked),
    }),
  ]);

const addressList = (ids: string[]) =>
  xdr.ScVal.scvVec(ids.map((id) => new Stellar.Address(id).toScVal()));

beforeEach(() => {
  chain.calls.length = 0;
  chain.answers.clear();
  resetConfig();
  resetIssuerClientForTesting();
  configure({
    issuerRegistryId: "CDYPCHIFRXAAJFUA7MBH4FAWYLNG7XMAH7QRGVF437V2PGDBXZ2VK2DZ",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    retries: 0,
  });
  chain.answers.set("issuer_count", () => nativeToScVal(2, { type: "u32" }));
  chain.answers.set("get_issuers_page", () => addressList([ISSUER_A, ISSUER_B]));
  chain.answers.set("get_issuer", ([id]) =>
    id === ISSUER_A
      ? issuerVal(["kyc", "age"], false)
      : id === ISSUER_B
        ? issuerVal(["kyc"], true)
        : new Error("HostError: Error(Contract, #2)"),
  );
  chain.answers.set("get_issuer_metadata", ([id]) =>
    id === ISSUER_A
      ? xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: nativeToScVal("logo", { type: "symbol" }),
            val: xdr.ScVal.scvVoid(),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("name", { type: "symbol" }),
            val: nativeToScVal("Acme KYC"),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("url", { type: "symbol" }),
            val: nativeToScVal("https://acme.example"),
          }),
        ])
      : xdr.ScVal.scvVoid(),
  );
  chain.answers.set("is_valid_issuer", ([id, type]) =>
    nativeToScVal(id === ISSUER_A && type === "kyc"),
  );
});

afterEach(() => resetConfig());

describe("IssuerRegistry reads", () => {
  it("lists active issuers with records and metadata, paging through the registry", async () => {
    const issuers = await listIssuers({ throwOnError: true });
    expect(issuers).toEqual([
      {
        id: ISSUER_A,
        revoked: false,
        credentialTypes: ["kyc", "age"],
        pubkeyHex: Buffer.from(PUBKEY).toString("hex"),
        metadata: { name: "Acme KYC", url: "https://acme.example" },
      },
    ]);
    expect(chain.calls).toContain("get_issuers_page");
  });

  it("includes revoked issuers on request", async () => {
    const issuers = await listIssuers({ includeRevoked: true, withMetadata: false });
    expect(issuers.map((i) => [i.id, i.revoked])).toEqual([
      [ISSUER_A, false],
      [ISSUER_B, true],
    ]);
    expect(chain.calls).not.toContain("get_issuer_metadata");
  });

  it("falls back to get_issuers on registries without paging", async () => {
    chain.answers.delete("issuer_count");
    chain.answers.set("get_issuers", () => addressList([ISSUER_B]));
    expect(await listIssuerIds()).toEqual([ISSUER_B]);
  });

  it("returns null for an unregistered issuer", async () => {
    expect(await getIssuer("GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ")).toBeNull();
  });

  it("checks is_valid_issuer per credential type", async () => {
    expect(await isValidIssuer(ISSUER_A, "kyc")).toBe(true);
    expect(await isValidIssuer(ISSUER_A, "income")).toBe(false);
  });

  it("fails soft without an issuerRegistryId, and throws on request", async () => {
    configure({ issuerRegistryId: "" });
    expect(await listIssuers()).toEqual([]);
    await expect(listIssuers({ throwOnError: true })).rejects.toBeInstanceOf(ConfigError);
    expect(chain.calls).toEqual([]);
  });

  it("rejects malformed issuer addresses", async () => {
    await expect(getIssuer("not-an-address")).rejects.toThrow(/Invalid issuer address/);
  });

  it("is exported from the package entry point", () => {
    expect(fromIndex.listIssuers).toBe(listIssuers);
    expect(fromIndex.default.getIssuer).toBe(getIssuer);
    expect(fromIndex.StellarCred.isValidIssuer).toBe(isValidIssuer);
  });
});

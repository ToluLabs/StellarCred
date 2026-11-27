import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as Stellar from "@stellar/stellar-sdk";
import { build } from "esbuild";
import { defaultDeps, EXIT, run, type Deps } from "../src/commands";
import { resolveConfig } from "../src/config";
import { registerIssuer, SECRET_ENV, type RegisterRpc } from "../src/register";

const exec = promisify(execFile);
const pkgDir = fileURLToPath(new URL("..", import.meta.url));

const WALLET = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const ISSUER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const PUBKEY = "ab".repeat(64);

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    configure: vi.fn(),
    checkClaimStatus: vi.fn(async () => ({
      valid: true,
      status: "verified" as const,
      record: {
        verifiedAt: 1_700_000_000,
        expiry: 1_900_000_000,
        revoked: false,
        issuer: ISSUER,
        threshold: 21,
        vkVersion: 1,
      },
    })),
    listIssuers: vi.fn(async () => [
      {
        id: ISSUER,
        revoked: false,
        credentialTypes: ["kyc", "age"],
        pubkeyHex: PUBKEY,
        metadata: { name: "Acme KYC" },
      },
    ]),
    getIssuer: vi.fn(async () => ({
      id: ISSUER,
      revoked: false,
      credentialTypes: ["kyc", "age"],
      pubkeyHex: PUBKEY,
    })),
    isValidIssuer: vi.fn(async (_id: string, type: string) => type === "kyc"),
    buildVerifyUrl: defaultDeps.buildVerifyUrl,
    registerIssuer: vi.fn(async () => ({
      network: "testnet",
      issuerRegistryId: "CREG",
      source: ISSUER,
      xdr: "AAAA-unsigned",
      signed: false,
    })),
    ...overrides,
  };
}

describe("configuration", () => {
  it("defaults to testnet with the DEPLOYMENTS.md contract ids", () => {
    const c = resolveConfig({}, {});
    expect(c.network).toBe("testnet");
    expect(c.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(c.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(c.registryId).toBe("CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV");
    expect(c.issuerRegistryId).toBe("CDYPCHIFRXAAJFUA7MBH4FAWYLNG7XMAH7QRGVF437V2PGDBXZ2VK2DZ");
  });

  it("reads the SDK's environment variables, and flags win", () => {
    const env = {
      STELLARCRED_NETWORK: "mainnet",
      STELLARCRED_REGISTRY_ID: "CENV",
      PROOF_REGISTRY_ID: "CIGNORED",
    };
    expect(resolveConfig({}, env)).toMatchObject({
      network: "mainnet",
      registryId: "CENV",
      issuerRegistryId: "",
    });
    expect(resolveConfig({ "registry-id": "CFLAG", network: "testnet" }, env)).toMatchObject({
      network: "testnet",
      registryId: "CFLAG",
    });
    expect(resolveConfig({}, { PROOF_REGISTRY_ID: "CSERVER" }).registryId).toBe("CSERVER");
  });

  it("rejects unknown networks", () => {
    expect(() => resolveConfig({ network: "devnet" }, {})).toThrow(/Unknown network/);
  });
});

describe("commands (SDK calls stubbed)", () => {
  it("check: reports a verified credential and exits 0", async () => {
    const deps = fakeDeps();
    const t = io();
    expect(await run(["check", WALLET, "age", "--min", "18"], {}, t.io, deps)).toBe(EXIT.ok);
    expect(deps.checkClaimStatus).toHaveBeenCalledWith(
      WALLET,
      "age",
      expect.objectContaining({ minThreshold: 18, throwOnError: true }),
    );
    expect(deps.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        registryId: "CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV",
      }),
    );
    expect(t.out.join("\n")).toMatch(/✔ .* age: verified/);
  });

  it("check: exits 1 for an unverified wallet, with JSON on request", async () => {
    const deps = fakeDeps({
      checkClaimStatus: vi.fn(async () => ({
        valid: false,
        status: "expired" as const,
        record: null,
        error: "expired",
      })),
    });
    const t = io();
    expect(await run(["check", WALLET, "kyc", "--json"], {}, t.io, deps)).toBe(EXIT.negative);
    expect(JSON.parse(t.out[0])).toMatchObject({
      wallet: WALLET,
      claim: "kyc",
      valid: false,
      status: "expired",
    });
  });

  it("check: refuses unknown claim types", async () => {
    const t = io();
    expect(await run(["check", WALLET, "passport"], {}, t.io, fakeDeps())).toBe(EXIT.usage);
    expect(t.err[0]).toMatch(/Unknown claim "passport"/);
  });

  it("issuers: lists registered issuers", async () => {
    const deps = fakeDeps();
    const t = io();
    expect(await run(["issuers", "--all"], {}, t.io, deps)).toBe(EXIT.ok);
    expect(deps.listIssuers).toHaveBeenCalledWith({ includeRevoked: true, throwOnError: true });
    expect(t.out[0]).toContain(`${ISSUER}  Acme KYC`);
  });

  it("verify-url: builds the link with the SDK", async () => {
    const t = io();
    const code = await run(
      [
        "verify-url",
        "--return-url",
        "https://app.example/done",
        "--claim",
        "kyc",
        "--wallet",
        WALLET,
        "--base-url",
        "https://cred.example",
      ],
      {},
      t.io,
      fakeDeps(),
    );
    expect(code).toBe(EXIT.ok);
    const url = new URL(t.out[0]);
    expect(url.origin + url.pathname).toBe("https://cred.example/verify");
    expect(url.searchParams.get("return_url")).toBe("https://app.example/done");
    expect(url.searchParams.get("claim")).toBe("kyc");
    expect(url.searchParams.get("wallet")).toBe(WALLET);
  });

  it("verify-url: requires an absolute return URL and a claim", async () => {
    expect(
      await run(
        ["verify-url", "--return-url", "/relative", "--claim", "kyc"],
        {},
        io().io,
        fakeDeps(),
      ),
    ).toBe(EXIT.usage);
    expect(
      await run(["verify-url", "--return-url", "https://a.example"], {}, io().io, fakeDeps()),
    ).toBe(EXIT.usage);
  });

  it("issuer status: shows the record and validity per type", async () => {
    const t = io();
    expect(await run(["issuer", "status", ISSUER], {}, t.io, fakeDeps())).toBe(EXIT.ok);
    expect(t.out[0]).toMatch(/status: {2}registered/);
    expect(t.out[0]).toMatch(/valid for kyc: yes/);
    expect(t.out[0]).toMatch(/valid for age: no/);
  });

  it("issuer status: exits 1 for an unregistered issuer", async () => {
    const t = io();
    const deps = fakeDeps({ getIssuer: vi.fn(async () => null) });
    expect(await run(["issuer", "status", ISSUER], {}, t.io, deps)).toBe(EXIT.negative);
    expect(t.out[0]).toMatch(/is not registered/);
  });

  it("issuer register: prints the unsigned transaction", async () => {
    const deps = fakeDeps();
    const t = io();
    const code = await run(
      ["issuer", "register", ISSUER, "--pubkey", PUBKEY, "--types", "kyc, age", "--source", ISSUER],
      {},
      t.io,
      deps,
    );
    expect(code).toBe(EXIT.ok);
    expect(deps.registerIssuer).toHaveBeenCalledWith(
      {
        issuerId: ISSUER,
        pubkeyHex: PUBKEY,
        credentialTypes: ["kyc", "age"],
        source: ISSUER,
        send: false,
      },
      expect.objectContaining({ network: "testnet" }),
      {},
    );
    expect(t.out[0]).toMatch(/simulated, not signed/);
    expect(t.out[0]).toContain("AAAA-unsigned");
  });

  it("refuses secret keys on the command line", async () => {
    const t = io();
    const secret = Stellar.Keypair.random().secret();
    expect(
      await run(["issuer", "register", ISSUER, `--source=${secret}`], {}, t.io, fakeDeps()),
    ).toBe(EXIT.usage);
    expect(t.err[0]).toMatch(/Refusing to read a secret key from the command line/);
  });

  it("refuses to send on mainnet without --allow-mainnet", async () => {
    const t = io();
    const deps = fakeDeps();
    const args = [
      "issuer",
      "register",
      ISSUER,
      "--pubkey",
      PUBKEY,
      "--types",
      "kyc",
      "--send",
      "--network",
      "mainnet",
    ];
    expect(await run(args, {}, t.io, deps)).toBe(EXIT.usage);
    expect(deps.registerIssuer).not.toHaveBeenCalled();
  });

  it("prints help and version", async () => {
    const t = io();
    expect(await run(["--help"], {}, t.io, fakeDeps())).toBe(EXIT.ok);
    expect(t.out[0]).toMatch(/stellarcred check <wallet> <claim>/);
    expect(await run([], {}, io().io, fakeDeps())).toBe(EXIT.usage);
  });
});

describe("issuer register against a simulated RPC", () => {
  const admin = Stellar.Keypair.random();
  let sent: unknown[];
  let rpc: RegisterRpc;
  const config = resolveConfig(
    { "issuer-registry-id": "CDYPCHIFRXAAJFUA7MBH4FAWYLNG7XMAH7QRGVF437V2PGDBXZ2VK2DZ" },
    {},
  );

  beforeEach(() => {
    sent = [];
    rpc = {
      getAccount: vi.fn(async (id: string) => new Stellar.Account(id, "100")),
      // Stands in for simulation: the real one adds footprint and resource fee.
      prepareTransaction: vi.fn(async (tx) => tx as never),
      sendTransaction: vi.fn(async (tx) => {
        sent.push(tx);
        return { status: "PENDING", hash: "abc123" };
      }),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS" })),
    };
  });

  const input = { issuerId: ISSUER, pubkeyHex: PUBKEY, credentialTypes: ["kyc", "age"] };

  it("builds an unsigned register_issuer call with the right arguments", async () => {
    const result = await registerIssuer(
      { ...input, source: admin.publicKey(), send: false },
      config,
      {},
      { rpc },
    );
    expect(result.signed).toBe(false);
    expect(sent).toEqual([]);
    const tx = Stellar.TransactionBuilder.fromXDR(
      result.xdr,
      config.networkPassphrase,
    ) as Stellar.Transaction;
    expect(tx.signatures).toHaveLength(0);
    expect(tx.source).toBe(admin.publicKey());
    const invoke = (
      tx.operations[0] as unknown as { func: Stellar.xdr.HostFunction }
    ).func.invokeContract();
    expect(invoke.functionName().toString()).toBe("register_issuer");
    const [issuer, pubkey, types] = invoke.args().map((a) => Stellar.scValToNative(a));
    expect(issuer).toBe(ISSUER);
    expect(Buffer.from(pubkey as Uint8Array).toString("hex")).toBe(PUBKEY);
    expect(types).toEqual(["kyc", "age"]);
  });

  it("signs with the environment key and submits only with --send", async () => {
    const env = { [SECRET_ENV]: admin.secret() };
    const result = await registerIssuer({ ...input, send: true }, config, env, {
      rpc,
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({
      signed: true,
      hash: "abc123",
      status: "SUCCESS",
      source: admin.publicKey(),
    });
    expect(sent).toHaveLength(1);
    const tx = Stellar.TransactionBuilder.fromXDR(
      result.xdr,
      config.networkPassphrase,
    ) as Stellar.Transaction;
    expect(tx.signatures).toHaveLength(1);
  });

  it("refuses --send without the environment key, or with a key in NEXT_PUBLIC_*", async () => {
    await expect(registerIssuer({ ...input, send: true }, config, {}, { rpc })).rejects.toThrow(
      new RegExp(SECRET_ENV),
    );
    await expect(
      registerIssuer(
        { ...input, send: true },
        config,
        { [SECRET_ENV]: admin.secret(), NEXT_PUBLIC_ADMIN: admin.secret() },
        { rpc },
      ),
    ).rejects.toThrow(/NEXT_PUBLIC_ADMIN holds a Stellar secret key/);
    expect(sent).toEqual([]);
  });

  it("validates the public key and credential types before touching the network", async () => {
    await expect(
      registerIssuer(
        { ...input, pubkeyHex: "abcd", source: admin.publicKey(), send: false },
        config,
        {},
        { rpc },
      ),
    ).rejects.toThrow(/128 hex/);
    await expect(
      registerIssuer(
        { ...input, credentialTypes: ["k y c"], source: admin.publicKey(), send: false },
        config,
        {},
        { rpc },
      ),
    ).rejects.toThrow(/Invalid credential type/);
    expect(rpc.getAccount).not.toHaveBeenCalled();
  });
});

describe("packaged binary", () => {
  let bin: string;

  beforeAll(async () => {
    // Inside the package so @stellar/stellar-sdk resolves the way it does once installed.
    bin = join(pkgDir, ".test-dist", "cli.mjs");
    // The same bundle `npm run build` produces (SDK inlined, stellar-sdk external).
    await build({
      entryPoints: [join(pkgDir, "src/cli.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      outfile: bin,
      external: ["@stellar/stellar-sdk"],
      alias: { "@stellarcred/sdk": join(pkgDir, "../sdk/src/index.ts") },
      banner: { js: "#!/usr/bin/env node" },
      logLevel: "silent",
    });
  });

  // Three sequential node spawns: comfortably over vitest's 5s default on
  // Windows and cold runners (one spawn measures ~2s there, ~0.25s in CI).
  it("runs as a Node executable: --version, --help, verify-url", async () => {
    const { stdout: version } = await exec(process.execPath, [bin, "--version"], { cwd: pkgDir });
    expect(version.trim()).toBe("0.1.0");
    const { stdout: help } = await exec(process.execPath, [bin, "--help"], { cwd: pkgDir });
    expect(help).toMatch(/stellarcred issuer register/);
    const { stdout: url } = await exec(
      process.execPath,
      [bin, "verify-url", "--return-url", "https://app.example/x", "--claim", "kyc"],
      { cwd: pkgDir },
    );
    expect(url.trim()).toBe(
      "https://stellarcred.xyz/verify?return_url=https%3A%2F%2Fapp.example%2Fx&claim=kyc",
    );
  });

  it("exits 2 on usage errors", async () => {
    await expect(exec(process.execPath, [bin, "bogus"], { cwd: pkgDir })).rejects.toMatchObject({
      code: 2,
    });
  });
});

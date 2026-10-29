import { parseArgs } from "node:util";

import * as sdk from "@stellarcred/sdk";
import { resolveConfig, type CliConfig, type Env, type Flags } from "./config";
import {
  assertNoSecretsInArgs,
  registerIssuer,
  SECRET_ENV,
  UsageError,
  type RegisterResult,
} from "./register";

export const VERSION = "0.1.0";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** Everything the commands touch outside the process — replaced in tests. */
export interface Deps {
  configure: typeof sdk.configure;
  checkClaimStatus: typeof sdk.checkClaimStatus;
  listIssuers: typeof sdk.listIssuers;
  getIssuer: typeof sdk.getIssuer;
  isValidIssuer: typeof sdk.isValidIssuer;
  buildVerifyUrl: typeof sdk.buildVerifyUrl;
  registerIssuer: typeof registerIssuer;
}

export const defaultDeps: Deps = {
  configure: sdk.configure,
  checkClaimStatus: sdk.checkClaimStatus,
  listIssuers: sdk.listIssuers,
  getIssuer: sdk.getIssuer,
  isValidIssuer: sdk.isValidIssuer,
  buildVerifyUrl: sdk.buildVerifyUrl,
  registerIssuer,
};

/** Exit codes: scripts can branch on "not verified" without parsing output. */
export const EXIT = { ok: 0, negative: 1, usage: 2, error: 3 } as const;

export const HELP = `stellarcred ${VERSION} — StellarCred from the command line

Usage:
  stellarcred check <wallet> <claim> [--min <n>] [--issuer <G…>]…
      Read a wallet's credential from ProofRegistry on-chain.
      Exit 0 when valid, 1 when not (expired, revoked, missing, below --min).
  stellarcred issuers [--all]
      List issuers registered in IssuerRegistry (--all includes revoked).
  stellarcred verify-url --return-url <url> (--claim <type> | --claims <a,b>)
                        [--wallet <G…>] [--state <s>] [--expires <minutes>] [--single-use]
      Build a StellarCred verify link that returns the user to <url>.
  stellarcred issuer status <issuer> [--type <claim>]…
      Show an issuer's on-chain record and whether it is valid per credential type.
      Exit 0 when registered and not revoked, 1 otherwise.
  stellarcred issuer register <issuer> --pubkey <128 hex> --types <a,b> (--source <G…> | --send)
      Build the admin-only register_issuer transaction. Without --send it is
      simulated and printed unsigned (sign it elsewhere). With --send it is
      signed with ${SECRET_ENV} from the environment and submitted.

Options:
  --network <testnet|mainnet|futurenet>   default: STELLARCRED_NETWORK or testnet
  --rpc-url <url>                          default: STELLARCRED_RPC_URL or the network's RPC
  --registry-id <C…>                       ProofRegistry (STELLARCRED_REGISTRY_ID, PROOF_REGISTRY_ID)
  --issuer-registry-id <C…>                IssuerRegistry (STELLARCRED_ISSUER_REGISTRY_ID)
  --base-url <url>                         verify-url host (STELLARCRED_BASE_URL)
  --allow-mainnet                          required for issuer register --send on mainnet
  --json                                   machine-readable output
  -h, --help / -v, --version

Claim types: ${sdk.CLAIM_TYPES.join(", ")}
Testnet contract ids default to the ones in DEPLOYMENTS.md.`;

const OPTIONS = {
  network: { type: "string" },
  "rpc-url": { type: "string" },
  "registry-id": { type: "string" },
  "issuer-registry-id": { type: "string" },
  "base-url": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  // check
  min: { type: "string" },
  issuer: { type: "string", multiple: true },
  // issuers
  all: { type: "boolean" },
  // verify-url
  "return-url": { type: "string" },
  claim: { type: "string" },
  claims: { type: "string" },
  wallet: { type: "string" },
  state: { type: "string" },
  expires: { type: "string" },
  "single-use": { type: "boolean" },
  // issuer status / register
  type: { type: "string", multiple: true },
  pubkey: { type: "string" },
  types: { type: "string" },
  source: { type: "string" },
  send: { type: "boolean" },
  "allow-mainnet": { type: "boolean" },
} as const;

function claimType(value: string | undefined, what = "claim"): sdk.ClaimType {
  if (!value)
    throw new UsageError(`Missing ${what}. Expected one of: ${sdk.CLAIM_TYPES.join(", ")}.`);
  if (!sdk.isValidClaimType(value)) {
    throw new UsageError(
      `Unknown ${what} "${value}". Expected one of: ${sdk.CLAIM_TYPES.join(", ")}.`,
    );
  }
  return value;
}

function positiveNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a non-negative number.`);
  return n;
}

const fmtTime = (seconds: number | undefined) =>
  seconds ? new Date(seconds * 1000).toISOString() : "—";

function configureSdk(deps: Deps, config: CliConfig): void {
  deps.configure({
    registryId: config.registryId,
    issuerRegistryId: config.issuerRegistryId,
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    baseUrl: config.baseUrl,
  });
}

export async function run(
  argv: string[],
  env: Env,
  io: Io,
  deps: Deps = defaultDeps,
): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: typeof OPTIONS;
      allowPositionals: true;
      strict: true;
      args: string[];
    }>
  >;
  try {
    assertNoSecretsInArgs(argv);
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    io.err(`stellarcred: ${(err as Error).message}\nRun "stellarcred --help" for usage.`);
    return EXIT.usage;
  }
  const flags = parsed.values as Flags;
  const [command, ...rest] = parsed.positionals;
  const json = Boolean(flags.json);
  const print = (human: string, data: unknown) =>
    io.out(json ? JSON.stringify(data, null, 2) : human);

  if (flags.version) {
    io.out(VERSION);
    return EXIT.ok;
  }
  if (flags.help || !command) {
    io.out(HELP);
    return command || flags.help ? EXIT.ok : EXIT.usage;
  }

  try {
    const config = resolveConfig(flags, env);

    switch (command) {
      case "check": {
        const [wallet, rawClaim] = rest;
        if (!wallet) throw new UsageError("Usage: stellarcred check <wallet> <claim> [--min <n>]");
        const claim = claimType(rawClaim);
        if (!config.registryId) {
          throw new UsageError(
            "No ProofRegistry id for this network: pass --registry-id or set STELLARCRED_REGISTRY_ID.",
          );
        }
        configureSdk(deps, config);
        const minThreshold = positiveNumber(flags.min as string | undefined, "--min");
        const trustedIssuers = (flags.issuer as string[] | undefined) ?? undefined;
        const result = await deps.checkClaimStatus(wallet, claim, {
          minThreshold,
          trustedIssuers,
          throwOnError: true,
        });
        const record = result.record;
        print(
          [
            `${result.valid ? "✔" : "✘"} ${wallet} ${claim}: ${result.status}`,
            ...(record
              ? [
                  `  verified at: ${fmtTime(record.verifiedAt)}`,
                  `  expires:     ${fmtTime(record.expiry)}`,
                  ...(record.issuer ? [`  issuer:      ${record.issuer}`] : []),
                  ...(record.threshold !== undefined ? [`  threshold:   ${record.threshold}`] : []),
                ]
              : []),
            ...(result.error && !result.valid ? [`  ${result.error}`] : []),
          ].join("\n"),
          { wallet, claim, network: config.network, ...result },
        );
        return result.valid ? EXIT.ok : EXIT.negative;
      }

      case "issuers": {
        if (!config.issuerRegistryId) {
          throw new UsageError(
            "No IssuerRegistry id for this network: pass --issuer-registry-id or set STELLARCRED_ISSUER_REGISTRY_ID.",
          );
        }
        configureSdk(deps, config);
        const issuers = await deps.listIssuers({
          includeRevoked: Boolean(flags.all),
          throwOnError: true,
        });
        print(
          issuers.length === 0
            ? "No registered issuers."
            : issuers
                .map(
                  (i) =>
                    `${i.id}${i.metadata?.name ? `  ${i.metadata.name}` : ""}${i.revoked ? "  [revoked]" : ""}\n  types: ${i.credentialTypes.join(", ") || "—"}`,
                )
                .join("\n"),
          { network: config.network, issuerRegistryId: config.issuerRegistryId, issuers },
        );
        return EXIT.ok;
      }

      case "verify-url": {
        const returnUrl = flags["return-url"] as string | undefined;
        if (!returnUrl) throw new UsageError("verify-url needs --return-url <url>.");
        try {
          new URL(returnUrl);
        } catch {
          throw new UsageError(`--return-url "${returnUrl}" is not an absolute URL.`);
        }
        const claims = flags.claims
          ? String(flags.claims)
              .split(",")
              .map((c) => claimType(c.trim(), "claim in --claims"))
          : undefined;
        const claim = flags.claim ? claimType(String(flags.claim)) : undefined;
        if (!claim && !claims)
          throw new UsageError("verify-url needs --claim <type> or --claims <a,b>.");
        configureSdk(deps, config);
        const expires = positiveNumber(flags.expires as string | undefined, "--expires");
        const url = deps.buildVerifyUrl({
          returnUrl,
          claim,
          claims,
          wallet: flags.wallet as string | undefined,
          state: flags.state as string | undefined,
          expiresInMinutes: expires,
          singleUse: Boolean(flags["single-use"]),
          baseUrl: config.baseUrl,
        });
        print(url, { url });
        return EXIT.ok;
      }

      case "issuer": {
        const [sub, issuerId] = rest;
        if (sub === "status") {
          if (!issuerId)
            throw new UsageError("Usage: stellarcred issuer status <issuer> [--type <claim>]");
          if (!config.issuerRegistryId) {
            throw new UsageError(
              "No IssuerRegistry id for this network: pass --issuer-registry-id or set STELLARCRED_ISSUER_REGISTRY_ID.",
            );
          }
          configureSdk(deps, config);
          const record = await deps.getIssuer(issuerId, { throwOnError: true });
          const types = ((flags.type as string[] | undefined) ?? record?.credentialTypes ?? []).map(
            (t) => t.trim(),
          );
          const valid: Record<string, boolean> = {};
          for (const t of types)
            valid[t] = await deps.isValidIssuer(issuerId, t, { throwOnError: true });
          const active = Boolean(record && !record.revoked);
          print(
            record
              ? [
                  `${issuerId}${record.metadata?.name ? `  ${record.metadata.name}` : ""}`,
                  `  status:  ${record.revoked ? "revoked" : "registered"}`,
                  `  pubkey:  ${record.pubkeyHex}`,
                  `  types:   ${record.credentialTypes.join(", ") || "—"}`,
                  ...Object.entries(valid).map(
                    ([t, ok]) => `  valid for ${t}: ${ok ? "yes" : "no"}`,
                  ),
                  ...(record.metadata?.url ? [`  url:     ${record.metadata.url}`] : []),
                ].join("\n")
              : `${issuerId} is not registered in IssuerRegistry ${config.issuerRegistryId} (${config.network}).`,
            {
              network: config.network,
              issuerId,
              registered: Boolean(record),
              record,
              validFor: valid,
            },
          );
          return active ? EXIT.ok : EXIT.negative;
        }
        if (sub === "register") {
          if (!issuerId)
            throw new UsageError(
              "Usage: stellarcred issuer register <issuer> --pubkey <hex> --types <a,b> (--source <G…> | --send)",
            );
          const send = Boolean(flags.send);
          if (send && config.network === "mainnet" && !flags["allow-mainnet"]) {
            throw new UsageError("Refusing to send on mainnet without --allow-mainnet.");
          }
          const result: RegisterResult = await deps.registerIssuer(
            {
              issuerId,
              pubkeyHex: String(flags.pubkey ?? ""),
              credentialTypes: String(flags.types ?? "")
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
              source: flags.source as string | undefined,
              send,
            },
            config,
            env,
          );
          print(
            result.signed
              ? [
                  `Submitted register_issuer for ${issuerId} on ${result.network}.`,
                  `  hash:   ${result.hash}`,
                  `  status: ${result.status}`,
                ].join("\n")
              : [
                  `Built register_issuer for ${issuerId} on ${result.network} (simulated, not signed).`,
                  `  source: ${result.source}`,
                  "  Sign and submit it with the admin key, e.g. with the Stellar CLI:",
                  `    echo <xdr> | stellar tx sign --sign-with-key <admin> --network ${result.network} | stellar tx send --network ${result.network}`,
                  "",
                  result.xdr,
                ].join("\n"),
            result,
          );
          return result.signed && result.status !== "SUCCESS" && result.status !== "PENDING"
            ? EXIT.error
            : EXIT.ok;
        }
        throw new UsageError(
          `Unknown issuer command "${sub ?? ""}". Use "issuer status" or "issuer register".`,
        );
      }

      default:
        throw new UsageError(`Unknown command "${command}". Run "stellarcred --help".`);
    }
  } catch (err) {
    if (
      err instanceof UsageError ||
      err instanceof sdk.InvalidAddressError ||
      err instanceof sdk.InvalidIssuerError ||
      err instanceof sdk.InvalidClaimTypeError ||
      err instanceof sdk.ConfigError
    ) {
      io.err(`stellarcred: ${(err as Error).message}`);
      return EXIT.usage;
    }
    io.err(`stellarcred: ${(err as Error).message ?? String(err)}`);
    return EXIT.error;
  }
}

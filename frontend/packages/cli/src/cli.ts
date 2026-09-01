import { createRequire } from "node:module";
import { Command } from "commander";
import { loadConfig, type CliConfig } from "./config";
import { registerCheckCommand } from "./commands/check";
import { registerIssuersCommand } from "./commands/issuers";
import { registerVerifyUrlCommand } from "./commands/verifyUrl";
import { registerIssuerCommand } from "./commands/issuer";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("stellarcred")
  .description(
    "Command-line access to StellarCred — check claims, list issuers, build verify links, " +
      "and manage issuer registration against a configured Stellar network.",
  )
  .version(version)
  .option("--rpc-url <url>", "Soroban RPC endpoint (default: $STELLARCRED_RPC_URL or testnet)")
  .option("--network-passphrase <passphrase>", "Stellar network passphrase")
  .option("--network <name>", "network name passed to `stellar` for write commands, e.g. testnet, mainnet")
  .option("--base-url <url>", "StellarCred base URL used to build verify links")
  .option("--registry-id <id>", "ProofRegistry contract ID (for `check`)")
  .option("--issuer-registry-id <id>", "IssuerRegistry contract ID (for `issuers` / `issuer`)");

function getConfig(): CliConfig {
  const opts = program.opts<{
    rpcUrl?: string;
    networkPassphrase?: string;
    network?: string;
    baseUrl?: string;
    registryId?: string;
    issuerRegistryId?: string;
  }>();
  return loadConfig({
    rpcUrl: opts.rpcUrl,
    networkPassphrase: opts.networkPassphrase,
    network: opts.network,
    baseUrl: opts.baseUrl,
    proofRegistryId: opts.registryId,
    issuerRegistryId: opts.issuerRegistryId,
  });
}

registerCheckCommand(program, getConfig);
registerIssuersCommand(program, getConfig);
registerVerifyUrlCommand(program, getConfig);
registerIssuerCommand(program, getConfig);

program.parseAsync(process.argv);

import { Command } from "commander";
import type { CliConfig } from "../config";
import { fetchIssuers } from "../issuerRegistry";
import { printResult } from "../output";

export function registerIssuersCommand(program: Command, getConfig: () => CliConfig) {
  program
    .command("issuers")
    .description("List addresses registered in the IssuerRegistry")
    .option("--sim-account <address>", "funded account used to simulate the read (defaults to $STELLARCRED_SIM_ACCOUNT)")
    .option("--json", "print machine-readable JSON instead of text")
    .action(async (opts: { simAccount?: string; json?: boolean }) => {
      const cfg = getConfig();
      const simAccount = opts.simAccount || cfg.simAccount;

      if (!cfg.issuerRegistryId) {
        printResult(
          opts.json,
          { error: "STELLARCRED_ISSUER_REGISTRY_ID (or NEXT_PUBLIC_ISSUER_REGISTRY_ID / --issuer-registry-id) is not set." },
          "Missing configuration: set STELLARCRED_ISSUER_REGISTRY_ID (or pass --issuer-registry-id).",
        );
        process.exitCode = 2;
        return;
      }
      if (!simAccount) {
        printResult(
          opts.json,
          { error: "No simulation account. Set STELLARCRED_SIM_ACCOUNT / NEXT_PUBLIC_ISSUER_ADDRESS, or pass --sim-account." },
          "Missing configuration: pass --sim-account <G...> (any existing funded account — it isn't charged or signed with).",
        );
        process.exitCode = 2;
        return;
      }

      try {
        const issuers = await fetchIssuers({
          rpcUrl: cfg.rpcUrl,
          networkPassphrase: cfg.networkPassphrase,
          issuerRegistryId: cfg.issuerRegistryId,
          simAccount,
        });
        printResult(
          opts.json,
          { issuers },
          issuers.length ? issuers.join("\n") : "No issuers registered.",
        );
      } catch (err) {
        printResult(opts.json, { error: (err as Error).message }, `Error: ${(err as Error).message}`);
        process.exitCode = 2;
      }
    });
}

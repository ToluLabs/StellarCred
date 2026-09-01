import { Command } from "commander";
import { configure, getClaim, hasClaim, type ClaimType } from "@stellarcred/sdk";
import type { CliConfig } from "../config";
import { printResult } from "../output";

export function registerCheckCommand(program: Command, getConfig: () => CliConfig) {
  program
    .command("check <wallet> <claim>")
    .description("Check whether a wallet holds a valid, unexpired StellarCred claim")
    .option(
      "--min-threshold <n>",
      "minimum threshold for parameterised claims (age, income, funds, accreditation)",
      Number,
    )
    .option("--trusted-issuers <addresses>", "comma-separated issuer addresses to restrict the claim to")
    .option("--json", "print machine-readable JSON instead of text")
    .action(
      async (
        wallet: string,
        claim: string,
        opts: { minThreshold?: number; trustedIssuers?: string; json?: boolean },
      ) => {
        const cfg = getConfig();
        if (!cfg.proofRegistryId) {
          printResult(
            opts.json,
            { error: "STELLARCRED_REGISTRY_ID (or NEXT_PUBLIC_PROOF_REGISTRY_ID / --registry-id) is not set." },
            "Missing configuration: set STELLARCRED_REGISTRY_ID (or pass --registry-id).",
          );
          process.exitCode = 2;
          return;
        }

        configure({
          registryId: cfg.proofRegistryId,
          rpcUrl: cfg.rpcUrl,
          networkPassphrase: cfg.networkPassphrase,
        });

        const trustedIssuers = opts.trustedIssuers
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        try {
          if (opts.minThreshold !== undefined) {
            const verified = await hasClaim(wallet, claim as ClaimType, {
              minThreshold: opts.minThreshold,
              trustedIssuers,
              throwOnError: true,
            });
            printResult(
              opts.json,
              { verified, wallet, claim, minThreshold: opts.minThreshold },
              verified
                ? `✓ ${wallet} holds a "${claim}" claim meeting minThreshold=${opts.minThreshold}`
                : `✗ ${wallet} does not hold a "${claim}" claim meeting minThreshold=${opts.minThreshold}`,
            );
            process.exitCode = verified ? 0 : 1;
            return;
          }

          const result = await getClaim(wallet, claim as ClaimType, { trustedIssuers });
          if (result) {
            printResult(
              opts.json,
              { verified: true, wallet, claim, verifiedAt: result.verifiedAt, expiry: result.expiry },
              `✓ ${wallet} holds a valid "${claim}" claim (verified ${new Date(result.verifiedAt * 1000).toISOString()}, expires ${new Date(result.expiry * 1000).toISOString()})`,
            );
            process.exitCode = 0;
          } else {
            printResult(
              opts.json,
              { verified: false, wallet, claim },
              `✗ ${wallet} does not hold a valid "${claim}" claim`,
            );
            process.exitCode = 1;
          }
        } catch (err) {
          printResult(opts.json, { error: (err as Error).message }, `Error: ${(err as Error).message}`);
          process.exitCode = 2;
        }
      },
    );
}

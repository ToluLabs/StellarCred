import { Command } from "commander";
import { buildVerifyUrl } from "@stellarcred/sdk";
import type { CliConfig } from "../config";

export function registerVerifyUrlCommand(program: Command, getConfig: () => CliConfig) {
  program
    .command("verify-url")
    .description("Build a StellarCred verify link for a given claim and return URL")
    .requiredOption("--return-url <url>", "where StellarCred redirects the user back to after verifying")
    .requiredOption("--claim <type>", "claim type to request, e.g. kyc, age, funds")
    .option("--threshold-years <n>", "minimum age in years (for claim=age)")
    .option("--threshold <n>", "minimum value in whole units (for claim=income/funds/accreditation)")
    .option("--restricted <codes>", "comma-separated ISO 3166-1 numeric country codes (for claim=jurisdiction)")
    .option("--mode <allow|block>", "jurisdiction list mode (default: block)")
    .option("--state <token>", "opaque correlation token round-tripped back on the redirect")
    .option("--base-url <url>", "override the StellarCred base URL")
    .action(
      (opts: {
        returnUrl: string;
        claim: string;
        thresholdYears?: string;
        threshold?: string;
        restricted?: string;
        mode?: "allow" | "block";
        state?: string;
        baseUrl?: string;
      }) => {
        const cfg = getConfig();
        const url = buildVerifyUrl({
          returnUrl: opts.returnUrl,
          claim: opts.claim,
          baseUrl: opts.baseUrl || cfg.baseUrl,
          state: opts.state,
          claimParams: {
            threshold_years: opts.thresholdYears,
            threshold: opts.threshold,
            restricted: opts.restricted?.split(",").map((s) => s.trim()).filter(Boolean),
            mode: opts.mode,
          },
        });
        console.log(url);
      },
    );
}

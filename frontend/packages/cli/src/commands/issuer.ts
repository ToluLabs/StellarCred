import { Command } from "commander";
import type { CliConfig } from "../config";
import { fetchIssuerStatus } from "../issuerRegistry";
import { invokeContract, StellarCliNotFoundError, StellarCliError } from "../stellarCli";
import { printResult } from "../output";

export function registerIssuerCommand(program: Command, getConfig: () => CliConfig) {
  const issuer = program.command("issuer").description("Manage IssuerRegistry entries");

  issuer
    .command("register")
    .description("Register (or overwrite) a trusted issuer — admin-only, requires a signing identity")
    .requiredOption("--issuer-id <address>", "Stellar address of the issuer being registered")
    .requiredOption("--pubkey <hex>", "secp256k1 credential-signing public key, hex-encoded (x || y, 64 bytes)")
    .requiredOption("--credential-types <types>", "comma-separated claim types this issuer may attest, e.g. kyc,age")
    .requiredOption(
      "--source <identity>",
      "signing identity configured in the local `stellar` CLI keystore (see `stellar keys generate`) — must be the IssuerRegistry admin",
    )
    .option("--json", "print machine-readable JSON instead of text")
    .action(
      async (opts: {
        issuerId: string;
        pubkey: string;
        credentialTypes: string;
        source: string;
        json?: boolean;
      }) => {
        const cfg = getConfig();
        if (!cfg.issuerRegistryId) {
          printResult(
            opts.json,
            { error: "STELLARCRED_ISSUER_REGISTRY_ID is not set." },
            "Missing configuration: set STELLARCRED_ISSUER_REGISTRY_ID (or pass --issuer-registry-id).",
          );
          process.exitCode = 2;
          return;
        }

        const types = opts.credentialTypes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        try {
          await invokeContract({
            contractId: cfg.issuerRegistryId,
            source: opts.source,
            network: cfg.network,
            rpcUrl: cfg.rpcUrl,
            networkPassphrase: cfg.networkPassphrase,
            send: true,
            functionArgs: [
              "register_issuer",
              "--issuer_id",
              opts.issuerId,
              "--pubkey",
              opts.pubkey,
              "--credential_types",
              JSON.stringify(types),
            ],
          });
          printResult(
            opts.json,
            { registered: true, issuerId: opts.issuerId, credentialTypes: types },
            `✓ Registered ${opts.issuerId} for: ${types.join(", ")}`,
          );
        } catch (err) {
          reportStellarCliError(err, opts.json);
        }
      },
    );

  issuer
    .command("status <issuerId>")
    .description("Show an issuer's on-chain pubkey, metadata, and (optionally) validity for a claim type")
    .option("--credential-type <type>", "also check validity for this claim type, e.g. kyc")
    .option("--sim-account <address>", "funded account used to simulate the read (defaults to $STELLARCRED_SIM_ACCOUNT)")
    .option("--json", "print machine-readable JSON instead of text")
    .action(async (issuerId: string, opts: { credentialType?: string; simAccount?: string; json?: boolean }) => {
      const cfg = getConfig();
      const simAccount = opts.simAccount || cfg.simAccount;

      if (!cfg.issuerRegistryId) {
        printResult(
          opts.json,
          { error: "STELLARCRED_ISSUER_REGISTRY_ID is not set." },
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
        const status = await fetchIssuerStatus({
          rpcUrl: cfg.rpcUrl,
          networkPassphrase: cfg.networkPassphrase,
          issuerRegistryId: cfg.issuerRegistryId,
          simAccount,
          issuerId,
          credentialType: opts.credentialType,
        });

        if (!status.pubkeyHex && !status.metadata) {
          printResult(opts.json, status, `${issuerId} is not registered.`);
          process.exitCode = 1;
          return;
        }

        const lines = [
          `Issuer:   ${status.issuerId}`,
          `Pubkey:   ${status.pubkeyHex ?? "(none)"}`,
          `Metadata: ${status.metadata ? JSON.stringify(status.metadata) : "(none)"}`,
        ];
        if (status.validForType !== null) {
          lines.push(`Valid for "${opts.credentialType}": ${status.validForType ? "yes" : "no"}`);
        }
        printResult(opts.json, status, lines.join("\n"));
        process.exitCode = status.validForType === false ? 1 : 0;
      } catch (err) {
        printResult(opts.json, { error: (err as Error).message }, `Error: ${(err as Error).message}`);
        process.exitCode = 2;
      }
    });
}

function reportStellarCliError(err: unknown, json?: boolean): void {
  if (err instanceof StellarCliNotFoundError) {
    printResult(json, { error: err.message }, `Error: ${err.message}`);
  } else if (err instanceof StellarCliError) {
    printResult(json, { error: err.message, stderr: err.stderr }, `Error: ${err.message}\n${err.stderr}`);
  } else {
    printResult(json, { error: (err as Error).message }, `Error: ${(err as Error).message}`);
  }
  process.exitCode = 2;
}

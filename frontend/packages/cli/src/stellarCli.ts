// Shells out to the `stellar` CLI for the one operation this tool needs to
// sign and submit: registering an issuer. This is a deliberate choice, not a
// shortcut — signing stays entirely inside the `stellar` CLI's own local
// keystore (`stellar keys ...`), the same one `scripts/deploy.sh` uses. The
// StellarCred CLI never reads, generates, or handles a secret key itself.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class StellarCliNotFoundError extends Error {
  constructor() {
    super(
      "The `stellar` CLI was not found on PATH. Install it (https://developers.stellar.org/docs/tools/stellar-cli) " +
        "and configure a signing identity with `stellar keys generate --network testnet --fund <name>` before " +
        "running issuer-registry write commands.",
    );
    this.name = "StellarCliNotFoundError";
  }
}

export class StellarCliError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "StellarCliError";
  }
}

export interface InvokeContractOptions {
  contractId: string;
  source: string;
  network: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  /** Function name followed by its `--flag value` pairs, e.g. `["register_issuer", "--issuer_id", "G...", ...]`. */
  functionArgs: string[];
  /** Set for state-changing calls; omitted for read-only simulation. */
  send?: boolean;
}

/** Runs `stellar contract invoke ...`, returning trimmed stdout. */
export async function invokeContract(options: InvokeContractOptions): Promise<string> {
  const args = ["contract", "invoke", "--id", options.contractId, "--source", options.source];

  if (options.rpcUrl) {
    args.push("--rpc-url", options.rpcUrl);
  }
  if (options.networkPassphrase) {
    args.push("--network-passphrase", options.networkPassphrase);
  } else {
    args.push("--network", options.network);
  }
  if (options.send) {
    args.push("--send", "yes");
  }
  args.push("--", ...options.functionArgs);

  try {
    const { stdout } = await execFileAsync("stellar", args);
    return stdout.trim();
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException & { stderr?: string };
    if (nodeErr.code === "ENOENT") {
      throw new StellarCliNotFoundError();
    }
    throw new StellarCliError(
      `stellar contract invoke failed: ${nodeErr.message}`,
      nodeErr.stderr ?? "",
    );
  }
}

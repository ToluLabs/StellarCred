/**
 * config.ts — Load and validate all environment configuration.
 * Every other module imports from here; never from process.env directly.
 */

export type DbDriver = "sqlite" | "postgres";

export interface Config {
  stellarNetwork: string;
  horizonUrl: string;
  rpcUrl: string;
  proofRegistryContractId: string;
  dbDriver: DbDriver;
  sqlitePath: string;
  databaseUrl: string | undefined;
  pollIntervalMs: number;
  startLedger: number;
  port: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  const driver = optional("DB_DRIVER", "sqlite") as DbDriver;
  if (driver !== "sqlite" && driver !== "postgres") {
    throw new Error(`DB_DRIVER must be "sqlite" or "postgres", got: ${driver}`);
  }

  return {
    stellarNetwork: optional("STELLAR_NETWORK", "testnet"),
    horizonUrl: optional(
      "HORIZON_URL",
      "https://horizon-testnet.stellar.org"
    ),
    rpcUrl: optional("RPC_URL", "https://soroban-testnet.stellar.org"),
    proofRegistryContractId: required("PROOF_REGISTRY_CONTRACT_ID"),
    dbDriver: driver,
    sqlitePath: optional("SQLITE_PATH", "./data/indexer.db"),
    databaseUrl: process.env["DATABASE_URL"],
    pollIntervalMs:
      Number(optional("POLL_INTERVAL_SECONDS", "6")) * 1000,
    startLedger: Number(optional("START_LEDGER", "0")),
    port: Number(optional("PORT", "3001")),
  };
}

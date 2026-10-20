#!/usr/bin/env node
/**
 * verify-onchain.mjs — Query Soroban RPC for contract state:
 * - Contract instance existence and executable WASM hash
 * - Contract version via `version()` simulation
 * - Registered circuit VK version and hash on CredentialVerifier
 *
 * Usage:
 *   node scripts/verify-onchain.mjs --network testnet \
 *     --issuer-registry <id> \
 *     --credential-verifier <id> \
 *     --proof-registry <id> \
 *     --gated-pool <id>
 */

import { createRequire } from "node:module";
import crypto from "node:crypto";
import { argv, exit } from "node:process";

const require = createRequire(import.meta.url);

let sdk;
try {
  sdk = require("@stellar/stellar-sdk");
} catch {
  try {
    sdk = require("../frontend/node_modules/@stellar/stellar-sdk");
  } catch (err) {
    console.error(
      JSON.stringify({
        error: "Failed to load @stellar/stellar-sdk: " + err.message,
      }),
    );
    exit(1);
  }
}

// ---------------------------------------------------------------------------
// Argument Parsing
// ---------------------------------------------------------------------------
function parseArgs(rawArgs) {
  const options = {
    network: "testnet",
    rpcUrl: "",
    contracts: {},
    jsonOnly: false,
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--network") {
      options.network = rawArgs[++i];
    } else if (arg === "--rpc-url") {
      options.rpcUrl = rawArgs[++i];
    } else if (arg === "--json") {
      options.jsonOnly = true;
    } else if (arg === "--issuer-registry") {
      options.contracts.issuer_registry = rawArgs[++i];
    } else if (arg === "--credential-verifier") {
      options.contracts.credential_verifier = rawArgs[++i];
    } else if (arg === "--proof-registry") {
      options.contracts.proof_registry = rawArgs[++i];
    } else if (arg === "--gated-pool") {
      options.contracts.gated_pool = rawArgs[++i];
    } else if (arg === "--contract") {
      const pair = rawArgs[++i] || "";
      const [name, id] = pair.split("=");
      if (name && id) options.contracts[name.trim()] = id.trim();
    }
  }

  if (!options.rpcUrl) {
    options.rpcUrl =
      options.network === "mainnet"
        ? "https://mainnet.sorobanrpc.com"
        : "https://soroban-testnet.stellar.org";
  }

  return options;
}

const args = parseArgs(argv.slice(2));
const server = new sdk.rpc.Server(args.rpcUrl, {
  allowHttp: args.rpcUrl.startsWith("http://"),
});

const networkPassphrase =
  args.network === "mainnet"
    ? sdk.Networks.PUBLIC
    : sdk.Networks.TESTNET;

const SIMULATION_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function decodeContractVersion(encoded) {
  if (typeof encoded !== "number" || encoded < 0) return null;
  const major = Math.floor(encoded / 1_000_000);
  const minor = Math.floor((encoded % 1_000_000) / 1_000);
  const patch = encoded % 1_000;
  return `${major}.${minor}.${patch}`;
}

// ---------------------------------------------------------------------------
// Query contract instance and version
// ---------------------------------------------------------------------------
async function inspectContract(contractId) {
  const details = {
    contractId: contractId || null,
    found: false,
    wasmHash: null,
    rawVersion: null,
    version: null,
    error: null,
  };

  if (!contractId || contractId.includes("Placeholder") || contractId === "TBD") {
    details.error = "Unconfigured or placeholder ID";
    return details;
  }

  let contractIdBytes;
  try {
    contractIdBytes = sdk.StrKey.decodeContract(contractId);
  } catch (e) {
    details.error = `Invalid contract ID format: ${e.message}`;
    return details;
  }

  // 1. Ledger entry for contract instance -> executable WASM hash
  try {
    const ledgerKey = sdk.xdr.LedgerKey.contractData(
      new sdk.xdr.LedgerKeyContractData({
        contract: new sdk.xdr.ScAddress.scAddressTypeContract(contractIdBytes),
        key: sdk.xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: sdk.xdr.ContractDataDurability.persistent(),
      }),
    );
    const res = await server.getLedgerEntries(ledgerKey);
    if (res.entries && res.entries.length > 0) {
      details.found = true;
      const entryXdr = Buffer.from(res.entries[0].xdr, "base64");
      const ledgerEntry = sdk.xdr.LedgerEntryData.fromXDR(entryXdr);
      const contractData = ledgerEntry.contractData();
      const instance = contractData.val().instance();
      const exec = instance.executable();
      if (exec.switch().name === "contractExecutableWasm") {
        details.wasmHash = exec.wasmHash().toString("hex").toLowerCase();
      }
    } else {
      details.error = "Not found on-chain";
    }
  } catch (e) {
    details.error = `Ledger entry query failed: ${e.message}`;
  }

  // 2. Simulate version() call
  if (details.found) {
    try {
      const account = new sdk.Account(SIMULATION_ACCOUNT, "0");
      const contract = new sdk.Contract(contractId);
      const tx = new sdk.TransactionBuilder(account, {
        fee: "100",
        networkPassphrase,
      })
        .addOperation(contract.call("version"))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!sdk.rpc.Api.isSimulationError(sim) && sim.result) {
        const raw = sdk.scValToNative(sim.result.retval);
        if (typeof raw === "number" && raw >= 0) {
          details.rawVersion = raw;
          details.version = decodeContractVersion(raw);
        }
      }
    } catch {
      // Simulation error: version stays null
    }
  }

  return details;
}

// ---------------------------------------------------------------------------
// Query registered VKs on CredentialVerifier
// ---------------------------------------------------------------------------
const CREDENTIAL_TYPES = [
  "kyc",
  "age",
  "income",
  "jurisdiction",
  "funds",
  "accreditation",
  "employment",
  "set_membership",
];

async function inspectRegisteredVks(verifierContractId) {
  const vks = {};
  if (
    !verifierContractId ||
    verifierContractId.includes("Placeholder") ||
    verifierContractId === "TBD"
  ) {
    return vks;
  }

  let contractIdBytes;
  try {
    contractIdBytes = sdk.StrKey.decodeContract(verifierContractId);
  } catch {
    return vks;
  }

  const account = new sdk.Account(SIMULATION_ACCOUNT, "0");
  const contract = new sdk.Contract(verifierContractId);

  for (const type of CREDENTIAL_TYPES) {
    const vkInfo = {
      type,
      registeredVersion: null,
      vkHash: null,
      error: null,
    };

    try {
      const tx = new sdk.TransactionBuilder(account, {
        fee: "100",
        networkPassphrase,
      })
        .addOperation(
          contract.call("get_latest_version", sdk.xdr.ScVal.scvSymbol(type)),
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!sdk.rpc.Api.isSimulationError(sim) && sim.result) {
        const rawVersion = sdk.scValToNative(sim.result.retval);
        if (typeof rawVersion === "number" && rawVersion > 0) {
          vkInfo.registeredVersion = rawVersion;

          // Attempt to read DataKey::Vk(Symbol(type), u32(rawVersion))
          try {
            const vkKey = sdk.xdr.ScVal.scvVec([
              sdk.xdr.ScVal.scvSymbol("Vk"),
              sdk.xdr.ScVal.scvSymbol(type),
              sdk.xdr.ScVal.scvU32(rawVersion),
            ]);
            const ledgerKey = sdk.xdr.LedgerKey.contractData(
              new sdk.xdr.LedgerKeyContractData({
                contract: new sdk.xdr.ScAddress.scAddressTypeContract(contractIdBytes),
                key: vkKey,
                durability: sdk.xdr.ContractDataDurability.persistent(),
              }),
            );
            const vkRes = await server.getLedgerEntries(ledgerKey);
            if (vkRes.entries && vkRes.entries.length > 0) {
              const entryXdr = Buffer.from(vkRes.entries[0].xdr, "base64");
              const ledgerEntry = sdk.xdr.LedgerEntryData.fromXDR(entryXdr);
              const vkBytesVal = ledgerEntry.contractData().val().bytes();
              if (vkBytesVal) {
                vkInfo.vkHash = crypto
                  .createHash("sha256")
                  .update(vkBytesVal)
                  .digest("hex");
              }
            }
          } catch {
            // Could not fetch raw VK bytes
          }
        }
      } else {
        vkInfo.error = "Not registered (VkNotSet)";
      }
    } catch (e) {
      vkInfo.error = e.message;
    }

    vks[type] = vkInfo;
  }

  return vks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const output = {
    network: args.network,
    rpcUrl: args.rpcUrl,
    contracts: {},
    registeredVks: {},
  };

  for (const [name, id] of Object.entries(args.contracts)) {
    output.contracts[name] = await inspectContract(id);
  }

  if (args.contracts.credential_verifier) {
    output.registeredVks = await inspectRegisteredVks(
      args.contracts.credential_verifier,
    );
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack }));
  exit(1);
});

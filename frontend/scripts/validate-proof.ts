import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCredential } from "../lib/credential";
import { decodeProofBytes, decodeProofFields, validateClaimInputs } from "../lib/proof-validation";

type ProofPayload = {
  proof?: unknown;
  publicInputs?: unknown;
};

function usage(): never {
  throw new Error(
    "Usage: pnpm validate-proof -- --credential <credential.json> --proof <proof.json> [--dry-run]\n" +
      "Proof JSON must contain proof and publicInputs fields. See docs/PROOF_VALIDATION.md.",
  );
}

function parseArgs(args: string[]): { credentialPath: string; proofPath: string; dryRun: boolean } {
  let credentialPath: string | undefined;
  let proofPath: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--credential") credentialPath = args[++index];
    else if (arg === "--proof") proofPath = args[++index];
    else usage();
  }
  if (!credentialPath || !proofPath) usage();
  return { credentialPath, proofPath, dryRun };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { credentialPath, proofPath, dryRun } = parseArgs(args);
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const credential = parseCredential(
    await readFile(resolve(invocationDirectory, credentialPath), "utf8"),
  );
  const payload = JSON.parse(
    await readFile(resolve(invocationDirectory, proofPath), "utf8"),
  ) as ProofPayload;
  const proof = decodeProofBytes(payload.proof, "proof");
  const publicInputs = decodeProofFields(payload.publicInputs);
  const claimErrors = validateClaimInputs(credential, publicInputs);
  if (claimErrors.length > 0) {
    throw new Error(claimErrors.join("\n"));
  }

  const artifactPath = resolve(
    fileURLToPath(new URL("../public/circuits/", import.meta.url)),
    `${credential.type}.json`,
  );
  const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as { bytecode?: unknown };
  if (typeof artifact.bytecode !== "string") {
    throw new Error(
      `Circuit artifact ${artifactPath} has no bytecode. Rebuild the ${credential.type} circuit.`,
    );
  }

  const { UltraHonkBackend } = await import("@aztec/bb.js");
  const backend = new UltraHonkBackend(artifact.bytecode, { threads: 1 });
  let verified: boolean;
  try {
    verified = await backend.verifyProof({ proof, publicInputs }, { keccak: true });
  } finally {
    await backend.destroy();
  }
  if (!verified) {
    throw new Error(
      "UltraHonk verification failed. Check that proof bytes, public inputs, credential, and circuit version belong together.",
    );
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        credentialType: credential.type,
        commitmentMatches: true,
        claimPolicyMatches: true,
        proofVerified: true,
        dryRun,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown validation error";
  console.error(JSON.stringify({ result: "FAIL", error: message }, null, 2));
  process.exitCode = 1;
});

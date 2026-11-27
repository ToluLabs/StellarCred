// @vitest-environment node
//
// Conformance check for the built-in bb.js proof verifier against the real
// `@aztec/bb.js` package the monorepo pins (0.87.0). The unit tests inject a
// fake module, which cannot catch an upstream API change: this one constructs a
// real `UltraHonkBackend` from a compiled circuit artifact and calls
// `verifyProof` exactly as the adapter does.
//
// Both the package and the artifact are optional to this package, so the test
// skips (with a reason) outside the monorepo checkout instead of failing.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createBbJsProofVerifier, ULTRAHONK_PROOF_BYTES } from "./offline";

const ARTIFACT_URL = new URL("../../../public/circuits/age.json", import.meta.url);

async function loadRealBbJs() {
  try {
    return await import("@aztec/bb.js");
  } catch {
    return null;
  }
}

async function loadCircuitBytecode(): Promise<string | null> {
  try {
    const artifact = JSON.parse(await readFile(fileURLToPath(ARTIFACT_URL), "utf8")) as {
      bytecode?: unknown;
    };
    return typeof artifact.bytecode === "string" ? artifact.bytecode : null;
  } catch {
    return null;
  }
}

const bbJs = await loadRealBbJs();
const circuitBytecode = await loadCircuitBytecode();
const available = bbJs !== null && circuitBytecode !== null;

describe.skipIf(!available)("createBbJsProofVerifier against the real @aztec/bb.js", () => {
  it("rejects an invalid proof without throwing", async () => {
    const verifier = createBbJsProofVerifier(async () => bbJs!);

    const verified = await verifier({
      verifierKey: new Uint8Array(32),
      proof: new Uint8Array(ULTRAHONK_PROOF_BYTES),
      publicInputs: Uint8Array.from({ length: 5 * 32 }, () => 0),
      credentialType: "age",
      vkVersion: 1,
      circuitBytecode: circuitBytecode!,
    });

    expect(verified).toBe(false);
  }, 120_000);
});

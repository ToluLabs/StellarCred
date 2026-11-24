import { afterEach, describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";

import { createPresentationToken, verifyPresentationToken } from "./presentation-token";

/**
 * Runtime compatibility for the Server Component helpers (#1062).
 *
 * Presentation token verification runs inside Next.js App Router Server
 * Components, which may use the Node.js runtime or the Edge runtime. The SDK
 * must not reach for browser globals (wallet extensions live there) or Node-only
 * globals such as `process` / the `Buffer` global. These tests exercise the
 * verifier with those globals removed and statically guard the module source.
 */

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL("./presentation-token.ts", import.meta.url)),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const browserGlobals = [
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "navigator",
] as const;

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function removeGlobal(name: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  savedGlobals.set(name, descriptor);
  // @ts-expect-error deliberately deleting test globals
  delete globalThis[name];
}

function restoreGlobals(): void {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      // @ts-expect-error cleanup for a global that was absent
      delete globalThis[name];
    }
  }
  savedGlobals.clear();
}

async function signedToken(kp: Keypair): Promise<string> {
  return createPresentationToken({
    wallet: kp.publicKey(),
    claims: ["kyc"],
    sign: (message) => kp.sign(Buffer.from(message, "utf8")).toString("base64"),
  });
}

afterEach(restoreGlobals);

describe("presentation token runtime compatibility (#1062)", () => {
  it("verifies tokens with no browser globals present, like a Server Component", async () => {
    const kp = Keypair.random();
    const token = await signedToken(kp);
    for (const name of browserGlobals) removeGlobal(name);

    const result = await verifyPresentationToken(token, { verifyClaims: false });

    expect(result.ok).toBe(true);
    expect(result.wallet).toBe(kp.publicKey());
    for (const name of browserGlobals) expect(name in globalThis).toBe(false);
  });

  it("does not require a Web Crypto global to verify an existing token", async () => {
    const kp = Keypair.random();
    const token = await signedToken(kp);
    removeGlobal("crypto");

    const result = await verifyPresentationToken(token, { verifyClaims: false });

    expect(result.ok).toBe(true);
  });

  it("still fails safely on malformed tokens when runtime globals are absent", async () => {
    for (const name of browserGlobals) removeGlobal(name);

    const result = await verifyPresentationToken("scpt1.not-json.not-a-signature", {
      verifyClaims: false,
    });

    expect(result).toMatchObject({ ok: false, failureReason: "malformed_token" });
  });

  it("module source avoids browser-only and Node-only APIs", () => {
    for (const name of browserGlobals) {
      expect(MODULE_SOURCE).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(MODULE_SOURCE).not.toMatch(/\bprocess\b/);
    expect(MODULE_SOURCE).not.toMatch(/\bBuffer\b/);
    expect(MODULE_SOURCE).not.toMatch(/from\s+["']node:/);
    expect(MODULE_SOURCE).not.toMatch(/require\(\s*["']node:/);
    expect(MODULE_SOURCE).not.toMatch(/@stellar\/stellar-sdk/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

describe("secrets-boundary (#976)", () => {
  const rootDir = path.resolve(__dirname, "../../..");

  it("docs/SERVER_CLIENT_SECRETS_BOUNDARY.md exists and documents the forbidden patterns", () => {
    const docPath = path.resolve(rootDir, "docs/SERVER_CLIENT_SECRETS_BOUNDARY.md");
    expect(existsSync(docPath)).toBe(true);
    const content = readFileSync(docPath, "utf8");
    expect(content).toContain("ISSUER_PRIVATE_KEY");
    expect(content).toContain("NEXT_PUBLIC_");
  });

  it("frontend/scripts/assert-no-issuer-secrets-in-bundle.mjs exists and scans for violations", () => {
    const scriptPath = path.resolve(
      rootDir,
      "frontend/scripts/assert-no-issuer-secrets-in-bundle.mjs",
    );
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain("FORBIDDEN_SECRET_PATTERNS");
  });
});

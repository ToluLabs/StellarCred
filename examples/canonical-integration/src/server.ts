/**
 * StellarCred Canonical Integration Example Server
 *
 * Demonstrates the end-to-end integration pattern recommended for Stellar protocols:
 *  1. Redirect to verify (buildVerifyUrl)
 *  2. Handle the return redirect (parseReturnParams — treating URL parameters as untrusted hints)
 *  3. Prove wallet control (createWalletChallenge + Ed25519 signature verification) to prevent
 *     the wallet-spoofing vulnerability (Issue #543)
 *  4. Re-verify on-chain server-side against the ProofRegistry contract
 *  5. Gate protected routes based on authenticated sessions backed by verified credentials
 *  6. Handle and distinguish every failure state:
 *     - not_verified (no on-chain proof found)
 *     - expired (proof exists but expiration has passed)
 *     - revoked (credential was revoked by issuer)
 *     - wrong_issuer (proof signed by untrusted issuer)
 *     - unmet_threshold (numeric credential below minimum required)
 *     - invalid_signature (spoofing attempt blocked)
 *     - challenge_replayed / challenge_expired (replay attacks prevented)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import StellarCred, {
  configure,
  healthCheck,
  buildVerifyUrl,
  parseReturnParams,
  createWalletChallenge,
  verifyWalletClaim,
  checkClaimStatus,
  type ClaimType,
  type ClaimOptions,
  type WalletChallenge,
} from "@stellarcred/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── 1. Configure the SDK at Startup ──────────────────────────────────────────
// Configure with environment variables or default testnet deployments
const REGISTRY_ID =
  process.env.STELLARCRED_REGISTRY_ID ??
  "CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV";
const RPC_URL =
  process.env.STELLARCRED_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.STELLARCRED_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";
const BASE_URL =
  process.env.STELLARCRED_BASE_URL ?? "https://stellarcred.xyz";
const PORT = Number(process.env.PORT ?? 3000);
const APP_DOMAIN = process.env.APP_DOMAIN ?? `localhost:${PORT}`;

configure({
  registryId: REGISTRY_ID,
  rpcUrl: RPC_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
  baseUrl: BASE_URL,
});

// Run startup health check to verify config
const health = healthCheck();
if (!health.configured) {
  // eslint-disable-next-line no-console
  console.warn("[StellarCred Example] Warning: SDK partially configured — missing:", health.missing);
}

// ── In-Memory Session Store ──────────────────────────────────────────────────
// Maps sessionToken -> { wallet, claim, verifiedAt, expiresAt }
export interface Session {
  wallet: string;
  claim: string;
  verifiedAt: number;
  expiresAt: number;
}

export const sessions = new Map<string, Session>();

// Session valid for 1 hour
const SESSION_TTL_MS = 60 * 60 * 1000;

// Helper to parse JSON request bodies
async function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error("Request payload too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("Malformed JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

// Helper to send JSON responses
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

// ── Application Handler ───────────────────────────────────────────────────────
export function createRequestHandler() {
  return async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = req.url ?? "/";
    const host = req.headers.host ?? `localhost:${PORT}`;
    const url = new URL(reqUrl, `http://${host}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase() ?? "GET";

    // Handle CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    try {
      // ── Step 0: Serve Frontend Web Page ───────────────────────────────────
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const publicHtmlPath = join(__dirname, "..", "public", "index.html");
        if (existsSync(publicHtmlPath)) {
          const content = readFileSync(publicHtmlPath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(content);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("StellarCred Canonical Integration Example running.");
        return;
      }

      // ── Step 0b: Public configuration & health check ───────────────────────
      if (method === "GET" && pathname === "/api/config") {
        sendJson(res, 200, {
          registryId: REGISTRY_ID,
          rpcUrl: RPC_URL,
          domain: APP_DOMAIN,
          baseUrl: BASE_URL,
          health: healthCheck(),
        });
        return;
      }

      // ── Step 1: Redirect to Verify (URL Generator) ─────────────────────────
      // GET /api/verify-url?claim=kyc&threshold=50000
      if (method === "GET" && pathname === "/api/verify-url") {
        const claim = (url.searchParams.get("claim") ?? "kyc") as ClaimType;
        const threshold = url.searchParams.get("threshold");
        const customReturnUrl = url.searchParams.get("returnUrl");

        const returnUrl = customReturnUrl ?? `http://${host}/verify-return`;
        const claimParams: Record<string, string> = {};
        if (threshold) {
          claimParams[claim === "age" ? "threshold_years" : "threshold"] = threshold;
        }

        const verifyUrl = buildVerifyUrl({
          claim,
          returnUrl,
          claimParams: Object.keys(claimParams).length > 0 ? claimParams : undefined,
        });

        // Also supports immediate 302 redirect if requested via ?redirect=true
        if (url.searchParams.get("redirect") === "true") {
          res.writeHead(302, { Location: verifyUrl });
          res.end();
          return;
        }

        sendJson(res, 200, {
          ok: true,
          claim,
          returnUrl,
          verifyUrl,
          instruction: "Direct holder to verifyUrl in their browser.",
        });
        return;
      }

      // ── Step 2: Handle the Return Redirect from StellarCred ────────────────
      // GET /verify-return?sc_verified=true&sc_wallet=G...&sc_claims=kyc
      if (method === "GET" && pathname === "/verify-return") {
        const hint = parseReturnParams(url.searchParams);

        // Security Warning: URL query parameters can be spoofed by any HTTP client!
        // Never grant access or create sessions solely from sc_verified / sc_wallet.
        sendJson(res, 200, {
          ok: true,
          message: "User returned from StellarCred verification.",
          warning:
            "CRITICAL SECURITY NOTICE: 'sc_verified' and 'sc_wallet' in the URL query string " +
            "are untrusted hints, NOT cryptographic proof of wallet control or valid credentials. " +
            "Always proceed to Step 3 and Step 4 to require a signed wallet challenge and perform " +
            "server-side on-chain verification before granting access.",
          untrustedHint: hint,
          nextStep: {
            action: "prove_wallet_control",
            endpoint: "POST /api/auth/verify",
            requires: ["wallet", "challenge", "signature"],
          },
        });
        return;
      }

      // ── Step 3: Issue Replay-Protected Challenge ───────────────────────────
      // GET /api/auth/challenge
      if (method === "GET" && pathname === "/api/auth/challenge") {
        const statement =
          url.searchParams.get("statement") ??
          "Sign this message to prove control of your Stellar account and access the Gated Treasury.";

        // createWalletChallenge issues a cryptographically random, replay-protected challenge
        const challenge: WalletChallenge = createWalletChallenge({
          domain: APP_DOMAIN,
          statement,
          ttlMs: 5 * 60 * 1000, // 5 minutes validity
        });

        sendJson(res, 200, {
          ok: true,
          challenge,
          instruction: "Have holder wallet sign challenge.message using Ed25519 (e.g. Freighter signMessage).",
        });
        return;
      }

      // ── Step 4: Verify Wallet Control & On-Chain Claim Server-Side ──────────
      // POST /api/auth/verify
      if (method === "POST" && pathname === "/api/auth/verify") {
        const body = await parseJsonBody(req);
        const { wallet, challenge, signature, claim = "kyc", claimOptions } = body;

        if (!wallet || !challenge || !signature) {
          sendJson(res, 400, {
            ok: false,
            error: "Missing required fields: wallet, challenge, and signature are required.",
          });
          return;
        }

        // Optional trusted issuers filter from environment or request options
        const envTrusted = process.env.TRUSTED_ISSUERS?.split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const finalOptions: ClaimOptions = {
          ...claimOptions,
          trustedIssuers:
            claimOptions?.trustedIssuers ?? (envTrusted && envTrusted.length > 0 ? envTrusted : undefined),
        };

        // verifyWalletClaim performs TWO critical checks atomically:
        // 1. Validates the signature over the challenge (proves wallet control, prevents #543 spoofing)
        // 2. Checks on-chain credential claim status against ProofRegistry
        const verification = await verifyWalletClaim({
          wallet,
          challenge,
          signature,
          claim: claim as ClaimType,
          claimOptions: finalOptions,
        });

        if (!verification.ok) {
          // Identify specific failure state
          sendJson(res, 403, {
            ok: false,
            wallet: verification.wallet,
            signatureValid: verification.signatureValid,
            claimValid: verification.claimValid,
            failureReason: verification.failureReason,
            claimStatus: verification.claimStatus,
            error: verification.error,
            remediation: {
              verifyUrl: buildVerifyUrl({
                claim: claim as ClaimType,
                returnUrl: `http://${host}/verify-return`,
              }),
            },
          });
          return;
        }

        // Access Granted: Issue an authenticated session token
        const sessionToken = crypto.randomUUID();
        const now = Date.now();
        sessions.set(sessionToken, {
          wallet: verification.wallet,
          claim,
          verifiedAt: now,
          expiresAt: now + SESSION_TTL_MS,
        });

        sendJson(res, 200, {
          ok: true,
          sessionToken,
          wallet: verification.wallet,
          claim,
          claimDetails: verification.claimDetails,
          claimStatus: verification.claimStatus,
          message: "Access granted: caller proved wallet control AND valid on-chain credential.",
        });
        return;
      }

      // ── Step 5: Gated Route (Protected Resource) ───────────────────────────
      // GET /api/protected/treasury
      if (method === "GET" && pathname === "/api/protected/treasury") {
        const authHeader = req.headers.authorization ?? "";
        const token = authHeader.replace(/^Bearer\s+/i, "").trim();

        if (!token || !sessions.has(token)) {
          sendJson(res, 401, {
            ok: false,
            error: "Unauthorized: Active authenticated session token required.",
            remediation: {
              authUrl: "/api/auth/challenge",
              verifyUrl: buildVerifyUrl({
                claim: "kyc",
                returnUrl: `http://${host}/verify-return`,
              }),
            },
          });
          return;
        }

        const session = sessions.get(token)!;
        if (Date.now() > session.expiresAt) {
          sessions.delete(token);
          sendJson(res, 401, {
            ok: false,
            error: "Session expired. Please re-authenticate.",
          });
          return;
        }

        // Return protected secret data
        sendJson(res, 200, {
          ok: true,
          authenticatedWallet: session.wallet,
          verifiedClaim: session.claim,
          protectedData: {
            title: "Stellar Gated Treasury Vault",
            secretTreasuryBalance: "$12,450,000.00 USDC",
            governanceVotingPower: 1000,
            confidentialClearance: "LEVEL_3_KYC_VERIFIED",
            accessGrantedAt: new Date(session.verifiedAt).toISOString(),
          },
        });
        return;
      }

      // ── Step 6: Detailed Failure State Diagnostics ────────────────────────
      // GET /api/claim-status?wallet=G...&claim=kyc
      if (method === "GET" && pathname === "/api/claim-status") {
        const wallet = url.searchParams.get("wallet") ?? "";
        const claim = (url.searchParams.get("claim") ?? "kyc") as ClaimType;
        const threshold = url.searchParams.get("threshold");
        const trusted = url.searchParams.get("trustedIssuers")?.split(",").map((s) => s.trim()).filter(Boolean);

        const opts: ClaimOptions = {};
        if (threshold) opts.minThreshold = Number(threshold);
        if (trusted && trusted.length > 0) opts.trustedIssuers = trusted;

        const status = await checkClaimStatus(wallet, claim, opts);
        sendJson(res, 200, {
          wallet,
          claim,
          options: opts,
          result: status,
        });
        return;
      }

      // Fallback 404
      sendJson(res, 404, {
        ok: false,
        error: `Route not found: ${method} ${pathname}`,
      });
    } catch (err: any) {
      sendJson(res, 500, {
        ok: false,
        error: `Internal Server Error: ${err.message}`,
      });
    }
  };
}

// ── Server Factory ────────────────────────────────────────────────────────────
export function createExampleServer() {
  const handler = createRequestHandler();
  return createServer(handler);
}

// ── Standalone Startup ────────────────────────────────────────────────────────
// When executed directly (e.g. `npm start` or `tsx src/server.ts`), start the server
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("src/server.ts") ||
    process.argv[1].endsWith("src/server.js") ||
    process.argv[1].includes("canonical-integration/src/server"));

if (isDirectExecution && process.env.NODE_ENV !== "test") {
  const server = createExampleServer();
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`\n========================================================`);
    // eslint-disable-next-line no-console
    console.log(`🚀 StellarCred Canonical Integration Example running at:`);
    // eslint-disable-next-line no-console
    console.log(`   http://localhost:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`========================================================\n`);
  });
}

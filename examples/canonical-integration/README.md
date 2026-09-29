# StellarCred Canonical Integration Example

A minimal, complete, runnable reference application demonstrating the full recommended StellarCred integration pattern end-to-end against Stellar Testnet.

This example covers the complete flow:
1. **Redirect to Verify** (`buildVerifyUrl`): Direct unverified users to the StellarCred web app.
2. **Handle the Return** (`parseReturnParams`): Receive users back while treating URL query parameters as **untrusted hints**.
3. **Prove Wallet Control** (`createWalletChallenge` & signature check): Defend against the wallet-spoofing vulnerability ([Issue #543](https://github.com/ToluLabs/StellarCred/issues/543)).
4. **Re-Verify On-Chain Server-Side** (`verifyWalletClaim`): Perform trustless verification directly against `ProofRegistry`.
5. **Gate a Route**: Enforce session-based access control to sensitive resources.
6. **Handle Failure States**: Distinguish and handle all failure conditions (`not_verified`, `expired`, `revoked`, `wrong_issuer`, `unmet_threshold`, `invalid_signature`, `challenge_replayed`).

---

## ⚠️ Security Notice: The Wallet-Spoofing Pitfall (#543)

When building an authenticated service or API gate, **never** rely solely on an untrusted wallet address provided in client headers, URL query parameters, or request bodies — even if you check `hasClaim(address)` on-chain.

Because on-chain proofs and Stellar public keys are public, an attacker could supply another user's verified address to bypass authorization.

**The Solution**:
1. Server issues a short-lived, replay-protected challenge (`createWalletChallenge`).
2. Client signs the challenge message with their Stellar wallet (e.g. Freighter `signMessage`).
3. Server calls `verifyWalletClaim` to verify **both** wallet ownership and on-chain credential claim status in one call.

---

## Quick Start

### 1. Prerequisites
- Node.js 20+
- npm or pnpm

### 2. Configure Environment
Copy the example environment file:
```bash
cp .env.example .env
```

The defaults point to the canonical testnet deployment of `ProofRegistry`:
```env
STELLARCRED_REGISTRY_ID=CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV
STELLARCRED_RPC_URL=https://soroban-testnet.stellar.org
STELLARCRED_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
STELLARCRED_BASE_URL=https://stellarcred.xyz
PORT=3000
APP_DOMAIN=localhost:3000
```

### 3. Install & Run
```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser to interact with the live UI.

### 4. Run Automated Tests
```bash
npm test
# Or from the repository root:
make test-example
```

---

## Architecture & Code Tour

The entire server is contained in [`src/server.ts`](src/server.ts) and can be read in a single sitting.

### Step 1: Redirect to Verify (`GET /api/verify-url`)
Constructs the verification URL for the required claim type and threshold:
```ts
import { buildVerifyUrl } from "@stellarcred/sdk/server";

const verifyUrl = buildVerifyUrl({
  claim: "kyc",
  returnUrl: "http://localhost:3000/verify-return",
  // Optional threshold for numeric claims (funds, age, income):
  // claimParams: { threshold: "50000" },
});
```

### Step 2: Handle Return (`GET /verify-return`)
Extracts the parameters returned when the user is redirected back:
```ts
import { parseReturnParams } from "@stellarcred/sdk/server";

const hint = parseReturnParams(url.searchParams);
// hint.verified is a client-side UI hint — do NOT grant access yet!
```

### Step 3: Issue Replay-Protected Challenge (`GET /api/auth/challenge`)
Creates a single-use cryptographic challenge:
```ts
import { createWalletChallenge } from "@stellarcred/sdk/server";

const challenge = createWalletChallenge({
  domain: "localhost:3000",
  statement: "Sign in to access Gated Treasury",
  ttlMs: 5 * 60 * 1000, // 5 minutes
});
```

### Step 4: Verify Wallet Control & On-Chain Claim (`POST /api/auth/verify`)
Atomically validates the signature and queries the on-chain registry:
```ts
import { verifyWalletClaim } from "@stellarcred/sdk/server";

const result = await verifyWalletClaim({
  wallet: req.body.wallet,
  challenge: req.body.challenge,
  signature: req.body.signature,
  claim: "kyc",
  // Optional: enforce minimum threshold or trusted issuers:
  // claimOptions: { minThreshold: 50_000, trustedIssuers: ["G..."] },
});

if (!result.ok) {
  // result.failureReason explains why:
  // "invalid_signature" | "challenge_replayed" | "not_verified" | "expired" | "revoked" | "wrong_issuer"
  return res.status(403).json({ error: result.error, failureReason: result.failureReason });
}

// Access granted: issue session token
createSession(result.wallet);
```

### Step 5: Gated Route (`GET /api/protected/treasury`)
Guarded by an authenticated session:
```ts
const session = sessions.get(token);
if (!session) {
  return res.status(401).json({ error: "Session required" });
}
return res.json({ secretData: "Treasury Balance: $12,450,000 USDC" });
```

---

## Failure States Matrix

The SDK and server distinguish each failure state clearly:

| Failure State | Meaning | Resolution |
| :--- | :--- | :--- |
| `invalid_signature` | Provided signature did not match wallet key (spoofing attempt blocked). | User must sign challenge with their actual private key. |
| `challenge_replayed` | Challenge nonce was already consumed or expired. | Request fresh challenge from `/api/auth/challenge`. |
| `not_verified` | Wallet has no cached proof for this claim in `ProofRegistry`. | User redirects to StellarCred to prove claim. |
| `expired` | On-chain credential has passed its `expiry` timestamp. | User returns to StellarCred to refresh/re-prove. |
| `revoked` | Issuer revoked this holder's credential on-chain. | User must obtain new credential from authorized issuer. |
| `wrong_issuer` | Proof was signed by an issuer not in the application's `trustedIssuers` list. | User must prove credential signed by an approved issuer. |
| `unmet_threshold` | Proven threshold on-chain is below application's `minThreshold`. | User must prove a higher value meeting the threshold. |

---

## License

MIT

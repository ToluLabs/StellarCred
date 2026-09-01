# @stellarcred/middleware

Express and Next.js middleware that gates a request on one or more
[StellarCred](https://github.com/Psalmuel01/StellarCred) claims, without
integrators re-implementing the same "check `hasClaim`, else 403/redirect"
boilerplate.

Built on [`@stellarcred/sdk`](../sdk) — reuses its batched `hasClaims` read,
per-request timeouts, and fail-soft error taxonomy. This package adds no new
on-chain logic; it only shapes the pass/fail response for each framework.

## Install

```bash
npm install @stellarcred/middleware @stellarcred/sdk
```

## Important: this is not authentication

The gate answers one question: *does this wallet hold these claims?* It does
**not** establish *whose* wallet the request is for. You must supply
`getWallet`, resolving the caller's wallet from something you already trust —
a verified session, a signed cookie, a JWT — never from a raw header or query
parameter, since anyone can set those to someone else's address.

## Express

```ts
import express from "express";
import { stellarCredGate } from "@stellarcred/middleware/express";

const app = express();

app.get(
  "/vault",
  stellarCredGate({
    claims: ["kyc", "funds"],
    minThresholds: { funds: 50000 },
    getWallet: (req) => req.session?.walletAddress,
    onFail: "redirect",
    returnUrl: "https://myapp.example/vault",
  }),
  (req, res) => {
    // req.stellarcred is populated once the gate passes
    res.json({ ok: true, wallet: req.stellarcred?.wallet });
  },
);
```

Omit `onFail` (or set it to `"403"`) for a JSON API instead of a redirect:

```json
{ "error": "insufficient_claims", "required": ["kyc", "funds"], "missing": ["funds"] }
```

## Next.js

### `middleware.ts`

```ts
import type { NextRequest } from "next/server";
import { createStellarCredMiddleware } from "@stellarcred/middleware/next";

const gate = createStellarCredMiddleware({
  claims: ["kyc"],
  getWallet: (req) => req.cookies.get("wallet")?.value,
  onFail: "redirect",
  returnUrl: "https://myapp.example/vault",
});

export function middleware(req: NextRequest) {
  return gate(req);
}

export const config = { matcher: ["/vault/:path*"] };
```

### App Router route handlers

```ts
// app/api/vault/route.ts
import { withStellarCredGate } from "@stellarcred/middleware/next";

export const GET = withStellarCredGate(
  {
    claims: ["kyc", "funds"],
    minThresholds: { funds: 50000 },
    getWallet: (req) => req.cookies.get("wallet")?.value,
  },
  async (req, { wallet }) => Response.json({ ok: true, wallet }),
);
```

## Options

Shared by both adapters (`ClaimGateOptions`, importable from
`@stellarcred/middleware`):

| Option | Description |
| --- | --- |
| `claims` | Required. One or more claim types — all must pass (AND, not OR). |
| `minThresholds` | Per-type minimum thresholds, e.g. `{ age: 21, funds: 50000 }`. |
| `trustedIssuers` | Restrict every claim in the batch to specific issuer addresses. |
| `requestTimeoutMs` | Max time per on-chain read; forwarded to `hasClaims`. |
| `onFail` | `"403"` (default, JSON) or `"redirect"` (302 to the verify flow). |
| `returnUrl` | Required when `onFail: "redirect"` — where StellarCred sends the caller back to after they verify. |
| `baseUrl` | Override the StellarCred base URL used to build the verify link. |
| `getWallet` | Required, framework-specific — resolve the caller's wallet from the request. |

A missing/falsy wallet is treated as failing every requested claim without
making any on-chain read.

# Content Security Policy (CSP)

This document details the Content Security Policy implementation for the StellarCred frontend, its operational modes, directive requirements, violation reporting pipeline, and rollout procedures.

---

## Overview

The application utilizes two distinct CSP configurations assembled across `lib/csp.mjs`, `next.config.mjs`, and `middleware.ts`:

1. **Legacy Enforced Policy**: Defined via `buildCsp({ strict: false, ... })` and served through the static `headers()` list in `next.config.mjs`. It permits `'unsafe-inline'` script execution to maintain backwards compatibility while external scripts and unauthorized origins remain restricted.
2. **Strict Nonce Policy**: Defined via `buildCsp({ strict: true, ... })` in `lib/csp.mjs` and generated dynamically in `middleware.ts`. It generates a cryptographically random Base64 nonce per request, injects it into Next.js script tags, and forbids `'unsafe-inline'` in script-src. The strict policy adds `frame-ancestors`, `worker-src` and `manifest-src` beyond the legacy one (`object-src`, `base-uri`, and `form-action` are in both policies, added to the legacy policy upstream in #800 and mirrored in `lib/csp.mjs`).

Violation telemetry is captured via the `Reporting-Endpoints` header pointing to `/api/csp-report`.

---

## Modes (`CSP_MODE`)

The runtime mode is governed by the `CSP_MODE` environment variable and resolved via `resolveCspMode()` in `lib/csp.mjs`. Any value other than `"enforce"` (case-insensitive, trimmed) safely falls back to `"report-only"`.

| `CSP_MODE` | `Content-Security-Policy` | `Content-Security-Policy-Report-Only` | `Reporting-Endpoints` |
|---|---|---|---|
| `report-only` (default) | Legacy policy (`next.config.mjs`) | Strict nonce policy (`middleware.ts`) | Set (`csp-endpoint="/api/csp-report"`) |
| `enforce` | Strict nonce policy (`middleware.ts`) | Omitted | Set (`csp-endpoint="/api/csp-report"`) |

In `enforce` mode, `next.config.mjs` omits the legacy `Content-Security-Policy` header from its response header list, ensuring the strict nonce-based policy emitted by middleware is the sole enforced policy.

---

## Directive reference

The table below outlines directives present across the legacy policy (`strict: false`) and strict policy (`strict: true`):

| Directive | Policy / Value | Why it is needed |
|---|---|---|
| `default-src` | `'self'` | Restricts resource loading to the origin by default unless explicitly permitted. |
| `script-src` | Legacy: `'self' 'unsafe-inline' 'wasm-unsafe-eval'`<br>Strict: `'self' 'nonce-<nonce>' 'wasm-unsafe-eval'` | Required for Next.js runtime bundles. `'wasm-unsafe-eval'` is strictly required for WebAssembly instantiation in Noir and Aztec Barretenberg (`bb.js`). Strict mode disallows `'unsafe-inline'` and requires valid nonces. |
| `style-src` | `'self' 'unsafe-inline'` | Retains `'unsafe-inline'` because React and Next.js emit inline style attributes dynamically at runtime, which CSP nonces cannot govern. |
| `img-src` | `'self' data: https://stellar.creit.tech https://storage.herewallet.app` (+ `https://explorer-api.walletconnect.com` if WalletConnect enabled) | `stellar.creit.tech` hosts wallet icons for Freighter, xBull, Lobstr, Albedo, etc. in Stellar Wallets Kit. `storage.herewallet.app` hosts HOT Wallet icons. `explorer-api.walletconnect.com` loads WalletConnect modal icons when enabled. data: allows data URIs for images. |
| `connect-src` | `'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org` (+ `NEXT_PUBLIC_RPC_URL` if set, + `NEXT_PUBLIC_INDEXER_URL` if set, + `wss://relay.walletconnect.com wss://relay.walletconnect.org https://explorer-api.walletconnect.com https://verify.walletconnect.com https://verify.walletconnect.org` if WalletConnect enabled) | Browser-side client RPC calls (`contracts.ts`) against Soroban endpoints and client-side indexer claim queries (`@stellarcred/sdk`). WalletConnect requires WebSocket relays and verify/explorer APIs hardcoded in `@walletconnect/core`. |
| `frame-src` | `'self' https://verify.walletconnect.com https://verify.walletconnect.org` (WalletConnect only) | Permits WalletConnect's domain verification iframe loaded by `@walletconnect/sign-client`. Omitted when WalletConnect is disabled. |
| `object-src` | Both policies: `'none'` (added to the legacy policy upstream in #800 and mirrored in `lib/csp.mjs`) | Blocks legacy plugin execution (Flash, Java applets). |
| `base-uri` | Both policies: `'self'` (added to the legacy policy upstream in #800 and mirrored in `lib/csp.mjs`) | Prevents malicious injection of `<base>` elements altering relative URLs. |
| `form-action` | Both policies: `'self'` (added to the legacy policy upstream in #800 and mirrored in `lib/csp.mjs`) | Restricts targets of HTML form submissions to the application origin. |
| `frame-ancestors` | Strict default: `'none'`<br>Badge route (`/badge`): `*` (or `BADGE_ALLOWED_ORIGINS`) | Forbids embedding application pages inside foreign frames/iframes (aligning with `X-Frame-Options: DENY`), while permitting embeddable verification badge iframes on `/badge` (#532) across both report-only and enforce modes. |
| `worker-src` | Strict: `'self'` | The proof worker (`/workers/proof-worker.js`) and Barretenberg Web Worker (`/bb/main.worker.js, copied from bb.js into public/bb at build time`) are served same-origin. `blob:` is not needed. |
| `manifest-src` | Strict: `'self'` | Restricts loading of progressive web app manifests to same-origin. |
| `report-uri` / `report-to` | Strict: `report-uri /api/csp-report; report-to csp-endpoint;` | Delivers violation reports to the `/api/csp-report` endpoint. |

---

## Design decisions

- **No `'strict-dynamic'`**: Modern browsers interpreting `'strict-dynamic'` ignore `'self'` and host allowances for script loading. This would complicate loading dynamic bundles from `/bb/*` and Web Workers instantiated via same-origin scripts.
- **Per-request nonces in middleware**: middleware.ts generates a nonce with Web Crypto (crypto.getRandomValues(), Base64-encoded) and sets it in two places on the request: the CSP header, which Next.js reads to stamp its own <script> tags, and an x-nonce header, which app/layout.tsx reads to stamp the inline theme script.
- **Report-only first**: The strict policy ships as `Content-Security-Policy-Report-Only` initially to identify unexpected inline scripts or uncatalogued third-party endpoints in production environments without breaking user workflows.
- **Badge embed exception (`/badge`)**: The verification badge route (`/badge`) is designed to be embedded on third-party sites (#532). Both legacy headers in `next.config.mjs` and dynamic policies in `middleware.ts` set `frame-ancestors *` (or restrict to origins defined in `BADGE_ALLOWED_ORIGINS`), ensuring badge embeds remain functional when `CSP_MODE=enforce` is active without loosening framing restrictions on other routes.

---

## Interaction with COOP/COEP

Cross-Origin Isolation headers remain active and unchanged in `next.config.mjs`:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

These headers unlock `SharedArrayBuffer` for Barretenberg's multithreaded proving. Because all `bb.js` assets are served from the same origin under `/bb` (the files live in `public/bb`), they satisfy `require-corp`. Violation reports dispatched by the browser to `/api/csp-report` are also same-origin.

---

## Violation reporting

Violation reports are collected at `POST /api/csp-report` supporting both Legacy (`application/csp-report`) and Reporting API (`application/reports+json`) formats.

- **Constraints**: 16 KB maximum payload size (`readJsonBody`), capped at 10 reports parsed per request. Rate limited per IP via `RATE_LIMIT_CSP_REPORT_IP` (default 30 per 60s window).
- **Logged fields**: Sanitized entries contain only `documentUri`, `blockedUri`, `sourceFile`, `effectiveDirective`, `disposition`, and optional finite integers `lineNumber`, `columnNumber`, `statusCode`.
- **Paths are kept**: URLs are reduced to origin plus path, so path segments (for example `/apps/<id>`) can appear in logs.
- **Never logged**: Query parameters, URL fragments, credentials (all stripped by `sanitizeUrl`), `script-sample`, `sample`, `original-policy`, `originalPolicy`, `referrer`, and contents of `data:` or `blob:` URIs.

---

## Rollout and rollback

1. **Deploy in report-only mode**: Run with `CSP_MODE=report-only` (or unset).
2. **Review telemetry**: Inspect `csp_violation` log events in monitoring tools.
3. **Resolve anomalies**: Update permitted origins or refactor code if valid app flows trigger violations.
4. **Stage enforcement**: Deploy to staging with `CSP_MODE=enforce`. Verify client-side proving and wallet signing.
5. **Promote to production**: Set `CSP_MODE=enforce` in production.
6. **Rollback procedure**: Unset `CSP_MODE` or set `CSP_MODE=report-only` and restart the application (`next.config.mjs` evaluates at startup).

---

## Known limitations

- `style-src` retains `'unsafe-inline'` due to framework style injection.
- Inline scripts remain permitted by the legacy policy until `CSP_MODE=enforce` is toggled.
- `NEXT_PUBLIC_*` variables are inlined at build time in `middleware.ts` but evaluated dynamically at runtime in `next.config.mjs` `headers()`; build and runtime variables must match.
- Rate limiting is in-memory and trusts `X-Forwarded-For`.
- `/api/csp-report` is an unauthenticated endpoint; all logged payloads must be treated as untrusted input.

---

## Verification results

Manual check on a production build (`pnpm build && pnpm start`) in Chrome, with `CSP_MODE` unset (report-only):

- `/holder`: the wallet picker opened and listed the wallets. The DevTools console showed no `[Report Only]` CSP violation messages.
- Response headers on `/`, `/es` and `/holder`: the nonce in the HTML matches the nonce in the report-only header, the nonce differs on every request, and the enforced legacy policy, COOP and COEP are unchanged.

Not covered by this check: `CSP_MODE=enforce` in a browser, end-to-end proving, connecting and signing with a real Stellar wallet extension, and browsers other than Chrome. Review the `csp_violation` log events from a real deployment before switching to `enforce`.

Unrelated to CSP: the wallet picker icons from `stellar.creit.tech` and `storage.herewallet.app` are blocked by the existing `Cross-Origin-Embedder-Policy: require-corp` header (`ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep`), because those hosts do not send `Cross-Origin-Resource-Policy`. This predates the CSP work, and the CSP `img-src` already allows those hosts. Fixing it means changing the COEP strategy, which is out of scope here.

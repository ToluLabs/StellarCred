# Frontend Bundle Size Budget & CI Enforcement

## Overview

StellarCred's frontend handles zero-knowledge proving in the browser via WebAssembly (`@aztec/bb.js`) and compiled Noir circuit artifacts (`public/circuits/*.json`). Because WASM proving assets and ZK circuits are naturally large, a strict **bundle-size budget** and automated **CI regression check** are configured to ensure performance and prevent unexpected bundle size growth.

The read-only SDK is intentionally kept separate from the proving pipeline: `@stellarcred/sdk` only pays the cost of the Stellar contract RPC client at call time. The bundle path for `hasClaim`/`getClaim`/`hasClaims` does not statically import the generated registry wrapper, and it lazily loads the narrow `@stellar/stellar-sdk/contract` client only when a protocol actually performs a read. This keeps the browser bundle for simple claim checks near the expected 18 kB compressed budget without sacrificing on-chain verification.

---

## Budget Allocation

Budget limits are configured in [`frontend/.size-limit.json`](../frontend/.size-limit.json) using compressed (brotli/gzip) transfer sizes:

| Target Component / Route | Path Selector | Size Budget Limit | Description |
| :--- | :--- | :--- | :--- |
| **Home Route (`/`)** | `.next/static/chunks/app/page-*.js`, `layout-*.js` | `10 kB` | Landing page route chunks |
| **Apps Route (`/apps`)** | `.next/static/chunks/app/apps/**/*.js` | `10 kB` | App directory listing chunks |
| **Holder Route (`/holder`)** | `.next/static/chunks/app/holder/**/*.js` | `15 kB` | Holder credential management chunks |
| **Issuer Route (`/issuer`)** | `.next/static/chunks/app/issuer/**/*.js` | `10 kB` | Issuer portal chunks |
| **Verifier Route (`/verifier`)** | `.next/static/chunks/app/verifier/**/*.js` | `10 kB` | Verifier portal chunks |
| **Verify Route (`/verify`)** | `.next/static/chunks/app/verify/**/*.js` | `10 kB` | Public proof verification page chunks |
| **Developers & Docs Routes** | `.next/static/chunks/app/developers/**/*.js`, `docs/**/*.js` | `15 kB` | Developer resources and docs chunks |
| **Shared JS Chunks** | `.next/static/chunks/*.js` | `550 kB` | Common vendor and app JS dependencies |
| **WASM Proving Assets** | `public/bb/*.js` | `5.5 MB` | Barretenberg WASM & worker modules |
| **Circuit JSON Assets** | `public/circuits/*.json` | `80 kB` | Noir circuit definition files |

---

## Local Inspection & Analysis

### 1. Enforce & Test Size Limits
Run the size limit check locally after building the frontend:
```bash
cd frontend
pnpm build
pnpm size
```

If any route or asset exceeds its configured budget, `pnpm size` will fail with an error detailing the exact budget overage.

### 2. Interactive Bundle Analysis
To visualize webpack module sizes and inspect individual chunk compositions:
```bash
cd frontend
pnpm analyze
```
This generates visual HTML bundle reports at:
- `frontend/.next/analyze/client.html`
- `frontend/.next/analyze/nodejs.html`
- `frontend/.next/analyze/edge.html`

---

## Continuous Integration (CI) Checks

The GitHub Actions workflow [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) automatically runs bundle budget checks on every PR and commit to `main`:

1. **Build & Measure**: Compares PR bundle sizes against the target branch.
2. **Budget Enforcement**: Fails the CI pipeline if any entry regresses beyond the defined threshold.
3. **PR Reporting**: Automatically posts a detailed bundle size breakdown table as a PR comment.

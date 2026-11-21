# Frontend Bundle Size Budget & CI Enforcement

## Overview

StellarCred's frontend handles zero-knowledge proving in the browser via WebAssembly (`@aztec/bb.js`) and compiled Noir circuit artifacts (`public/circuits/*.json`). Because WASM proving assets and ZK circuits are naturally large, a strict **bundle-size budget** and automated **CI regression check** are configured to ensure performance and prevent unexpected bundle size growth.

---

## Bundle Optimizations (#737)

The following optimizations have been applied to reduce the production bundle:

1. **`@tabler/icons-react` per-icon imports** (`modularizeImports` in `next.config.mjs`)
   Barrel imports from `@tabler/icons-react` in 52+ files are automatically rewritten to per-icon ESM paths (e.g. `@tabler/icons-react/dist/esm/icons/IconCheck`). This prevents the full ~475 kB icon library from entering shared chunks when only a handful of icons are used per route. The package sets `sideEffects: false`, making the rewrite safe.

2. **Dynamic imports for the root-layout overlay** (`layout.tsx`)
   `OnboardingWizard` (~18 kB file with many icons) is loaded lazily with `next/dynamic` (`ssr: false`) via the `components/OnboardingOverlays.tsx` client wrapper (`ssr: false` is not allowed directly in a Server Component). It is an interactive-only overlay — not needed for initial render — so deferring it removes its weight from every route's critical JS path.

3. **Lazy QR scanner** (`VerifyQrScannerModal.tsx`)
   `QrScanner` (which bundles `jsqr`, a ~60 kB camera-decoding library) is now loaded lazily via `next/dynamic` only when the user actually opens the QR scanning UI. This keeps `jsqr` out of the initial `/verify` route bundle.

4. **Vendor chunk splitting** (`next.config.mjs` `splitChunks`)
   `@stellar/stellar-sdk`, `@creit.tech/stellar-wallets-kit`, `@walletconnect/*`, and `@noble/*` are grouped into dedicated named chunks (`stellar-vendor`, `noble-vendor`). These large libraries are loaded once and shared across routes rather than duplicated, reducing the total bytes sent on navigation.

---

## Budget Allocation

Budget limits are configured in [`frontend/.size-limit.json`](../frontend/.size-limit.json) using compressed (brotli/gzip) transfer sizes:

| Target Component / Route | Path Selector | Size Budget Limit | Description |
| :--- | :--- | :--- | :--- |
| **Home Route (`/`)** | `.next/static/chunks/app/page-*.js`, `layout-*.js` | `11 kB` | Landing page route chunks |
| **Apps Route (`/apps`)** | `.next/static/chunks/app/apps/**/*.js` | `14 kB` | App directory listing chunks |
| **Holder Route (`/holder`)** | `.next/static/chunks/app/holder/**/*.js` | `19 kB` | Holder credential management chunks |
| **Issuer Route (`/issuer`)** | `.next/static/chunks/app/issuer/**/*.js` | `10 kB` | Issuer portal chunks |
| **Verifier Route (`/verifier`)** | `.next/static/chunks/app/verifier/**/*.js` | `10 kB` | Verifier portal chunks |
| **Verify Route (`/verify`)** | `.next/static/chunks/app/verify/**/*.js` | `12 kB` | Public proof verification page chunks |
| **Badge Route (`/badge`)** | `.next/static/chunks/app/badge/**/*.js` | `10 kB` | Embeddable badge page chunks |
| **Developers & Docs Routes** | `.next/static/chunks/app/developers/**/*.js`, `docs/**/*.js` | `15 kB` | Developer resources and docs chunks |
| **Shared JS Chunks** | `.next/static/chunks/*.js` | `765 kB` | Common vendor and app JS dependencies |
| **WASM Proving Assets** | `public/bb/*.js` | `5.5 MB` | Barretenberg WASM & worker modules |
| **Prover Worker** | `public/workers/*.js` | `25 kB` | Dedicated proof-generation worker script |
| **Circuit JSON Assets** | `public/circuits/*.json` | `150 kB` | Noir circuit definition files |

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
ANALYZE=true pnpm build
```
This generates visual HTML bundle reports at:
- `frontend/.next/analyze/client.html`
- `frontend/.next/analyze/nodejs.html`
- `frontend/.next/analyze/edge.html`

---

## Continuous Integration (CI) Checks

The GitHub Actions workflow [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) automatically runs bundle budget checks in the `frontend` job on every PR and commit to `main`:

1. **Build**: The `frontend` job builds the app with `pnpm build` and uploads the `.next` output as an artifact.
2. **Budget Enforcement** (`Check bundle size budget`): Runs `pnpm size` immediately after the build. The step uses `continue-on-error: true` while the baseline is being established. It briefly switches the job to Node 22, because size-limit 13 imports `glob` from `node:fs/promises` (Node ≥ 22) and would otherwise crash on the job's Node 20 without measuring anything.
3. **PR Reporting** (`Report bundle size on PR`): On pull requests, posts a detailed bundle size breakdown table as a PR comment using `andresz1/size-limit-action`.

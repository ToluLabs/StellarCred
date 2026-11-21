import { createRequire } from "module";
import withBundleAnalyzer from "@next/bundle-analyzer";
import createNextIntlPlugin from "next-intl/plugin";
import { buildCsp, resolveCspMode, resolveBadgeFrameAncestors } from "./lib/csp.mjs";

const withBundleReport = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const withNextIntl = createNextIntlPlugin();

const require = createRequire(import.meta.url);
const bufferPath = require.resolve("buffer/");
const processPath = require.resolve("process/browser");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework/version to scanners (#800 audit).
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["@tabler/icons-react"],
  },

  // Rewrite barrel imports from "@tabler/icons-react" to per-icon ESM files.
  // e.g. `import { IconCheck } from "@tabler/icons-react"` becomes
  //      `import { IconCheck } from "@tabler/icons-react/dist/esm/icons/IconCheck.mjs"`
  // This prevents the entire ~475 kB icon library from being included in the
  // bundle when only a handful of icons are actually used. The package has
  // `sideEffects: false`, making this tree-shaking safe.
  modularizeImports: {
    "@tabler/icons-react": {
      transform: "@tabler/icons-react/dist/esm/icons/{{member}}",
    },
  },

  // (Removed the legacy `optimizeFonts: false` here: Next 16 no longer
  // recognises the key. Build-time font fetches were already avoided by
  // `preload: false` on every next/font in app/layout.tsx.)

  // The /api/issue route runs Noir server-side to compute the Poseidon
  // commitment. Keep these out of the server bundle so Node require()s them
  // from node_modules and resolves their CJS/"nodejs" entry points, which read
  // the WASM from disk with fs. If bundled, webpack picks the "web" build that
  // fetch()es the WASM via a /_next/... URL, which has no base on the server
  // ("Failed to parse URL from /_next/static/media/...wasm").
  // (Next 15 renamed this out of `experimental`; Next 16 keeps the stable key.)
  serverExternalPackages: [
    "@noir-lang/noir_js",
    "@noir-lang/acvm_js",
    "@noir-lang/noirc_abi",
  ],

  // Noir + Barretenberg (bb.js) prove in WASM in the browser. They expect Node
  // globals (Buffer/process) and load WASM modules; these settings make the
  // client bundle work without server-side polyfills.
  webpack: (config, { webpack, isServer }) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };

    // lib/wallet.ts's WalletConnectModule pulls in @walletconnect/sign-client
    // -> @walletconnect/logger -> pino, which conditionally requires
    // pino-pretty (a dev-only pretty-printing transport, never used in the
    // browser bundle we ship). It's not a dependency here, so webpack can't
    // statically resolve it — aliasing it to false is pino's own documented
    // fix for bundlers (https://github.com/pinojs/pino/blob/main/docs/bundling.md).
    config.resolve.alias = { ...config.resolve.alias, "pino-pretty": false };

    // Buffer/process polyfills are only needed in the browser bundle.
    // Applying ProvidePlugin on the server replaces Node's real `process`
    // with `process/browser` (env: {}), which hides server-only env vars
    // like ISSUER_PRIVATE_KEY even after they are set in .env.local.
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/@ledgerhq\/devices\/hid-framing/, (resource) => { resource.request = "@ledgerhq/devices/lib-es/hid-framing.js"; }));
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: bufferPath,
        process: processPath,
      };
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ["buffer", "Buffer"],
          process: processPath,
        }),
      );

      // Split heavy Stellar/wallet vendor libs into a separate named chunk so
      // they are fetched once and shared across routes rather than duplicated.
      // @stellar/stellar-sdk + @creit.tech/stellar-wallets-kit combined are
      // several hundred kB; isolating them prevents them from inflating every
      // route's first-load budget.
      config.optimization = config.optimization ?? {};
      config.optimization.splitChunks = {
        ...(config.optimization.splitChunks ?? {}),
        cacheGroups: {
          ...((config.optimization.splitChunks)?.cacheGroups ?? {}),
          stellarVendor: {
            name: "stellar-vendor",
            test: /[\\/]node_modules[\\/](@stellar[\\/]stellar-sdk|@creit\.tech[\\/]stellar-wallets-kit|@walletconnect[\\/]|pino)[\\/]/,
            chunks: "all",
            priority: 20,
            reuseExistingChunk: true,
          },
          nobleVendor: {
            name: "noble-vendor",
            test: /[\\/]node_modules[\\/](@noble[\\/])/,
            chunks: "all",
            priority: 15,
            reuseExistingChunk: true,
          },
        },
      };
    }

    return config;
  },

  // Cross-Origin-Opener/Embedder-Policy make the page crossOriginIsolated,
  // which unlocks SharedArrayBuffer and lets bb.js take its *multithreaded*
  // proving path (lib/proof.ts picks navigator.hardwareConcurrency threads
  // when crossOriginIsolated, else falls back to 1).
  //
  // This used to corrupt proving: @aztec/bb.js's UltraHonkBackend spawns a Web
  // Worker from its prebuilt main.worker.js bundle via
  // `new Worker(new URL("./main.worker.js", import.meta.url))`, and if
  // Next.js/webpack re-processed that already-bundled file it corrupted its
  // inner module runtime ("Object.defineProperty called on non-object"). That
  // no longer applies: scripts/copy-bb.mjs copies bb.js's browser bundle to
  // /public/bb, and lib/proof.ts loads it with a webpackIgnore dynamic import,
  // so webpack never touches it regardless of these headers. All bb.js assets
  // (main.worker.js, barretenberg.js, the .wasm) are served same-origin from
  // /public/bb, so COEP's same-origin exemption covers them without needing
  // extra Cross-Origin-Resource-Policy headers.
  //
  // 'wasm-unsafe-eval' in script-src is required for WASM instantiation and
  // is unrelated to cross-origin isolation.
  async headers() {
    // lib/wallet.ts only registers WalletConnectModule (and only the app ever
    // opens its relay/verify/explorer traffic) when this is set — keep the CSP
    // minimally permissive for deployments that leave WalletConnect disabled.
    const mode = resolveCspMode(process.env.CSP_MODE);
    const walletConnectEnabled = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

    // Build the legacy CSP string (only used when mode !== "enforce").
    const csp =
      mode !== "enforce"
        ? buildCsp({
            strict: false,
            walletConnectEnabled,
            rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
            indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL,
          })
        : null;

    // Allow framing for the badge route (#532): it's designed to be embedded
    // in third-party sites via iframe. An optional BADGE_ALLOWED_ORIGINS env
    // var can restrict which origins may embed it (comma-separated list);
    // defaults to allowing all origins when unset.
    const badgeFrameAncestors = `frame-ancestors ${resolveBadgeFrameAncestors(
      process.env.BADGE_ALLOWED_ORIGINS,
    )}`;

    // buildCsp() returns a joined string ending with ";".
    // Append the frame-ancestors directive for each route variant.
    const badgeCsp = csp !== null ? `${csp} ${badgeFrameAncestors};` : null;
    const defaultCsp = csp !== null ? `${csp} frame-ancestors 'none';` : null;

    return [
      {
        // Badge route: frameable by default (#532)
        source: "/badge",
        headers: [
          ...(badgeCsp !== null ? [{ key: "Content-Security-Policy", value: badgeCsp }] : []),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          // X-Frame-Options has no "allow all" value; omit it for the badge
          // route and rely on CSP frame-ancestors for modern browsers. Legacy
          // browsers without CSP support will allow framing by default.
          { key: "Permissions-Policy", value: "camera=()" },
          // Badge doesn't need cross-origin isolation (no WASM proving)
          { key: "Cross-Origin-Opener-Policy", value: "unsafe-none" },
          { key: "Cross-Origin-Embedder-Policy", value: "unsafe-none" },
        ],
      },
      {
        // All other routes: deny framing
        source: "/:path*",
        headers: [
          ...(defaultCsp !== null ? [{ key: "Content-Security-Policy", value: defaultCsp }] : []),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "X-Frame-Options", value: "DENY" },
          // components/QrScanner.tsx uses getUserMedia() for camera-based QR
          // scanning (/verify and /holder). Explicitly scoped to this origin —
          // no embedding context should be able to request it.
          { key: "Permissions-Policy", value: "camera=(self)" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      // CORS headers for /api/* are handled by middleware.ts (OPTIONS preflight
      // returns 204, all other methods get headers appended to the response).
    ];
  },
};

export default withBundleReport(withNextIntl(nextConfig));

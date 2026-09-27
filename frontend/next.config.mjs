import { createRequire } from "module";
import withBundleAnalyzer from "@next/bundle-analyzer";
import createNextIntlPlugin from "next-intl/plugin";

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

  // The /api/issue route runs Noir server-side to compute the Poseidon
  // commitment. Keep these out of the server bundle so Node require()s them
  // from node_modules and resolves their CJS/"nodejs" entry points, which read
  // the WASM from disk with fs. If bundled, webpack picks the "web" build that
  // fetch()es the WASM via a /_next/... URL, which has no base on the server
  // ("Failed to parse URL from /_next/static/media/...wasm").
  experimental: {
    serverComponentsExternalPackages: [
      "@noir-lang/noir_js",
      "@noir-lang/acvm_js",
      "@noir-lang/noirc_abi",
    ],
  },

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
    }

    return config;
  },

  // ── Security headers ─────────────────────────────────────────────────────────
  //
  // CONTENT SECURITY POLICY (#531)
  // ─────────────────────────────
  // A CSP is the primary defence-in-depth control against XSS.  An XSS that
  // can run arbitrary script could read credential material from localStorage
  // regardless of any other control, so this policy is enforced (not report-
  // only) and kept as tight as the app's legitimate needs allow.
  //
  // Directives and their reasons:
  //   default-src 'self'
  //     Catch-all fallback; tightened per-resource below.
  //
  //   script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'
  //     'unsafe-inline'    — required by Next.js inline hydration/bootstrap
  //                          scripts; cannot be replaced by a nonce at build
  //                          time with the App Router.
  //     'wasm-unsafe-eval' — required for in-browser WASM instantiation
  //                          (bb.js UltraHonk proving).
  //
  //   style-src 'self' 'unsafe-inline'
  //     Next.js injects critical CSS as inline <style> tags.
  //
  //   img-src 'self' data: https://stellar.creit.tech https://storage.herewallet.app
  //     stellar.creit.tech    — Stellar Wallets Kit wallet icons (Albedo,
  //                             Freighter, xBull, Rabet, Lobstr, Hana, Klever,
  //                             WalletConnect).
  //     storage.herewallet.app — HOT Wallet icon.
  //     explorer-api.walletconnect.com (conditional) — WalletConnect wallet
  //                             list images, shown only when QR pairing opens.
  //
  //   connect-src 'self' https://soroban-{testnet,mainnet}.stellar.org …
  //     Soroban RPC — contracts.ts calls getAccount/prepareTransaction/
  //                   sendTransaction from the browser.
  //     /api/witness, /api/issue — same-origin fetch, covered by 'self'.
  //     WalletConnect relay/verify/explorer (conditional) — hardcoded by
  //                   @walletconnect/core and @walletconnect/modal-core.
  //     NEXT_PUBLIC_RPC_URL (conditional) — operator-configured RPC override.
  //
  //   frame-src (conditional, WalletConnect only)
  //     verify.walletconnect.{com,org} — domain-verification iframe loaded by
  //     @walletconnect/sign-client; blocked silently without this directive,
  //     causing WalletConnect connect attempts to hang.
  //
  //   frame-ancestors — see FRAMING POLICY below.
  //
  // FRAMING POLICY (#532)
  // ─────────────────────
  // The /badge route is intentionally embeddable: it is a public read-only
  // widget designed to be placed in third-party sites via <iframe>.  Every
  // other route must not be frameable to prevent clickjacking.
  //
  // Two complementary mechanisms are used:
  //   frame-ancestors in CSP — modern browsers honour this over X-Frame-Options
  //                            when both are present.
  //   X-Frame-Options        — legacy fallback for older browsers that do not
  //                            support frame-ancestors.
  //
  // The default rule (/:path*) sets both to DENY.  A second, more-specific
  // rule (/badge) overrides them: frame-ancestors allows all origins ('*') by
  // default, or an operator-supplied allowlist via BADGE_EMBED_ORIGINS.
  //
  // BADGE_EMBED_ORIGINS — optional, space-separated list of origins that are
  // allowed to embed the badge (e.g. "https://example.com https://app.io").
  // When unset the badge is embeddable from any origin.  Operators who want
  // to restrict embedding should set this env var.
  //
  // COOP/COEP (#531)
  // ────────────────
  // Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy:
  // require-corp make the page crossOriginIsolated, unlocking SharedArrayBuffer
  // and enabling bb.js multithreaded proving.  These are set on all routes.
  // The /badge route is intentionally excluded from COEP (see below) so that
  // third-party pages embedding it don't need to opt in to cross-origin
  // isolation themselves.
  //
  // 'wasm-unsafe-eval' in script-src is required for WASM instantiation and
  // is unrelated to cross-origin isolation.
  async headers() {
    // lib/wallet.ts only registers WalletConnectModule (and only the app ever
    // opens its relay/verify/explorer traffic) when this is set — keep the CSP
    // minimally permissive for deployments that leave WalletConnect disabled.
    const walletConnectEnabled = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

    // Operator-supplied embedding allowlist for the badge route (#532).
    // When set, only the listed origins may embed /badge in an iframe.
    // When unset, any origin may embed it (the badge is a public widget).
    const badgeEmbedOrigins = process.env.BADGE_EMBED_ORIGINS?.trim() ?? "";
    const frameAncestorsBadge = badgeEmbedOrigins
      ? `frame-ancestors ${badgeEmbedOrigins};`
      : "frame-ancestors *;";

    // ── Build the shared CSP string ──────────────────────────────────────────
    // frame-ancestors is appended per-route (different values for /badge vs
    // the rest), so it is NOT included in this shared array.
    const cspDirectives = [
      "default-src 'self'",
      // 'unsafe-inline' is required by Next.js inline hydration scripts.
      // 'wasm-unsafe-eval' is required for bb.js in-browser WASM proving.
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      // Wallet icons — see comment block above for details.
      `img-src 'self' data: https://stellar.creit.tech https://storage.herewallet.app${
        walletConnectEnabled ? " https://explorer-api.walletconnect.com" : ""
      }`,
      // Soroban RPC + WalletConnect relay/verify/explorer (conditional).
      `connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org${
        walletConnectEnabled
          ? " wss://relay.walletconnect.com wss://relay.walletconnect.org https://explorer-api.walletconnect.com https://verify.walletconnect.com https://verify.walletconnect.org"
          : ""
      }${process.env.NEXT_PUBLIC_RPC_URL ? " " + process.env.NEXT_PUBLIC_RPC_URL : ""}`,
    ];

    if (walletConnectEnabled) {
      // verify.walletconnect.{com,org} is WalletConnect's domain-verification
      // iframe (loaded by @walletconnect/sign-client); without this it's
      // silently blocked and WalletConnect connect attempts hang.
      cspDirectives.push(
        "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org",
      );
    }

    // Shared CSP string without frame-ancestors (appended per route below).
    const cspBase = cspDirectives.join("; ") + "; ";

    // ── Shared security headers applied to every route ───────────────────────
    // frame-ancestors and X-Frame-Options are intentionally omitted here and
    // applied per-route so /badge can override them.
    const sharedHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      // components/QrScanner.tsx uses getUserMedia() for camera-based QR
      // scanning (/verify and /holder). Explicitly scoped to this origin —
      // no embedding context should be able to request it.
      { key: "Permissions-Policy", value: "camera=(self)" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
    ];

    return [
      // ── Default: all routes — framing denied (#531 + #532) ────────────────
      {
        source: "/((?!badge).*)",
        headers: [
          ...sharedHeaders,
          {
            key: "Content-Security-Policy",
            // frame-ancestors 'none' prevents this page from being loaded in
            // any frame, iframe, or object tag.  Combined with X-Frame-Options
            // for browsers that do not support frame-ancestors in CSP.
            value: cspBase + "frame-ancestors 'none';",
          },
          // X-Frame-Options is the legacy fallback for browsers that predate
          // the frame-ancestors CSP directive.
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },

      // ── /badge: framing allowed (#532) ────────────────────────────────────
      // The badge widget is designed to be embedded by third-party sites.
      // frame-ancestors permits embedding (all origins by default, or the
      // operator allowlist); X-Frame-Options is omitted because it cannot
      // express "allow all" — its absence is the correct signal here.
      //
      // COOP/COEP are also omitted: the badge is a lightweight read-only
      // widget served without SharedArrayBuffer, so cross-origin isolation is
      // not needed.  Keeping COEP off also avoids requiring the embedding page
      // to set Cross-Origin-Embedder-Policy itself.
      {
        source: "/badge",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=()" },
          // frame-ancestors controls which origins may embed this route.
          // Default: '*' (any origin).  Override with BADGE_EMBED_ORIGINS.
          {
            key: "Content-Security-Policy",
            value: cspBase + frameAncestorsBadge,
          },
          // Explicitly set COOP to unsafe-none so the badge can be loaded in
          // a cross-origin browsing context without the embedding page needing
          // COOP: same-origin.
          { key: "Cross-Origin-Opener-Policy", value: "unsafe-none" },
        ],
      },

      // CORS headers for /api/* are handled by middleware.ts (OPTIONS preflight
      // returns 204, all other methods get headers appended to the response).
    ];
  },
};

export default withBundleReport(withNextIntl(nextConfig));
#!/usr/bin/env node
/**
 * Issue #630 — assert proving assets are absent from the first-load
 * critical path for every route.
 *
 * Proving assets (bb.js, the prover worker, circuit JSON, WASM) are
 * multi-megabyte and must only be fetched when the user actually clicks
 * "Generate proof" — never during initial page load.
 *
 * This script loads each route with Playwright, records every network
 * request that fires before the page reaches 'load', and fails if any
 * request URL matches a proving-asset pattern.
 *
 * Runs under CI after `pnpm build` + `pnpm start --port 4319` in the same
 * job. Uses the already-installed Playwright (no new deps).
 */
import { chromium } from '@playwright/test';

const PORT = '4319';
const BASE = `http://localhost:${PORT}`;
const ROUTES = ['/', '/apps', '/holder', '/issuer', '/verify', '/docs'];

// Patterns that identify a proving asset. If any request matches one of
// these during initial load, the route has put the prover on the critical
// path and the assertion fails.
const PROVING_PATTERNS = [
  /\/bb\/[^/]+\.js$/,          // public/bb/*.js — the bb.js WASM wrapper
  /\/bb\/.*\.wasm$/,           // any WASM under public/bb/
  /\/workers\/[^/]+\.js$/,     // prover worker
  /\/circuits\/.*\.json$/,     // circuit JSON
  /\.wasm(\?|$)/               // any WASM anywhere
];

function isProvingAsset(url) {
  return PROVING_PATTERNS.some((re) => re.test(new URL(url).pathname));
}

async function checkRoute(browser, route) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requestedProvingAssets = [];

  page.on('request', (req) => {
    if (isProvingAsset(req.url())) {
      requestedProvingAssets.push(req.url());
    }
  });

  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'load', timeout: 30_000 });
  } catch (e) {
    await context.close();
    return { route, error: e.message };
  }
  await context.close();
  return { route, requestedProvingAssets };
}

async function main() {
  console.log(`Checking first-load critical path on ${ROUTES.length} routes...\n`);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const failures = [];

  for (const route of ROUTES) {
    process.stdout.write(`  ${route.padEnd(10)} `);
    const result = await checkRoute(browser, route);
    if (result.error) {
      console.log(`FAIL — ${result.error}`);
      failures.push({ route, reason: `navigation error: ${result.error}` });
      continue;
    }
    if (result.requestedProvingAssets.length > 0) {
      console.log(`FAIL — ${result.requestedProvingAssets.length} proving asset(s) loaded:`);
      for (const u of result.requestedProvingAssets) {
        console.log(`         ${u}`);
      }
      failures.push({
        route,
        reason: `${result.requestedProvingAssets.length} proving asset(s) on critical path`,
      });
    } else {
      console.log('OK');
    }
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\n${failures.length} route(s) failed the critical-path assertion:`);
    for (const f of failures) {
      console.error(`  ${f.route}: ${f.reason}`);
    }
    process.exit(1);
  }
  console.log('\nAll routes passed — proving assets are lazy-loaded.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
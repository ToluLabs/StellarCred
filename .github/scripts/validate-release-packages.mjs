#!/usr/bin/env node
/**
 * Release gate for the npm packages published by `.github/workflows/release.yml`.
 *
 *   node .github/scripts/validate-release-packages.mjs [--tag vX.Y.Z[-pre.N]] [--repo owner/name] [--packed]
 *
 * What it enforces (every violation is reported, then the exit code is 1):
 *
 *   1. Version alignment  - every published package carries the SAME version, and,
 *      when `--tag` is given, that version equals the tag without its leading "v".
 *   2. Metadata           - name, semver version, description, license, public
 *      access, a `repository` that matches the repo the release runs from (npm
 *      provenance rejects a publish when it does not), a `files` allow-list, and
 *      entry points (`main` / `module` / `types` / `exports`) that stay inside the
 *      package.
 *   3. Tarball contents   - with `--packed`, `npm pack --dry-run` is run for each
 *      package (lifecycle scripts disabled) and the tarball must contain every
 *      entry point and must not contain sources, tests, env files or key material.
 *
 * Dependency-free on purpose: it runs before `pnpm install` in some contexts and must
 * never execute code from the packages it is judging.
 *
 * Design note: the `--packed` check never runs `prepack` / `prepublishOnly` (it passes
 * `--ignore-scripts`). Build the packages first; this script only inspects the result.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Packages published by release.yml. Keep in sync with `.github/scripts/publish-packages.sh`. */
export const PACKAGES = [
  { name: "@stellarcred/sdk", dir: "frontend/packages/sdk" },
  { name: "@stellarcred/issuer", dir: "frontend/packages/issuer" },
];

// Semver 2.0 without build metadata (npm dist-tags and our tag format do not use it).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const TAG = /^v(.+)$/;

/** Paths that must never appear in a published tarball. */
const FORBIDDEN_IN_TARBALL = [
  /^src\//,
  /^test\//,
  /^scripts\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)\.npmrc$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
];

/** `git+https://github.com/Owner/Repo.git` -> `owner/repo` (null when not a GitHub URL). */
export function normalizeRepo(url) {
  if (typeof url !== "string") return null;
  const m = url
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .match(/^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+\/[^/]+)$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Every relative file path an entry-point field (string or nested exports map) refers to. */
export function collectEntryPoints(pkg) {
  const found = new Set();
  const visit = (value) => {
    if (typeof value === "string") found.add(value);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  for (const field of ["main", "module", "types", "typings", "exports"]) visit(pkg[field]);
  return [...found];
}

/** Lexically normalise a package-relative path ("./dist/a.js" -> "dist/a.js"). */
function packageRelative(p) {
  return posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
}

/**
 * Validate one package manifest. Pure: no filesystem or network access.
 * @returns {string[]} human-readable violations (empty when the manifest is fine)
 */
export function validateManifest(pkg, { name, dir }, { repo } = {}) {
  const errors = [];
  const fail = (msg) => errors.push(`${name}: ${msg}`);

  if (pkg.name !== name) fail(`package.json "name" is ${JSON.stringify(pkg.name)}, expected ${JSON.stringify(name)}`);
  if (pkg.private === true) fail(`"private": true — npm refuses to publish it`);

  if (typeof pkg.version !== "string" || !SEMVER.test(pkg.version)) {
    fail(`"version" ${JSON.stringify(pkg.version)} is not valid semver (X.Y.Z or X.Y.Z-pre.N)`);
  }
  if (typeof pkg.description !== "string" || pkg.description.trim() === "") fail(`"description" is missing`);
  if (typeof pkg.license !== "string" || pkg.license.trim() === "") fail(`"license" is missing`);

  if (pkg.publishConfig?.access !== "public") {
    fail(`"publishConfig.access" must be "public" (scoped packages default to restricted)`);
  }

  // repository: must point at the repo the release runs from, and at this package's directory.
  const declared = normalizeRepo(typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url);
  if (!declared) {
    fail(`"repository.url" is missing or not a github.com URL`);
  } else if (repo && declared !== repo.toLowerCase()) {
    fail(
      `"repository.url" points at ${declared} but the release runs from ${repo.toLowerCase()} ` +
        `(npm provenance rejects a mismatch)`,
    );
  }
  if (pkg.repository?.directory !== dir) {
    fail(`"repository.directory" is ${JSON.stringify(pkg.repository?.directory)}, expected ${JSON.stringify(dir)}`);
  }

  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    fail(`"files" allow-list is missing — without it npm publishes everything not git-ignored`);
  }

  const entries = collectEntryPoints(pkg);
  if (entries.length === 0) fail(`no "main" / "module" / "types" / "exports" entry point is declared`);
  for (const entry of entries) {
    const rel = packageRelative(entry);
    if (rel.startsWith("..") || posix.isAbsolute(rel)) fail(`entry point ${JSON.stringify(entry)} escapes the package`);
  }

  return errors;
}

/**
 * Cross-package and tag checks. Pure.
 * @param {{name: string, version: unknown}[]} manifests
 */
export function validateAlignment(manifests, tag) {
  const errors = [];
  const versions = [...new Set(manifests.map((m) => m.version))];
  if (versions.length > 1) {
    errors.push(
      `versions are not aligned: ${manifests.map((m) => `${m.name}@${m.version}`).join(", ")} — ` +
        `all published packages must share one version`,
    );
  }
  if (tag !== undefined) {
    const m = TAG.exec(tag);
    if (!m || !SEMVER.test(m[1])) {
      errors.push(`tag ${JSON.stringify(tag)} is not "v" + semver (expected vX.Y.Z or vX.Y.Z-pre.N)`);
    } else {
      for (const pkg of manifests) {
        if (pkg.version !== m[1]) {
          errors.push(`tag ${tag} does not match ${pkg.name}@${pkg.version} (expected version ${m[1]})`);
        }
      }
    }
  }
  return errors;
}

/**
 * Check an `npm pack --dry-run --json` file list against the manifest. Pure.
 * @param {string[]} files package-relative paths inside the tarball
 */
export function validateTarballFiles(pkg, { name }, files) {
  const errors = [];
  const fail = (msg) => errors.push(`${name}: ${msg}`);
  const inTarball = new Set(files.map((f) => f.replace(/\\/g, "/")));

  for (const entry of collectEntryPoints(pkg)) {
    const rel = packageRelative(entry);
    if (!inTarball.has(rel)) fail(`entry point ${JSON.stringify(entry)} is not in the tarball — did the build run?`);
  }
  for (const required of ["package.json", "README.md"]) {
    if (!inTarball.has(required)) fail(`${required} is not in the tarball`);
  }
  for (const f of inTarball) {
    if (FORBIDDEN_IN_TARBALL.some((re) => re.test(f))) fail(`tarball contains ${JSON.stringify(f)}, which must not be published`);
  }
  return errors;
}

function readManifest(root, dir) {
  const file = join(root, dir, "package.json");
  if (!existsSync(file)) throw new Error(`${dir}/package.json not found`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function packFileList(root, dir) {
  const bin = process.platform === "win32" ? "npm.cmd" : "npm";
  const out = execFileSync(bin, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: join(root, dir),
    encoding: "utf8",
    shell: process.platform === "win32", // Node refuses to spawn .cmd files otherwise
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  return (parsed[0]?.files ?? []).map((f) => f.path);
}

function parseArgs(argv) {
  const opts = { packed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--packed") opts.packed = true;
    else if (arg === "--tag") opts.tag = argv[++i];
    else if (arg === "--repo") opts.repo = argv[++i];
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (opts.tag === "" || (argv.includes("--tag") && opts.tag === undefined)) throw new Error("--tag needs a value");
  opts.repo ??= process.env.GITHUB_REPOSITORY || undefined;
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const errors = [];
  const manifests = [];

  for (const spec of PACKAGES) {
    let pkg;
    try {
      pkg = readManifest(root, spec.dir);
    } catch (err) {
      errors.push(`${spec.name}: ${err.message}`);
      continue;
    }
    manifests.push({ spec, pkg });
    errors.push(...validateManifest(pkg, spec, { repo: opts.repo }));
  }

  errors.push(...validateAlignment(manifests.map(({ spec, pkg }) => ({ name: spec.name, version: pkg.version })), opts.tag));

  if (opts.packed) {
    for (const { spec, pkg } of manifests) {
      try {
        errors.push(...validateTarballFiles(pkg, spec, packFileList(root, spec.dir)));
      } catch (err) {
        errors.push(`${spec.name}: \`npm pack --dry-run\` failed: ${String(err.stderr || err.message).trim()}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`Release package validation failed (${errors.length}):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    return 1;
  }

  for (const { spec, pkg } of manifests) console.log(`✓ ${spec.name}@${pkg.version}${opts.packed ? " (tarball checked)" : ""}`);
  if (!opts.repo) console.log("note: no --repo / GITHUB_REPOSITORY given; repository.url was not compared to a repo");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`validate-release-packages: ${err.message}`);
    process.exitCode = 2;
  }
}

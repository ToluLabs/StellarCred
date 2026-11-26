import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectEntryPoints,
  normalizeRepo,
  validateAlignment,
  validateManifest,
  validateTarballFiles,
} from "./validate-release-packages.mjs";

const SPEC = { name: "@stellarcred/issuer", dir: "frontend/packages/issuer" };
const REPO = "ToluLabs/StellarCred";

const good = () => ({
  name: "@stellarcred/issuer",
  version: "0.1.1",
  description: "Server-only issuance client",
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/ToluLabs/StellarCred.git",
    directory: "frontend/packages/issuer",
  },
  publishConfig: { access: "public" },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", node: { import: "./dist/index.mjs", require: "./dist/index.js" } } },
  files: ["dist"],
});

const tarball = ["package.json", "README.md", "dist/index.js", "dist/index.mjs", "dist/index.d.ts"];

test("a correct manifest has no violations", () => {
  assert.deepEqual(validateManifest(good(), SPEC, { repo: REPO }), []);
});

test("normalizeRepo handles the URL spellings npm accepts", () => {
  for (const url of [
    "git+https://github.com/ToluLabs/StellarCred.git",
    "https://github.com/ToluLabs/StellarCred",
    "https://github.com/tolulabs/stellarcred/",
    "git@github.com:ToluLabs/StellarCred.git",
  ]) {
    assert.equal(normalizeRepo(url), "tolulabs/stellarcred", url);
  }
  assert.equal(normalizeRepo("https://gitlab.com/ToluLabs/StellarCred"), null);
  assert.equal(normalizeRepo(undefined), null);
});

test("a stale repository owner is rejected (provenance would 422)", () => {
  const pkg = good();
  pkg.repository.url = "git+https://github.com/Psalmuel01/StellarCred.git";
  const errors = validateManifest(pkg, SPEC, { repo: REPO });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /provenance/);
});

test("repository is not compared when no repo is supplied", () => {
  const pkg = good();
  pkg.repository.url = "git+https://github.com/Psalmuel01/StellarCred.git";
  assert.deepEqual(validateManifest(pkg, SPEC, {}), []);
});

test("wrong repository.directory is rejected", () => {
  const pkg = good();
  pkg.repository.directory = "frontend/packages/sdk";
  assert.match(validateManifest(pkg, SPEC, { repo: REPO }).join("\n"), /repository\.directory/);
});

test("missing publishConfig.access, files, license, description are each reported", () => {
  const pkg = good();
  delete pkg.publishConfig;
  delete pkg.files;
  delete pkg.license;
  delete pkg.description;
  const text = validateManifest(pkg, SPEC, { repo: REPO }).join("\n");
  for (const needle of ["publishConfig.access", '"files"', '"license"', '"description"']) {
    assert.ok(text.includes(needle), `expected a violation mentioning ${needle}`);
  }
});

test("private packages and invalid semver are rejected", () => {
  const pkg = good();
  pkg.private = true;
  pkg.version = "1.0";
  const text = validateManifest(pkg, SPEC, { repo: REPO }).join("\n");
  assert.match(text, /private/);
  assert.match(text, /not valid semver/);
});

test("pre-release versions are valid semver", () => {
  for (const version of ["1.0.0", "0.1.1", "1.0.0-rc.1", "1.0.0-alpha", "2.3.4-pre.10"]) {
    const pkg = { ...good(), version };
    assert.deepEqual(validateManifest(pkg, SPEC, { repo: REPO }), [], version);
  }
  for (const version of ["01.0.0", "1.0.0+build", "v1.0.0", "1.0.0-", "1.0.0-01"]) {
    assert.match(validateManifest({ ...good(), version }, SPEC, { repo: REPO }).join("\n"), /semver/, version);
  }
});

test("entry points that escape the package are rejected", () => {
  const pkg = good();
  pkg.main = "../../outside.js";
  assert.match(validateManifest(pkg, SPEC, { repo: REPO }).join("\n"), /escapes the package/);
});

test("collectEntryPoints walks nested exports", () => {
  assert.deepEqual(collectEntryPoints(good()).sort(), ["./dist/index.d.ts", "./dist/index.js", "./dist/index.mjs"]);
});

test("aligned versions matching the tag pass, including pre-releases", () => {
  const m = [
    { name: "a", version: "1.2.3" },
    { name: "b", version: "1.2.3" },
  ];
  assert.deepEqual(validateAlignment(m, "v1.2.3"), []);
  assert.deepEqual(validateAlignment(m, undefined), []);
  const pre = m.map((x) => ({ ...x, version: "1.2.3-rc.1" }));
  assert.deepEqual(validateAlignment(pre, "v1.2.3-rc.1"), []);
});

test("misaligned package versions are rejected even without a tag", () => {
  const errors = validateAlignment(
    [
      { name: "@stellarcred/sdk", version: "0.1.1" },
      { name: "@stellarcred/issuer", version: "0.1.0" },
    ],
    undefined,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not aligned/);
});

test("a tag that differs from the package version is rejected, per package", () => {
  const m = [
    { name: "@stellarcred/sdk", version: "0.1.1" },
    { name: "@stellarcred/issuer", version: "0.1.1" },
  ];
  const errors = validateAlignment(m, "v0.2.0");
  assert.equal(errors.length, 2);
  assert.match(errors[0], /@stellarcred\/sdk@0\.1\.1/);
});

test("malformed tags are rejected", () => {
  const m = [{ name: "a", version: "1.0.0" }];
  for (const tag of ["1.0.0", "v1.0", "release-1.0.0", "v"]) {
    assert.match(validateAlignment(m, tag).join("\n"), /not "v" \+ semver/, tag);
  }
});

test("a complete tarball passes", () => {
  assert.deepEqual(validateTarballFiles(good(), SPEC, tarball), []);
});

test("a tarball missing built output is rejected (build did not run)", () => {
  const errors = validateTarballFiles(good(), SPEC, ["package.json", "README.md"]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /did the build run/);
});

test("sources, tests, env files and key material must not be published", () => {
  const leaked = [...tarball, "src/index.ts", "dist/index.test.js", ".env", ".env.local", "keys/issuer.pem", ".npmrc", "node_modules/x/index.js"];
  const text = validateTarballFiles(good(), SPEC, leaked).join("\n");
  for (const f of ["src/index.ts", "dist/index.test.js", '".env"', ".env.local", "issuer.pem", ".npmrc", "node_modules"]) {
    assert.ok(text.includes(f), `expected the tarball check to flag ${f}`);
  }
});

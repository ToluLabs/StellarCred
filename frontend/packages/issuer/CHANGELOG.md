# @stellarcred/issuer Changelog

All notable changes to `@stellarcred/issuer` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0.0 a MINOR release may contain breaking changes; they are listed under a
`BREAKING` heading. See [SUPPORT_POLICY.md](../../../SUPPORT_POLICY.md#issuer-package-versions).

`@stellarcred/issuer` is released in lockstep with `@stellarcred/sdk`: both packages
carry the same version in every release.

## [Unreleased]

## [0.1.1]

First public release on npm.

### Added
- Published by the repository's release workflow (`release.yml`) together with
  `@stellarcred/sdk`, with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
- Documented package lifecycle: versioning, support windows, upgrade checklist and
  how to verify provenance (`SUPPORT_POLICY.md`, package README).

### Changed
- Version aligned with `@stellarcred/sdk` (was `0.1.0`, which was never published).
- `repository.url` now points at `ToluLabs/StellarCred`, and `publishConfig.access`
  is `public`. No source or API changes.

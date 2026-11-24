# V1 Public Surface

Canonical compatibility page for the StellarCred v1 public surface. Anything
listed here is frozen: changing it requires the release-scope review below and
an explicit compatibility note in `VERSION_COMPATIBILITY.md`.

## Frozen surfaces and their sources of truth

| Surface | Source of truth | Drift check |
|---------|-----------------|-------------|
| ProofRegistry contract ABI (entrypoints, auth, panics, error codes) | [PROOF_REGISTRY_API.md](PROOF_REGISTRY_API.md) | `.github/scripts/check-api-reference.mjs` |
| Contract events, topics, and XDR payloads | [EVENTS.md](EVENTS.md) | Contract tests |
| Contract error codes | [contract-error-codes.md](contract-error-codes.md) | `.github/scripts/check-api-reference.mjs` |
| Circuit ids, public inputs, and verification-key versions | [`circuits/supported-circuits.v1.json`](../circuits/supported-circuits.v1.json) | `contracts-ci` circuit checks |
| SDK public API signatures and runtime support | [SDK_RUNTIME_SUPPORT.md](SDK_RUNTIME_SUPPORT.md) | `.github/scripts/check-sdk-runtime-support.mjs` |
| Version promises and support windows | [VERSION_COMPATIBILITY.md](../VERSION_COMPATIBILITY.md), [SUPPORT_POLICY.md](../SUPPORT_POLICY.md) | Release workflow |

The ProofRegistry ABI reference is the authoritative description of every
public entrypoint. Events are catalogued separately because consumers decode
them off-chain; the two documents must agree on names, payload fields, and
units.

## Release-scope review checklist

A change that touches any frozen surface must answer all of the following in
its pull request:

1. **Surface identified** — name the frozen item and link its source of truth.
2. **Drift checks run** — `node .github/scripts/check-api-reference.mjs` for ABI
   or error changes, and `node .github/scripts/check-sdk-runtime-support.mjs`
   for SDK runtime changes.
3. **Compatibility classified** — breaking or non-breaking, following
   [SUPPORT_POLICY.md § Breaking vs Non-Breaking Changes](../SUPPORT_POLICY.md#breaking-vs-non-breaking-changes).
4. **Migration path documented** — for breaking changes, add an upgrade or
   migration note to `VERSION_COMPATIBILITY.md` (and a runbook step if state
   must be migrated).
5. **Sign-off recorded** — contract, circuits, and SDK maintainers approve
   changes that span more than one surface. CODEOWNERS enforces the reviewers
   for these files.
6. **Tests cover the freeze** — an ABI or event change includes a test that
   pins the new shape, so the next drift is caught in CI rather than by an
   integrator.

## What is not frozen

Operational entrypoints (admin, role management, pause/unpause, and data
migration helpers) may evolve between minor versions. Their current signatures
and auth rules are still documented in
[PROOF_REGISTRY_API.md](PROOF_REGISTRY_API.md), but integrators should not
build new dependencies on them.

# StellarCred v1 Public Surface

This is the canonical v1 compatibility page. It lists every surface that is
frozen for the v1 line and the single file that is its source of truth. Any
change that touches a frozen surface needs sign-off from the contract,
circuits, and SDK maintainers and a completed entry in the
[release-scope checklist](RELEASE_CHECKLIST.md) before merge
(see [SUPPORT_POLICY.md](../SUPPORT_POLICY.md#v1-public-surface-freeze)).

## Frozen surfaces and their sources of truth

| Surface | Source of truth | Enforced by |
|---|---|---|
| ProofRegistry contract ABI (entrypoints, auth, panics) | [PROOF_REGISTRY_API.md](PROOF_REGISTRY_API.md), generated against `contracts/proof_registry/src/lib.rs` | `node .github/scripts/check-api-reference.mjs` (Contract API reference drift check) |
| Contract error codes | [PROOF_REGISTRY_API.md](PROOF_REGISTRY_API.md) §10 error table and [contract-error-codes.md](contract-error-codes.md) | `node .github/scripts/check-api-reference.mjs` |
| Contract event topics and payloads | [EVENTS.md](EVENTS.md) | Contract tests |
| Circuit versions and VK versions | `circuits/circuit-versions.json` | Circuit compile / VK version checks |
| Supported circuits and public-input layouts | `circuits/supported-circuits.v1.json` | Circuit compile |
| SDK exports and signatures | `frontend/packages/sdk/src/index.ts` and the [SDK README](../frontend/packages/sdk/README.md) | SDK entry-point parity tests |
| Version promises across components | [VERSION_COMPATIBILITY.md](../VERSION_COMPATIBILITY.md) | Review (CODEOWNERS) |

## Rules

1. Additive changes (a new entrypoint, event, or SDK export) are MINOR and
   must be documented in the source of truth above in the same pull request.
2. Removing or changing the shape of anything listed above is a breaking
   change and is not allowed on the v1 line.
3. When a source of truth moves, update this page in the same commit so the
   drift checks keep pointing at the right file.

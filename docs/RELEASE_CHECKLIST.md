# Release-Scope Review Checklist (v1 public-surface freeze)

Complete this checklist on any pull request that touches a surface listed in
[V1_PUBLIC_SURFACE.md](V1_PUBLIC_SURFACE.md). Changes to this file are owned
by the contract, circuits, and SDK maintainers (see `.github/CODEOWNERS`).

## Scope

- [ ] Which frozen surface does the change touch (contract ABI, events, error
      codes, circuit versions or public inputs, SDK exports, version promises)?
- [ ] Is the change additive (MINOR) or breaking? Breaking changes are not
      accepted on the v1 line.

## Sources of truth updated in the same pull request

- [ ] [PROOF_REGISTRY_API.md](PROOF_REGISTRY_API.md) for any ProofRegistry
      entrypoint or error-code change, and
      `node .github/scripts/check-api-reference.mjs` passes locally.
- [ ] [EVENTS.md](EVENTS.md) for any event topic or payload change.
- [ ] `circuits/circuit-versions.json` and `circuits/supported-circuits.v1.json`
      for any circuit, VK, or public-input change.
- [ ] The SDK README and `frontend/packages/sdk/src/index.ts` for any SDK export
      change.
- [ ] [VERSION_COMPATIBILITY.md](../VERSION_COMPATIBILITY.md) for any change to a
      version promise.

## Sign-off

- [ ] Contract maintainer approval recorded on the pull request.
- [ ] Circuits maintainer approval recorded on the pull request.
- [ ] SDK maintainer approval recorded on the pull request.

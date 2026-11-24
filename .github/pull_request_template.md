## What does this PR do?

<!-- One paragraph. What changed and why. -->

Closes #

## Components touched

<!-- Name every component the diff touches. `.github/CODEOWNERS` uses the paths
     you change to request reviewers; see docs/COMPONENT_OWNERSHIP.md for the
     scope of each component. -->

- [ ] Contracts
- [ ] Circuits and VKs
- [ ] SDK and client bindings
- [ ] Frontend
- [ ] Issuer
- [ ] Indexer
- [ ] CI / tooling / docs only

## Type of change

- [ ] Bug fix
- [ ] New feature / credential type
- [ ] Refactor / cleanup
- [ ] Docs
- [ ] CI / tooling

## Checklist

<!-- See CONTRIBUTING.md for code style, commit message format, testing
     expectations, and the CI job → command map. -->

- [ ] Tests added or updated
- [ ] Lint passes (`make lint` / `pnpm lint`)
- [ ] CHANGELOG.md updated (user-facing changes)

## Security checks (issuance, signing, KYC, circuits)

<!-- Check these when the diff touches the paths named in
     docs/COMPONENT_OWNERSHIP.md § Sensitive changes. -->

- [ ] No `NEXT_PUBLIC_` prefix on server-only env vars
- [ ] No identity fields stored or logged after KYC provider call
- [ ] `prehash:false` preserved on any issuer signing path touched
- [ ] Issuer private key never referenced from client-bundled code
- [ ] Circuit changes: `fixtures/<type>/` artifacts updated

## CI and merge readiness

<!-- Every job that runs on this PR must be green before merge. The list of
     PR-triggered workflows is in docs/COMPONENT_OWNERSHIP.md § 5. -->

- [ ] All CI checks that ran on this PR are green
- [ ] Every review comment is addressed — no unresolved threads
- [ ] Coverage thresholds met (no regression vs. base)
- [ ] A reviewer from each touched component has reviewed (requested
      automatically by `.github/CODEOWNERS`)

## Notes for reviewers

<!-- Anything tricky, a design decision you're unsure about, or context that isn't obvious from the diff. -->

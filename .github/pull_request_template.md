## What does this PR do?

<!-- One paragraph. What changed and why. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature / credential type
- [ ] Refactor / cleanup
- [ ] Docs
- [ ] CI / tooling

## Merge requirements

- [ ] **CI is green* * — `cargo test` (contracts), `pnpm tsc --noEmit` (frontend), `pnpm build` (frontend), circuit tests — all green
- [ ] **Gretile confidence ≥ 4/5** — all review comments addressed, no unresolved threads
- [ ] Circuit changes: `fixtures/<type>/` artifacts updated
- [ ] No `NEXT_PUBLIC_` prefix on server-only env vars
- [ ] No identity fields stored or logged after KYC provider call
- [ ] `prehash:false` preserved on any issuer signing path touched
- [ ] Issuer private key never referenced from client-bundled code

## Coverage

<!-- Coverage reports are uploaded by CI\n     and annotated on this PR. Summary appears in the checks below. -->

- [ ] Coverage report uploaded and visible in PR checks
- [ ] Coverage thresholds met (no regression vs. base)

## ➡ Merge requirements

- [ ] All CI checks pass (contracts / frontend / circuits as applicable)
- [ ] Every Gretile review comment is addressed — no unresolved review threads
- [ ] Gretile confidence score is **4/5 or higher**

## Notes for reviewers

<!-- Anything tricky, a design decision you're unsure about, or context that isn't obvious from the diff. -->

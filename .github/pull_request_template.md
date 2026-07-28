## What does this PR do?

<!-- One paragraph. What changed and why. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature / credential type
- [ ] Refactor / cleanup
- [ ] Docs
- [ ] CI / tooling

## Checklist

- [ ] `cargo test` passes (contracts)
- [ ] `pnpm tsc --noEmit` passes (frontend)
- [ ] `pnpm build` passes (frontend)
- [ ] Circuit changes: `fixtures/<type>/` artifacts updated
- [ ] No `NEXT_PUBLIC_` prefix on server-only env vars
- [ ] No identity fields stored or logged after KYC provider call
- [ ] `prehash:false` preserved on any issuer signing path touched
- [ ] Issuer private key never referenced from client-bundled code

## ✅ Merge requirements

- [ ] All CI checks pass (contracts / frontend / circuits as applicable)
- [ ] Every Greptile review comment is addressed — no unresolved review threads
- [ ] Greptile confidence score is **4/5 or higher**

## Notes for reviewers

<!-- Anything tricky, a design decision you're unsure about, or context that isn't obvious from the diff. -->

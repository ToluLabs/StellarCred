# Contract Client Regeneration & Freshness Checks (#641, #999)

`frontend/packages/proof-registry` and `frontend/packages/issuer-registry` contain TypeScript clients generated from contract ABIs.

## Continuous Integration Freshness Gate (#999)

CI executes client freshness verification as a required check in both `.github/workflows/contracts-ci.yml` and `.github/workflows/ci.yml`.

If contract source changes are introduced without updating generated TypeScript bindings, the `Verify generated contract client freshness` step fails:
1. It compares committed client packages against contract interfaces.
2. If drift is detected, it generates a concise diff artifact `client-freshness.diff` uploaded to the CI run artifacts.
3. The step fails with exit code 1 and outputs the exact command needed to synchronize clients.

## Regenerating Clients Locally

When smart contracts (`ProofRegistry` or `IssuerRegistry`) are updated with new entrypoints, type definitions, or signature changes, regenerate the TypeScript clients locally:

```bash
# Ensure contracts are built first:
cargo build --release --target wasm32v1-none

# Regenerate bindings using the script:
bash scripts/gen-bindings.sh

# Or run freshness verification:
bash scripts/verify-client-freshness.sh
```

Then commit the updated files:
```bash
git add frontend/packages/proof-registry frontend/packages/issuer-registry
git commit -m "chore(bindings): regenerate contract clients"
```
